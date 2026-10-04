import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { connectionHeaders } from "../../shared/connection-auth.ts";
import {
  activateSessionTools,
  mountedDescription,
  mountedToolName,
  readConnectionToolsStore,
} from "../../shared/connection-tools-store.ts";
import {
  onDemandConnections,
  searchConnectionTools,
  selectMountedTools,
} from "../../shared/connection-tools.ts";
import { findConnectionById } from "../../shared/connections-store.ts";
import { toolInputSchema } from "../../shared/json-schema-zod.ts";
import { callMcpTool } from "../../shared/mcp-http.ts";
import { MAX_SESSION_TOOLS } from "../../shared/policy.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { mcpToolGate, mcpToolRisk } from "../lib/connector-risk.ts";
import { actionSha256, approvalActor, executeIfApproved, waitUntilNotPending } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { sessionPermission } from "../lib/permission.ts";
import { markOutside } from "../lib/outside-content.ts";

/**
 * The tools of connected MCP servers, mounted only once a bot has asked for
 * them.
 *
 * Every connection used to be handed to eve on `turn.started`, so every one
 * of its tools sat in context on every turn. A server may publish two hundred;
 * three medium ones took a bot past the router's tool cap, which answers a
 * non-retryable `unsupported_parameter`, and eve retires a session that gets
 * one. The chat was dead for good, and nothing checked the total on the way
 * in.
 *
 * So the big servers wait. `find_tools` searches their listings and records
 * what it handed over; this resolver runs before each model call, so the tools
 * it named are mounted for the next one, inside the same turn. The names stay
 * `<connectionId>__<toolName>`, which is both what eve would have called them
 * and what the macOS app parses to put a drawing on screen.
 */

const RESULT_MAX_BYTES = 24 * 1024;
const MAX_HITS = 8;
/**
 * The card shows every argument the hash binds, so there is no clipped
 * preview: a call whose arguments would not fit is refused and the model
 * asked to shorten it.
 */
const CARD_ARGS_MAX = 4000;

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const sessionId = ctx.session?.id ?? "";
      // Nothing to look through: no `find_tools` either, rather than a tool
      // that can only ever answer "no connections".
      if (onDemandConnections().length === 0) return null;
      // One read for the whole step. Looking each tool up on its own meant a
      // parse of the whole file per mounted tool, per model call.
      const store = sessionId ? readConnectionToolsStore() : null;
      // `unknown` because eve's own resolver signature is: each `defineTool`
      // call below is checked on its own, and one Record cannot hold two
      // tools whose input schemas differ.
      const tools: Record<string, unknown> = {
        find_tools: defineTool({
          description:
            "Find tools in the owner's connected MCP servers and make them callable. " +
            "Search by what you want to do, not by tool name. The tools it returns are " +
            "available on your next step, not in this one.",
          inputSchema: z.object({
            query: z.string().min(2).max(200)
              .describe("What you want to do, in a few words: \"send a slack message\"."),
          }),
          async execute(input, toolCtx) {
            markOutside(toolCtx);
            const id = toolCtx.session?.id ?? "";
            if (!id) return { status: "blocked", error: "no_session" };
            const hits = await searchConnectionTools(input.query, MAX_HITS);
            if (hits.length === 0) {
              return { status: "ok", found: 0, tools: [], note: "No connected server has a tool like that." };
            }
            const outcome = activateSessionTools(
              id,
              hits.map((hit) => hit.name),
              undefined,
              // Every mounted description carries its connection's name, so
              // the charge has to carry it too, for what this session already
              // holds as well as for what it is taking now.
              Object.fromEntries(
                onDemandConnections().map((item) => [item.id, item.name]),
              ),
            );
            const held = outcome.tools.length;
            return {
              status: "ok",
              found: hits.length,
              // Named so the model can call them by name on its next step.
              tools: hits
                .filter((hit) => !outcome.refused.includes(hit.name))
                .map((hit) => ({
                  name: hit.name,
                  // Outside the fence, so kept to one line like the
                  // mounted description keeps it.
                  app: hit.connectionName.replace(/[\r\n]+/g, " ").trim(),
                  // The server wrote this, so it is quoted rather than
                  // spoken: a listing is a place to plant instructions.
                  description: wrapUntrusted(`connection:${hit.connectionId}`, hit.description),
                })),
              ...(outcome.refused.length
                ? {
                  refused: outcome.refused,
                  note: `This chat is holding ${held} of ${MAX_SESSION_TOOLS} tools. Work with those, or start a fresh chat.`,
                }
                : {}),
            };
          },
        }),
      };
      // A caller with no session (an eval, a test) gets `find_tools` and
      // nothing else: there is no session to record an activation against,
      // and one shared key would mount one caller's tools in another's.
      //
      // Weighed again here, against the index as it is now: the charge at
      // activation was for the listing then, and a server that republished
      // fatter schemas since would otherwise walk the mounted set past the
      // router's byte wall with no call from the model at all.
      const picks = selectMountedTools(store?.sessions[sessionId]?.tools ?? [], {
        connection: findConnectionById,
        indexed: (connectionId, tool) => store?.index[connectionId]?.tools.find((item) => item.name === tool),
      });
      for (const { split, entry, indexed } of picks) {
        const { schema } = toolInputSchema(indexed.inputSchema);
        const connectionId = entry.id;
        const connectionName = entry.name;
        const url = entry.url;
        const toolName = split.tool;
        tools[mountedToolName(connectionId, toolName)] = defineTool({
          // Built by the same function that charged it, so what was weighed
          // is what is sent. The server wrote every word of it, schema
          // included, so it is quoted rather than spoken.
          description: mountedDescription(indexed, connectionId, connectionName),
          inputSchema: schema,
          async execute(input: unknown, toolCtx) {
            markOutside(toolCtx);
            // Read the row again rather than closing over it: eve snapshots a
            // callback's closure when the call is made, and the owner can
            // change or disconnect a server in between. Only strings are
            // captured here, which is also what the durable closure allows.
            const live = findConnectionById(connectionId);
            // The owner can disconnect a server, or narrow what it may do,
            // between the step that mounted this and the call.
            if (!live || live.url !== url) {
              return { status: "blocked", error: "connection_gone", connection: connectionId };
            }
            if (live.toolsAllow && !live.toolsAllow.includes(toolName)) {
              return { status: "blocked", error: "tool_not_allowed", connection: connectionId };
            }
            // Someone else's tool doing something on the owner's behalf is
            // gated like a connector call: this app runs it itself, so the
            // card is this app's to show.
            //
            // The posture decides, and nothing the server named does. A
            // Composio slug is Composio's to write, so a read verb in one
            // says something; an MCP server names its own tools, so a
            // `list_items` that deletes would have read as a read. The name
            // only labels the card.
            const permission = sessionPermission(toolCtx);
            const risk = mcpToolRisk(toolName);
            const gate = mcpToolGate(permission);
            if (gate === "refuse") return { status: "blocked", error: "workspace_read_only", risk };
            const args = input && typeof input === "object" && !Array.isArray(input)
              ? input as Record<string, unknown>
              : {};
            const argsText = JSON.stringify(args, null, 1);
            if (gate === "ask" && argsText.length > CARD_ARGS_MAX) {
              return { status: "blocked", error: "arguments_too_long_for_approval", max: CARD_ARGS_MAX };
            }
            // Bounded even when no card is shown: the record is written
            // either way, and a run-gated call with a megabyte of arguments
            // would be rewritten into the store on every later approval.
            const previewArgs = argsText.length > CARD_ARGS_MAX
              ? `${argsText.slice(0, CARD_ARGS_MAX)}…`
              : argsText;
            const hash = actionSha256({
              tool: "connection",
              canonicalArgs: JSON.stringify({ connection: connectionId, tool: toolName, arguments: args }),
              cwd: "",
              targetRevision: null,
              backend: "mcp",
              toolVersion: "1",
            });
            const approvals = getApprovalStore();
            const rec = approvals.request({
              ...approvalActor(toolCtx),
              tool: "connection",
              actionSha256: hash,
              preview: `${connectionName} · ${toolName}${risk === "destructive" ? " (destructive)" : ""}`
                + (previewArgs === "{}" ? "" : `\n${previewArgs}`),
            });
            if (gate === "run") {
              approvals.decide(rec.id, "approve", hash);
            } else {
              await waitUntilNotPending(approvals, rec.id);
              // A read-only switch while the card sat open refuses; a widened
              // one is not spent on this call.
              if (sessionPermission(toolCtx) !== permission) {
                return { status: "blocked", error: "permission_changed" };
              }
            }
            return executeIfApproved(approvals, rec.id, hash, async () => {
            // Read again after the wait: a card can sit open for minutes, and
            // an owner who repointed or narrowed the connection meanwhile
            // must not have the call go to the old endpoint with its
            // credential. The permission is re-checked above for the same
            // reason.
            const current = findConnectionById(connectionId);
            if (!current || current.url !== url) {
              return { status: "blocked", error: "connection_gone", connection: connectionId };
            }
            if (current.toolsAllow && !current.toolsAllow.includes(toolName)) {
              return { status: "blocked", error: "tool_not_allowed", connection: connectionId };
            }
            let headers: Record<string, string> = {};
            try {
              headers = await connectionHeaders(current);
              const raw = await callMcpTool(url, toolName, args, headers);
              let text = JSON.stringify(raw);
              let truncated = false;
              if (text.length > RESULT_MAX_BYTES) {
                text = text.slice(0, RESULT_MAX_BYTES);
                truncated = true;
              }
              return {
                status: "ok",
                tool: toolName,
                truncated,
                result: wrapUntrusted(`connection:${connectionId}/${toolName}`, text),
              };
            } catch (err) {
              // The server's words, never the headers that reached it: a
              // server can echo the credential it was sent back in an error.
              let message = err instanceof Error ? err.message : "failed";
              // Each part of a value too, so `Bearer <token>` is caught when
              // only the token comes back.
              for (const value of Object.values(headers)) {
                for (const part of [value, ...value.split(/\s+/)]) {
                  if (part.length >= 8) message = message.split(part).join("[redacted]");
                }
              }
              message = message.slice(0, 300);
              return {
                status: "error",
                tool: toolName,
                error: wrapUntrusted(`connection:${connectionId}/${toolName} error`, message),
              };
            }
            });
          },
        });
      }
      return tools;
    },
  },
});

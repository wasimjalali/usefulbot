import { defineTool, type UsefulTool } from "../lib/tool.ts";
import { connectionHeaders, OAuthExpiredError } from "../../shared/connection-auth.ts";
import {
  mountedDescription,
  mountedToolName,
  nextStamp,
  readConnectionToolsStore,
} from "../../shared/connection-tools-store.ts";
import {
  markConnectionAuthFailed,
  markConnectionExpired,
  refreshBeforeMount,
  selectMountedTools,
  splitMountedName,
} from "../../shared/connection-tools.ts";
import { findConnectionById } from "../../shared/connections-store.ts";
import { toolInputSchema } from "../../shared/json-schema-zod.ts";
import { callMcpTool, McpError, TOOL_CALL_TIMEOUT_MS } from "../../shared/mcp-http.ts";
import { clipUtf8, flatLine, wrapUntrusted } from "../../shared/untrusted.ts";
import { mcpToolGate, mcpToolRisk } from "../lib/connector-risk.ts";
import { actionSha256, approvalActor, executeIfApproved, waitUntilNotPending } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { sessionPermission } from "../lib/permission.ts";
import { markOutside } from "../lib/outside-content.ts";
import type { ToolCtx } from "../lib/tool.ts";

/**
 * The MCP tools `find_tools` picked for a chat, as tools the engine can
 * register (agent/tools/find_tools.ts holds the picks per chat). Each is
 * named `<connectionId>__<toolName>`, gated by `mcpToolGate` and called
 * through this app's own MCP client, with the result capped at 24 KB.
 */

const RESULT_MAX_BYTES = 24 * 1024;
/**
 * The card shows every argument the hash binds, so there is no clipped
 * preview: a call whose arguments would not fit is refused and the model
 * asked to shorten it.
 */
const CARD_ARGS_MAX = 4000;

/** Per chat, the connections its last `refreshPickedTools` judged unfit to mount. */
const blocked = new Map<string, Set<string>>();

/**
 * Before a chat's picked tools are registered after a restart: make sure each
 * connection's listing is current, so a tool the server dropped, a schema it
 * changed or an access that was revoked is not offered as working. Optional;
 * `pickedTools` works from whatever the index holds.
 */
export async function refreshPickedTools(chatId: string): Promise<void> {
  const saved = readConnectionToolsStore().sessions[chatId]?.tools ?? [];
  const ids = saved.map((name) => splitMountedName(name)?.connectionId).filter((id): id is string => id !== undefined);
  const stale = await refreshBeforeMount(ids);
  const mine = new Set<string>();
  for (const id of new Set(ids)) if (stale.has(id)) mine.add(id);
  blocked.set(chatId, mine);
}

export function pickedTools(chatId: string): UsefulTool[] {
  const store = readConnectionToolsStore();
  const saved = store.sessions[chatId]?.tools ?? [];
  const picks = selectMountedTools(saved, {
    connection: (connectionId) => (blocked.get(chatId)?.has(connectionId) ? null : findConnectionById(connectionId)),
    indexed: (connectionId, tool) => store.index[connectionId]?.tools.find((item) => item.name === tool),
  });
  return picks.map(({ split, entry, indexed }) => {
    const { schema } = toolInputSchema(indexed.inputSchema);
    const connectionId = entry.id;
    const connectionName = entry.name;
    const url = entry.url;
    const toolName = split.tool;
    return defineTool({
      name: mountedToolName(connectionId, toolName),
      // Built by the same function that charged it, so what was weighed is
      // what is sent. The server wrote every word of it, schema included, so
      // it is quoted rather than spoken.
      description: mountedDescription(indexed, connectionId, connectionName),
      inputSchema: schema,
      sequential: true,
      execute: (input: unknown, ctx: ToolCtx) => callPicked(ctx, { connectionId, connectionName, url, toolName }, input),
    });
  });
}

async function callPicked(
  ctx: ToolCtx,
  pick: { connectionId: string; connectionName: string; url: string; toolName: string },
  input: unknown,
): Promise<Record<string, unknown>> {
  const { connectionId, connectionName, url, toolName } = pick;
  markOutside(ctx);
  // Read the row again rather than trusting the registration: the owner can
  // change or disconnect a server between the pick and the call.
  const live = findConnectionById(connectionId);
  if (!live || live.url !== url) {
    return { status: "blocked", error: "connection_gone", connection: connectionId };
  }
  if (live.toolsAllow && !live.toolsAllow.includes(toolName)) {
    return { status: "blocked", error: "tool_not_allowed", connection: connectionId };
  }
  // Someone else's tool doing something on the owner's behalf is gated like a
  // connector call: this app runs it itself, so the card is this app's to show.
  //
  // The posture decides, and nothing the server named does. A Composio slug is
  // Composio's to write, so a read verb in one says something; an MCP server
  // names its own tools, so a `list_items` that deletes would have read as a
  // read. The name only labels the card.
  const permission = sessionPermission(ctx);
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
  // Bounded even when no card is shown: the record is written either way, and
  // a run-gated call with a megabyte of arguments would be rewritten into the
  // store on every later approval.
  const previewArgs = argsText.length > CARD_ARGS_MAX ? `${argsText.slice(0, CARD_ARGS_MAX)}…` : argsText;
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
    ...approvalActor(ctx),
    tool: "connection",
    actionSha256: hash,
    preview: `${flatLine(connectionName)} · ${toolName}${risk === "destructive" ? " (destructive)" : ""}`
      + (previewArgs === "{}" ? "" : `\n${previewArgs}`),
  });
  if (gate === "run") {
    approvals.decide(rec.id, "approve", hash);
  } else {
    if (await waitUntilNotPending(approvals, rec.id, ctx.abortSignal) === "aborted") return { status: "cancelled" };
    // A read-only switch while the card sat open refuses; a widened one is not
    // spent on this call.
    if (sessionPermission(ctx) !== permission) {
      return { status: "blocked", error: "permission_changed" };
    }
  }
  return executeIfApproved(approvals, rec.id, hash, async () => {
    // Read again after the wait: a card can sit open for minutes, and an owner
    // who repointed or narrowed the connection meanwhile must not have the
    // call go to the old endpoint with its credential.
    const current = findConnectionById(connectionId);
    if (!current || current.url !== url) {
      return { status: "blocked", error: "connection_gone", connection: connectionId };
    }
    if (current.toolsAllow && !current.toolsAllow.includes(toolName)) {
      return { status: "blocked", error: "tool_not_allowed", connection: connectionId };
    }
    let headers: Record<string, string> = {};
    // Stamped as the call begins: a refusal that comes back after the owner
    // reconnected is about the old credential, and the store keeps the newer answer.
    const callStamp = nextStamp();
    try {
      headers = await connectionHeaders(current);
      const raw = await callMcpTool(url, toolName, args, headers, AbortSignal.any([AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS), ctx.abortSignal]));
      const { text, cut: truncated } = clipUtf8(JSON.stringify(raw), RESULT_MAX_BYTES);
      return {
        status: "ok",
        tool: toolName,
        truncated,
        result: wrapUntrusted(`connection:${connectionId}/${toolName}`, text),
      };
    } catch (err) {
      // A Stop is not a failure to retry: the call may still have run.
      if (ctx.abortSignal.aborted) throw err;
      // The server refused the credential (revoked, rotated, or a token that
      // is still in date but no longer good): the owner's to renew too, and
      // recorded the same way, so the tool is not offered again as working.
      if (err instanceof McpError && err.kind === "auth") {
        try {
          markConnectionAuthFailed(connectionId, err.status, callStamp);
        } catch (writeErr) {
          console.warn(`[useful-bot] connection ${connectionId} refused credential could not be recorded: ${writeErr instanceof Error ? writeErr.message : "unknown"}`);
        }
        return {
          status: "blocked",
          error: "auth_failed",
          connection: connectionId,
          hint: `Ask the owner to reconnect ${flatLine(connectionName)} in Connectors.`,
        };
      }
      // A sign-in that ran out is the owner's to renew, and the bot can say so
      // rather than relay an opaque failure.
      if (err instanceof OAuthExpiredError) {
        // Said where the Connectors page and the next search read it too, not
        // only to this call: the tool is not offered again as working until
        // the owner signs in.
        try {
          markConnectionExpired(connectionId, callStamp);
        } catch (writeErr) {
          console.warn(`[useful-bot] connection ${connectionId} expired sign-in could not be recorded: ${writeErr instanceof Error ? writeErr.message : "unknown"}`);
        }
        return {
          status: "blocked",
          error: "oauth_expired",
          connection: connectionId,
          hint: `Ask the owner to reconnect ${flatLine(connectionName)} in Connectors.`,
        };
      }
      // The server's words, never the headers that reached it: a server can
      // echo the credential it was sent back in an error.
      let message = err instanceof Error ? err.message : "failed";
      // Each part of a value too, so `Bearer <token>` is caught when only the
      // token comes back.
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
}

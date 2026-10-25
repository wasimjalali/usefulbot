import { defineTool } from "../lib/tool.ts";
import { z } from "zod";
import { activateSessionTools } from "../../shared/connection-tools-store.ts";
import { findConnectionTools, onDemandConnections } from "../../shared/connection-tools.ts";
import { MAX_SESSION_TOOLS } from "../../shared/policy.ts";
import { flatLine, wrapUntrusted } from "../../shared/untrusted.ts";
import { markOutside } from "../lib/outside-content.ts";

/**
 * The way into a connected MCP server's tools. A server may publish two
 * hundred; three medium ones took a request past the router's tool cap, which
 * answers a non-retryable `unsupported_parameter`. So the tools wait here:
 * this searches their listings and records what it handed over, and the
 * engine registers those for the chat before the next model request
 * (agent/tools/picked.ts). The names stay `<connectionId>__<toolName>`, which
 * is what the macOS app parses to put a drawing on screen.
 */

const MAX_HITS = 8;

export default defineTool({
  name: "find_tools",
  description:
    "Find tools in the owner's connected MCP servers and make them callable. " +
    "Search by what you want to do, not by tool name. The tools it returns are " +
    "available on your next step, not in this one.",
  inputSchema: z.object({
    query: z.string().min(2).max(200)
      .describe("What you want to do, in a few words: \"send a slack message\"."),
  }),
  sequential: true,
  async execute(input, ctx) {
    markOutside(ctx);
    const connections = onDemandConnections();
    if (connections.length === 0) {
      return { status: "ok", found: 0, tools: [], note: "No MCP server is connected." };
    }
    const { hits, unavailable } = await findConnectionTools(input.query, MAX_HITS);
    // Said per server, so "found nothing" is never what a sign-in that ran out
    // or a server that is down looks like. What the healthy servers had still
    // comes back below.
    const down = unavailable.length
      ? { unavailable: unavailable.map((item) => ({ server: item.server, state: item.state, hint: item.hint })) }
      : {};
    if (hits.length === 0) {
      return {
        status: "ok",
        found: 0,
        tools: [],
        ...down,
        note: unavailable.length
          ? "No tool found, and some connected servers could not be searched."
          : "No connected server has a tool like that.",
      };
    }
    const outcome = activateSessionTools(
      ctx.chatId,
      hits.map((hit) => hit.name),
      undefined,
      // Every mounted description carries its connection's name, so the
      // charge has to carry it too, for what this chat already holds as well
      // as for what it is taking now.
      Object.fromEntries(connections.map((item) => [item.id, item.name])),
    );
    const held = outcome.tools.length;
    return {
      status: "ok",
      found: hits.length,
      ...down,
      // Named so the model can call them by name on its next step.
      tools: hits
        .filter((hit) => !outcome.refused.includes(hit.name))
        .map((hit) => ({
          name: hit.name,
          // Outside the fence, so kept to one line like the mounted
          // description keeps it.
          app: flatLine(hit.connectionName),
          // The server wrote this, so it is quoted rather than spoken: a
          // listing is a place to plant instructions.
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
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { toolRouterIds } from "../lib/router-identity.ts";

/** The router allows one search a second per caller, and says how long is left. */
const MAX_SEARCH_WAIT_MS = 2_500;
const SEARCH_ATTEMPTS = 3;

export default defineTool({
  description: "Search the public web via the local router. No search key is held here.",
  inputSchema: z.object({
    query: z.string().min(1).max(512),
    count: z.number().int().min(1).max(5).optional(),
  }),
  async execute(input, ctx) {
    const token = process.env.UB_ROUTER_DESKTOP_TOKEN;
    if (!token) {
      throw new Error("router token missing");
    }
    // The session keys the router's search gate, so this bot's search and
    // another bot's run side by side. The header is optional at the router:
    // with no session the call takes the per-caller slot, as it always did.
    const ids = toolRouterIds(ctx);
    let res: Response;
    for (let attempt = 1; ; attempt += 1) {
      res = await fetch("http://127.0.0.1:4319/v1/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(ids ? { "x-useful-session-id": ids.sessionId } : {}),
        },
        body: JSON.stringify({ query: input.query, count: input.count ?? 5 }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status !== 429 || attempt >= SEARCH_ATTEMPTS) break;
      // Only a wait the router named and that is short: two bots searching in
      // the same second. A spent daily search budget names no wait and fails.
      const body = await res.json().catch(() => null) as { error?: { retry_after_ms?: unknown } } | null;
      const wait = body?.error?.retry_after_ms;
      if (typeof wait !== "number" || !(wait >= 0) || wait > MAX_SEARCH_WAIT_MS) {
        throw new Error("search_failed:429");
      }
      await new Promise((resolve) => setTimeout(resolve, wait + 100 * attempt));
    }
    if (!res.ok) {
      throw new Error(`search_failed:${res.status}`);
    }
    // Titles, urls and snippets are outside text: serialise the payload and
    // mark it untrusted, the way connector_search does for app text.
    const json = await res.json();
    return wrapUntrusted("web search", JSON.stringify(json));
  },
});

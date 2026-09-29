import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolRouterIds } from "../lib/router-identity.ts";

// The router refuses /v1/chat/completions without the session, turn and request
// UUIDs, and gates one call per session: the session is the calling bot's, so
// two bots can ask for a review at the same time (agent/lib/router-identity.ts).

export default defineTool({
  description: "Ask the pinned reviewer to find defects in supplied text. Read-only. Not available to phone.",
  inputSchema: z.object({
    text: z.string().min(1).max(8000),
  }),
  async execute(input, ctx) {
    const token = process.env.UB_ROUTER_REVIEWER_TOKEN;
    if (!token) {
      // The S2 probe relies on the fixture; otherwise the model must never be
      // handed placeholder text shaped as a real answer.
      if (process.env.UB_S2_FIXTURE === "1") {
        return { text: "reviewer-offline", fixture: true };
      }
      return {
        status: "unavailable",
        error: "reviewer_unconfigured",
        hint: "The reviewer credential is not provisioned on this Mac.",
      };
    }
    // UB_ROUTER_BASE_URL is a base ending in /v1, the way agent.ts reads it;
    // the chat path is appended here rather than baked into the default.
    // No session means no bot to collide with, so a call-unique id is honest.
    const ids = toolRouterIds(ctx) ?? { sessionId: randomUUID(), turnId: randomUUID() };
    const base = process.env.UB_ROUTER_BASE_URL ?? "http://127.0.0.1:4319/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-useful-session-id": ids.sessionId,
        "x-useful-turn-id": ids.turnId,
        "x-useful-request-id": randomUUID(),
      },
      body: JSON.stringify({
        model: "reviewer",
        messages: [{ role: "user", content: input.text }],
        max_tokens: 1024,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`reviewer_failed:${res.status}`);
    }
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    return { text, fixture: false };
  },
});

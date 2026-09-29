import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";
import { POLICY_WINDOW_TOKENS } from "../../../shared/policy.ts";
import { routerFetch } from "../../lib/router-fetch.ts";
import { turnIdOf, type RouterIds } from "../../lib/router-identity.ts";
import { perSessionModel } from "../../lib/session-model.ts";

// One model handle per child eve session the review runs in: the router gates
// one model call per session, so a process-wide id made two bots' reviews one
// session and the second 409'd. See agent/lib/session-model.ts.
function reviewerModel(ids: () => RouterIds) {
  if (process.env.UB_S2_FIXTURE === "1") {
    const provider = createOpenAICompatible({
      name: "s2-fixture",
      baseURL: "http://s2.invalid/v1",
      apiKey: "s2-fixture",
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "rev",
            object: "chat.completion",
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "reviewer-offline" },
            }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    return provider.chatModel("s2-fixture");
  }
  // The desktop token's profile forbids the reviewer alias, so only the
  // reviewer credential works here. A missing one must not throw at module
  // load: eve evaluates every subagent at boot, and this Mac has no reviewer
  // credential yet, so a throw here took the whole agent down. The token is
  // read per call instead, the way agent/tools/review.ts reads it, so a
  // credential provisioned after boot is picked up and a missing one fails
  // the call, not the process.
  const provider = createOpenAICompatible({
    name: "useful-bot-router",
    baseURL: process.env.UB_ROUTER_BASE_URL ?? "http://127.0.0.1:4319/v1",
    apiKey: "reviewer-unconfigured",
    // The router refuses /v1/chat/completions without the x-useful-* UUIDs,
    // so every call carries the session and turn plus a fresh request id.
    fetch: routerFetch({
      ids,
      authorization: () => {
        const token = process.env.UB_ROUTER_REVIEWER_TOKEN;
        if (!token) {
          throw new Error("reviewer_unconfigured");
        }
        return `Bearer ${token}`;
      },
    }),
  });
  return provider.chatModel("reviewer");
}

const reviewerFor = perSessionModel(reviewerModel);

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => ({
        model: reviewerFor(ctx.session.id, turnIdOf(event)),
        modelContextWindowTokens: POLICY_WINDOW_TOKENS,
      }),
    },
  }),
  // eve refuses to boot if a subagent's description is empty.
  description: "Read-only defect finder over supplied text. No tools, no delegation.",
});

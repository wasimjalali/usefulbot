import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";
import { POLICY_WINDOW_TOKENS } from "../shared/policy.ts";
import { routerFetch } from "./lib/router-fetch.ts";
import { turnIdOf } from "./lib/router-identity.ts";
import { frozenTurnFor, perSessionModel } from "./lib/session-model.ts";
import { ensureTurnSnapshot, frozenSelection } from "./lib/turn-snapshot.ts";
import { routerApiBase } from "../shared/stack.ts";

const PLANTED = "S2-TOOL-PLANT-001";

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[], signal: AbortSignal | undefined, delayMs: number): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for (const chunk of chunks) {
          await sleep(delayMs, signal);
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function hasToolResult(messages: Array<{ role?: string }>): boolean {
  return messages.some((message) => message.role === "tool");
}

async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (process.env.UB_S2_FIXTURE !== "1") {
    throw new Error("fixture fetch invoked without UB_S2_FIXTURE=1");
  }
  const raw = init?.body;
  const body = raw ? JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8")) : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = body.stream === true;
  const signal = init?.signal ?? undefined;

  if (!hasToolResult(messages)) {
    const toolCall = {
      id: "s2cmpl_tool",
      object: stream ? "chat.completion.chunk" : "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          ...(stream
            ? {
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_plant",
                      type: "function",
                      function: { name: "plant_read", arguments: "{}" },
                    },
                  ],
                },
              }
            : {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_plant",
                      type: "function",
                      function: { name: "plant_read", arguments: "{}" },
                    },
                  ],
                },
              }),
        },
      ],
    };
    return stream ? sseResponse([JSON.stringify(toolCall)], signal, 0) : jsonResponse(toolCall);
  }

  if (stream) {
    const first = JSON.stringify({
      id: "s2cmpl_stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: PLANTED }, finish_reason: null }],
    });
    const last = JSON.stringify({
      id: "s2cmpl_stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    return sseResponse([first, last], signal, 250);
  }

  return jsonResponse({
    id: "s2cmpl_final",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: PLANTED },
      },
    ],
  });
}

function s2FixtureModel() {
  const provider = createOpenAICompatible({
    name: "s2-fixture",
    baseURL: "http://s2.invalid/v1",
    apiKey: "s2-fixture",
    fetch: fixtureFetch,
  });
  return provider.chatModel("s2-fixture");
}

// One model handle per eve session: see agent/lib/session-model.ts. The turn's
// selection is frozen at its first step and every request of the turn sends it
// (x-useful-selection), so a pick made mid-turn waits for the next turn.
const routerModel = perSessionModel((ids, selection) => {
  const token = process.env.UB_ROUTER_DESKTOP_TOKEN;
  if (!token) {
    throw new Error("UB_ROUTER_DESKTOP_TOKEN missing; S2 probe sets UB_S2_FIXTURE=1");
  }
  const provider = createOpenAICompatible({
    name: "useful-bot-router",
    baseURL: routerApiBase(),
    apiKey: token,
    fetch: routerFetch({ ids, selection }),
  });
  return provider.chatModel("workhorse");
}, 64, frozenSelection);

// Built once: the fixture never reaches the router, so it has no session.
const FIXTURE_MODEL = process.env.UB_S2_FIXTURE === "1" ? s2FixtureModel() : null;
if (!FIXTURE_MODEL && !process.env.UB_ROUTER_DESKTOP_TOKEN) {
  // Fail at boot, as the process-wide model did, rather than on the first turn.
  throw new Error("UB_ROUTER_DESKTOP_TOKEN missing; S2 probe sets UB_S2_FIXTURE=1");
}

export default defineAgent({
  // Compact at three quarters of the window rather than eve's 0.9. eve sizes
  // the history with a character estimate, and JSON tool results tokenize
  // heavier than that, so at 0.9 the summary call itself could overrun a
  // small window after the owner switched models mid-task.
  compaction: { thresholdPercent: 0.75 },
  // No per-session input cap. The router's daily budgets are the spend guard.
  // eve's 40M default counts cache reads, so a long-lived bot chat reaches it
  // in days, and the pause it raises stalls the chat. An uncapped parent also
  // delegates uncapped sub-agents.
  limits: { maxInputTokensPerSession: false },
  // Resolved at every step, but the selection and its window are frozen on the
  // first step of a turn (agent/lib/session-model.ts): the owner can pick a
  // different model for this bot while a turn runs, and that applies to the
  // next turn, never to the rest of this one. `step.started` is also the only
  // scope allowed to return a live LanguageModel rather than a gateway id.
  model: defineDynamic({
    events: {
      "step.started": async (event, ctx) => {
        if (FIXTURE_MODEL) return { model: FIXTURE_MODEL, modelContextWindowTokens: POLICY_WINDOW_TOKENS };
        const turnId = turnIdOf(event);
        // The backstop of the bot context. A throwing instruction resolver is
        // skipped silently, so the refusal lives here, where a throw fails the
        // turn. The snapshot is rebuilt when there is none (a process restart
        // mid-turn), and refused only when the session is unbound, the claim and
        // the binding name different bots, or the context resolver recorded a
        // failure for this turn.
        const snapshot = await ensureTurnSnapshot(ctx, turnId);
        if (!snapshot || snapshot.status !== "ok") {
          console.error(JSON.stringify({
            event: "bot_context_missing",
            count: 1,
            sessionId: ctx.session.id,
            turnId: turnId ?? null,
            reason: snapshot ? "context_failed" : "unbound_or_mismatch",
          }));
          throw new Error("bot_context_missing");
        }
        const model = routerModel(ctx.session.id, turnId);
        // The window is the frozen selection's, the one the handle sends.
        const frozen = frozenTurnFor(ctx.session.id);
        if (!frozen) throw new Error("bot_context_missing");
        return { model, modelContextWindowTokens: frozen.selection.windowTokens };
      },
    },
  }),
});

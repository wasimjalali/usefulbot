import assert from "node:assert/strict";
import test from "node:test";
import { AliasCircuit, UpstreamRefusalError, circuitKey } from "../router/src/circuit.ts";
import { RouterError } from "../router/src/errors.ts";
import { rewrapThinkHistory, stripEarlierReasoning } from "../router/src/inline-think.ts";
import { promptCacheKey, sessionHeader, upstreamConfigError } from "../router/src/upstreams/opencode.ts";
import { buildMessagesBody, safeToolId, translateMessagesJson } from "../router/src/upstreams/anthropic-messages.ts";
import { buildResponsesBody, translateResponsesJson } from "../router/src/upstreams/openai-responses.ts";
import { usageFromPayload } from "../shared/usage-parse.ts";

const protocolError = () => new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "x" });
const rateLimited = (ms: number) => new RouterError({ status: 429, type: "rate_limit_error", code: "upstream_rate_limited", message: "x", retryAfterMs: ms });
const A = circuitKey("workhorse", "conn-a", "model-a");
const B = circuitKey("workhorse", "conn-a", "model-b");
const C = circuitKey("workhorse", "conn-b", "model-a");

test("a rate limit pauses only its own upstream", () => {
  const circuit = new AliasCircuit();
  circuit.recordFailure(A, rateLimited(60_000), 1000);
  assert.throws(() => circuit.assertClosed(A, 2000), (e: RouterError) => e.code === "upstream_rate_limited");
  circuit.assertClosed(B, 2000);
  circuit.assertClosed(C, 2000);
});

test("a missing model pauses only that model, and switching away is not blocked", () => {
  const circuit = new AliasCircuit();
  circuit.recordFailure(A, new RouterError({ status: 502, type: "upstream_error", code: "model_unavailable", message: "x" }), 1000);
  assert.throws(() => circuit.assertClosed(A, 2000), (e: RouterError) => e.code === "circuit_open");
  circuit.assertClosed(B, 2000);
});

test("three protocol errors open one upstream only", () => {
  const circuit = new AliasCircuit();
  for (let i = 0; i < 3; i += 1) circuit.recordFailure(A, protocolError(), 1000 + i);
  assert.throws(() => circuit.assertClosed(A, 2000), (e: RouterError) => e.code === "circuit_open");
  circuit.assertClosed(B, 2000);
  circuit.assertClosed(C, 2000);
});

test("provider 4xx refusals never count toward the failure circuit", () => {
  const circuit = new AliasCircuit();
  const refusal = () => new UpstreamRefusalError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "x" });
  for (let i = 0; i < 10; i += 1) circuit.recordFailure(A, refusal(), 1000 + i);
  circuit.assertClosed(A, 2000);
  // They also do not reset the real failures that came before.
  circuit.recordFailure(A, protocolError(), 3000);
  circuit.recordFailure(A, protocolError(), 3001);
  circuit.recordFailure(A, refusal(), 3002);
  circuit.assertClosed(A, 3003);
  circuit.recordFailure(A, protocolError(), 3004);
  assert.throws(() => circuit.assertClosed(A, 3005), (e: RouterError) => e.code === "circuit_open");
});

test("a success on one upstream does not clear another's pause", () => {
  const circuit = new AliasCircuit();
  circuit.recordFailure(A, rateLimited(60_000), 1000);
  circuit.recordSuccess(B);
  assert.throws(() => circuit.assertClosed(A, 2000));
});

test("disable() is alias wide: every model of the alias, not another alias", () => {
  const circuit = new AliasCircuit();
  circuit.disable("workhorse");
  for (const key of [A, B, C]) assert.throws(() => circuit.assertClosed(key, 1), (e: RouterError) => e.code === "circuit_disabled");
  circuit.assertClosed(circuitKey("reviewer", "conn-a", "model-a"), 1);
});

const MIXED_HISTORY = [
  { role: "system", content: "sys" },
  { role: "user", content: "first question" },
  { role: "assistant", content: "old answer", reasoning_content: "written by model X" },
  { role: "user", content: "second question" },
  { role: "assistant", content: null, reasoning_content: "current turn thinking", tool_calls: [{ id: "call.1:abc", type: "function", function: { name: "t", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call.1:abc", content: "result" },
];

test("earlier-turn reasoning is stripped, the current turn keeps its own", () => {
  const out = stripEarlierReasoning(MIXED_HISTORY) as Array<Record<string, unknown>>;
  assert.equal("reasoning_content" in out[2], false);
  assert.equal(out[2].content, "old answer");
  assert.equal(out[4].reasoning_content, "current turn thinking");
  // The input is not changed.
  assert.equal((MIXED_HISTORY[2] as Record<string, unknown>).reasoning_content, "written by model X");
});

test("the inline-think rewrap uses the same boundary", () => {
  const out = rewrapThinkHistory(MIXED_HISTORY) as Array<Record<string, unknown>>;
  assert.equal(out[2].content, "old answer");
  assert.equal("reasoning_content" in out[2], false);
  assert.equal(out[4].content, "<think>current turn thinking</think>");
  assert.equal("reasoning_content" in out[4], false);
});

test("reasoning parts in an earlier assistant array are dropped too", () => {
  const out = stripEarlierReasoning([
    { role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "text", text: "t" }] },
    { role: "user", content: "next" },
  ]) as Array<{ content: unknown[] }>;
  assert.deepEqual(out[0].content, [{ type: "text", text: "t" }]);
});

test("anthropic: unsafe tool ids map deterministically, same for call and result", () => {
  assert.equal(safeToolId("toolu_01-ok_X"), "toolu_01-ok_X");
  const mapped = safeToolId("call.1:abc");
  assert.match(mapped, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(safeToolId("call.1:abc"), mapped);
  assert.notEqual(safeToolId("call.2:abc"), mapped);
  assert.match(safeToolId("x".repeat(200)), /^[a-zA-Z0-9_-]{1,64}$/);
  const body = buildMessagesBody({ messages: MIXED_HISTORY, max_tokens: 100 }, { model: "claude" });
  const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
  const use = (messages[3].content as Array<Record<string, unknown>>).find((part) => part.type === "tool_use");
  const result = (messages[4].content as Array<Record<string, unknown>>).find((part) => part.type === "tool_result");
  assert.equal(use?.id, mapped);
  assert.equal(result?.tool_use_id, mapped);
});

test("anthropic: empty assistant messages are dropped", () => {
  const body = buildMessagesBody({
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "  ", tool_calls: [] },
      { role: "user", content: "b" },
    ],
    max_tokens: 100,
  }, { model: "claude" });
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.map((m) => m.role), ["user"]);
  assert.equal((messages[0].content as unknown[]).length, 2);
});

test("anthropic: cache_control only when asked", () => {
  const chat = { messages: [{ role: "user", content: "a" }], max_tokens: 10 };
  assert.deepEqual(buildMessagesBody(chat, { model: "m", cache: true }).cache_control, { type: "ephemeral" });
  assert.equal("cache_control" in buildMessagesBody(chat, { model: "m" }), false);
});

test("usage: all three provider shapes report cached tokens", () => {
  assert.deepEqual(usageFromPayload({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }),
    { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 });
  assert.deepEqual(usageFromPayload({ usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 64 } } }),
    { inputTokens: 100, outputTokens: 5, cachedInputTokens: 64 });
  // Anthropic: input_tokens excludes the cache, so the budget input adds it back.
  assert.deepEqual(usageFromPayload({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 } }),
    { inputTokens: 100, outputTokens: 5, cachedInputTokens: 70, cacheWriteTokens: 20 });
  assert.deepEqual(usageFromPayload({ usage: { prompt_tokens: 3, completion_tokens: 2 } }), { inputTokens: 3, outputTokens: 2 });
});

test("usage: adapters hand the router a prompt count that includes the cache", () => {
  const anthropic = translateMessagesJson({
    id: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 },
  }, "claude");
  assert.deepEqual(usageFromPayload(anthropic), { inputTokens: 100, outputTokens: 5, cachedInputTokens: 70, cacheWriteTokens: 20 });
  const responses = translateResponsesJson({
    id: "r", output: [], usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 64 } },
  }, "gpt");
  assert.deepEqual(usageFromPayload(responses), { inputTokens: 100, outputTokens: 5, cachedInputTokens: 64 });
});

test("cache keys: per caller, session, connection and model; opaque", () => {
  const key = promptCacheKey("caller", "sess", "conn", "gpt-x");
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key, promptCacheKey("caller", "sess", "conn", "gpt-x"));
  assert.notEqual(key, promptCacheKey("caller", "sess", "conn", "gpt-y"));
  assert.notEqual(key, promptCacheKey("caller", "sess", "conn2", "gpt-x"));
  assert.notEqual(key, promptCacheKey("caller", "sess2", "conn", "gpt-x"));
  assert.equal(buildResponsesBody({ messages: [{ role: "user", content: "a" }], prompt_cache_key: key }, { model: "m", chatgpt: false }).prompt_cache_key, key);
  assert.equal("prompt_cache_key" in buildResponsesBody({ messages: [{ role: "user", content: "a" }] }, { model: "m", chatgpt: false }), false);
});

test("opencode session header is scoped by connection and model", () => {
  const base = sessionHeader("c", "s", "root");
  assert.equal(base, sessionHeader("c", "s", "root"));
  assert.notEqual(base, sessionHeader("c", "s", "root", "conn:model-a"));
  assert.notEqual(sessionHeader("c", "s", "root", "conn:model-a"), sessionHeader("c", "s", "root", "conn:model-b"));
});

test("a vanished selection is a 4xx the circuit never counts", () => {
  const error = upstreamConfigError(Object.assign(new Error("model_selection_unavailable"), { code: "model_selection_unavailable" }));
  assert.equal(error.code, "model_selection_unavailable");
  assert.equal(error.status, 422);
  assert.equal(upstreamConfigError(new Error("model_selection_unavailable")).status, 422);
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { usageFromSseBlock } from "../shared/usage-parse.ts";
import { createThinkStream, splitThinkBlock } from "../router/src/inline-think.ts";
import { settleStreamBlock } from "../router/src/tool-finish.ts";
import { completeUpstream, type ResolvedUpstream } from "../router/src/upstreams/opencode.ts";
import type { RegistryEntry } from "../router/src/registry.ts";

// Isolated stores: completeUpstream reads the model catalog and notes connection state.
const dir = mkdtempSync(join(tmpdir(), "ub-local-usage-"));
process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");

const entry = { maxOutputTokens: 1024 } as unknown as RegistryEntry;

function resolvedFor(providerId: string, connectionId: string, protocol = "openai-chat"): ResolvedUpstream {
  return {
    providerId,
    connection: { id: connectionId, providerId },
    mode: { headers: {} },
    protocol,
    baseUrl: "http://upstream.test/v1",
    keyHeader: "authorization",
    opencodeSession: false,
    credential: { kind: "key", key: "k-test" },
    model: "m-1",
    modelId: "m-1",
    effort: null,
    speed: "standard",
    fallback: false,
  } as unknown as ResolvedUpstream;
}

type Sent = Record<string, unknown>;

/** Stubs global fetch; `answer` gets the 1-based call number and the parsed body. */
async function run(
  resolved: ResolvedUpstream,
  body: Record<string, unknown>,
  answer: (call: number, sent: Sent) => Response,
): Promise<{ sent: Sent[]; status: number; refused: number; thrown: unknown; text: string }> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  let refused = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as Sent;
    sent.push(parsed);
    return answer(sent.length, parsed);
  }) as typeof fetch;
  try {
    const result = await completeUpstream({
      entry,
      body,
      sessionId: "s",
      callerId: "c",
      signal: new AbortController().signal,
      resolved,
      onRefusedAttempt: () => { refused += 1; },
    });
    return { sent, status: result.response.status, refused, thrown: null, text: await result.response.text() };
  } catch (error) {
    return { sent, status: 0, refused, thrown: error, text: "" };
  } finally {
    globalThis.fetch = original;
  }
}

const streamed = { messages: [{ role: "user", content: "hi" }], stream: true };
const plain = { messages: [{ role: "user", content: "hi" }] };

const noUsageStream = () => new Response('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
const ok = () => new Response("{}", { status: 200 });

test("lmstudio streamed: include_usage is asked for", async () => {
  const r = await run(resolvedFor("lmstudio", "lmstudio:t1"), streamed, ok);
  assert.deepEqual(r.sent[0].stream_options, { include_usage: true });
});

test("custom streamed: include_usage is asked for", async () => {
  const r = await run(resolvedFor("custom", "custom:t2"), streamed, ok);
  assert.deepEqual(r.sent[0].stream_options, { include_usage: true });
});

test("lmstudio non-streamed: no stream_options", async () => {
  const r = await run(resolvedFor("lmstudio", "lmstudio:t3"), plain, ok);
  assert.equal("stream_options" in r.sent[0], false);
  const off = await run(resolvedFor("lmstudio", "lmstudio:t3"), { ...plain, stream: false }, ok);
  assert.equal("stream_options" in off.sent[0], false);
});

test("another openai-chat provider streamed: no stream_options added", async () => {
  for (const id of ["ollama", "openrouter"]) {
    const r = await run(resolvedFor(id, `${id}:t4`), streamed, ok);
    assert.equal("stream_options" in r.sent[0], false, id);
  }
});

test("a caller's own stream_options is kept and merged", async () => {
  const r = await run(resolvedFor("lmstudio", "lmstudio:t5"), { ...streamed, stream_options: { include_usage: false, extra: 1 } }, ok);
  assert.deepEqual(r.sent[0].stream_options, { include_usage: true, extra: 1 });
});

test("an upstream that ignores the field streams on with no usage, no crash", async () => {
  const r = await run(resolvedFor("custom", "custom:t6"), streamed, noUsageStream);
  assert.equal(r.status, 200);
  assert.equal(r.sent.length, 1);
  const blocks = r.text.split("\n\n");
  assert.equal(blocks.map((block) => usageFromSseBlock(block)).find((u) => u !== null) ?? null, null);
});

test("an openai-chat final chunk with choices [] and usage is read as usage", () => {
  const usage = usageFromSseBlock('data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168}}');
  assert.equal(usage?.inputTokens, 123);
  assert.equal(usage?.outputTokens, 45);
});

test("custom 400 naming stream_options: one retry without it, then later requests skip it", async () => {
  const resolved = resolvedFor("custom", "custom:t7");
  const refuse = (call: number, sent: Sent) =>
    "stream_options" in sent
      ? new Response(JSON.stringify({ error: { message: "Unknown field: stream_options" } }), { status: 400 })
      : ok();
  const first = await run(resolved, streamed, refuse);
  assert.equal(first.status, 200);
  assert.equal(first.sent.length, 2);
  assert.equal("stream_options" in first.sent[0], true);
  assert.equal("stream_options" in first.sent[1], false);
  assert.equal(first.refused, 1);
  const second = await run(resolved, streamed, refuse);
  assert.equal(second.status, 200);
  assert.equal(second.sent.length, 1);
  assert.equal("stream_options" in second.sent[0], false);
  // Another model on the same connection still asks.
  const other = await run({ ...resolved, model: "m-2" } as ResolvedUpstream, streamed, refuse);
  assert.equal("stream_options" in other.sent[0], true);
});

test("a retry that is refused again does not loop", async () => {
  const r = await run(resolvedFor("custom", "custom:t8"), streamed, () =>
    new Response("bad stream_options", { status: 400 }));
  assert.equal(r.sent.length, 2);
  assert.ok(r.thrown);
  // A retry that failed too proves nothing about the field: the next request still asks.
  const next = await run(resolvedFor("custom", "custom:t8"), streamed, ok);
  assert.equal("stream_options" in next.sent[0], true);
});

test("a 422 naming stream_options is retried without it too", async () => {
  const resolved = resolvedFor("custom", "custom:t10");
  const refuse = (_call: number, sent: Sent) =>
    "stream_options" in sent
      ? new Response(JSON.stringify({ detail: [{ loc: ["body", "stream_options"], msg: "extra fields not permitted" }] }), { status: 422 })
      : ok();
  const r = await run(resolved, streamed, refuse);
  assert.equal(r.status, 200);
  assert.equal(r.sent.length, 2);
  assert.equal("stream_options" in r.sent[1], false);
});

test("the relay passes a final usage chunk with choices [] through unchanged", () => {
  const block = 'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}';
  const settled = settleStreamBlock(block, { toolCall: false });
  assert.equal(settled, block);
  assert.equal(splitThinkBlock(settled, createThinkStream()), block);
  assert.equal(usageFromSseBlock(settled)?.inputTokens, 10);
});

test("a 400 that does not mention stream_options is not retried", async () => {
  const resolved = resolvedFor("custom", "custom:t9");
  const r = await run(resolved, streamed, () => new Response(JSON.stringify({ error: { message: "context too long" } }), { status: 400 }));
  assert.equal(r.sent.length, 1);
  assert.equal(r.refused, 0);
  assert.ok(r.thrown);
  // Nothing was remembered: the next request still asks.
  const next = await run(resolved, streamed, ok);
  assert.equal("stream_options" in next.sent[0], true);
});

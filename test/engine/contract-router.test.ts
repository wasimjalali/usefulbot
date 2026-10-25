import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stableUuid } from "../../agent/lib/router-identity.ts";
import { decodeSelectionHeader } from "./selection.ts";
import { CONNECTION, MODEL, makeWorld } from "./helpers.ts";
import { startRealRouter } from "./real-router.ts";

/**
 * Contract tests 2 to 5 (SPEC 14), against a scripted router: every attempt
 * stamps its own request id, Pi's request passes the router's own validation,
 * a length stop after a tool call leaves no orphan, and compaction keeps tool
 * calls with their results and never trips the one-call-per-session gate.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("contract 2: every HTTP attempt carries a fresh request id, the chat's session id and the turn's selection", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    // Two 503s that Pi retries as whole requests, then a 429 the router fetch waits out itself, then success.
    world.router.enqueue(
      { kind: "error", status: 503, code: "upstream_unavailable" },
      { kind: "error", status: 503, code: "upstream_unavailable" },
      { kind: "error", status: 429, code: "global_concurrency_limit", retryAfterMs: 10 },
      { kind: "text", text: "finally" },
    );
    const sent = world.send(chatId, "hello");
    await world.idle(chatId);
    const requests = world.router.requests;
    assert.equal(requests.length, 4);
    const requestIds = requests.map((request) => request.headers["x-useful-request-id"]);
    assert.equal(new Set(requestIds).size, 4, "a fresh request id each attempt");
    for (const id of requestIds) assert.match(id, UUID);
    assert.equal(new Set(requests.map((request) => request.headers["x-useful-session-id"])).size, 1);
    assert.equal(requests[0].headers["x-useful-session-id"], stableUuid(`session:${chatId}`));
    assert.equal(new Set(requests.map((request) => request.headers["x-useful-turn-id"])).size, 1);
    assert.equal(requests[0].headers["x-useful-turn-id"], stableUuid(`turn:${chatId}:${sent.turnId}`));
    const selection = decodeSelectionHeader(requests[0].headers["x-useful-selection"]);
    assert.equal(selection.connectionId, "opencode-go:plan");
    assert.equal(selection.modelId, "glm-5.3-flash");
    for (const request of requests) {
      assert.equal(request.body.model, "workhorse", "the alias the router resolves the selection for");
      assert.equal(request.headers.authorization, "Bearer test-router-token");
    }
    assert.equal(world.engine.rows(chatId, {}).rows.at(-1)?.kind, "assistant");
  } finally {
    await world.close();
  }
});

test("contract 3: Pi's request passes the real router's validation, tool round trip included", async () => {
  const upstream = await makeWorld();
  const router = await startRealRouter(upstream.router.baseUrl);
  try {
    const { makeWorld: again } = await import("./helpers.ts");
    // The engine under test talks to the real router; the first world's fake router is its upstream.
    const world = await again({
      router: upstream.router,
      engine: { routerBaseUrl: router.baseUrl, routerToken: () => router.token },
    });
    try {
      const chatId = world.newChat();
      upstream.router.enqueue(
        { kind: "tools", calls: [{ name: "echo", args: { text: "x" } }] },
        { kind: "text", text: "through the router" },
      );
      world.send(chatId, "round trip");
      await world.idle(chatId);
      const rows = world.engine.rows(chatId, {}).rows;
      assert.equal(rows.at(-1)?.kind, "assistant", "the turn completed through the real router");
      assert.equal((rows.at(-1) as { text: string }).text, "through the router");
      assert.equal(upstream.router.requests.length, 2, "both model calls reached the upstream");
      const forwarded = upstream.router.requests[1].body;
      assert.ok(Array.isArray(forwarded.messages));
      assert.ok(!("store" in forwarded) && !("prompt_cache_key" in forwarded), "nothing the compat flags turn off went upstream");
    } finally {
      await world.close();
    }
  } finally {
    await router.close();
    await upstream.close();
  }
});

test("contract 4: a length stop after a tool call does not orphan a tool result", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue(
      { kind: "tools", calls: [{ name: "echo", args: { text: "one" } }] },
      { kind: "length", partialCall: { name: "echo", argsPrefix: '{"text": "abc' } },
      { kind: "text", text: "recovered" },
    );
    world.send(chatId, "do it");
    await world.idle(chatId);
    assert.deepEqual(world.router.refused, [], "the router refused no request");
    const last = world.router.requests.at(-1);
    assert.ok(last);
    assert.equal((world.engine.rows(chatId, {}).rows.at(-1) as { text?: string }).text, "recovered");
    // The next owner message after the length stop is accepted too.
    world.router.enqueue({ kind: "text", text: "and again" });
    world.send(chatId, "once more");
    await world.idle(chatId);
    assert.deepEqual(world.router.refused, []);
  } finally {
    await world.close();
  }
});

test("contract 5: compaction keeps every tool call with its result and the summary shares the chat's router session", async () => {
  const world = await makeWorld({ window: 20_000 });
  try {
    const chatId = world.newChat();
    const filler = "lorem ipsum ".repeat(1200);
    world.router.fallback((request) => {
      const text = JSON.stringify(request.body.messages);
      if (text.includes("<conversation>")) return { kind: "text", text: "SUMMARY OF EARLIER WORK", usage: { prompt_tokens: 900, completion_tokens: 30 } };
      // Enough reported usage to cross the compaction threshold (window minus reserve).
      return { kind: "text", text: `answer ${request.n}`, usage: { prompt_tokens: 16_500, completion_tokens: 20 } };
    });
    for (let i = 0; i < 3; i += 1) {
      world.router.enqueue({ kind: "tools", calls: [{ name: "echo", args: { text: `step ${i}` } }], usage: { prompt_tokens: 3_000, completion_tokens: 10 } });
      world.send(chatId, `message ${i} ${filler}`);
      await world.idle(chatId);
    }
    assert.deepEqual(world.router.refused, [], "no request broke the pairing rules or hit a busy session");
    const summaries = world.router.requests.filter((request) => JSON.stringify(request.body.messages).includes("<conversation>"));
    assert.ok(summaries.length >= 1, "compaction ran");
    const sessionIds = new Set(world.router.requests.map((request) => request.headers["x-useful-session-id"]));
    assert.equal(sessionIds.size, 1, "the summary call used the chat's router session");
    assert.ok(world.engine.rows(chatId, {}).rows.some((row) => row.kind === "note" && row.source === "compaction"));
  } finally {
    await world.close();
  }
});

test("review 1: model facts follow the catalog: a changed window or vision flag re-registers the model", async () => {
  const world = await makeWorld({ window: 100_000 });
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "one" }, { kind: "text", text: "two" });
    world.send(chatId, "first");
    await world.idle(chatId);
    const selection = { connectionId: CONNECTION, modelId: MODEL, effort: null, speed: "standard" as const };
    const provider = world.engine.host.provider;
    const before = provider.modelFor(selection);
    assert.equal(before.contextWindow, 100_000);
    assert.equal(provider.modelFor(selection), before, "unchanged facts keep the same model");

    // The owner refreshed the model list: the window shrank and the model lost vision.
    writeFileSync(join(world.root, "models-cache.json"), JSON.stringify({
      schemaVersion: 3,
      providers: { [CONNECTION]: { fetchedAt: Date.now(), models: [{ id: MODEL, label: MODEL, efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens: 40_000, inputs: ["text"] }] } },
    }));
    const after = provider.modelFor(selection);
    assert.notEqual(after, before);
    assert.equal(after.contextWindow, 40_000);
    assert.deepEqual(after.input, ["text"]);
    assert.equal(after.maxTokens, 4_000);

    // The next turn builds its session on the new facts.
    world.send(chatId, "second");
    await world.idle(chatId);
    assert.equal(world.engine.host.chat(chatId).live?.model, after);
  } finally {
    await world.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { forgetRouterError, lastRouterError, routerFetch, MAX_PROVIDER_TOTAL_WAIT_MS, MAX_TOTAL_WAIT_MS } from "../agent/lib/router-fetch.ts";
import { routerIds, stableUuid, toolRouterIds } from "../agent/lib/router-identity.ts";

// The router's own pattern (router/src/index.ts): a call that fails it is a 400.
const ROUTER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("a chat id becomes a stable uuid the router accepts, distinct per chat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const id = stableUuid(`session:chat_${i}`);
    assert.match(id, ROUTER_UUID);
    seen.add(id);
  }
  assert.equal(seen.size, 500);
  assert.equal(stableUuid("session:a"), stableUuid("session:a"));
});

test("ids derive from the chat and the turn unless the env pins them", () => {
  const free = routerIds("chat_a", "turn_1", {});
  assert.equal(free.sessionId, stableUuid("session:chat_a"));
  assert.notEqual(free.turnId, routerIds("chat_a", "turn_2", {}).turnId);
  // The same turn id in two chats is two turns.
  assert.notEqual(free.turnId, routerIds("chat_b", "turn_1", {}).turnId);
  assert.notEqual(free.sessionId, free.turnId);
  // No turn in hand: still a valid uuid.
  assert.match(routerIds("chat_a", undefined, {}).turnId, ROUTER_UUID);

  const pinned = routerIds("chat_a", "turn_1", {
    UB_SESSION_ID: "11111111-1111-4111-8111-111111111111",
    UB_TURN_ID: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(pinned.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(pinned.turnId, "22222222-2222-4222-8222-222222222222");
});

test("a tool with no session gets no ids, never a shared constant", () => {
  assert.equal(toolRouterIds(undefined), null);
  assert.equal(toolRouterIds({}), null);
  assert.equal(toolRouterIds({ session: { id: "" } }), null);
  const saved = { s: process.env.UB_SESSION_ID, t: process.env.UB_TURN_ID };
  delete process.env.UB_SESSION_ID;
  delete process.env.UB_TURN_ID;
  try {
    const a = toolRouterIds({ session: { id: "chat_a", turn: { id: "turn_1" } } });
    // The tool and the model call of one turn are the same router session and turn.
    assert.deepEqual(a, routerIds("chat_a", "turn_1", {}));
    assert.notEqual(a?.sessionId, toolRouterIds({ session: { id: "chat_b" } })?.sessionId);
  } finally {
    if (saved.s !== undefined) process.env.UB_SESSION_ID = saved.s;
    if (saved.t !== undefined) process.env.UB_TURN_ID = saved.t;
  }
});

function refusal(code: string, retryAfterMs?: number): Response {
  return new Response(
    JSON.stringify({ error: { code, retryable: true, ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}) } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

let harnessTurn = 0;

function harness(responses: Array<() => Response>) {
  const requests: Headers[] = [];
  const sleeps: number[] = [];
  harnessTurn += 1;
  const turnId = `turn-${harnessTurn}`;
  const doFetch = routerFetch({
    ids: () => ({ sessionId: "s", turnId }),
    fetch: async (_input, init) => {
      requests.push(new Headers(init?.headers));
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next();
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
  });
  return { doFetch, requests, sleeps, turnId };
}

test("a model call waits out the concurrency ceiling, with a fresh request id each attempt", async () => {
  const h = harness([
    () => refusal("global_concurrency_limit", 2000),
    () => refusal("global_concurrency_limit", 2000),
    () => new Response("{}", { status: 200 }),
  ]);
  const res = await h.doFetch("http://router/v1/chat/completions", { method: "POST", headers: { "x-keep": "1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(h.sleeps, [2000, 2000]);
  assert.equal(h.requests.length, 3);
  assert.equal(new Set(h.requests.map((r) => r.get("x-useful-request-id"))).size, 3);
  for (const r of h.requests) {
    assert.equal(r.get("x-useful-session-id"), "s");
    assert.equal(r.get("x-useful-turn-id"), h.turnId);
    assert.equal(r.get("x-keep"), "1");
  }
});

test("a spent budget, a busy session and a foreign 429 are handed straight back", async () => {
  for (const make of [
    () => refusal("global_budget_exhausted"),
    () => refusal("caller_budget_exhausted"),
    () => new Response(JSON.stringify({ error: { code: "session_busy" } }), { status: 409 }),
    () => new Response("slow down", { status: 429 }),
  ]) {
    const h = harness([make]);
    const res = await h.doFetch("http://router/x");
    assert.equal(res.status >= 400, true);
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.requests.length, 1);
    // The body is still there for the caller to read.
    await res.text();
  }
});

test("the wait is bounded: a long hint fails at once, and the total is capped", async () => {
  const long = harness([() => refusal("caller_rate_limit", 55_000)]);
  assert.equal((await long.doFetch("http://router/x")).status, 429);
  assert.deepEqual(long.sleeps, []);

  const forever = harness(Array.from({ length: 50 }, () => () => refusal("caller_rate_limit", 9_000)));
  assert.equal((await forever.doFetch("http://router/x")).status, 429);
  const total = forever.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.equal(total <= MAX_TOTAL_WAIT_MS, true);
  assert.equal(forever.sleeps.length, 6);
});

test("a provider rate limit pauses the call for its retry-after instead of failing the turn", async () => {
  const h = harness([
    () => refusal("upstream_rate_limited", 60_000),
    () => refusal("upstream_rate_limited", 45_000),
    () => new Response("{}", { status: 200 }),
  ]);
  assert.equal((await h.doFetch("http://router/x")).status, 200);
  assert.deepEqual(h.sleeps, [60_000, 45_000]);

  // Bounded all the same: past the provider allowance the 429 goes back.
  const forever = harness(Array.from({ length: 20 }, () => () => refusal("upstream_rate_limited", 60_000)));
  assert.equal((await forever.doFetch("http://router/x")).status, 429);
  assert.equal(forever.sleeps.reduce((sum, ms) => sum + ms, 0) <= MAX_PROVIDER_TOTAL_WAIT_MS, true);
  assert.equal(forever.sleeps.length, 3);

  // A pause longer than one slice is waited a slice at a time.
  const long = harness([
    () => refusal("upstream_rate_limited", 120_000),
    () => refusal("upstream_rate_limited", 30_000),
    () => new Response("{}", { status: 200 }),
  ]);
  assert.equal((await long.doFetch("http://router/x")).status, 200);
  assert.deepEqual(long.sleeps, [90_000, 30_000]);

  // One longer than the whole allowance goes back at once.
  const hours = harness([() => refusal("upstream_rate_limited", 3_600_000)]);
  assert.equal((await hours.doFetch("http://router/x")).status, 429);
  assert.deepEqual(hours.sleeps, []);

  // A used-up plan is not a wait.
  const used = harness([() => new Response(JSON.stringify({ error: { code: "upstream_usage_limit", retryable: false } }), { status: 402 })]);
  assert.equal((await used.doFetch("http://router/x")).status, 402);
  assert.deepEqual(used.sleeps, []);
});

test("with no hint the wait backs off, and an abort during it ends the call", async () => {
  const h = harness([
    () => refusal("global_concurrency_limit"),
    () => refusal("global_concurrency_limit"),
    () => refusal("global_concurrency_limit"),
    () => new Response("{}", { status: 200 }),
  ]);
  await h.doFetch("http://router/x");
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);

  const controller = new AbortController();
  const real = routerFetch({
    ids: () => ({ sessionId: "s", turnId: "t" }),
    fetch: async () => refusal("global_concurrency_limit", 5_000),
  });
  const pending = real("http://router/x", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stopped")), 20);
  await assert.rejects(pending, /stopped/);
});

test("the router's last error for a turn is kept for turn.failed, and forgotten on success", async () => {
  const body = (error: Record<string, unknown>, status: number, headers: Record<string, string> = {}) =>
    () => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });

  const unavailable = harness([body({ code: "upstream_unavailable", message: "The provider didn't answer.", retry_after_ms: 4000 }, 503)]);
  await unavailable.doFetch("http://router/x");
  assert.deepEqual(lastRouterError(unavailable.turnId), {
    status: 503,
    code: "upstream_unavailable",
    message: "The provider didn't answer.",
    retryAfterMs: 4000,
    resetsAt: null,
  });

  // A used-up plan carries its reset time in the message.
  const used = harness([body({ code: "upstream_usage_limit", message: "Plan used up. resets_at=1792944000" }, 402)]);
  await used.doFetch("http://router/x");
  assert.equal(lastRouterError(used.turnId)?.resetsAt, new Date(1792944000 * 1000).toISOString());
  assert.equal(lastRouterError(used.turnId)?.code, "upstream_usage_limit");

  // The Retry-After header stands in for a body without a hint.
  const header = harness([body({ code: "upstream_unavailable" }, 503, { "retry-after": "7" })]);
  await header.doFetch("http://router/x");
  assert.equal(lastRouterError(header.turnId)?.retryAfterMs, 7000);

  // A body that is not the router's shape still records the status.
  const plain = harness([() => new Response("bad gateway", { status: 502 })]);
  await plain.doFetch("http://router/x");
  assert.deepEqual(lastRouterError(plain.turnId), { status: 502, code: null, message: null, retryAfterMs: null, resetsAt: null });

  // A waited-out 429 that clears leaves nothing behind; a later success forgets an earlier error.
  const waited = harness([() => refusal("global_concurrency_limit", 10), () => new Response("{}", { status: 200 })]);
  await waited.doFetch("http://router/x");
  assert.equal(lastRouterError(waited.turnId), null);
  const recovered = harness([body({ code: "upstream_unavailable" }, 503), () => new Response("{}", { status: 200 })]);
  await recovered.doFetch("http://router/x");
  assert.equal(lastRouterError(recovered.turnId)?.code, "upstream_unavailable");
  await recovered.doFetch("http://router/x");
  assert.equal(lastRouterError(recovered.turnId), null);

  // A 429 handed back after the wait budget keeps its code.
  const exhausted = harness([() => refusal("global_budget_exhausted")]);
  await exhausted.doFetch("http://router/x");
  assert.equal(lastRouterError(exhausted.turnId)?.code, "global_budget_exhausted");
  forgetRouterError(exhausted.turnId);
  assert.equal(lastRouterError(exhausted.turnId), null);
});

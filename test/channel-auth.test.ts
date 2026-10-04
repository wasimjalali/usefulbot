import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { channelAuth } from "../agent/lib/channel-auth.ts";
import { authorizeChildCancel, authorizeChildStream, authorizeEveCall, carryOverReader, childWriteRefusal, readStreamEventAt, type ChildStreamDeps } from "../web/lib/eve-session-auth.ts";
import { CHILD_AT_MAX } from "../shared/eve-proxy.ts";
import { channelJwt } from "../web/lib/agent-exec.ts";
import type { ShellStore } from "../shared/shell-store.ts";

const SECRET = "channel-auth-test-secret";
const EVE = "http://127.0.0.1:4420";

function sign(claims: Record<string, unknown>, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: "desktop-app", iss: "useful-bot", aud: "useful-bot", iat: now, exp: now + 3600, ...claims,
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function call(method: string, path: string, claims?: Record<string, unknown> | null): Request {
  const headers = new Headers();
  if (claims !== null) headers.set("authorization", `Bearer ${sign(claims ?? {})}`);
  return new Request(`${EVE}${path}`, { method, headers });
}

const bindings = new Map<string, string>([["sess-a", "bot-a"]]);
const roster = { bots: [{ id: "bot-a" }, { id: "bot-b" }] } as unknown as ShellStore;
const claimed: string[] = [];
const auth = channelAuth({
  secret: SECRET,
  readBot: (id) => bindings.get(id) ?? null,
  roster: () => roster,
  owners: { claim: (id) => { claimed.push(id); return "ok"; } },
});

async function refused(request: Request, message: string): Promise<void> {
  await assert.rejects(async () => auth(request), (err: unknown) => {
    assert.match(String((err as Error).message), new RegExp(message));
    return true;
  });
}

// MARK: - eve side

test("a create needs a string claim that names a roster bot", async () => {
  await refused(call("POST", "/eve/v1/session"), "bot_claim_missing");
  await refused(call("POST", "/eve/v1/session", {}), "bot_claim_missing");
  await refused(call("POST", "/eve/v1/session", { botId: "bot-ghost" }), "bot_claim_unknown");
  assert.ok(await auth(call("POST", "/eve/v1/session", { botId: "bot-b" })));
});

test("a claim that is not a string is dropped by eve, so it reads as no claim", async () => {
  await refused(call("POST", "/eve/v1/session", { botId: 7 }), "bot_claim_missing");
  await refused(call("POST", "/eve/v1/session/sess-a", { botId: 7 }), "session_bot_mismatch");
  await refused(call("GET", "/eve/v1/session/sess-a/stream", { botId: { id: "bot-a" } }), "session_bot_mismatch");
});

test("another bot's claim is refused on a continue, a stream and a cancel; the bound bot's passes", async () => {
  await refused(call("POST", "/eve/v1/session/sess-a", { botId: "bot-b" }), "session_bot_mismatch");
  await refused(call("GET", "/eve/v1/session/sess-a/stream?startIndex=0", { botId: "bot-b" }), "session_bot_mismatch");
  await refused(call("POST", "/eve/v1/session/sess-a/cancel", { botId: "bot-b" }), "session_bot_mismatch");
  await refused(call("POST", "/eve/v1/session/sess-a"), "session_bot_mismatch");
  assert.ok(await auth(call("POST", "/eve/v1/session/sess-a", { botId: "bot-a", delivery: "owner" })));
  assert.ok(await auth(call("GET", "/eve/v1/session/sess-a/stream", { botId: "bot-a" })));
  assert.ok(await auth(call("POST", "/eve/v1/session/sess-a/cancel", { botId: "bot-a" })));
});

test("an unbound session is refused, except a cancel", async () => {
  await refused(call("POST", "/eve/v1/session/sess-nobody", { botId: "bot-a" }), "session_unbound");
  await refused(call("GET", "/eve/v1/session/sess-nobody/stream", { botId: "bot-a" }), "session_unbound");
  assert.ok(await auth(call("POST", "/eve/v1/session/sess-nobody/cancel", { botId: "bot-a" })));
  assert.ok(await auth(call("POST", "/eve/v1/session/sess-nobody/cancel", {})));
  // Only a cancel: a GET on a cancel path is a stream-shaped read, not a stop.
  await refused(call("GET", "/eve/v1/session/sess-nobody/cancel", {}), "session_unbound");
});

test("health and info need a valid token and no claim; a bad or missing token never passes", async () => {
  assert.ok(await auth(call("GET", "/eve/v1/health", {})));
  assert.ok(await auth(call("GET", "/eve/v1/info", {})));
  assert.equal(await auth(call("GET", "/eve/v1/info", null)), null);
  const forged = new Request(`${EVE}/eve/v1/session/sess-a`, {
    method: "POST",
    headers: { authorization: `Bearer ${sign({ botId: "bot-a" }, "another-secret")}` },
  });
  assert.equal(await auth(forged), null);
});

test("a binding that cannot be read, or an owner clash, is refused", async () => {
  const broken = channelAuth({
    secret: SECRET,
    readBot: () => { throw new Error("session_owners_locked"); },
    roster: () => roster,
    owners: { claim: () => "ok" },
  });
  await assert.rejects(async () => broken(call("GET", "/eve/v1/session/sess-a/stream", { botId: "bot-a" })), /session_binding_unavailable/);
  const clash = channelAuth({
    secret: SECRET,
    readBot: (id) => bindings.get(id) ?? null,
    roster: () => roster,
    owners: { claim: () => "forbidden" },
  });
  await assert.rejects(async () => clash(call("GET", "/eve/v1/session/sess-a/stream", { botId: "bot-a" })), /session_ownership/);
  const noSecret = channelAuth({ secret: "" });
  await assert.rejects(async () => noSecret(call("GET", "/eve/v1/health", {})), /channel_auth_unconfigured/);
});

// MARK: - proxy side

function claimsOf(jwt: string | null): Record<string, unknown> {
  assert.ok(jwt);
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

async function withSecret<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = { secret: process.env.UB_CHANNEL_JWT_SECRET, env: process.env.UB_CHANNEL_JWT };
  process.env.UB_CHANNEL_JWT_SECRET = SECRET;
  delete process.env.UB_CHANNEL_JWT;
  try {
    return await fn();
  } finally {
    if (saved.secret === undefined) delete process.env.UB_CHANNEL_JWT_SECRET; else process.env.UB_CHANNEL_JWT_SECRET = saved.secret;
    if (saved.env !== undefined) process.env.UB_CHANNEL_JWT = saved.env;
  }
}

test("the proxy mints a stream read with the bound bot's claim, whatever the caller says", async () => {
  await withSecret(() => {
    const made = authorizeEveCall("GET", "session/sess-a/stream", null, (id) => bindings.get(id) ?? null);
    assert.ok(made.ok);
    assert.equal(claimsOf(made.jwt).botId, "bot-a");
    assert.equal(made.bound, "bot-a");
    const stop = authorizeEveCall("POST", "session/sess-a/cancel", "", (id) => bindings.get(id) ?? null);
    assert.ok(stop.ok);
    assert.equal(claimsOf(stop.jwt).botId, "bot-a");
  });
});

test("a continue naming another bot is refused before any eve call, and the bound bot is pinned", async () => {
  await withSecret(async () => {
    const real = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch;
    try {
      const refusal = authorizeEveCall("POST", "session/sess-a", JSON.stringify({ botId: "bot-b", message: "hi" }), (id) => bindings.get(id) ?? null);
      assert.deepEqual(refusal, { ok: false, status: 400, error: "session_bot_mismatch" });
      assert.equal(fetched, 0);
      const ok = authorizeEveCall("POST", "session/sess-a", JSON.stringify({ message: "hi" }), (id) => bindings.get(id) ?? null);
      assert.ok(ok.ok);
      assert.equal((JSON.parse(ok.body ?? "") as { botId?: string }).botId, "bot-a");
      assert.equal(claimsOf(ok.jwt).botId, "bot-a");
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("an unbound session is a 400 on a continue and a stream, and a claimless cancel; a create is minted later", async () => {
  await withSecret(() => {
    const none = () => null;
    assert.deepEqual(authorizeEveCall("POST", "session/x", JSON.stringify({ botId: "bot-a" }), none), { ok: false, status: 400, error: "session_unbound" });
    assert.deepEqual(authorizeEveCall("GET", "session/x/stream", null, none), { ok: false, status: 400, error: "session_unbound" });
    const stop = authorizeEveCall("POST", "session/x/cancel", "", none);
    assert.ok(stop.ok);
    assert.equal("botId" in claimsOf(stop.jwt), false);
    const create = authorizeEveCall("POST", "session", JSON.stringify({ botId: "bot-a" }), () => { throw new Error("never read"); });
    assert.ok(create.ok);
    assert.equal(create.jwt, null);
    const health = authorizeEveCall("GET", "health", null, none);
    assert.ok(health.ok);
    assert.equal("botId" in claimsOf(health.jwt), false);
  });
});

test("a token needs the channel secret: the baked env token is no fallback, and delivery rides along", async () => {
  await withSecret(() => {
    assert.equal(claimsOf(channelJwt("bot-a", "handoff")).delivery, "handoff");
    assert.equal(claimsOf(channelJwt("bot-a", "routine")).delivery, "routine");
    assert.equal(claimsOf(channelJwt("bot-b")).botId, "bot-b");
    assert.equal(channelJwt("bot-a", "routine"), channelJwt("bot-a", "routine"), "cached per bot and delivery");
    assert.notEqual(channelJwt("bot-a", "routine"), channelJwt("bot-a", "handoff"));
    delete process.env.UB_CHANNEL_JWT_SECRET;
    process.env.UB_CHANNEL_JWT = "baked-env-token";
    try {
      assert.throws(() => channelJwt("bot-a"), /channel_credential_missing/);
    } finally {
      delete process.env.UB_CHANNEL_JWT;
    }
  });
});

test("a carry-over reads the old session only as the bot that owns it", async () => {
  await withSecret(() => {
    const resolve = (id: string) => (id === "sess-a" ? "bot-a" : id === "sess-b" ? "bot-b" : null);
    const refused = { ok: false, status: 400, error: "continue_from_refused" };
    // No owner bot for the continuing chat: no token is minted.
    assert.deepEqual(carryOverReader("sess-a", null, resolve), refused);
    assert.deepEqual(carryOverReader("sess-a", "", resolve), refused);
    // The old session is bound to another bot, or to nobody.
    assert.deepEqual(carryOverReader("sess-b", "bot-a", resolve), refused);
    assert.deepEqual(carryOverReader("sess-nobody", "bot-a", resolve), refused);
    const ok = carryOverReader("sess-a", "bot-a", resolve);
    assert.ok(ok.ok);
    assert.equal(claimsOf(ok.jwt).botId, "bot-a");
    // A bot id is never empty, so a null subject cannot reach the signer.
    assert.throws(() => channelJwt(""), /channel_bot_missing/);
  });
});

// MARK: - child session streams
//
// Failure modes, written before the code. The parent is unbound, bound to
// another bot, or itself a child (a nested read). The child is the parent, a
// root session of this or another bot, recorded under a different parent, or
// recorded for another bot. A child with no row yet must prove itself with
// `at`, the absolute index of the parent's `subagent.called`: `at` is missing,
// negative, fractional, huge or not a number; the event at `at` is another
// type, a `subagent.called` for another child (a forged `at`), one raised by
// another session (a nested child's call forwarded onto the parent), or one
// whose JSON is cut off or does not parse; the read ends, or overflows its
// byte cap, before one whole event; eve answers an error, or never answers
// (time cap). Events appended after `at` (a live parent) change nothing and
// the read stops after the first. An eve failure is loud (thrown, mapped to a
// 503 by the route) and never remembered. A child already bound under this
// parent and bot is served with no eve read at all. A store that cannot be
// read is loud. A bind that conflicts is loud too.

function childDeps(over: Partial<ChildStreamDeps> = {}): ChildStreamDeps & { reads: Array<{ parent: string; at: number }>; binds: string[] } {
  const owners = new Map<string, string>([
    ["p1", "bot-a"], ["p2", "bot-b"], ["root-a", "bot-a"],
    ["kid-1", "bot-a"], ["kid-b", "bot-b"], ["kid-other", "bot-a"], ["kid-old", "bot-a"], ["nested", "bot-a"],
  ]);
  const parents = new Map<string, string>([["kid-1", "p1"], ["kid-b", "p2"], ["kid-other", "p9"], ["kid-old", "p1"], ["nested", "kid-old"]]);
  const reads: Array<{ parent: string; at: number }> = [];
  const binds: string[] = [];
  return {
    resolveBot: (id) => owners.get(id) ?? null,
    readParent: (id) => parents.get(id) ?? null,
    readEventAt: async (parent, at) => {
      reads.push({ parent, at });
      return JSON.stringify(called(parent, "kid-new"));
    },
    bind: (child, parent, bot) => { binds.push(`${child}<${parent}@${bot}`); },
    ...over,
    reads,
    binds,
  };
}

function called(sessionId: string, childSessionId: string) {
  return { type: "subagent.called", data: { agentId: "agent_1", callId: "call_1", childSessionId, sessionId, toolName: "agent", turnId: "turn_0" }, meta: { id: "evt_1", at: "2026-10-03T00:00:00.000Z" } };
}

const unverified = { ok: false, status: 403, error: "child_session_unverified" };

test("a child already bound under the parent and bot is served with no eve read", async () => {
  await withSecret(async () => {
    const deps = childDeps();
    for (const at of [null, 0, 12]) {
      const ok = await authorizeChildStream("p1", "kid-1", at, deps);
      assert.ok(ok.ok);
      assert.equal(claimsOf(ok.jwt).botId, "bot-a");
      assert.equal(ok.bound, "bot-a");
      assert.equal(ok.body, null);
    }
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.binds, []);
  });
});

test("a child stream is refused for an unbound, foreign or nested parent and for a wrong child, before any read", async () => {
  await withSecret(async () => {
    const deps = childDeps();
    assert.deepEqual(await authorizeChildStream("ghost", "kid-1", 3, deps), { ok: false, status: 400, error: "session_unbound" });
    // The parent is bot-b's while the child is recorded for bot-a under p1.
    assert.deepEqual(await authorizeChildStream("p2", "kid-1", 3, deps), unverified);
    // Nested: the parent is itself a child.
    assert.deepEqual(await authorizeChildStream("kid-old", "nested", 3, deps), unverified);
    assert.deepEqual(await authorizeChildStream("kid-old", "kid-new", 3, deps), unverified);
    // Recorded under a different parent than the one named.
    assert.deepEqual(await authorizeChildStream("p1", "kid-other", 3, deps), unverified);
    // The parent as its own child, a root session as a child, another bot's child.
    assert.deepEqual(await authorizeChildStream("p1", "p1", 3, deps), unverified);
    assert.deepEqual(await authorizeChildStream("p1", "root-a", 3, deps), unverified);
    assert.deepEqual(await authorizeChildStream("p1", "p2", 3, deps), unverified);
    assert.deepEqual(await authorizeChildStream("p1", "kid-b", 3, deps), unverified);
    // Same parent id, but the child's row names another bot than the parent's.
    const crossed = childDeps({ resolveBot: (id) => (id === "kid-1" ? "bot-b" : childDeps().resolveBot(id)) });
    assert.deepEqual(await authorizeChildStream("p1", "kid-1", 3, crossed), unverified);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(crossed.reads, []);
    assert.deepEqual(deps.binds, []);
    // A store that cannot be read is loud, not "refused".
    await assert.rejects(authorizeChildStream("p1", "kid-1", 3, childDeps({ readParent: () => { throw new Error("session_owners_locked"); } })), /session_owners_locked/);
  });
});

test("a new child is bound only when the parent's event at `at` is its exact subagent.called", async () => {
  await withSecret(async () => {
    const deps = childDeps();
    const ok = await authorizeChildStream("p1", "kid-new", 41, deps);
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(claimsOf(ok.jwt).botId, "bot-a");
    assert.equal(ok.bound, "bot-a");
    assert.deepEqual(deps.reads, [{ parent: "p1", at: 41 }]);
    assert.deepEqual(deps.binds, ["kid-new<p1@bot-a"]);
    // `at` 0 is a real index.
    assert.ok((await authorizeChildStream("p1", "kid-new", 0, childDeps())).ok);
  });
});

test("a new child without a usable `at` is refused before eve is read", async () => {
  await withSecret(async () => {
    const deps = childDeps();
    for (const at of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, CHILD_AT_MAX + 1]) {
      assert.deepEqual(await authorizeChildStream("p1", "kid-new", at, deps), unverified, String(at));
    }
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.binds, []);
  });
});

test("whatever else sits at `at` is refused and binds nothing", async () => {
  await withSecret(async () => {
    const at = (payload: string | null) => childDeps({ readEventAt: async () => payload });
    const cases: Array<[string, string | null]> = [
      // A forged `at` pointing at another child's call from the same parent.
      ["another child's call", JSON.stringify(called("p1", "kid-sibling"))],
      // A nested child's own call, forwarded onto the parent's stream.
      ["a call raised by another session", JSON.stringify(called("kid-old", "kid-new"))],
      ["a non-subagent event", JSON.stringify({ type: "message.completed", data: { sessionId: "p1", childSessionId: "kid-new", message: "kid-new" } })],
      ["the admission receipt", JSON.stringify({ type: "subagent.completed", data: { sessionId: "p1", childSessionId: "kid-new" } })],
      ["a wrapped child event", JSON.stringify({ type: "subagent.event", data: { event: called("p1", "kid-new") } })],
      ["a call with no data", JSON.stringify({ type: "subagent.called" })],
      ["a child id that is not a string", JSON.stringify({ type: "subagent.called", data: { sessionId: "p1", childSessionId: ["kid-new"] } })],
      ["a truncated event", JSON.stringify(called("p1", "kid-new")).slice(0, 60)],
      ["JSON that is not an object", "\"subagent.called\""],
      ["a short read", null],
    ];
    for (const [name, payload] of cases) {
      const deps = at(payload);
      assert.deepEqual(await authorizeChildStream("p1", "kid-new", 7, deps), unverified, name);
      assert.deepEqual(deps.binds, [], name);
    }
  });
});

test("an eve failure while verifying is loud and is not remembered", async () => {
  await withSecret(async () => {
    let fail = true;
    const deps = childDeps({
      readEventAt: async (parent) => {
        if (fail) throw new Error("eve_stream_503");
        return JSON.stringify(called(parent, "kid-new"));
      },
    });
    await assert.rejects(authorizeChildStream("p1", "kid-new", 7, deps), /eve_stream_503/);
    assert.deepEqual(deps.binds, []);
    fail = false;
    assert.ok((await authorizeChildStream("p1", "kid-new", 7, deps)).ok);
    // A bind that conflicts (the child was bound as a root meanwhile) is loud too.
    const conflict = childDeps({ bind: () => { throw new Error("session_owner_conflict"); } });
    await assert.rejects(authorizeChildStream("p1", "kid-new", 7, conflict), /session_owner_conflict/);
  });
});

// The reader against a stand-in for eve's stream route: eve 0.54.3 writes one
// blank line, then each event as `JSON.stringify(event) + "\n"` starting at
// the absolute `startIndex`, and with no `includeTailIndex` keeps following
// the live stream (eve-channel/request.js serializeAsNdjson).
function fakeEve(events: unknown[], options: { live?: boolean; status?: number; split?: number; raw?: string } = {}) {
  const seen: { urls: string[]; auth: string[]; aborted: boolean; served: number } = { urls: [], auth: [], aborted: false, served: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.urls.push(url.toString());
    seen.auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (options.status) return new Response(JSON.stringify({ ok: false }), { status: options.status });
    const start = Number(url.searchParams.get("startIndex"));
    const encoder = new TextEncoder();
    const text = options.raw ?? `\n${events.slice(start).map((e) => `${JSON.stringify(e)}\n`).join("")}`;
    const step = options.split ?? text.length;
    let offset = 0;
    let gone = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < text.length) {
          controller.enqueue(encoder.encode(text.slice(offset, offset + step)));
          offset += step;
          seen.served = Math.min(offset, text.length);
          return;
        }
        if (!options.live) {
          controller.close();
          return;
        }
        // Live: the parent keeps going; a new event lands every few ms until the reader goes.
        return new Promise<void>((resolve) => setTimeout(() => {
          if (!gone) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "message.appended", data: { messageDelta: "x" } })}\n`));
          resolve();
        }, 5));
      },
      cancel() { gone = true; seen.aborted = true; },
    });
    init?.signal?.addEventListener("abort", () => { seen.aborted = true; });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function parentEvents(n: number, calls: Record<number, string>): unknown[] {
  return Array.from({ length: n }, (_, i) => (calls[i] ? called("p1", calls[i]) : { type: "message.appended", data: { messageDelta: `e${i}` } }));
}

test("the reader asks eve for the absolute index and returns only the first event there", async () => {
  const eve = fakeEve(parentEvents(40, { 3: "kid-a", 30: "kid-b" }));
  const got = await readStreamEventAt("p1", 30, "jwt-1", { fetch: eve.fetchImpl, origin: "http://eve.test" });
  assert.deepEqual(JSON.parse(got ?? "null"), called("p1", "kid-b"));
  const url = new URL(eve.seen.urls[0]);
  assert.equal(url.pathname, "/eve/v1/session/p1/stream");
  assert.equal(url.searchParams.get("startIndex"), "30");
  assert.equal(url.searchParams.has("includeTailIndex"), false);
  assert.equal(eve.seen.auth[0], "Bearer jwt-1");
  assert.equal(eve.seen.aborted, true, "the read stops after the first event");
  // Index 0 is the first event, not the blank line before it.
  const first = await readStreamEventAt("p1", 0, "jwt-1", { fetch: fakeEve(parentEvents(5, { 0: "kid-0" })).fetchImpl, origin: "http://eve.test" });
  assert.deepEqual(JSON.parse(first ?? "null"), called("p1", "kid-0"));
});

test("a live parent appending past `at` changes nothing, and the read does not follow it", async () => {
  const eve = fakeEve(parentEvents(10, { 9: "kid-live" }), { live: true, split: 7 });
  const got = await readStreamEventAt("p1", 9, "jwt", { fetch: eve.fetchImpl, origin: "http://eve.test", timeoutMs: 2000 });
  assert.deepEqual(JSON.parse(got ?? "null"), called("p1", "kid-live"));
  assert.equal(eve.seen.aborted, true);
  // End to end: the proxy binds the live parent's child.
  await withSecret(async () => {
    const binds: string[] = [];
    const deps = childDeps({
      readEventAt: (parent, at, jwt, signal) => readStreamEventAt(parent, at, jwt, { fetch: fakeEve(parentEvents(10, { 9: "kid-new" }), { live: true }).fetchImpl, origin: "http://eve.test", signal }),
      bind: (child, parent, bot) => { binds.push(`${child}<${parent}@${bot}`); },
    });
    assert.ok((await authorizeChildStream("p1", "kid-new", 9, deps)).ok);
    assert.deepEqual(binds, ["kid-new<p1@bot-a"]);
    // A forged `at` one past the call reads the next event, which is not it.
    const forged = childDeps({
      readEventAt: (parent, at, jwt, signal) => readStreamEventAt(parent, at, jwt, { fetch: fakeEve(parentEvents(12, { 9: "kid-new" }), { live: true }).fetchImpl, origin: "http://eve.test", signal }),
    });
    assert.deepEqual(await authorizeChildStream("p1", "kid-new", 10, forged), unverified);
    assert.deepEqual(forged.binds, []);
  });
});

test("a first event split across chunks is read whole; one cut off is a short read", async () => {
  const split = fakeEve(parentEvents(4, { 2: "kid-s" }), { split: 3 });
  assert.deepEqual(JSON.parse((await readStreamEventAt("p1", 2, "jwt", { fetch: split.fetchImpl, origin: "http://eve.test" })) ?? "null"), called("p1", "kid-s"));
  const cut = JSON.stringify(called("p1", "kid-s"));
  for (const raw of ["", "\n", `\n${cut.slice(0, 40)}`, `\n${cut}`]) {
    // A stream that ends with no newline after the event never yields a whole event.
    const eve = fakeEve([], { raw });
    assert.equal(await readStreamEventAt("p1", 2, "jwt", { fetch: eve.fetchImpl, origin: "http://eve.test" }), null, JSON.stringify(raw));
  }
});

test("a first event past the byte cap is not read further", async () => {
  const huge = { type: "subagent.called", data: { sessionId: "p1", childSessionId: "kid-h", pad: "x".repeat(64 * 1024) } };
  const eve = fakeEve([huge], { split: 512, live: true });
  assert.equal(await readStreamEventAt("p1", 0, "jwt", { fetch: eve.fetchImpl, origin: "http://eve.test", maxBytes: 1024 }), null);
  // The cap plus the stream's own read-ahead, nowhere near the whole event.
  assert.ok(eve.seen.served <= 1024 + 4 * 512, `read ${eve.seen.served} bytes`);
  assert.equal(eve.seen.aborted, true);
});

test("an event over the cap is refused even when its newline is in the chunk that crosses it", async () => {
  // Review round 5: the cap was only checked after a whole line was returned.
  const big = { type: "subagent.called", data: { sessionId: "p1", childSessionId: "kid-b", pad: "x".repeat(1100) } };
  const eve = fakeEve([big], { split: 4096 });
  assert.equal(await readStreamEventAt("p1", 0, "jwt", { fetch: eve.fetchImpl, origin: "http://eve.test", maxBytes: 1024 }), null);
  // The same event under a cap it fits in is read.
  const fits = fakeEve([big], { split: 4096 });
  assert.notEqual(await readStreamEventAt("p1", 0, "jwt", { fetch: fits.fetchImpl, origin: "http://eve.test", maxBytes: 4096 }), null);
});

test("an eve error status, a refused fetch or a read that never starts is loud", async () => {
  for (const status of [500, 503, 404, 401]) {
    const eve = fakeEve([], { status });
    await assert.rejects(readStreamEventAt("p1", 0, "jwt", { fetch: eve.fetchImpl, origin: "http://eve.test" }), new RegExp(`eve_stream_${status}`));
  }
  const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(readStreamEventAt("p1", 0, "jwt", { fetch: refused, origin: "http://eve.test" }), /fetch failed/);
  // `at` past the tail: eve waits for an event that never comes. The time cap ends it.
  const idle = fakeEve([], { raw: "\n", live: false });
  const silent = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await idle.fetchImpl(input, init);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("\n")); },
      cancel() { idle.seen.aborted = true; },
    });
    init?.signal?.addEventListener("abort", () => { idle.seen.aborted = true; });
    void res.body?.cancel();
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(readStreamEventAt("p1", 999, "jwt", { fetch: silent, origin: "http://eve.test", timeoutMs: 80 }), /eve_stream_timeout/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(idle.seen.aborted, true);
  // A caller that goes away stops the read.
  const gone = new AbortController();
  const pending = readStreamEventAt("p1", 999, "jwt", { fetch: silent, origin: "http://eve.test", timeoutMs: 5000, signal: gone.signal });
  gone.abort();
  await assert.rejects(pending, /aborted/);
});

// MARK: - review round 1
//
// Failure modes: a send into a child that was unbound when the request
// arrived but is recorded by the time it is authorised (a child-stream read
// binds it), and a cancel into a child, must be refused by the authorisation
// itself, in whatever order the requests land.

test("a send or cancel into a recorded child is refused by the authorisation, whatever the order", async () => {
  await withSecret(() => {
    const resolve = (id: string) => (id === "kid" || id === "sess-a" ? "bot-a" : null);
    let recorded = false;
    const isChild = (id: string) => id === "kid" && recorded;
    const body = JSON.stringify({ message: "hi" });
    // The send arrives while the child is unbound-as-child (passes the early guard) ...
    assert.equal(childWriteRefusal("POST", "session/kid", isChild), null);
    // ... a GET records it, and the authorisation that follows the slow body read refuses.
    recorded = true;
    const late = authorizeEveCall("POST", "session/kid", body, resolve, isChild);
    assert.deepEqual(late, { ok: false, status: 403, error: "child_session_readonly" });
    assert.deepEqual(authorizeEveCall("POST", "session/kid/cancel", "", resolve, isChild), { ok: false, status: 403, error: "child_session_readonly" });
    assert.deepEqual(authorizeEveCall("POST", "session/kid", JSON.stringify({ inputResponses: [{ requestId: "r", optionId: "stop" }] }), resolve, isChild), { ok: false, status: 403, error: "child_session_readonly" });
    // The same check just before forwarding.
    assert.deepEqual(childWriteRefusal("POST", "session/kid/cancel", isChild), { status: 403, error: "child_session_readonly" });
    // A root session and a read are not affected.
    assert.ok(authorizeEveCall("POST", "session/sess-a", body, resolve, isChild).ok);
    assert.equal(childWriteRefusal("GET", "session/kid/stream", isChild), null);
    assert.equal(childWriteRefusal("POST", "session", isChild), null);
    // A store that cannot be read is loud, not "not a child".
    assert.throws(() => authorizeEveCall("POST", "session/sess-a", body, resolve, () => { throw new Error("session_owners_locked"); }), /session_owners_locked/);
  });
});


// A cancel into a sub-agent's child names its parent and the parent's
// subagent.called index like a child stream read; no other request does.
import { childCancelQuery } from "../shared/eve-proxy.ts";

test("childCancelQuery reads parent and at only on a cancel POST", () => {
  assert.deepEqual(childCancelQuery("POST", "session/kid/cancel", "?parent=p1&at=7"), { present: true, parent: "p1", at: 7, search: "", agentId: null, agentIdBad: false });
  // agentId is parsed, validated and stripped from what is forwarded.
  assert.deepEqual(childCancelQuery("POST", "session/kid/cancel", "?parent=p1&at=7&agentId=ag_agent:ab12&x=1"), { present: true, parent: "p1", at: 7, search: "?x=1", agentId: "ag_agent:ab12", agentIdBad: false });
  for (const bad of ["agentId=nope", "agentId=ag_agent:A", "agentId=ag_agent:a&agentId=ag_agent:b", "agentId="]) {
    const q = childCancelQuery("POST", "session/kid/cancel", `?parent=p1&at=7&${bad}`);
    assert.equal(q.present && q.agentIdBad, true, bad);
    assert.equal(q.present && q.agentId, null, bad);
  }
  assert.deepEqual(childCancelQuery("POST", "session/kid/cancel", ""), { present: false });
  assert.deepEqual(childCancelQuery("GET", "session/kid/stream", "?parent=p1&at=7"), { present: false });
  assert.deepEqual(childCancelQuery("POST", "session/kid", "?parent=p1&at=7"), { present: false });
  // Malformed claims are present but unverifiable.
  assert.deepEqual(childCancelQuery("POST", "session/kid/cancel", "?parent=p1&parent=p2&at=-1"), { present: true, parent: null, at: null, search: "", agentId: null, agentIdBad: false });
});

test("a cancel into a child is one verified decision; nothing else skips the write refusal", async () => {
  await withSecret(async () => {
    const refused = { kind: "refused", status: 403, error: "child_session_unverified" };
    // A cancel that is not a child cancel (no parent) goes the normal way, which refuses a recorded child.
    assert.deepEqual(await authorizeChildCancel("POST", "session/kid-1/cancel", "", childDeps()), { kind: "none" });
    // A non-cancel POST carrying parent and at is never a child cancel, and the normal refusal holds.
    for (const suffix of ["session/kid-1", "session/kid-1/stream", "session", "session/kid-1/cancel/x", "x/session/kid-1/cancel"]) {
      const deps = childDeps();
      assert.deepEqual(await authorizeChildCancel("POST", suffix, "?parent=p1&at=3", deps), { kind: "none" }, suffix);
      assert.equal(deps.reads.length, 0, suffix);
    }
    const isChild = (id: string) => id === "kid-1";
    assert.deepEqual(childWriteRefusal("POST", "session/kid-1", isChild), { status: 403, error: "child_session_readonly" });
    // A GET never is one.
    assert.deepEqual(await authorizeChildCancel("GET", "session/kid-1/cancel", "?parent=p1&at=3", childDeps()), { kind: "none" });
    // No at, a bad at, a missing or doubled parent: refused, nothing read.
    for (const search of ["?parent=p1", "?parent=p1&at=x", "?parent=p1&parent=p2&at=3", "?parent=p1&at=3&at=4"]) {
      const deps = childDeps();
      assert.deepEqual(await authorizeChildCancel("POST", "session/kid-new/cancel", search, deps), refused, search);
      assert.equal(deps.reads.length, 0, search);
    }
    // A wrong at: the event there is not this child's call.
    const wrong = childDeps({ readEventAt: async () => JSON.stringify({ type: "message.appended", data: {} }) });
    assert.deepEqual(await authorizeChildCancel("POST", "session/kid-new/cancel", "?parent=p1&at=4", wrong), refused);
    // A root session is never cancelled this way, whatever parent is named.
    assert.deepEqual(await authorizeChildCancel("POST", "session/root-a/cancel", "?parent=p1&at=4", childDeps()), refused);
    // A child recorded under another parent is refused.
    assert.deepEqual(await authorizeChildCancel("POST", "session/kid-b/cancel", "?parent=p1&at=4", childDeps()), refused);
    // A verified child is forwarded, with the parent's bot token and without parent or at.
    const deps = childDeps();
    const ok = await authorizeChildCancel("POST", "session/kid-new/cancel", "?parent=p1&at=9&x=1", deps);
    assert.equal(ok.kind, "verified");
    assert.equal(ok.kind === "verified" ? ok.search : "", "?x=1");
    assert.deepEqual(deps.reads, [{ parent: "p1", at: 9 }]);
    // An already recorded child under this parent needs no eve read.
    const recorded = childDeps();
    assert.equal((await authorizeChildCancel("POST", "session/kid-1/cancel", "?parent=p1&at=1", recorded)).kind, "verified");
    assert.equal(recorded.reads.length, 0);
  });
});

test("only a verified child cancel names the child and parent a stop is recorded under", async () => {
  await withSecret(async () => {
    const ok = await authorizeChildCancel("POST", "session/kid-new/cancel", "?parent=p1&at=9", childDeps());
    assert.equal(ok.kind === "verified" ? `${ok.parent}/${ok.child}` : "", "p1/kid-new");
    // Refused and non-child requests carry nothing to record.
    for (const [suffix, search] of [["session/kid-new/cancel", "?parent=p1"], ["session/kid-1/cancel", ""], ["session/kid-new", "?parent=p1&at=9"]] as const) {
      const r = await authorizeChildCancel("POST", suffix, search, childDeps());
      assert.notEqual(r.kind, "verified", suffix + search);
    }
  });
});

test("a malformed agentId on a child cancel is refused, a good one is carried", async () => {
  await withSecret(async () => {
    const bad = childDeps();
    assert.deepEqual(await authorizeChildCancel("POST", "session/kid-new/cancel", "?parent=p1&at=9&agentId=nope", bad), { kind: "refused", status: 403, error: "child_session_unverified" });
    assert.equal(bad.reads.length, 0);
    const ok = await authorizeChildCancel("POST", "session/kid-new/cancel", "?parent=p1&at=9&agentId=ag_agent:ab12", childDeps());
    assert.equal(ok.kind === "verified" ? `${ok.agentId}|${ok.search}` : "", "ag_agent:ab12|");
  });
});

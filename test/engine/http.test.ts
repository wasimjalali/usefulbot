import assert from "node:assert/strict";
import { request as httpRequest, createServer as createNetServer, type Server } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import type { Engine } from "../../agent/engine/engine.ts";
import { createEngineServer } from "../../agent/engine/http.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld, type World } from "./helpers.ts";

/** The HTTP surface (SPEC 5.1, 6): who may call, what each route answers, and the stream. */

const TOKEN = "engine-test-token";

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

type Served = { base: string; port: number; setEngine(engine: Engine | null): void; close(): Promise<void>; server: Server };

async function serve(initial: Engine | null, pingMs?: number): Promise<Served> {
  const port = await freePort();
  let engine = initial;
  const server = createEngineServer({ token: TOKEN, port, stack: "daily", engine: () => engine, ...(pingMs ? { pingMs } : {}) });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    server,
    setEngine: (next) => { engine = next; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function raw(port: number, headers: Record<string, string>, path = "/status"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServed(fn: (world: World, served: Served) => Promise<void>, pingMs?: number): Promise<void> {
  const world = await makeWorld();
  const served = await serve(world.engine, pingMs);
  try {
    await fn(world, served);
  } finally {
    await served.close();
    await world.close();
  }
}

test("health answers without a token and before boot has finished; everything else waits", async () => {
  const served = await serve(null);
  try {
    const health = await fetch(`${served.base}/health`);
    assert.equal(health.status, 200);
    const body = await json(health);
    assert.deepEqual([body.ok, body.stack, body.epoch], [true, "daily", null]);
    assert.match(String(body.pi), /^\d+\.\d+\.\d+/);
    const starting = await fetch(`${served.base}/status`, { headers: auth });
    assert.equal(starting.status, 503);
    assert.deepEqual(await json(starting), { ok: false, error: "engine_starting" });
    // Even before boot, a caller without the token is told no, not "starting".
    assert.equal((await fetch(`${served.base}/status`)).status, 401);
  } finally {
    await served.close();
  }
});

test("a bearer token is required, a browser origin is refused and the Host must be loopback", async () => {
  await withServed(async (world, served) => {
    assert.equal((await fetch(`${served.base}/status`)).status, 401);
    assert.equal((await fetch(`${served.base}/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${served.base}/status`, { headers: { authorization: TOKEN } })).status, 401, "the scheme is required");
    const ok = await fetch(`${served.base}/status`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).epoch, world.engine.epoch);
    assert.equal((await raw(served.port, { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" })).status, 403);
    assert.equal((await raw(served.port, { authorization: `Bearer ${TOKEN}`, host: "localhost" })).status, 421);
    assert.equal((await raw(served.port, { authorization: `Bearer ${TOKEN}`, host: "evil.example:80" })).status, 421);
    assert.equal((await raw(served.port, { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1" })).status, 200);
    // The health route obeys the Host and Origin rules too.
    assert.equal((await raw(served.port, { origin: "http://evil.example" }, "/health")).status, 403);
  });
});

test("bodies are capped and must be JSON, and errors have one shape", async () => {
  await withServed(async (world, served) => {
    const huge = JSON.stringify({ botId: DEFAULT_BOT_ID, pad: "x".repeat(70 * 1024) });
    const tooBig = await fetch(`${served.base}/chats`, { method: "POST", headers: auth, body: huge });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(await json(tooBig), { ok: false, error: "body_too_large" });
    const notJson = await fetch(`${served.base}/chats`, { method: "POST", headers: auth, body: "{ nope" });
    assert.equal(notJson.status, 400);
    assert.equal((await json(notJson)).error, "invalid_json");
    const missing = await fetch(`${served.base}/chats`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).error, "invalid_body");
    const chatId = world.newChat();
    // A turn may be big: 6 MB passes the body cap (the engine's own parser then judges it).
    const big = await fetch(`${served.base}/chats/${chatId}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ clientId: crypto.randomUUID(), text: "hi", attachments: [], pad: "x".repeat(6 * 1024 * 1024) }) });
    assert.notEqual(big.status, 413);
    await world.idle(chatId);
    const tooBigTurn = await fetch(`${served.base}/chats/${chatId}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ text: "x".repeat(9 * 1024 * 1024) }) });
    assert.equal(tooBigTurn.status, 413);
    const unknownChat = await fetch(`${served.base}/chats/nope/rows`, { headers: auth });
    assert.equal(unknownChat.status, 404);
    assert.deepEqual(await json(unknownChat), { ok: false, error: "chat_not_found" });
    assert.equal((await fetch(`${served.base}/nowhere`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${served.base}/chats`, { method: "DELETE", headers: auth })).status, 404);
  });
});

test("a whole conversation over HTTP: create, stream, send, rows, rename, search, cancel, delete", async () => {
  await withServed(async (world, served) => {
    const created = await json(await fetch(`${served.base}/chats`, { method: "POST", headers: auth, body: JSON.stringify({ botId: DEFAULT_BOT_ID }) }));
    const chatId = String(created.chatId);
    assert.ok(chatId);

    const stream = await fetch(`${served.base}/chats/${chatId}/events`, { headers: auth });
    assert.equal(stream.headers.get("content-type"), "application/x-ndjson");
    assert.equal(stream.headers.get("cache-control"), "no-store");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const lines: Record<string, unknown>[] = [];
    let buffer = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          lines.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
        }
      }
    })();

    world.router.enqueue({ kind: "text", text: "Hello over HTTP.", chunks: 2 });
    const sent = await fetch(`${served.base}/chats/${chatId}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ clientId: crypto.randomUUID(), text: "hi there", attachments: [] }) });
    assert.equal(sent.status, 202);
    const accepted = await json(sent);
    assert.equal(typeof accepted.turnId, "string");
    await world.idle(chatId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lines[0].type, "stream.ready");
    assert.equal(lines.at(-1)?.type, "turn.completed");
    assert.ok(lines.some((line) => line.type === "message.delta"));

    const rows = await json(await fetch(`${served.base}/chats/${chatId}/rows`, { headers: auth }));
    assert.deepEqual((rows.rows as { kind: string }[]).map((row) => row.kind), ["user", "assistant"]);
    assert.equal(rows.tailSeq, lines.at(-1)?.seq);
    assert.equal(rows.epoch, world.engine.epoch);
    const page = await json(await fetch(`${served.base}/chats/${chatId}/rows?limit=1`, { headers: auth }));
    assert.equal((page.rows as unknown[]).length, 1);
    assert.equal(typeof page.nextBefore, "string");
    const older = await json(await fetch(`${served.base}/chats/${chatId}/rows?limit=1&before=${encodeURIComponent(String(page.nextBefore))}`, { headers: auth }));
    assert.equal((older.rows as { kind: string }[])[0].kind, "user");
    assert.equal((await fetch(`${served.base}/chats/${chatId}/rows?before=nope`, { headers: auth })).status, 400);

    assert.equal((await fetch(`${served.base}/chats/${chatId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ title: "Greeting" }) })).status, 200);
    assert.equal((await fetch(`${served.base}/chats/${chatId}/open`, { method: "POST", headers: auth })).status, 200);
    const list = await json(await fetch(`${served.base}/chats?botId=${DEFAULT_BOT_ID}`, { headers: auth }));
    assert.equal(list.current, chatId);
    assert.equal((list.chats as { title: string }[])[0].title, "Greeting");
    const search = await json(await fetch(`${served.base}/chats/search?q=hello%20over`, { headers: auth }));
    assert.equal((search.hits as unknown[]).length, 1);
    const status = await json(await fetch(`${served.base}/status`, { headers: auth }));
    assert.equal((status.chats as { chatId: string }[])[0].chatId, chatId);

    const cancelled = await fetch(`${served.base}/chats/${chatId}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancelled.status, 202);
    const deleted = await json(await fetch(`${served.base}/chats/${chatId}`, { method: "DELETE", headers: auth }));
    assert.deepEqual([deleted.ok, deleted.current], [true, null]);
    await reader.cancel();
    await pump.catch(() => undefined);
  });
});

test("the stream sends a ping on its interval, replays from `after`, and lets go when the client leaves", async () => {
  await withServed(async (world, served) => {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "one" });
    world.send(chatId, "first");
    await world.idle(chatId);
    const tail = world.engine.host.chat(chatId).bus.tailSeq;
    const controller = new AbortController();
    const stream = await fetch(`${served.base}/chats/${chatId}/events?after=${tail - 2}&epoch=${world.engine.epoch}`, { headers: auth, signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!text.includes('"type":"ping"') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    const seen = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(seen[0].type, "stream.ready");
    assert.equal(seen[0].resync, false);
    assert.deepEqual(seen.slice(1, 3).map((line) => line.seq), [tail - 1, tail], "the two events after the client's position are replayed");
    const ping = seen.find((line) => line.type === "ping");
    assert.ok(ping);
    assert.equal(ping.seq, tail, "a ping carries the current seq");
    assert.equal(world.engine.host.chat(chatId).bus.subscriberCount, 1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(world.engine.host.chat(chatId).bus.subscriberCount, 0, "the subscription is released");
    assert.equal((await fetch(`${served.base}/chats/nope/events`, { headers: auth })).status, 404, "an unknown chat is a 404 before any stream starts");
  }, 40);
});

test("the internal routes: filed rows, system turns, bot context and routine runs", async () => {
  await withServed(async (world, served) => {
    const chatId = world.newChat();
    const post = (path: string, body: unknown) => fetch(`${served.base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    const filed = await post(`/internal/bots/${DEFAULT_BOT_ID}/rows`, { chatId, key: "note:connected-gmail", kind: "note", text: "Connected Gmail." });
    assert.equal(filed.status, 200);
    assert.deepEqual(await json(filed), { chatId, rowId: "note:connected-gmail" });
    await post(`/internal/bots/${DEFAULT_BOT_ID}/rows`, { chatId, key: "note:connected-gmail", kind: "note", text: "Connected Gmail." });
    const rows = world.engine.rows(chatId, {}).rows;
    assert.equal(rows.length, 1, "filing the same key twice adds one row");
    assert.equal((rows[0] as { source: string }).source, "connect");
    assert.equal((await post(`/internal/bots/${DEFAULT_BOT_ID}/rows`, { chatId, key: "x", kind: "nonsense" })).status, 400);
    assert.equal((await post(`/internal/bots/${DEFAULT_BOT_ID}/rows`, { chatId, key: "w", kind: "widget", widgetId: "w1" })).status, 400, "a widget row needs its call and connection");
    assert.equal((await post(`/internal/bots/no-such-bot/rows`, { key: "k", kind: "note", text: "t" })).status, 404);
    // No chat id: the bot's current chat.
    const current = await json(await post(`/internal/bots/${DEFAULT_BOT_ID}/rows`, { key: "card:p1", kind: "card", proposalId: "p1" }));
    assert.equal(current.chatId, chatId);

    world.router.enqueue({ kind: "text", text: "Welcome back." });
    const first = await json(await post(`/internal/bots/${DEFAULT_BOT_ID}/system-turn`, { key: "resume-1", text: "Gmail is connected.", note: "Connected Gmail." }));
    assert.equal(first.chatId, chatId);
    assert.equal(first.queued, false);
    await world.idle(chatId);
    const again = await json(await post(`/internal/bots/${DEFAULT_BOT_ID}/system-turn`, { key: "resume-1", text: "Gmail is connected.", note: "Connected Gmail." }));
    assert.equal(again.turnId, first.turnId, "the same key is the same turn");
    await world.idle(chatId);
    assert.equal(world.router.requests.length, 1, "no second turn ran");

    const context = await json(await fetch(`${served.base}/internal/bots/${DEFAULT_BOT_ID}/context`, { headers: auth }));
    assert.deepEqual(Object.keys(context).sort(), ["envelopeTokens", "instructionTokens", "windowTokens"]);
    assert.ok(Number(context.windowTokens) > Number(context.envelopeTokens));

    assert.equal((await post("/internal/routines/no-such-routine/run", {})).status, 404);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineUnavailableError,
  engineBotContext,
  engineFetch,
  engineHealthy,
  engineJson,
  engineNoteRow,
  engineRunRoutine,
  engineSystemTurn,
  engineWidgetRow,
} from "../../shared/engine-client.ts";
import { startStubEngine, withEnv, type StubEngine } from "./stub-engine.ts";

// Ways the web's engine client can fail: it sends a call without the bearer or
// with the wrong one, it leaks a cookie or an Origin the engine refuses, it
// reports a refusal as success, it lets a caller's abort pass for the engine
// being down, or it reads a down engine as healthy.

async function withEngine<T>(fn: (engine: StubEngine) => Promise<T>): Promise<T> {
  const engine = await startStubEngine();
  try {
    return await withEnv({ UB_ENGINE_PORT: String(engine.port), UB_ENGINE_TOKEN: engine.token }, () => fn(engine));
  } finally {
    await engine.close();
  }
}

test("every call carries the engine bearer and nothing the engine refuses", async () => {
  await withEngine(async (engine) => {
    await engineNoteRow("bot-useful", "connect:1", "Connected Gmail.");
    await engineSystemTurn("bot-useful", "connect:1", "go on");
    await engineBotContext("bot-useful");
    await engineRunRoutine("rtn_1");
    assert.equal(engine.requests.length, 4);
    for (const request of engine.requests) {
      assert.equal(request.headers.authorization, `Bearer ${engine.token}`, request.path);
      assert.equal(request.headers.origin, undefined, request.path);
      assert.match(request.headers.host ?? "", /^127\.0\.0\.1:\d+$/, request.path);
    }
  });
});

test("the engine refuses a wrong token, and the client reports the refusal, not success", async () => {
  await withEngine(async (engine) => {
    await withEnv({ UB_ENGINE_TOKEN: "not-the-token" }, async () => {
      const res = await engineJson("/status");
      assert.equal(res.status, 401);
      assert.equal(res.ok, false);
      assert.equal(res.body.error, "unauthorized");
      await assert.rejects(engineNoteRow("bot-useful", "k", "t"), /engine_rows_401/);
      assert.equal(await engineSystemTurn("bot-useful", "k", "t"), false);
    });
    assert.equal(engine.requests.length, 3);
  });
});

test("a note row goes to the bot's rows route keyed, as a connect note", async () => {
  await withEngine(async (engine) => {
    await engineNoteRow("bot/odd id", "connect:7", "Connected Gmail.");
    const sent = engine.requests[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/internal/bots/bot%2Fodd%20id/rows");
    assert.deepEqual(JSON.parse(sent.body), { key: "connect:7", kind: "note", text: "Connected Gmail.", source: "connect" });
    assert.equal(sent.headers["content-type"], "application/json");
  });
});

test("a widget row names its chat, its widget and its call, keyed by the call", async () => {
  await withEngine(async (engine) => {
    await engineWidgetRow("bot-useful", "chat-1", "call_abc12345", "call_abc12345");
    assert.deepEqual(JSON.parse(engine.requests[0].body), { chatId: "chat-1", key: "widget:call_abc12345", kind: "widget", widgetId: "call_abc12345", callId: "call_abc12345" });
    engine.answer("POST", "/internal/bots/bot-useful/rows", 404, { ok: false, error: "chat_not_found" });
    await assert.rejects(engineWidgetRow("bot-useful", "chat-gone", "call_abc12345", "call_abc12345"), /engine_rows_404/);
  });
});

test("a system turn sends its key and text, and a note only when there is one; it reports whether the engine took it", async () => {
  await withEngine(async (engine) => {
    assert.equal(await engineSystemTurn("bot-useful", "connect:9", "go on"), true);
    assert.equal(await engineSystemTurn("bot-useful", "connect:9", "go on", "Connected."), true);
    assert.deepEqual(JSON.parse(engine.requests[0].body), { key: "connect:9", text: "go on" });
    assert.deepEqual(JSON.parse(engine.requests[1].body), { key: "connect:9", text: "go on", note: "Connected." });
    engine.answer("POST", "/internal/bots/bot-useful/system-turn", 503, { ok: false, error: "engine_starting" });
    assert.equal(await engineSystemTurn("bot-useful", "connect:9", "go on"), false);
  });
});

test("the routine run and the context come back as the engine answered them", async () => {
  await withEngine(async (engine) => {
    const run = await engineRunRoutine("rtn_1");
    assert.equal(run.status, 202);
    assert.equal(run.body.queued, false);
    engine.answer("POST", "/internal/routines/rtn_1/run", 409, { ok: false, error: "routine_busy" });
    const busy = await engineRunRoutine("rtn_1");
    assert.deepEqual([busy.status, busy.ok, busy.body.error], [409, false, "routine_busy"]);
    const context = await engineBotContext("bot-useful");
    assert.deepEqual(context.body, { ok: true, windowTokens: 32768, instructionTokens: 900, envelopeTokens: 9000 });
  });
});

test("health needs no token, and is false for an engine that is down", async () => {
  const engine = await startStubEngine();
  const port = engine.port;
  await withEnv({ UB_ENGINE_PORT: String(port) }, async () => {
    const saved = process.env.UB_ENGINE_TOKEN;
    delete process.env.UB_ENGINE_TOKEN;
    try {
      assert.equal(await engineHealthy(), true);
      assert.equal(engine.requests.at(-1)?.headers.authorization, undefined);
    } finally {
      if (saved !== undefined) process.env.UB_ENGINE_TOKEN = saved;
    }
  });
  await engine.close();
  await withEnv({ UB_ENGINE_PORT: String(port) }, async () => {
    assert.equal(await engineHealthy(), false);
  });
});

test("a down engine is EngineUnavailableError, a caller's own abort is not, and a missing token fails loud", async () => {
  const engine = await startStubEngine();
  const port = engine.port;
  await engine.close();
  await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
    await assert.rejects(engineFetch("/status"), (error: unknown) => error instanceof EngineUnavailableError && error.message === "engine_unavailable");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(engineFetch("/status", { signal: controller.signal }), (error: unknown) => !(error instanceof EngineUnavailableError));
    const saved = process.env.UB_ENGINE_TOKEN;
    delete process.env.UB_ENGINE_TOKEN;
    try {
      await assert.rejects(engineFetch("/status"), /engine_credential_missing/);
    } finally {
      if (saved !== undefined) process.env.UB_ENGINE_TOKEN = saved;
    }
  });
});

test("a body that is not JSON reads as engine_error with the engine's status", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => { res.writeHead(502); res.end("bad gateway"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
      const res = await engineJson("/status");
      assert.deepEqual([res.status, res.ok, res.body], [502, false, { ok: false, error: "engine_error" }]);
    });
  } finally {
    server.close();
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "../../web/lib/api-guard.ts";
import { engineQuery, relayJson, relayStream, safeId } from "../../web/lib/engine-proxy.ts";
import { startStubEngine, withEnv, type StubEngine } from "./stub-engine.ts";

// Ways the chat relay can fail:
// 1. a write goes through without the session's CSRF token, or past the rate limit;
// 2. an oversize or malformed body reaches the engine instead of being refused here;
// 3. the engine sees the browser's cookie, CSRF token or Origin, or loses its bearer;
// 4. an engine answer is changed on the way back (status, typed code, retryAfterMs);
// 5. the event stream is buffered, cut at a deadline, or keeps the engine's side open after the client goes;
// 6. a path or query value from the URL reaches the engine unchecked;
// 7. an engine that is down surfaces as a 500 or a hang instead of 503 engine_unavailable.

const SESSION = { csrf: "csrf-token", callerId: "caller-proxy" };
const CHAT = "c4a7f00d-1111-4111-8111-111111111111";
const CLIENT_ID = "c1c1c1c1-0000-4000-8000-0000000000c1";
let callers = 0;
const session = () => ({ csrf: SESSION.csrf, callerId: `${SESSION.callerId}-${(callers += 1)}` });

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:4420${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ub-csrf": SESSION.csrf, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withEngine<T>(fn: (engine: StubEngine) => Promise<T>): Promise<T> {
  const engine = await startStubEngine();
  try {
    return await withEnv({ UB_ENGINE_PORT: String(engine.port), UB_ENGINE_TOKEN: engine.token }, () => fn(engine));
  } finally {
    await engine.close();
  }
}

const turn = (over: Record<string, unknown> = {}) => ({ clientId: CLIENT_ID, text: "hello", attachments: [], ...over });
const PNG = `data:image/png;base64,${Buffer.from("png-bytes-for-a-test").toString("base64")}`;

test("a write needs the session's CSRF token, and a missing or wrong one never reaches the engine", async () => {
  await withEngine(async (engine) => {
    for (const headers of [{ "x-ub-csrf": "" }, { "x-ub-csrf": "wrong" }]) {
      const res = await relayJson(post(`/api/chats/${CHAT}/cancel`, {}, headers), session(), { method: "POST", path: `/chats/${CHAT}/cancel` });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { ok: false, error: "csrf" });
    }
    assert.equal(engine.requests.length, 0);
  });
});

test("writes are rate limited per caller at 60 a minute, and a read is not counted", async () => {
  await withEngine(async (engine) => {
    const caller = session();
    let limited = 0;
    for (let index = 0; index < 62; index += 1) {
      const res = await relayJson(post(`/api/chats/${CHAT}/open`, {}), caller, { method: "POST", path: `/chats/${CHAT}/open` });
      if (res.status === 429) {
        limited += 1;
        assert.deepEqual(await res.json(), { ok: false, error: "rate_limited" });
      }
    }
    assert.equal(limited, 2);
    assert.equal(engine.requests.length, 60);
    for (let index = 0; index < 5; index += 1) {
      const read = await relayJson(new Request("http://127.0.0.1:4420/api/engine/status"), caller, { method: "GET", path: "/status" });
      assert.equal(read.status, 200);
    }
  });
});

test("a body must be JSON, and one over the cap is refused before it is parsed", async () => {
  await withEngine(async (engine) => {
    const plain = new Request("http://127.0.0.1:4420/api/chats", { method: "POST", headers: { "content-type": "text/plain", "x-ub-csrf": SESSION.csrf }, body: "{}" });
    assert.equal((await relayJson(plain, session(), { method: "POST", path: "/chats", body: "json" })).status, 415);
    const big = post("/api/chats", { botId: "bot-useful", pad: "x".repeat(300 * 1024) });
    const refused = await relayJson(big, session(), { method: "POST", path: "/chats", body: "json" });
    assert.equal(refused.status, 413);
    assert.equal((await refused.json()).error, "payload_too_large");
    const huge = post(`/api/chats/${CHAT}/turns`, turn({ text: "x".repeat(9 * 1024 * 1024) }));
    assert.equal((await relayJson(huge, session(), { method: "POST", path: `/chats/${CHAT}/turns`, body: "turn" })).status, 413);
    const garbage = post("/api/chats", "{not json");
    assert.equal((await relayJson(garbage, session(), { method: "POST", path: "/chats", body: "json" })).status, 400);
    const array = post("/api/chats", "[]");
    assert.equal((await relayJson(array, session(), { method: "POST", path: "/chats", body: "json" })).status, 400);
    assert.equal(engine.requests.length, 0);
  });
});

test("a turn body is validated here: every malformed one is a 400 with a code and never reaches the engine", async () => {
  await withEngine(async (engine) => {
    const attachment = (over: Record<string, unknown> = {}) => ({ name: "notes.txt", mediaType: "text/plain", size: 5, text: "hello", ...over });
    const cases: Array<[string, unknown, string]> = [
      ["no client id", turn({ clientId: undefined }), "client_id_invalid"],
      ["client id not a uuid", turn({ clientId: "not-a-uuid" }), "client_id_invalid"],
      ["text not a string", turn({ text: 7 }), "turn_text_invalid"],
      ["text over 64k", turn({ text: "x".repeat(64 * 1024 + 1) }), "turn_text_invalid"],
      ["nothing to send", turn({ text: "   " }), "turn_empty"],
      ["retry that is not true", turn({ retry: "yes" }), "turn_invalid"],
      ["a body that is not an object", [1, 2], "turn_invalid"],
      ["six attachments", turn({ attachments: Array.from({ length: 6 }, () => attachment()) }), "attachment_invalid"],
      ["attachments not a list", turn({ attachments: "notes.txt" }), "attachment_invalid"],
      ["a credential-looking name", turn({ attachments: [attachment({ name: ".env" })] }), "attachment_invalid"],
      ["a name with a path in it", turn({ attachments: [attachment({ name: "../../etc/passwd" })] }), "attachment_invalid"],
      ["a size past the cap", turn({ attachments: [attachment({ size: 2 * 1024 * 1024 })] }), "attachment_invalid"],
      ["a media type that is not one", turn({ attachments: [attachment({ mediaType: "text/plain\nx" })] }), "attachment_invalid"],
      ["text past 64k", turn({ attachments: [attachment({ text: "x".repeat(64 * 1024 + 1) })] }), "attachment_invalid"],
      ["a data url that is not an image", turn({ attachments: [attachment({ text: undefined, mediaType: "image/png", dataUrl: "data:text/html;base64,AAAA" })] }), "attachment_invalid"],
      ["a data url whose type differs from the declared one", turn({ attachments: [attachment({ text: undefined, mediaType: "image/jpeg", dataUrl: PNG })] }), "attachment_invalid"],
      ["both text and pixels", turn({ attachments: [attachment({ mediaType: "image/png", dataUrl: PNG })] }), "attachment_invalid"],
    ];
    for (const [name, body, code] of cases) {
      const res = await relayJson(post(`/api/chats/${CHAT}/turns`, body), session(), { method: "POST", path: `/chats/${CHAT}/turns`, body: "turn" });
      assert.equal(res.status, 400, name);
      assert.deepEqual(await res.json(), { ok: false, error: code }, name);
    }
    assert.equal(engine.requests.length, 0);
  });
});

test("a good turn is relayed rebuilt from its validated fields, with the engine's bearer and nothing of the browser's", async () => {
  await withEngine(async (engine) => {
    const body = turn({
      retry: true,
      text: "look at these",
      botId: "bot-smuggled",
      extra: { hidden: true },
      attachments: [
        { name: "notes.txt", mediaType: "text/plain", size: 5, text: "hello", smuggled: "x" },
        { name: "shot.png", mediaType: "image/png", size: 20, dataUrl: PNG },
        { name: "data.bin", mediaType: "application/octet-stream", size: 9 },
      ],
    });
    const request = post(`/api/chats/${CHAT}/turns`, body, { cookie: "ub_session=secret", authorization: "Bearer browser-token", origin: "http://127.0.0.1:4420" });
    const res = await relayJson(request, session(), { method: "POST", path: `/chats/${CHAT}/turns`, body: "turn" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, turnId: "7a1e0001-0000-4000-8000-00000000a009" });
    const seen = engine.requests.at(-1)!;
    assert.equal(seen.path, `/chats/${CHAT}/turns`);
    assert.equal(seen.headers.authorization, `Bearer ${engine.token}`);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers["x-ub-csrf"], undefined);
    assert.equal(seen.headers.origin, undefined);
    assert.deepEqual(JSON.parse(seen.body), {
      clientId: CLIENT_ID,
      text: "look at these",
      attachments: [
        { name: "notes.txt", mediaType: "text/plain", size: 5, text: "hello" },
        { name: "shot.png", mediaType: "image/png", size: 20, dataUrl: PNG },
        { name: "data.bin", mediaType: "application/octet-stream", size: 9 },
      ],
      retry: true,
    });
  });
});

test("a retry may carry no text: the engine already holds the failed message", async () => {
  await withEngine(async (engine) => {
    const res = await relayJson(post(`/api/chats/${CHAT}/turns`, turn({ text: "", retry: true })), session(), { method: "POST", path: `/chats/${CHAT}/turns`, body: "turn" });
    assert.equal(res.status, 202);
    assert.equal(JSON.parse(engine.requests.at(-1)!.body).retry, true);
  });
});

test("the engine's status and body come back unchanged: refusals, a busy chat and a retry delay", async () => {
  await withEngine(async (engine) => {
    const path = `/chats/${CHAT}/turns`;
    const send = () => relayJson(post(`/api/chats/${CHAT}/turns`, turn()), session(), { method: "POST", path, body: "turn" });
    for (const [status, body] of [
      [400, { ok: false, error: "model_no_vision" }],
      [400, { ok: false, error: "provider_route_retired", message: "That plan is no longer offered." }],
      [409, { ok: false, error: "context_too_large" }],
      [429, { ok: false, error: "retry_too_soon", retryAfterMs: 4000 }],
      [404, { ok: false, error: "chat_not_found" }],
      [503, { ok: false, error: "engine_starting" }],
    ] as const) {
      engine.answer("POST", path, status, body);
      const res = await send();
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), body);
    }
    engine.answer("DELETE", `/chats/${CHAT}`, 409, { ok: false, error: "chat_busy" });
    const busy = await relayJson(new Request(`http://127.0.0.1:4420/api/chats/${CHAT}`, { method: "DELETE", headers: { "x-ub-csrf": SESSION.csrf } }), session(), { method: "DELETE", path: `/chats/${CHAT}` });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { ok: false, error: "chat_busy" });
  });
});

test("an engine answer that is not JSON reads as engine_error and keeps no engine text", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => { res.writeHead(500, { "content-type": "text/html" }); res.end("<h1>stack trace at /Users/owner/secret</h1>"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
      const res = await relayJson(new Request("http://127.0.0.1:4420/api/engine/status"), session(), { method: "GET", path: "/status" });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { ok: false, error: "engine_error" });
    });
  } finally {
    server.close();
  }
});

test("an engine that is down is 503 engine_unavailable on a read, a write and the stream, and a missing token is 503 too", async () => {
  const engine = await startStubEngine();
  const port = engine.port;
  await engine.close();
  await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
    const read = await relayJson(new Request("http://127.0.0.1:4420/api/engine/status"), session(), { method: "GET", path: "/status" });
    assert.equal(read.status, 503);
    assert.deepEqual(await read.json(), { ok: false, error: "engine_unavailable" });
    const write = await relayJson(post(`/api/chats/${CHAT}/turns`, turn()), session(), { method: "POST", path: `/chats/${CHAT}/turns`, body: "turn" });
    assert.equal(write.status, 503);
    assert.deepEqual(await write.json(), { ok: false, error: "engine_unavailable" });
    const stream = await relayStream(new Request(`http://127.0.0.1:4420/api/chats/${CHAT}/events`), `/chats/${CHAT}/events`);
    assert.equal(stream.status, 503);
    assert.deepEqual(await stream.json(), { ok: false, error: "engine_unavailable" });
  });
  await withEnv({ UB_ENGINE_PORT: String(port) }, async () => {
    const saved = process.env.UB_ENGINE_TOKEN;
    delete process.env.UB_ENGINE_TOKEN;
    try {
      const res = await relayJson(new Request("http://127.0.0.1:4420/api/engine/status"), session(), { method: "GET", path: "/status" });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: "engine_credential_missing" });
    } finally {
      if (saved !== undefined) process.env.UB_ENGINE_TOKEN = saved;
    }
  });
});

test("the event stream is relayed as it arrives, as NDJSON, with the engine's lines whole and in order", async () => {
  await withEngine(async (engine) => {
    const controller = new AbortController();
    const request = new Request(`http://127.0.0.1:4420/api/chats/${CHAT}/events?after=0&epoch=e7a1c0de`, { signal: controller.signal });
    const res = await relayStream(request, `/chats/${CHAT}/events${engineQuery(request, { after: "int", epoch: "cursor" })}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The first lines arrive while the stub still has lines to send and its stream is open:
    // nothing waited for the stream to end (it never does).
    while (text.split("\n").filter(Boolean).length < 3) {
      const { done, value } = await reader.read();
      assert.equal(done, false, "the stream ended on its own");
      text += decoder.decode(value, { stream: true });
    }
    assert.equal(engine.streams.open, 1);
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; seq?: number });
    assert.equal(lines[0].type, "stream.ready");
    const seqs = lines.map((line) => line.seq).filter((seq): seq is number => typeof seq === "number");
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(engine.requests.at(-1)!.query.get("after"), "0");
    assert.equal(engine.requests.at(-1)!.query.get("epoch"), "e7a1c0de");
    assert.equal(engine.requests.at(-1)!.headers.authorization, `Bearer ${engine.token}`);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

test("the client closing the event stream closes the engine's side too", async () => {
  await withEngine(async (engine) => {
    const controller = new AbortController();
    const request = new Request(`http://127.0.0.1:4420/api/chats/${CHAT}/events`, { signal: controller.signal });
    const res = await relayStream(request, `/chats/${CHAT}/events`);
    const reader = res.body!.getReader();
    await reader.read();
    assert.equal(engine.streams.open, 1);
    controller.abort();
    await reader.read().catch(() => undefined);
    const deadline = Date.now() + 2_000;
    while (engine.streams.open > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engine.streams.open, 0, "the engine's stream is still open after the client left");
    assert.equal(engine.streams.closedByClient, 1);
  });
});

test("an engine refusal on the stream comes back as JSON, not as an empty stream", async () => {
  await withEngine(async (engine) => {
    engine.answer("GET", `/chats/${CHAT}/events`, 404, { ok: false, error: "chat_not_found" });
    const res = await relayStream(new Request(`http://127.0.0.1:4420/api/chats/${CHAT}/events`), `/chats/${CHAT}/events`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, error: "chat_not_found" });
  });
});

test("the stream has no deadline of its own: it asks the engine client for none", () => {
  const source = readFileSync(new URL("../../web/lib/engine-proxy.ts", import.meta.url), "utf8");
  assert.match(source, /relayStream[\s\S]*timeoutMs: null/);
});

test("a path id must be a plain id: no traversal, no slash, no overlong value", () => {
  assert.equal(safeId(CHAT), CHAT);
  assert.equal(safeId("bot-useful"), "bot-useful");
  for (const bad of ["..", "../x", "a/b", "a b", "", "x".repeat(81), "a?b", "a%2Fb", 7, null, undefined]) {
    assert.equal(safeId(bad), null, String(bad));
  }
});

test("only the allowed query values reach the engine, each held to its shape", () => {
  const request = (query: string) => new Request(`http://127.0.0.1:4420/api/chats?${query}`);
  const allowed = { botId: "id", before: "cursor", limit: "int", includeFixtures: "flag", q: "text" } as const;
  assert.equal(engineQuery(request("botId=bot-useful&limit=60&before=row-1"), allowed), "?botId=bot-useful&before=row-1&limit=60");
  assert.equal(engineQuery(request("botId=..%2Fx&limit=-1&before=a%20b&includeFixtures=0&evil=1"), allowed), "");
  assert.equal(engineQuery(request("includeFixtures=1"), allowed), "?includeFixtures=1");
  assert.equal(engineQuery(request(`q=${"x".repeat(201)}`), allowed), "");
  assert.equal(engineQuery(request("q=find%20me"), allowed), "?q=find+me");
  assert.equal(engineQuery(request("limit=99999999999"), allowed), "");
});

test("a checkBody that throws an ApiError is that status and code, and the engine hears nothing", async () => {
  await withEngine(async (engine) => {
    const res = await relayJson(post("/api/chats", { botId: "../x" }), session(), {
      method: "POST",
      path: "/chats",
      body: "json",
      checkBody: (body) => {
        if (safeId(body.botId) === null) throw new ApiError(400, "bot_required");
        return body;
      },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "bot_required" });
    assert.equal(engine.requests.length, 0);
  });
});

test("every chat route calls the relay, keeps the owner gate first, and takes the id through safeId", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const routes = [
    "web/app/api/chats/route.ts",
    "web/app/api/chats/search/route.ts",
    "web/app/api/chats/[chatId]/route.ts",
    "web/app/api/chats/[chatId]/open/route.ts",
    "web/app/api/chats/[chatId]/rows/route.ts",
    "web/app/api/chats/[chatId]/events/route.ts",
    "web/app/api/chats/[chatId]/turns/route.ts",
    "web/app/api/chats/[chatId]/cancel/route.ts",
    "web/app/api/engine/status/route.ts",
  ];
  for (const path of routes) {
    const source = read(path);
    assert.match(source, /requireOwner\(request\)/, path);
    assert.match(source, /relay(Json|Stream)\(/, path);
    assert.ok(source.indexOf("requireOwner(") < source.search(/relay(Json|Stream)\(/), `${path}: the gate comes first`);
    if (path.includes("[chatId]")) assert.match(source, /safeId\(/, path);
  }
  assert.match(read("web/app/api/chats/[chatId]/turns/route.ts"), /body: "turn"/);
});

test("Stop still reaches the engine after the write bucket is spent: control writes have their own bucket", async () => {
  await withEngine(async (engine) => {
    const caller = session();
    for (let index = 0; index < 61; index += 1) {
      await relayJson(post(`/api/chats/${CHAT}/rename`, {}), caller, { method: "POST", path: `/chats/${CHAT}/open` });
    }
    const before = engine.requests.length;
    const stop = await relayJson(post(`/api/chats/${CHAT}/cancel`, {}), caller, { method: "POST", path: `/chats/${CHAT}/cancel`, bucket: "control" });
    assert.notEqual(stop.status, 429);
    assert.equal(engine.requests.length, before + 1);
  });
});

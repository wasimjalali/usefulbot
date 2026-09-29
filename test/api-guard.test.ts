import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, rateLimitBucketCount, rateLimited, readBody, readFormData, readJson } from "../web/lib/api-guard.ts";

const URL = "http://127.0.0.1:4320/api/x";

test("readBody rejects a body over the declared cap", async () => {
  const req = new Request(URL, { method: "POST", body: "abcdefghij" });
  await assert.rejects(() => readBody(req, 4), /payload_too_large/);
  const ok = new Request(URL, { method: "POST", body: "abcd" });
  assert.equal((await readBody(ok, 4)).byteLength, 4);
});

test("readBody caps a streamed body with no content-length", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abcdefghij"));
      controller.close();
    },
  });
  const req = new Request(URL, { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(() => readBody(req, 4), /payload_too_large/);
});

test("readJson enforces content type, size, and parsing", async () => {
  const ok = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(await readJson(ok), { a: 1 });

  const wrong = new Request(URL, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  await assert.rejects(() => readJson(wrong), /unsupported_media_type/);

  const bad = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  await assert.rejects(() => readJson(bad), /invalid_json/);

  const big = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ s: "x".repeat(1000) }),
  });
  await assert.rejects(() => readJson(big, 10), /payload_too_large/);
});

test("rateLimited throttles only after the burst", () => {
  const key = `test-${process.pid}-${Date.now()}`;
  assert.equal(rateLimited(key, 60, 2), false);
  assert.equal(rateLimited(key, 60, 2), false);
  assert.equal(rateLimited(key, 60, 2), true);
});

test("rateLimited evicts buckets idle for over ten minutes", () => {
  const base = Date.now();
  const idleA = `idle-a-${process.pid}-${base}`;
  const idleB = `idle-b-${process.pid}-${base}`;
  rateLimited(idleA, 60, 1, base);
  rateLimited(idleB, 60, 1, base);
  // A later call, past the idle window, sweeps both away before adding its own.
  rateLimited(`idle-c-${process.pid}-${base}`, 60, 1, base + 11 * 60_000);
  assert.equal(rateLimitBucketCount(), 1);
});

test("readFormData bounds a multipart body before it is parsed", async () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(64)], "a.txt", { type: "text/plain" }));
  const req = new Request(URL, { method: "POST", body: form });
  const parsed = await readFormData(req, 4096);
  const file = parsed.get("file");
  assert.equal(file instanceof File, true);
  assert.equal((file as File).name, "a.txt");

  // A chunked upload carries no content-length, so readBody has to cap the
  // stream; this is the path the old declared-length-only gate missed.
  const big = new FormData();
  big.set("file", new File([new Uint8Array(5000)], "b.txt", { type: "text/plain" }));
  const bigReq = new Request(URL, { method: "POST", body: big });
  await assert.rejects(() => readFormData(bigReq, 1024), /payload_too_large/);

  const wrong = new Request(URL, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hi",
  });
  await assert.rejects(() => readFormData(wrong, 1024), /unsupported_media_type/);
});

test("errorCode keeps short codes and strips free-form errors", () => {
  assert.equal(errorCode(new Error("shell_bot_session")), "shell_bot_session");
  assert.equal(errorCode(new Error("approval_not_found:apr_1")), "approval_not_found:apr_1");
  assert.equal(errorCode(new Error("approvals_locked"), "approval_error"), "approvals_locked");
  assert.equal(
    errorCode(new Error("ENOENT: no such file or directory, open '/Users/x/.useful-bot/shell.json'")),
    "invalid",
  );
  assert.equal(errorCode(new Error("Unexpected token 'o'"), "shell_unavailable"), "shell_unavailable");
  assert.equal(errorCode(undefined, "fallback"), "fallback");
});

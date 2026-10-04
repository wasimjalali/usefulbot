import assert from "node:assert/strict";
import test from "node:test";
import { requestSignal } from "../router/src/request-signal.ts";

// Ways the streaming deadline can fail:
// 1. A stream that keeps producing is cut at the old 3 minute cap (the incident).
// 2. The upstream never answers, and nothing ends the wait before the backstop.
// 3. The backstop is gone, so a stream that never ends is never cut.
// 4. A cut is not labelled a TimeoutError, so abortKind reports "other".
// 5. A client disconnect is lost behind the timers.
// 6. The header timer outlives the headers and kills a healthy stream.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a stream that flows past the header cap is not cut", async () => {
  const controller = new AbortController();
  const guard = requestSignal(controller, { headerMs: 40, totalMs: 1_000 });
  await wait(10);
  guard.headersArrived();
  await wait(120);
  assert.equal(guard.signal.aborted, false);
  guard.dispose();
});

test("no headers by the header cap aborts as a timeout", async () => {
  const controller = new AbortController();
  const guard = requestSignal(controller, { headerMs: 30, totalMs: 1_000 });
  await wait(100);
  assert.equal(guard.signal.aborted, true);
  assert.equal((guard.signal.reason as { name?: string }).name, "TimeoutError");
  guard.dispose();
});

test("the total backstop still ends a stream that never stops", async () => {
  const controller = new AbortController();
  const guard = requestSignal(controller, { headerMs: 30, totalMs: 80 });
  guard.headersArrived();
  await wait(150);
  assert.equal(guard.signal.aborted, true);
  assert.equal((guard.signal.reason as { name?: string }).name, "TimeoutError");
  guard.dispose();
});

test("a client disconnect aborts with its own reason", () => {
  const controller = new AbortController();
  const guard = requestSignal(controller, { headerMs: 1_000, totalMs: 1_000 });
  controller.abort(new Error("client_disconnect"));
  assert.equal(guard.signal.aborted, true);
  assert.equal((guard.signal.reason as Error).message, "client_disconnect");
  guard.dispose();
});

test("dispose stops the header timer from aborting later", async () => {
  const controller = new AbortController();
  const guard = requestSignal(controller, { headerMs: 30, totalMs: 1_000 });
  guard.dispose();
  await wait(80);
  assert.equal(controller.signal.aborted, false);
});

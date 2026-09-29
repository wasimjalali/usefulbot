import assert from "node:assert/strict";
import test from "node:test";
import { readHandoffStream } from "../web/lib/agent-exec.ts";

type FakeEvent = { type: string; data?: Record<string, unknown>; meta?: { id?: string } };

function sse(events: FakeEvent[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("handoff stream throws when its envelope never echoes back", async () => {
  await assert.rejects(
    () => readHandoffStream(sse([
      { type: "message.received", data: { message: "someone else" }, meta: { id: "x1" } },
      { type: "turn.completed", data: {}, meta: { id: "x2" } },
    ]), new AbortController().signal, new Set(), "expected"),
    /envelope_mismatch/,
  );
});

test("handoff stream ignores replayed history and collects the reply", async () => {
  const reply = await readHandoffStream(sse([
    // Arms only on the exact envelope for this delivery.
    { type: "message.received", data: { message: "expected" }, meta: { id: "r1" } },
    // A completed event already in the history skip set must not overwrite.
    { type: "message.completed", data: { message: "stale reply" }, meta: { id: "old" } },
    { type: "message.appended", data: { messageDelta: "fresh " }, meta: { id: "r2" } },
    { type: "message.appended", data: { messageDelta: "reply" }, meta: { id: "r3" } },
    { type: "turn.completed", data: {}, meta: { id: "r4" } },
  ]), new AbortController().signal, new Set(["old"]), "expected");
  assert.equal(reply, "fresh reply");
});

test("handoff stream records an empty reply when the turn has no text", async () => {
  const reply = await readHandoffStream(sse([
    { type: "message.received", data: { message: "expected" }, meta: { id: "e1" } },
    { type: "turn.completed", data: {}, meta: { id: "e2" } },
  ]), new AbortController().signal, new Set(), "expected");
  assert.equal(reply, "");
});

test("the idle hook fires for replayed history too, so a long replay is not read as silence", async () => {
  let beats = 0;
  const reply = await readHandoffStream(sse([
    // Two events already in the skip set: progress, even though neither is new.
    { type: "message.completed", data: { message: "old" }, meta: { id: "h1" } },
    { type: "turn.completed", data: {}, meta: { id: "h2" } },
    { type: "message.received", data: { message: "expected" }, meta: { id: "n1" } },
    { type: "message.appended", data: { messageDelta: "ok" }, meta: { id: "n2" } },
    { type: "turn.completed", data: {}, meta: { id: "n3" } },
  ]), new AbortController().signal, new Set(["h1", "h2"]), "expected", () => { beats += 1; });
  assert.equal(reply, "ok");
  assert.equal(beats, 5);
});

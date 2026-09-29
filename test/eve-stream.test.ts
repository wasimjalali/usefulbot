import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEveEvent,
  consumeEveNdjson,
  createProjection,
  parseEveStreamLine,
} from "../shared/eve-stream.ts";

test("parseEveStreamLine reads NDJSON and data-prefix lines", () => {
  const ndjson = parseEveStreamLine('{"type":"message.appended","data":{"messageDelta":"Hi"}}');
  assert.equal(ndjson?.type, "message.appended");
  assert.equal(ndjson?.data?.messageDelta, "Hi");
  const sse = parseEveStreamLine('data: {"type":"session.waiting","data":{}}');
  assert.equal(sse?.type, "session.waiting");
  assert.equal(parseEveStreamLine(""), null);
  assert.equal(parseEveStreamLine("data: [DONE]"), null);
  assert.equal(parseEveStreamLine(": keepalive"), null);
  assert.equal(parseEveStreamLine("not-json"), null);
});

test("applyEveEvent streams deltas then replaces with completed text", () => {
  let state = createProjection();
  state = applyEveEvent(state, { type: "turn.started", data: { turnId: "turn_0" }, meta: { id: "e1" } });
  assert.equal(state.pending, true);
  state = applyEveEvent(state, {
    type: "message.received",
    data: { message: "hi" },
    meta: { id: "e2" },
  });
  state = applyEveEvent(state, {
    type: "message.appended",
    data: { messageDelta: "Hel" },
    meta: { id: "e3" },
  });
  state = applyEveEvent(state, {
    type: "message.appended",
    data: { messageDelta: "lo" },
    meta: { id: "e4" },
  });
  assert.equal(state.messages.at(-1)?.text, "Hello");
  state = applyEveEvent(state, {
    type: "message.completed",
    data: { message: "Hello there.", finishReason: "stop" },
    meta: { id: "e5" },
  });
  assert.equal(state.messages.filter((m) => m.role === "assistant").length, 1);
  assert.equal(state.messages.at(-1)?.text, "Hello there.");
  state = applyEveEvent(state, { type: "session.waiting", data: {}, meta: { id: "e6" } });
  assert.equal(state.pending, false);
});

test("applyEveEvent dedupes event ids and optimistic matching user text", () => {
  let state = createProjection();
  state = {
    ...state,
    messages: [{ role: "user", text: "hi", id: "local" }],
    pending: true,
  };
  state = applyEveEvent(state, {
    type: "message.received",
    data: { message: "hi" },
    meta: { id: "recv" },
  });
  assert.equal(state.messages.filter((m) => m.role === "user").length, 1);
  const once = applyEveEvent(state, {
    type: "message.appended",
    data: { messageDelta: "A" },
    meta: { id: "dup" },
  });
  const twice = applyEveEvent(once, {
    type: "message.appended",
    data: { messageDelta: "A" },
    meta: { id: "dup" },
  });
  assert.equal(twice.messages.at(-1)?.text, "A");
});

test("applyEveEvent cancel and failure settle pending", () => {
  let state = createProjection();
  state = applyEveEvent(state, { type: "turn.started", meta: { id: "t1" } });
  state = applyEveEvent(state, { type: "turn.cancelled", meta: { id: "t2" } });
  assert.equal(state.pending, false);
  state = applyEveEvent(state, { type: "turn.started", meta: { id: "t3" } });
  state = applyEveEvent(state, { type: "turn.failed", data: { message: "boom", code: "x" }, meta: { id: "t4" } });
  assert.equal(state.pending, false);
  assert.equal(state.error, "Turn failed");
  state = applyEveEvent(state, { type: "turn.started", meta: { id: "t5" } });
  state = applyEveEvent(state, { type: "session.completed", meta: { id: "t6" } });
  assert.equal(state.pending, false);
});

test("consumeEveNdjson emits parsed events from a chunked body", async () => {
  const events: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"type":"turn.started"}\n{"type":"mes'));
      controller.enqueue(encoder.encode('sage.appended","data":{"messageDelta":"Hi"}}\n'));
      controller.close();
    },
  });
  await consumeEveNdjson(stream, (event) => events.push(event.type));
  assert.deepEqual(events, ["turn.started", "message.appended"]);
});

test("action.result projects https search chips and ignores junk", () => {
  let state = createProjection();
  state = applyEveEvent(state, { type: "turn.started", meta: { id: "s1" } });
  state = applyEveEvent(state, {
    type: "action.result",
    data: {
      results: [
        { title: "Example", url: "https://example.com/a", snippet: "Hello" },
        { title: "bad", url: "javascript:alert(1)" },
        { title: "File", url: "http://127.0.0.1/docs", snippet: "local" },
      ],
    },
    meta: { id: "s2" },
  });
  assert.equal(state.searchHits.length, 2);
  assert.equal(state.searchHits[0].url, "https://example.com/a");
  assert.equal(state.searchHits[1].url, "http://127.0.0.1/docs");
  state = applyEveEvent(state, { type: "turn.started", meta: { id: "s3" } });
  assert.equal(state.searchHits.length, 0);
});

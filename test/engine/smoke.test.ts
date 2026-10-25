import assert from "node:assert/strict";
import test from "node:test";
import { makeWorld, types } from "./helpers.ts";

test("a plain turn streams, settles and shows up as rows", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "text", text: "Hello there, owner.", chunks: 3 });
    const sent = world.send(chatId, "Hi");
    assert.ok(sent.turnId);
    await world.idle(chatId);
    const kinds = types(recorder.events);
    assert.equal(kinds[0], "stream.ready");
    assert.ok(kinds.includes("turn.started"));
    assert.ok(kinds.includes("message.user"));
    assert.ok(kinds.includes("message.delta"));
    assert.ok(kinds.includes("message.final"));
    assert.equal(kinds.at(-1), "turn.completed");
    const page = world.engine.rows(chatId, {});
    assert.deepEqual(page.rows.map((row) => row.kind), ["user", "assistant"]);
    assert.equal(page.rows[0].rowId, `${sent.turnId}:u`);
    assert.equal(page.rows[1].rowId, `${sent.turnId}:a0`);
    assert.equal((page.rows[1] as { text: string }).text, "Hello there, owner.");
    assert.equal(page.running, null);
  } finally {
    await world.close();
  }
});

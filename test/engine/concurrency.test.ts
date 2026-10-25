import assert from "node:assert/strict";
import test from "node:test";
import { stableUuid } from "../../agent/lib/router-identity.ts";
import { makeWorld, waitForRequests } from "./helpers.ts";

/** One turn per chat; different chats run at the same time and never see each other's events. */

test("two chats run side by side, each on its own router session, and their events stay apart", async () => {
  const world = await makeWorld();
  try {
    const first = world.newChat();
    const second = world.newChat();
    const firstEvents = world.record(first);
    const secondEvents = world.record(second);
    world.router.fallback({ kind: "stall", text: "working" });
    world.send(first, "chat one");
    world.send(second, "chat two");
    await waitForRequests(world, 2);
    assert.equal(world.engine.host.chat(first).turn !== null && world.engine.host.chat(second).turn !== null, true, "both are running");
    assert.deepEqual(world.router.refused, [], "different sessions do not meet the one-call gate");
    const sessions = new Set(world.router.requests.map((request) => request.headers["x-useful-session-id"]));
    assert.deepEqual(sessions, new Set([stableUuid(`session:${first}`), stableUuid(`session:${second}`)]));
    const status = world.engine.status().chats;
    assert.equal(status.filter((chat) => chat.running !== null).length, 2);

    world.router.release();
    await world.idle(first);
    await world.idle(second);
    for (const [recorder, chatId, text] of [[firstEvents, first, "chat one"], [secondEvents, second, "chat two"]] as const) {
      assert.ok(recorder.events.every((event) => event.chatId === chatId), "no event from the other chat");
      assert.equal(recorder.events.find((event) => event.type === "message.user")?.text, text);
      assert.equal(recorder.events.at(-1)?.type, "turn.completed");
    }
  } finally {
    await world.close();
  }
});

test("Stop on one chat leaves the other running", async () => {
  const world = await makeWorld();
  try {
    const first = world.newChat();
    const second = world.newChat();
    world.router.fallback({ kind: "stall", text: "working" });
    world.send(first, "chat one");
    world.send(second, "chat two");
    await waitForRequests(world, 2);
    world.engine.cancel(first);
    await world.idle(first);
    assert.notEqual(world.engine.host.chat(second).turn, null, "the other turn is still going");
    world.router.release();
    await world.idle(second);
    assert.equal(world.engine.rows(second, {}).rows.at(-1)?.kind, "assistant");
    assert.equal(world.engine.status().chats.find((chat) => chat.chatId === first)?.lastTurn?.outcome, "cancelled");
  } finally {
    await world.close();
  }
});

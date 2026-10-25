import assert from "node:assert/strict";
import test from "node:test";
import { ChatBus, RING_SIZE } from "../../agent/engine/events.ts";
import type { EngineEvent } from "../../agent/engine/protocol.ts";
import { makeWorld, waitForRequests } from "./helpers.ts";

const EPOCH = "epoch-1";

function bus(): ChatBus {
  return new ChatBus("chat-1", EPOCH, () => new Date("2026-10-25T12:00:00.000Z"));
}

test("seq counts from 1 per chat, and the envelope carries the epoch, chat and turn", () => {
  const events = bus();
  const first = events.emit({ type: "turn.started", origin: "owner" }, "turn-1");
  const second = events.emit({ type: "message.delta", rowId: "turn-1:a0", delta: "hi" }, "turn-1");
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.deepEqual({ epoch: first.epoch, chatId: first.chatId, turnId: first.turnId, at: first.at }, { epoch: EPOCH, chatId: "chat-1", turnId: "turn-1", at: "2026-10-25T12:00:00.000Z" });
  assert.equal("turnId" in events.emit({ type: "row" }), false, "a chat-level event has no turn");
});

test("review 2: dropping the ring keeps seq and epoch, and an old reconnect is told to refetch", () => {
  const events = bus();
  for (let i = 0; i < 5; i += 1) events.emit({ type: "message.delta", rowId: "t:a0", delta: "x" });
  events.dropRing();
  assert.equal(events.tailSeq, 5, "seq carries on");
  assert.equal(events.bufferedEvents, 0);
  const stale = events.subscribe(() => undefined, { after: 2, epoch: EPOCH, running: null });
  assert.equal(stale.initial[0].resync, true);
  assert.equal(stale.initial.length, 1, "no replay");
  const current = events.subscribe(() => undefined, { after: 5, epoch: EPOCH, running: null });
  assert.equal(current.initial[0].resync, false, "a client that is fully caught up needs nothing");
  assert.equal(events.emit({ type: "row" }).seq, 6);
});

test("review 2: a chat that is evicted with nobody watching drops its event ring, and keeps it while a client is attached", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "one" });
    world.send(chatId, "go");
    await world.idle(chatId);
    const chat = world.engine.host.chat(chatId);
    assert.ok(chat.bus.bufferedEvents > 0);
    const watcher = world.record(chatId);
    chat.evict();
    assert.ok(chat.bus.bufferedEvents > 0, "a subscriber is attached");
    watcher.stop();
    chat.evict();
    assert.equal(chat.bus.bufferedEvents, 0);
    const reconnect = world.engine.subscribe(chatId, () => undefined, { after: 1, epoch: world.engine.epoch });
    assert.equal(reconnect.initial[0].resync, true);
    reconnect.unsubscribe();
  } finally {
    await world.close();
  }
});

test("stream.ready and ping carry the current seq and are never stored or counted", () => {
  const events = bus();
  events.emit({ type: "turn.started" });
  const seen: EngineEvent[] = [];
  const subscription = events.subscribe((event) => seen.push(event), { running: null });
  assert.equal(subscription.initial.length, 1);
  assert.deepEqual({ type: subscription.initial[0].type, seq: subscription.initial[0].seq, tailSeq: subscription.initial[0].tailSeq, resync: subscription.initial[0].resync, running: subscription.initial[0].running }, { type: "stream.ready", seq: 1, tailSeq: 1, resync: false, running: null });
  const ping = events.ping();
  assert.deepEqual([ping.type, ping.seq], ["ping", 1]);
  assert.equal(events.emit({ type: "turn.completed" }).seq, 2);
  assert.deepEqual(seen.map((event) => event.type), ["turn.completed"], "a ping is never sent to subscribers by the bus itself");
});

test("a client that is still inside the ring gets the events it missed, in order", () => {
  const events = bus();
  for (let i = 0; i < 10; i += 1) events.emit({ type: "message.delta", delta: String(i) });
  const subscription = events.subscribe(() => undefined, { after: 6, epoch: EPOCH, running: { turnId: "t" } });
  assert.equal(subscription.initial[0].resync, false);
  assert.deepEqual(subscription.initial[0].running, { turnId: "t" });
  assert.deepEqual(subscription.initial.slice(1).map((event) => event.seq), [7, 8, 9, 10]);
  const caughtUp = events.subscribe(() => undefined, { after: 10, epoch: EPOCH, running: null });
  assert.equal(caughtUp.initial.length, 1);
  assert.equal(caughtUp.initial[0].resync, false);
});

test("a client behind the ring, from another epoch, or from the future is told to refetch", () => {
  const events = bus();
  for (let i = 0; i < RING_SIZE + 50; i += 1) events.emit({ type: "message.delta" });
  assert.equal(events.subscribe(() => undefined, { after: 10, epoch: EPOCH, running: null }).initial.length, 1, "no replay");
  assert.equal(events.subscribe(() => undefined, { after: 10, epoch: EPOCH, running: null }).initial[0].resync, true);
  const edge = events.subscribe(() => undefined, { after: 50, epoch: EPOCH, running: null });
  assert.equal(edge.initial[0].resync, false, "the oldest event still held is seq 51");
  assert.equal(edge.initial.length, 1 + RING_SIZE);
  assert.equal(events.subscribe(() => undefined, { after: RING_SIZE, epoch: "old-epoch", running: null }).initial[0].resync, true);
  assert.equal(events.subscribe(() => undefined, { after: RING_SIZE * 5, epoch: EPOCH, running: null }).initial[0].resync, true);
  assert.equal(events.subscribe(() => undefined, { epoch: "old-epoch", running: null }).initial[0].resync, true);
  assert.equal(events.subscribe(() => undefined, { running: null }).initial[0].resync, false, "a client with no position just starts live");
});

test("an unsubscribed or broken subscriber stops getting events and never stops the others", () => {
  const events = bus();
  const good: string[] = [];
  const first = events.subscribe(() => { throw new Error("socket closed"); }, { running: null });
  events.subscribe((event) => good.push(event.type), { running: null });
  events.emit({ type: "a" });
  events.emit({ type: "b" });
  assert.deepEqual(good, ["a", "b"]);
  first.unsubscribe();
  assert.equal(events.subscriberCount, 1);
});

test("contract 14: seq survives the session being disposed and a chat evicted from the pool", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "one", chunks: 3 });
    world.send(chatId, "first");
    await world.idle(chatId);
    const chat = world.engine.host.chat(chatId);
    const before = chat.bus.tailSeq;
    assert.ok(before > 5);
    chat.disposeSession();
    chat.evict();
    assert.equal(chat.live, null);
    world.router.enqueue({ kind: "text", text: "two" });
    world.send(chatId, "second");
    await world.idle(chatId);
    const after = world.engine.host.chat(chatId).bus.tailSeq;
    assert.ok(after > before, "numbering went on, it did not restart");
    const recorder = world.record(chatId, { after: before, epoch: world.engine.epoch });
    assert.equal(recorder.events[0].resync, false);
    assert.equal(recorder.events.length - 1, after - before, "the events since the client's position are replayed");
    assert.equal(recorder.events[1].seq, before + 1);
  } finally {
    await world.close();
  }
});

test("contract 14: an idle pool drops sessions beyond the limit but keeps the running one", async () => {
  const world = await makeWorld({ engine: { idleSessionLimit: 2 } });
  try {
    const chats = [world.newChat(), world.newChat(), world.newChat(), world.newChat()];
    for (const chatId of chats) {
      world.router.enqueue({ kind: "text", text: "ok" });
      world.send(chatId, "hello");
      await world.idle(chatId);
    }
    world.router.enqueue({ kind: "stall", text: "holding" });
    const running = world.newChat();
    world.send(running, "hold");
    await waitForRequests(world, 5);
    world.engine.host.sweep();
    const withSession = world.engine.host.runtimes().filter((chat) => chat.live?.session);
    assert.ok(withSession.length <= 3, `${withSession.length} sessions alive`);
    assert.ok(world.engine.host.chat(running).live?.session, "a session with a running turn is never evicted");
    world.router.release();
    await world.idle(running);
    // A chat whose session was dropped still answers.
    world.router.enqueue({ kind: "text", text: "back" });
    world.send(chats[0], "again");
    await world.idle(chats[0]);
    assert.equal((world.engine.rows(chats[0], {}).rows.at(-1) as { text: string }).text, "back");
  } finally {
    await world.close();
  }
});

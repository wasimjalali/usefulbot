import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "../../agent/engine/protocol.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld } from "./helpers.ts";

/** The widget row the web service files once the app has drawn a widget (SPEC 5.10). */

async function drawn() {
  const world = await makeWorld();
  const chatId = world.newChat();
  world.router.enqueue(
    { kind: "tools", calls: [{ name: "find_tools", args: { query: "draw" } }] },
    { kind: "tools", calls: [{ name: "demo__ping", args: { elements: [] } }] },
    { kind: "text", text: "Drawn." },
  );
  world.send(chatId, "draw it");
  await world.idle(chatId);
  const callId = [...world.engine.host.chat(chatId).calls.keys()].find((id) => world.engine.host.chat(chatId).calls.get(id)?.widget) as string;
  return { world, chatId, callId };
}

test("the web names the call; the engine adds the connection and tool, and the turn the call belonged to", async () => {
  const { world, chatId, callId } = await drawn();
  try {
    assert.ok(callId, "the widget call was seen");
    const turnId = world.engine.host.chat(chatId).calls.get(callId)?.turnId;
    const filed = world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: `widget:${callId}`, kind: "widget", widgetId: "wdg-1", callId });
    assert.deepEqual(filed, { chatId, rowId: `widget:${callId}` });
    const row = world.engine.rows(chatId, {}).rows.find((item) => item.kind === "widget");
    assert.ok(row && row.kind === "widget");
    assert.deepEqual([row.widgetId, row.callId, row.connectionId, row.toolName, row.turnId], ["wdg-1", callId, "demo", "ping", turnId]);
    // Idempotent by key: the app may file it twice.
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: `widget:${callId}`, kind: "widget", widgetId: "wdg-1", callId });
    assert.equal(world.engine.rows(chatId, {}).rows.filter((item) => item.kind === "widget").length, 1);
  } finally {
    await world.close();
  }
});

test("review 1: a widget row filed while a later turn runs belongs to the turn that made the call", async () => {
  const { world, chatId, callId } = await drawn();
  try {
    const callTurn = world.engine.host.chat(chatId).calls.get(callId)?.turnId;
    world.router.enqueue({ kind: "stall", text: "the next turn" });
    world.send(chatId, "something else");
    const deadline = Date.now() + 5_000;
    while (!world.engine.host.chat(chatId).turn?.partialText && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const running = world.engine.host.chat(chatId).turn?.turnId;
    assert.ok(running && running !== callTurn, "another turn is running");
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: `widget:${callId}`, kind: "widget", widgetId: "wdg-5", callId });
    const row = world.engine.rows(chatId, {}).rows.find((item) => item.kind === "widget");
    assert.equal(row?.turnId, callTurn);
    world.router.release();
    await world.idle(chatId);
  } finally {
    await world.close();
  }
});

test("after a restart the call is found on the branch, and an unknown call is refused", async () => {
  const { world, chatId, callId } = await drawn();
  try {
    world.engine.host.chat(chatId).evict();
    world.engine.host.chat(chatId).calls.clear();
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: `widget:${callId}`, kind: "widget", widgetId: "wdg-2", callId });
    const row = world.engine.rows(chatId, {}).rows.find((item) => item.kind === "widget");
    assert.ok(row && row.kind === "widget");
    assert.deepEqual([row.connectionId, row.toolName], ["demo", "ping"]);
    assert.match(row.turnId ?? "", /^[0-9a-f-]{36}$/);

    assert.throws(
      () => world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: "widget:nope", kind: "widget", widgetId: "wdg-3", callId: "no-such-call" }),
      (error: unknown) => error instanceof EngineError && error.status === 404 && error.code === "widget_call_unknown",
    );
    // A call to a tool with no widget is no widget either.
    const echoCall = world.engine.host.chat(chatId).live?.sm.getBranch().flatMap((entry) => {
      if (entry.type !== "message") return [];
      const content = (entry.message as unknown as { content?: { type?: string; id?: string; name?: string }[] }).content;
      return Array.isArray(content) ? content.filter((block) => block.type === "toolCall" && block.name === "find_tools") : [];
    })[0];
    assert.ok(echoCall?.id);
    assert.throws(
      () => world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: "widget:plain", kind: "widget", widgetId: "wdg-4", callId: echoCall.id as string }),
      (error: unknown) => error instanceof EngineError && error.code === "widget_call_unknown",
    );
  } finally {
    await world.close();
  }
});

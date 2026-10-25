import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import test from "node:test";
import { makeWorld, type World } from "./helpers.ts";

/** A question from `ask` waits for the owner's next message, whatever happens to the engine in between. */

test("a question still waiting for the owner survives a restart: the rows show it and the status poll says so", async () => {
  const world = await makeWorld();
  const restartRoot = `${world.root}-restart`;
  let second: World | null = null;
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "tools", calls: [{ name: "ask", args: { prompt: "Which folder?" } }] });
    world.send(chatId, "save the report");
    await world.idle(chatId);
    assert.equal(world.engine.status().chats.find((chat) => chat.chatId === chatId)?.waitingOnOwner, "question");
    cpSync(world.root, restartRoot, { recursive: true });

    second = await makeWorld({ root: restartRoot, router: world.router });
    assert.equal(second.engine.status().chats.find((chat) => chat.chatId === chatId)?.waitingOnOwner, "question", "before anything opened the chat");
    assert.equal(second.engine.rows(chatId, {}).openQuestion?.prompt, "Which folder?");
    second.router.enqueue({ kind: "text", text: "Saved." });
    second.send(chatId, "Desktop");
    await second.idle(chatId);
    assert.equal(second.engine.status().chats.find((chat) => chat.chatId === chatId)?.waitingOnOwner, null);
    assert.equal(second.engine.rows(chatId, {}).openQuestion, null);
  } finally {
    await second?.close();
    await world.close();
    rmSync(restartRoot, { recursive: true, force: true });
  }
});

test("a turn that follows a question, even a routine one, leaves it open until the owner answers", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "tools", calls: [{ name: "ask", args: { prompt: "Which?" } }] });
    world.send(chatId, "go");
    await world.idle(chatId);
    world.router.enqueue({ kind: "text", text: "A system note." });
    world.engine.systemTurn("bot-useful", "connect-x", "Carry on.");
    await world.idle(chatId);
    assert.equal(world.engine.rows(chatId, {}).openQuestion?.prompt, "Which?");
    assert.equal(world.engine.status().chats.find((chat) => chat.chatId === chatId)?.waitingOnOwner, "question");
  } finally {
    await world.close();
  }
});

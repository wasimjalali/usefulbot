import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeSelectionHeader } from "./selection.ts";
import { instructionsText } from "../../agent/engine/context.ts";
import { readSessionGrant } from "../../shared/workspace-store.ts";
import { updateShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID, withBotSelection } from "../../shared/shell-store.ts";
import { CONNECTION, MODEL, makeWorld } from "./helpers.ts";

/** Prompt and context (SPEC 5.6), the frozen selection (5.3) and the pieces a turn stamps (5.5.3). */

type Message = { role: string; content: unknown };

const messagesOf = (request: { body: Record<string, unknown> }) => request.body.messages as Message[];
const text = (message: Message) => JSON.stringify(message.content);
const withThisTurn = (messages: Message[]) => messages.filter((message) => message.role === "user" && text(message).includes("# This turn"));

test("the system prompt is the rules, the skills list, then the bot's own block", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "ok" });
    world.send(chatId, "hi");
    await world.idle(chatId);
    const system = messagesOf(world.router.requests[0]).find((message) => message.role === "system");
    const prompt = String(system?.content);
    assert.ok(prompt.startsWith(instructionsText()), "the rules come first");
    const skills = prompt.indexOf("# Skills");
    const bot = prompt.indexOf("# Your bot");
    assert.ok(skills > 0 && bot > skills, "skills, then Your bot");
    assert.match(prompt, /- about-useful-bot: Questions about the app\./);
    assert.match(prompt, /You are Useful Bot\./);
    assert.match(prompt, /<owner-instructions>/);
    assert.doesNotMatch(prompt, /# This turn/, "what changes every turn is not in the cached prefix");
  } finally {
    await world.close();
  }
});

test("'This turn' and the notes ride last as one hidden message, sent again only when they change", async () => {
  let notes = "# Your notes\n- remember the milk";
  const world = await makeWorld({ deps: { notesBlockFor: () => notes } });
  try {
    const chatId = world.newChat();
    world.router.fallback({ kind: "text", text: "ok" });
    world.send(chatId, "first");
    await world.idle(chatId);
    const first = messagesOf(world.router.requests[0]);
    assert.equal(first.at(-1)?.role, "user");
    assert.match(text(first.at(-1) as Message), /# This turn[\s\S]*Owner:/);
    assert.match(text(first.at(-1) as Message), /remember the milk/);
    assert.match(text(first.at(-2) as Message), /first/, "the owner's words come before it");
    assert.equal(withThisTurn(first).length, 1);

    // "This is the owner's first chat with you" is true for the first turn only, so the block changes once.
    world.send(chatId, "second");
    await world.idle(chatId);
    assert.doesNotMatch(text(withThisTurn(messagesOf(world.router.requests[1])).at(-1) as Message), /first chat with you/);
    world.send(chatId, "second and a half");
    await world.idle(chatId);
    assert.equal(withThisTurn(messagesOf(world.router.requests[2])).length, 2, "unchanged: not sent a third time");

    notes = "# Your notes\n- remember the milk\n- call Sam";
    world.send(chatId, "third");
    await world.idle(chatId);
    const third = messagesOf(world.router.requests[3]);
    assert.equal(withThisTurn(third).length, 3, "changed: sent again, after the owner's message");
    assert.match(text(third.at(-1) as Message), /call Sam/);

    // The permission is in the block: a change of it changes the message.
    updateShell((store) => ({ ...store, bots: store.bots.map((bot) => (bot.id === DEFAULT_BOT_ID ? { ...bot, permission: "full_access" as const } : bot)) }));
    world.send(chatId, "fourth");
    await world.idle(chatId);
    const fourth = messagesOf(world.router.requests[4]);
    assert.equal(withThisTurn(fourth).length, 4);
    assert.match(text(fourth.at(-1) as Message), /Full access/);
    // The hidden message never shows up as a row.
    assert.equal(world.engine.rows(chatId, {}).rows.filter((row) => row.kind !== "user" && row.kind !== "assistant").length, 0);
  } finally {
    await world.close();
  }
});

test("the hidden message is sent again on the first turn after a compaction", async () => {
  const world = await makeWorld({ window: 20_000 });
  try {
    const chatId = world.newChat();
    const filler = "lorem ipsum ".repeat(1200);
    world.router.fallback((request) => {
      if (JSON.stringify(request.body.messages).includes("<conversation>")) return { kind: "text", text: "SUMMARY" };
      return { kind: "text", text: "ok", usage: { prompt_tokens: 16_500, completion_tokens: 20 } };
    });
    for (let i = 0; i < 3; i += 1) {
      world.send(chatId, `message ${i} ${filler}`);
      await world.idle(chatId);
    }
    const before = world.router.requests.length;
    world.send(chatId, "after the summary");
    await world.idle(chatId);
    const sent = messagesOf(world.router.requests[before]);
    assert.ok(text(sent[1]).includes("compacted") || JSON.stringify(sent).includes("SUMMARY"), "the model sees the summary");
    assert.ok(withThisTurn(sent).length >= 1, "and 'This turn' is there again");
    assert.match(text(sent.at(-1) as Message), /# This turn/, "last, after the owner's message");
  } finally {
    await world.close();
  }
});

test("editing the bot's instructions changes the next turn's system prompt", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.fallback({ kind: "text", text: "ok" });
    world.send(chatId, "one");
    await world.idle(chatId);
    const session = world.engine.host.chat(chatId).live?.session;
    updateShell((store) => ({ ...store, bots: store.bots.map((bot) => (bot.id === DEFAULT_BOT_ID ? { ...bot, description: "Always answer in rhyme." } : bot)) }));
    world.send(chatId, "two");
    await world.idle(chatId);
    assert.match(String(messagesOf(world.router.requests[1]).find((message) => message.role === "system")?.content), /Always answer in rhyme\./);
    assert.notEqual(world.engine.host.chat(chatId).live?.session, session, "a new prompt is a new session");
    assert.doesNotMatch(String(messagesOf(world.router.requests[0]).find((message) => message.role === "system")?.content), /rhyme/);
    // The history is still there: the new session was built from the file.
    assert.equal(messagesOf(world.router.requests[1]).filter((message) => message.role === "user" && text(message) === '[{"type":"text","text":"one"}]').length, 1);
  } finally {
    await world.close();
  }
});

test("the selection is frozen for the turn; a pick made during it applies to the next one", async () => {
  const world = await makeWorld();
  try {
    // A second model on the same connection, with its own window.
    const row = (id: string, contextTokens: number) => ({ id, label: id, efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens });
    writeFileSync(join(world.root, "models-cache.json"), JSON.stringify({ schemaVersion: 3, providers: { [CONNECTION]: { fetchedAt: Date.now(), models: [row(MODEL, 200_000), row("glm-5", 100_000)] } } }));
    const chatId = world.newChat();
    let flipped = false;
    world.router.fallback((request) => {
      if (!flipped) {
        // The owner picks another model while the first turn is between its two model calls.
        flipped = true;
        updateShell((store) => withBotSelection(store, DEFAULT_BOT_ID, { connectionId: CONNECTION, modelId: "glm-5", effort: "low", speed: "standard" }));
        return { kind: "tools", calls: [{ name: "echo", args: { text: "x" } }] };
      }
      return { kind: "text", text: `answer ${request.n}` };
    });
    world.send(chatId, "first turn");
    await world.idle(chatId);
    const [one, two] = world.router.requests;
    assert.equal(decodeSelectionHeader(one.headers["x-useful-selection"]).modelId, MODEL);
    assert.equal(decodeSelectionHeader(two.headers["x-useful-selection"]).modelId, MODEL, "the second call of the same turn kept the first pick");
    const grant = readSessionGrant(chatId);
    assert.equal(grant?.selection?.modelId, MODEL, "the grant carries the frozen model beside the permission");

    world.send(chatId, "second turn");
    await world.idle(chatId);
    const third = world.router.requests[2];
    assert.equal(decodeSelectionHeader(third.headers["x-useful-selection"]).modelId, "glm-5");
    assert.match(text(withThisTurn(messagesOf(third)).at(-1) as Message), /Model: glm-5 \(glm-5\)/);
    // Switching models builds a session for the new model (and its window), from the same file.
    const live = world.engine.host.chat(chatId).live;
    assert.equal(live?.session?.model?.id, `${CONNECTION}/glm-5`);
    assert.equal(messagesOf(third).filter((message) => message.role === "user" && text(message) === '[{"type":"text","text":"first turn"}]').length, 1);
  } finally {
    await world.close();
  }
});

test("a turn stamps its chat's grant from the bot, and a deleted chat revokes it", async () => {
  const world = await makeWorld();
  try {
    updateShell((store) => ({
      ...store,
      bots: store.bots.map((bot) => (bot.id === DEFAULT_BOT_ID ? { ...bot, permission: "auto" as const, workspace: { path: "/Users/someone/Projects/Atlas", permission: "auto" as const } as never } : bot)),
    }));
    const chatId = world.newChat();
    assert.equal(readSessionGrant(chatId), null, "nothing before a turn");
    world.router.enqueue({ kind: "text", text: "ok" });
    world.send(chatId, "hello");
    await world.idle(chatId);
    const grant = readSessionGrant(chatId);
    assert.deepEqual([grant?.path, grant?.permission], ["/Users/someone/Projects/Atlas", "auto"]);
    assert.match(text(withThisTurn(messagesOf(world.router.requests[0])).at(-1) as Message), /Auto, folder \\"Atlas\\" attached/);
    world.engine.deleteChat(chatId);
    assert.equal(readSessionGrant(chatId), null, "the capability goes with the chat");
  } finally {
    await world.close();
  }
});

test("picked tools: registered when find_tools settles, in time for the next model request, and kept for the chat", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue(
      { kind: "tools", calls: [{ name: "find_tools", args: { query: "ping" } }] },
      { kind: "tools", calls: [{ name: "demo__ping", args: {} }] },
      { kind: "text", text: "pong" },
    );
    world.send(chatId, "ping the demo");
    await world.idle(chatId);
    const names = (request: { body: Record<string, unknown> }) => (request.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(!names(world.router.requests[0]).includes("demo__ping"), "not declared before it is picked");
    assert.ok(names(world.router.requests[1]).includes("demo__ping"), "declared on the very next request");
    assert.equal(names(world.router.requests[1]).length, names(world.router.requests[0]).length + 1);
    const result = messagesOf(world.router.requests[2]).filter((message) => message.role === "tool").at(-1);
    assert.match(text(result as Message), /pong/);

    // A reopened chat declares the picks from the start.
    world.engine.host.chat(chatId).evict();
    world.router.enqueue({ kind: "text", text: "again" });
    world.send(chatId, "once more");
    await world.idle(chatId);
    assert.ok(names(world.router.requests[3]).includes("demo__ping"));
  } finally {
    await world.close();
  }
});

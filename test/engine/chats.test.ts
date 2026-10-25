import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatIndex, TITLE_MAX, TRASH_DAYS } from "../../agent/engine/chats.ts";
import { EngineError } from "../../agent/engine/protocol.ts";
import { defaultShellPath, peekShell } from "../../shared/shell-io.ts";
import { defaultWorkspacePath } from "../../shared/workspace-store.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld } from "./helpers.ts";

/** The chat index (SPEC 5.4): its file, paging, rename, trash, and the engine operations around it. */

function tempIndex(now: () => Date = () => new Date()): { dir: string; index: ChatIndex } {
  const dir = mkdtempSync(join(tmpdir(), "ub-chats-"));
  return { dir, index: new ChatIndex(dir, now) };
}

test("a created chat is listed newest first and survives a reload", () => {
  let tick = 0;
  const { dir, index } = tempIndex(() => new Date(Date.UTC(2026, 9, 25, 12, 0, tick++)));
  const a = index.create({ botId: "bot-useful", title: "First" });
  const b = index.create({ botId: "bot-useful", title: "Second" });
  index.create({ botId: "bot-other", title: "Elsewhere" });
  assert.deepEqual(index.list({ botId: "bot-useful" }).chats.map((chat) => chat.title), ["Second", "First"]);
  index.update(a.chatId, { preview: "touched" });
  assert.deepEqual(index.list({ botId: "bot-useful" }).chats.map((chat) => chat.title), ["First", "Second"], "an update moves a chat to the top");
  const reloaded = new ChatIndex(dir);
  assert.deepEqual(reloaded.list({ botId: "bot-useful" }).chats.map((chat) => chat.chatId), [a.chatId, b.chatId]);
  assert.equal(JSON.parse(readFileSync(join(dir, "chats.json"), "utf8")).schemaVersion, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("paging: before is the last chat of the previous page", () => {
  let tick = 0;
  const { dir, index } = tempIndex(() => new Date(Date.UTC(2026, 9, 25, 12, 0, tick++)));
  const ids = Array.from({ length: 7 }, (_, i) => index.create({ botId: "bot-useful", title: `Chat ${i}` }).chatId);
  const first = index.list({ botId: "bot-useful", limit: 3 });
  assert.deepEqual(first.chats.map((chat) => chat.chatId), [ids[6], ids[5], ids[4]]);
  assert.equal(first.nextBefore, ids[4]);
  const second = index.list({ botId: "bot-useful", limit: 3, before: first.nextBefore as string });
  assert.deepEqual(second.chats.map((chat) => chat.chatId), [ids[3], ids[2], ids[1]]);
  const last = index.list({ botId: "bot-useful", limit: 3, before: second.nextBefore as string });
  assert.deepEqual(last.chats.map((chat) => chat.chatId), [ids[0]]);
  assert.equal(last.nextBefore, null);
  assert.throws(() => index.list({ before: "nope" }), (error: unknown) => error instanceof EngineError && error.code === "before_unknown");
  rmSync(dir, { recursive: true, force: true });
});

test("fixture chats are listed only when asked for", () => {
  const { dir, index } = tempIndex();
  index.create({ botId: "bot-useful", title: "Real" });
  index.create({ botId: "bot-useful", title: "Perf fixture", fixture: true });
  assert.deepEqual(index.list({ botId: "bot-useful" }).chats.map((chat) => chat.title), ["Real"]);
  assert.equal(index.list({ botId: "bot-useful", includeFixtures: true }).chats.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("rename sets the owner's title, trimmed to the cap, and refuses an empty one", () => {
  const { dir, index } = tempIndex();
  const chat = index.create({ botId: "bot-useful" });
  const renamed = index.rename(chat.chatId, `  ${"word ".repeat(40)}  `);
  assert.equal(renamed.titleSetByOwner, true);
  assert.ok(renamed.title.length <= TITLE_MAX);
  assert.throws(() => index.rename(chat.chatId, "   "), (error: unknown) => error instanceof EngineError && error.code === "title_invalid");
  rmSync(dir, { recursive: true, force: true });
});

test("removing a chat moves its file to the trash, and the trash is purged after 30 days", () => {
  const stamp = new Date("2026-10-25T12:00:00.000Z");
  let now = stamp;
  const { dir, index } = tempIndex(() => now);
  const chat = index.create({ botId: "bot-useful" });
  const file = join(dir, "sessions", "bot-useful", "2026-10-25T12-00-00-000Z_session.jsonl");
  mkdirSync(join(dir, "sessions", "bot-useful"), { recursive: true });
  writeFileSync(file, "{}\n");
  index.update(chat.chatId, { sessionFile: file }, { touch: false });
  index.remove(chat.chatId);
  assert.equal(index.get(chat.chatId), undefined);
  assert.equal(existsSync(file), false);
  const trashed = readdirSync(index.trashDir);
  assert.equal(trashed.length, 1);
  assert.match(trashed[0], /^2026-10-25T12-00-00-000Z__/);
  now = new Date(stamp.getTime() + (TRASH_DAYS - 1) * 86_400_000);
  assert.equal(index.purgeTrash(), 0);
  now = new Date(stamp.getTime() + (TRASH_DAYS + 1) * 86_400_000);
  assert.equal(index.purgeTrash(), 1);
  assert.deepEqual(readdirSync(index.trashDir), []);
  // A file with no stamp falls back to its modification time.
  writeFileSync(join(index.trashDir, "stray.jsonl"), "{}\n");
  utimesSync(join(index.trashDir, "stray.jsonl"), new Date(0), new Date(0));
  assert.equal(index.purgeTrash(), 1);
  rmSync(dir, { recursive: true, force: true });
});

test("an index file that does not parse stops the engine instead of starting empty over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chats-"));
  writeFileSync(join(dir, "chats.json"), "{ not json");
  assert.throws(() => new ChatIndex(dir));
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ schemaVersion: 2, chats: [] }));
  assert.throws(() => new ChatIndex(dir), /chat_index_unreadable/);
  rmSync(dir, { recursive: true, force: true });
});

test("new, rename, search, open and delete through the engine", async () => {
  const world = await makeWorld();
  try {
    const first = world.newChat();
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, first);
    world.router.enqueue({ kind: "text", text: "The capital of France is Paris." });
    world.send(first, "What is the capital of France?");
    await world.idle(first);
    const meta = world.engine.host.index.require(first);
    assert.equal(meta.title, "What is the capital of France?", "the first owner message names the chat");
    assert.equal(meta.preview, "The capital of France is Paris.");
    assert.ok(meta.sessionFile && existsSync(meta.sessionFile), "the index points at the file once it exists");

    world.engine.renameChat(first, "Geography");
    world.send(first, "And Spain?");
    await world.idle(first);
    assert.equal(world.engine.host.index.require(first).title, "Geography", "an owner's title is never replaced");

    const second = world.newChat();
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, second, "a new chat becomes current");
    world.engine.openChat(first);
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, first, "opening makes it current");
    assert.equal(world.engine.host.openChatId, first);

    // Search finds titles, previews and message text.
    const byText = world.engine.searchChats("capital");
    assert.deepEqual(byText.hits.map((hit) => hit.chatId), [first]);
    assert.match(byText.hits[0].snippet.toLowerCase(), /capital/);
    assert.ok(byText.hits[0].rowId.length > 0);
    assert.equal(world.engine.searchChats("geography").hits[0].chatId, first);
    assert.deepEqual(world.engine.searchChats("zzz-nothing").hits, []);

    // Delete: refused while a turn runs, otherwise to the trash, and the newest remaining chat becomes current.
    world.router.enqueue({ kind: "stall", text: "busy" });
    world.send(second, "hold on");
    const deadline = Date.now() + 3_000;
    while (world.router.requests.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.throws(() => world.engine.deleteChat(second), (error: unknown) => error instanceof EngineError && error.status === 409 && error.code === "chat_busy");
    world.router.release();
    await world.idle(second);
    const file = world.engine.host.index.require(second).sessionFile as string;
    const deleted = world.engine.deleteChat(second);
    assert.equal(deleted.current, first, "the newest remaining chat takes over");
    assert.equal(existsSync(file), false);
    assert.equal(readdirSync(world.engine.host.index.trashDir).length, 1);
    assert.throws(() => world.engine.rows(second, {}), (error: unknown) => error instanceof EngineError && error.status === 404 && error.code === "chat_not_found");
    assert.equal(world.engine.deleteChat(first).current, null, "no chat left: no current chat");
  } finally {
    await world.close();
  }
});

test("a session file that cannot be read shows one unreadable row and the engine carries on", async () => {
  const world = await makeWorld();
  try {
    const bad = world.newChat();
    world.router.enqueue({ kind: "text", text: "fine" });
    world.send(bad, "hello");
    await world.idle(bad);
    const file = world.engine.host.index.require(bad).sessionFile as string;
    world.engine.host.forget(bad);
    writeFileSync(file, "this is not a session file\n");
    const rows = world.engine.rows(bad, {}).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, (rows[0] as { code: string }).code], ["failure", "unreadable"]);
    assert.throws(() => world.send(bad, "again"), (error: unknown) => error instanceof EngineError && error.code === "chat_unreadable");
    // Other chats are untouched.
    const other = world.newChat();
    world.router.enqueue({ kind: "text", text: "still fine" });
    world.send(other, "hi");
    await world.idle(other);
    assert.equal((world.engine.rows(other, {}).rows.at(-1) as { text: string }).text, "still fine");
  } finally {
    await world.close();
  }
});

test("review 3: a busy workspace store refuses a chat delete before anything is removed", async () => {
  const world = await makeWorld();
  const lock = `${defaultWorkspacePath()}.lock`;
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "hello" });
    world.send(chatId, "hi");
    await world.idle(chatId);
    mkdirSync(lock);
    const started = Date.now();
    assert.throws(
      () => world.engine.deleteChat(chatId),
      (error: unknown) => error instanceof EngineError && error.status === 503 && error.code === "workspace_store_busy" && error.fields.retryable === true,
    );
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
    assert.ok(world.engine.host.index.get(chatId), "still there");
    assert.equal(world.engine.rows(chatId, {}).rows.length, 2, "with its rows");
    rmdirSync(lock);
    world.engine.deleteChat(chatId);
    assert.equal(world.engine.host.index.get(chatId), undefined);
  } finally {
    rmSync(lock, { recursive: true, force: true });
    await world.close();
  }
});

test("review 2: search reads chats without leaving runtimes behind, and stops at its budget", async () => {
  const world = await makeWorld();
  const copy = `${world.root}-copy`;
  let second: Awaited<ReturnType<typeof makeWorld>> | null = null;
  try {
    for (const word of ["alpha", "bravo", "charlie"]) {
      const chatId = world.newChat();
      world.router.enqueue({ kind: "text", text: `the needle is in ${word}` });
      world.send(chatId, `look for ${word}`);
      await world.idle(chatId);
    }
    cpSync(world.root, copy, { recursive: true });
    second = await makeWorld({ root: copy, router: world.router });
    assert.equal(second.engine.host.runtimes().length, 0, "a fresh engine has touched nothing");
    const found = second.engine.searchChats("needle");
    assert.equal(found.hits.length, 3);
    assert.equal(second.engine.host.runtimes().length, 0, "reading three chats left no runtime");
    // Title and preview hits take the same path.
    assert.ok(second.engine.searchChats("look for alpha").hits.length >= 1);
    assert.equal(second.engine.host.runtimes().length, 0);
    assert.deepEqual(second.engine.searchChats("needle", 50, 0).hits, [], "a spent budget stops both passes");
  } finally {
    await second?.close();
    await world.close();
    rmSync(copy, { recursive: true, force: true });
  }
});

test("review 1: a shell lock held by someone else delays the write of the open chat, never the engine", async () => {
  const world = await makeWorld();
  const lock = `${defaultShellPath()}.lock`;
  const logged = console.error;
  console.error = () => undefined;
  try {
    const before = world.newChat();
    assert.equal(peekShell()?.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.chatId, before);
    mkdirSync(lock);
    const started = Date.now();
    const { chatId } = world.engine.createChat(DEFAULT_BOT_ID);
    assert.ok(Date.now() - started < 1_500, `createChat took ${Date.now() - started} ms with the lock held`);
    // The engine already answers with the new chat; the file catches up.
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, chatId);
    assert.equal(peekShell()?.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.chatId, before);

    // A turn that settles while the lock is held is not held up by it either.
    world.router.enqueue({ kind: "text", text: "fine" });
    world.send(chatId, "hello");
    await world.idle(chatId, 2_000);
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, chatId);

    rmdirSync(lock);
    const deadline = Date.now() + 3_000;
    while (peekShell()?.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.chatId !== chatId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const bot = peekShell()?.bots.find((item) => item.id === DEFAULT_BOT_ID);
    assert.equal(bot?.chatId, chatId, "the parked write landed once the lock was free");
    assert.equal(bot?.lastPreview, "fine", "and so did the newest preview");
  } finally {
    console.error = logged;
    rmSync(lock, { recursive: true, force: true });
    await world.close();
  }
});

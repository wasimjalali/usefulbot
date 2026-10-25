import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, resetMemoryDir } from "../agent/lib/memory.ts";
import { notesBlockFor } from "../shared/notes-block.ts";

// "Your notes" in the per-turn context: the bot's own memory, rendered from the
// store each time it is asked for (no replay digest, no cache).

function freshStore(): MemoryStore {
  const root = mkdtempSync(join(tmpdir(), "ub-notes-mem-"));
  resetMemoryDir(root);
  return new MemoryStore(root);
}

function put(store: MemoryStore, botId: string, title: string, body: string, extra: { id?: string; expectedRevision?: number | null } = {}) {
  return store.upsert({
    id: extra.id, expectedRevision: extra.expectedRevision ?? null, title, tags: [], body, botId,
    source: "model", expiresAt: null, sessionId: "s",
  });
}

test("an empty bot gets the sentinel, never a blank block", () => {
  const store = freshStore();
  const text = notesBlockFor("bot-a", () => store);
  assert.match(text, /^# Your notes/);
  assert.match(text, /No notes yet/);
  assert.match(text, /memory save/);
  assert.ok(text.trim().length > 0);
});

test("the block holds only this bot's notes, newest first, with the outside-content mark", () => {
  const store = freshStore();
  put(store, "bot-a", "Mine", "my body");
  put(store, "bot-b", "Theirs", "their-canary");
  store.upsert({ expectedRevision: null, title: "From web", tags: [], body: "web body", botId: "bot-a", source: "model-after-outside-content", expiresAt: null, sessionId: "s" });
  const text = notesBlockFor("bot-a", () => store);
  assert.match(text, /Mine/);
  assert.match(text, /my body/);
  assert.match(text, /written after reading outside content/);
  assert.doesNotMatch(text, /web body|From web/, "an outside-sourced note shows neither title nor body");
  assert.doesNotMatch(text, /their-canary|Theirs/);
});

test("the same notes give the same bytes, and an edit shows in the next call", () => {
  const store = freshStore();
  const note = put(store, "bot-a", "Plan", "first");
  const before = notesBlockFor("bot-a", () => store);
  assert.equal(notesBlockFor("bot-a", () => store), before, "deterministic");
  put(store, "bot-a", "Plan", "second", { id: note.id, expectedRevision: 1 });
  const after = notesBlockFor("bot-a", () => store);
  assert.notEqual(after, before);
  assert.match(after, /second/);
  assert.doesNotMatch(after, /first/);
});

test("\"more\" counts against the true note count and the newest bodies show in full", () => {
  const store = freshStore();
  for (let index = 0; index < 70; index += 1) {
    put(store, "bot-a", `Note ${String(index).padStart(2, "0")}`, `body-${index}`);
  }
  const text = notesBlockFor("bot-a", () => store);
  // 6 full + 50 titles are shown: 14 of 70 are behind "more".
  assert.match(text, /14 more: use memory search\./);
  assert.equal((text.match(/body-\d+/g) ?? []).length, 6, "six bodies, the newest");
  assert.ok(text.length <= 6000, `block is ${text.length} chars`);
});

test("the block names the merged memory tool, not the four it replaced", () => {
  const store = freshStore();
  for (let index = 0; index < 60; index += 1) put(store, "bot-a", `T${index}`, `b${index}`);
  const text = `${notesBlockFor("bot-a", () => store)}\n${notesBlockFor("bot-empty", () => store)}`;
  assert.match(text, /memory read/);
  assert.doesNotMatch(text, /memory_(read|search|upsert|delete)/);
});

test("a note deleted between the list and the read is skipped, not a failed send", () => {
  const store = freshStore();
  put(store, "bot-a", "Stays", "still here");
  const gone = put(store, "bot-a", "Vanishes", "deleted meanwhile");
  const racing = Object.create(store) as MemoryStore;
  racing.readCard = (id: string, botId: string) => {
    if (id === gone.id) throw new Error("memory_not_found");
    return store.readCard(id, botId);
  };
  const text = notesBlockFor("bot-a", () => racing);
  assert.match(text, /still here/);
  assert.doesNotMatch(text, /Vanishes|deleted meanwhile/);
});

test("a store failure is not hidden: the call throws", () => {
  const broken = () => { throw new Error("index locked"); };
  assert.throws(() => notesBlockFor("bot-a", broken as never), /index locked/);
});

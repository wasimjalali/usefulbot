import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, resetMemoryDir } from "../agent/lib/memory.ts";

const A = "bot-a";
const B = "bot-b";

function fresh(): { root: string; store: MemoryStore } {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  return { root, store: new MemoryStore(root) };
}

type Put = {
  botId?: string;
  id?: string;
  expectedRevision?: number | null;
  title?: string;
  tags?: string[];
  body?: string;
  expiresAt?: string | null;
  source?: "owner" | "model" | "model-after-outside-content";
};

function put(store: MemoryStore, input: Put = {}) {
  return store.upsert({
    id: input.id,
    expectedRevision: input.expectedRevision ?? null,
    title: input.title ?? "Note",
    tags: input.tags ?? [],
    body: input.body ?? "body",
    botId: input.botId ?? A,
    source: input.source ?? "model",
    expiresAt: input.expiresAt ?? null,
    sessionId: "s",
  });
}

test("upsert search read and revision conflict", () => {
  const { store } = fresh();
  const created = put(store, { title: "Writing preference", tags: ["writing"], body: "Use short sentences." });
  const hits = store.search("short", A);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, created.id);
  const read = store.read(created.id, A);
  assert.match(read.body, /short sentences/);
  assert.throws(
    () => put(store, { id: created.id, expectedRevision: 99, title: "Writing preference", body: "changed" }),
    /memory_revision_conflict/,
  );
});

test("secret-like bodies are refused", () => {
  const { store } = fresh();
  assert.throws(() => put(store, { title: "keys", body: "api_key=not-a-real-secret-but-blocked" }), /memory_secret_refused/);
});

test("rebuild index from markdown", () => {
  const { store } = fresh();
  put(store, { title: "Rebuild me", tags: ["index"], body: "Persian سلام and emoji 🙂 and code const x = 1;" });
  const rebuilt = store.rebuildIndex();
  assert.equal(rebuilt.indexed, 1);
  assert.equal(store.search("سلام", A).length, 1);
});

test("fts operator characters in a query do not throw", () => {
  const { store } = fresh();
  put(store, { title: "Pricing", tags: ["pricing"], body: "Short sentences about pricing." });
  for (const query of ['"', "OR", "*", "(", "pricing AND"]) {
    assert.doesNotThrow(() => store.search(query, A), `query ${query}`);
  }
  assert.equal(store.search("pricing", A).length, 1);
  assert.equal(store.search("*", A).length, 0);
});

test("note ids cannot traverse out of the notes directory", () => {
  const { store } = fresh();
  assert.throws(() => store.read("../outside", A), /memory_id_invalid/);
  assert.throws(() => put(store, { id: "../outside", body: "x" }), /memory_id_invalid/);
});

test("revision is enforced across two stores on the same directory", () => {
  const { root, store: first } = fresh();
  const second = new MemoryStore(root);
  const created = put(first, { title: "Shared", body: "one" });
  put(second, { id: created.id, expectedRevision: 1, title: "Shared", body: "two" });
  assert.throws(
    () => put(first, { id: created.id, expectedRevision: 1, title: "Shared", body: "three" }),
    /memory_revision_conflict/,
  );
  assert.equal(first.read(created.id, A).body, "two");
});

test("an offset expiry is normalised to a UTC instant and the note stays live", () => {
  const { root, store } = fresh();
  put(store, { title: "Offset expiry", body: "Still valid tomorrow.", expiresAt: "2099-01-01T12:00:00+01:00" });
  const listed = store.list(A);
  assert.equal(listed.length, 1);
  const raw = readFileSync(join(root, "notes", `${listed[0].id}.md`), "utf8");
  const meta = JSON.parse(raw.split("\n")[1]) as { expiresAt: string };
  assert.equal(meta.expiresAt, "2099-01-01T11:00:00.000Z");
  assert.equal(store.search("Still valid", A).length, 1);
  assert.throws(() => put(store, { title: "Bad expiry", body: "unparsable", expiresAt: "not-a-time" }), /memory_meta/);
});

test("ordinary text with sk- is saved; a real key shape is still refused", () => {
  const { store } = fresh();
  for (const body of ["my task-list for today", "desk-setup notes", "risk-taking is fine"]) {
    assert.doesNotThrow(() => put(store, { title: "Notes", body }), `body ${body}`);
  }
  assert.throws(() => put(store, { title: "Key", body: "sk-abcdefghijklmnopqrst" }), /memory_secret_refused/);
});

test("a legacy invalid note id is skipped instead of poisoning list and search", () => {
  const { root, store } = fresh();
  put(store, { title: "Good", body: "searchable target" });
  // A pre-existing index row whose id is unsafe as a file name, as an older
  // build could have written before ids were validated.
  const db = new DatabaseSync(join(root, "index.sqlite"));
  db.exec(
    "INSERT INTO notes (id, revision, body_sha, audience, bot_id, tags, title, updated_at, expires_at, status) " +
      `VALUES ('my_note', 1, 'x', 'desktop', '${A}', '', 'Legacy', '2020-01-01T00:00:00.000Z', NULL, 'active')`,
  );
  db.exec("INSERT INTO notes_fts (title, tags, body, id) VALUES ('Legacy', '', 'legacy body', 'my_note')");
  db.close();

  assert.doesNotThrow(() => store.list(A));
  assert.equal(store.list(A).length, 1);
  assert.equal(store.search("searchable", A).length, 1);
  assert.equal(store.search("legacy", A).length, 0);
  assert.equal(store.skippedRowCount() > 0, true);
});

test("rebuild counts an invalid id as rejected and keeps the good rows", () => {
  const { root, store } = fresh();
  put(store, { title: "Good", body: "kept" });
  const meta = {
    schemaVersion: 1,
    id: "my_note",
    revision: 1,
    title: "Legacy",
    tags: [],
    audience: "desktop",
    createdAt: "x",
    updatedAt: "x",
    expiresAt: null,
    sourceSessionId: "s",
    approvedBy: "owner",
    status: "active",
  };
  writeFileSync(join(root, "notes", "my_note.md"), `---\n${JSON.stringify(meta)}\n---\nlegacy body`);
  const rebuilt = store.rebuildIndex();
  assert.equal(rebuilt.indexed, 1);
  assert.equal(rebuilt.rejected, 1);
  assert.equal(store.list(A).length, 1);
});

test("a crash between note rename and index insert is repaired on the next open", () => {
  const { root, store } = fresh();
  const created = put(store, { title: "Crash", body: "before the crash" });
  // Simulate the crash window: the markdown rename landed with new content but
  // the index was never updated, and the dirty marker was never cleared.
  const meta = {
    schemaVersion: 1,
    id: created.id,
    revision: 1,
    title: "Crash",
    tags: [],
    audience: "desktop",
    botId: A,
    source: "model",
    createdAt: "x",
    updatedAt: "x",
    expiresAt: null,
    sourceSessionId: "s",
    approvedBy: "owner",
    status: "active",
  };
  writeFileSync(join(root, "notes", `${created.id}.md`), `---\n${JSON.stringify(meta)}\n---\nrecovered body`);
  writeFileSync(join(root, "index.dirty"), `${created.id}\n`);
  assert.equal(store.search("recovered", A).length, 0, "index is stale before repair");

  const reopened = new MemoryStore(root);
  assert.equal(reopened.search("recovered", A).length, 1);
  assert.equal(existsSync(join(root, "index.dirty")), false);
});

// MARK: - Ownership: one bot's notes are invisible and untouchable to another

test("canaries: each bot sees only its own notes in search, list and read", () => {
  const { store } = fresh();
  const a = put(store, { botId: A, title: "Alpha canary", body: "canary-alpha-7731 lives here" });
  const b = put(store, { botId: B, title: "Beta canary", body: "canary-beta-9042 lives here" });

  const searchA = store.search("canary", A);
  assert.deepEqual(searchA.map((note) => note.id), [a.id]);
  const searchB = store.search("canary", B);
  assert.deepEqual(searchB.map((note) => note.id), [b.id]);
  // The other bot's token is not found by any query, empty or not.
  assert.equal(store.search("canary-beta-9042", A).length, 0);
  assert.equal(store.search("", A).every((note) => note.id === a.id), true);
  assert.deepEqual(store.list(A).map((note) => note.id), [a.id]);
  assert.deepEqual(store.list(B).map((note) => note.id), [b.id]);
  assert.equal(store.list("bot-nobody").length, 0);

  assert.match(store.read(a.id, A).body, /canary-alpha/);
  assert.throws(() => store.read(a.id, B), /memory_forbidden/);
  assert.throws(() => store.read(b.id, A), /memory_forbidden/);
});

test("a bot that guesses another bot's note id cannot overwrite it, whatever the revision", () => {
  const { store } = fresh();
  const a = put(store, { botId: A, title: "Alpha", body: "alpha original" });
  // The right revision, the wrong bot: refused on ownership, before the
  // revision is even compared.
  assert.throws(
    () => put(store, { botId: B, id: a.id, expectedRevision: 1, title: "Taken", body: "beta wrote this" }),
    /memory_forbidden/,
  );
  // A wrong revision from the wrong bot says the same thing: no oracle.
  assert.throws(
    () => put(store, { botId: B, id: a.id, expectedRevision: 77, title: "Taken", body: "beta wrote this" }),
    /memory_forbidden/,
  );
  assert.equal(store.read(a.id, A).body, "alpha original");
  assert.equal(store.read(a.id, A).title, "Alpha");
  assert.equal(store.search("beta", B).length, 0);
});

test("an update never retags the note and keeps its owner", () => {
  const { root, store } = fresh();
  const a = put(store, { botId: A, title: "Mine", body: "one", tags: ["bot:bot-b", "keep"] });
  const next = put(store, { botId: A, id: a.id, expectedRevision: 1, title: "Mine", body: "two", tags: ["bot:bot-b"] });
  assert.equal(next.revision, 2);
  const raw = readFileSync(join(root, "notes", `${a.id}.md`), "utf8");
  const meta = JSON.parse(raw.split("\n")[1]) as { botId: string; tags: string[] };
  assert.equal(meta.botId, A);
  // A `bot:` tag is only a tag: ownership is botId alone.
  assert.deepEqual(meta.tags, ["bot:bot-b"]);
  assert.deepEqual(store.list(B), []);
  assert.equal(store.read(a.id, A).body, "two");
  assert.throws(() => store.read(a.id, B), /memory_forbidden/);
});

test("the owner filter lands before the limit in search and list", async () => {
  const { store } = fresh();
  const mine = put(store, { botId: "target", title: "Oldest note", body: "needle in the oldest note" });
  // Every other note lands in a strictly later millisecond, so a limit-first
  // query had no room left for the target bot's own note.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 100; i += 1) {
    put(store, { botId: "other", title: `Other ${i}`, body: "needle in a haystack of other notes" });
  }
  assert.deepEqual(store.list("target", 100).map((note) => note.id), [mine.id]);
  assert.deepEqual(store.search("needle", "target").map((note) => note.id), [mine.id]);
  assert.deepEqual(store.search("", "target").map((note) => note.id), [mine.id]);
});

test("an expired note is gone for search, list and read; a live one stays", () => {
  const { store } = fresh();
  const live = put(store, { title: "Live", body: "expiry token live", expiresAt: "2099-01-01T00:00:00Z" });
  const dead = put(store, { title: "Dead", body: "expiry token dead", expiresAt: "2001-01-01T00:00:00Z" });
  assert.deepEqual(store.search("expiry", A).map((note) => note.id), [live.id]);
  assert.deepEqual(store.list(A).map((note) => note.id), [live.id]);
  assert.match(store.read(live.id, A).body, /live/);
  assert.throws(() => store.read(dead.id, A), /memory_not_found/);
});

test("read returns the whole note while search and list return a clipped preview", () => {
  const { store } = fresh();
  const body = `${"long ".repeat(500)}END-MARKER`;
  assert.ok(body.length > 2000 && body.length < 8192);
  const note = put(store, { title: "Long", body });
  const read = store.read(note.id, A);
  assert.equal(read.body, body);
  assert.equal(read.truncated, false);
  const hit = store.search("long", A)[0];
  assert.equal(hit.body.length, 1024);
  assert.equal(hit.truncated, true);
  assert.equal(hit.body.includes("END-MARKER"), false);
  assert.equal(store.list(A)[0].body.length, 1024);
});

test("a note records who wrote it last", () => {
  const { root, store } = fresh();
  const note = put(store, { source: "owner", body: "from settings" });
  const metaOf = () => JSON.parse(readFileSync(join(root, "notes", `${note.id}.md`), "utf8").split("\n")[1]) as { source: string };
  assert.equal(metaOf().source, "owner");
  put(store, { id: note.id, expectedRevision: 1, source: "model", body: "model edit" });
  assert.equal(metaOf().source, "model");
});

// MARK: - Malformed note files

test("a note missing required metadata is rejected and reported, and never blocks an open", () => {
  const { root, store } = fresh();
  put(store, { title: "Fine", body: "a good note" });
  const bare = (id: string, meta: Record<string, unknown>) =>
    writeFileSync(join(root, "notes", `${id}.md`), `---\n${JSON.stringify({ schemaVersion: 1, id, ...meta })}\n---\nbody`);
  const whole = { title: "t", revision: 1, updatedAt: "2026-01-01T00:00:00.000Z", status: "active", tags: [], botId: A, source: "model" };
  bare("no-revision", { ...whole, revision: undefined });
  bare("no-title", { ...whole, title: undefined });
  bare("no-updated", { ...whole, updatedAt: undefined });
  bare("no-owner", { ...whole, botId: undefined });
  bare("bad-source", { ...whole, source: "somebody" });
  bare("bad-expiry", { ...whole, expiresAt: "next tuesday" });
  writeFileSync(join(root, "notes", "broken.md"), "this is not a note");
  assert.deepEqual(
    [...store.rebuildIndex().rejectedFiles].sort(),
    ["bad-expiry.md", "bad-source.md", "broken.md", "no-owner.md", "no-revision.md", "no-title.md", "no-updated.md"],
  );
  // The good note is still there, and a second open is just as fine.
  assert.equal(store.list(A).length, 1);
  assert.equal(new MemoryStore(root).list(A).length, 1);
});

// MARK: - archive, source and readCard (UB-009)

test("archive refuses another bot's note, before the revision is looked at", () => {
  const { store } = fresh();
  const a = put(store, { botId: A, title: "Alpha" });
  assert.throws(() => store.archive(a.id, B, a.revision), /memory_forbidden/);
  assert.throws(() => store.archive(a.id, B, 99), /memory_forbidden/, "a wrong revision learns nothing either");
  assert.equal(store.read(a.id, A).title, "Alpha", "the note is untouched");
  assert.throws(() => store.archive("nope", A, 1), /memory_not_found/);
  assert.throws(() => store.archive("../x", A, 1), /memory_id_invalid/);
});

test("archive refuses a stale revision and leaves the note", () => {
  const { store } = fresh();
  const a = put(store, { title: "v1" });
  put(store, { id: a.id, expectedRevision: 1, title: "v2" });
  assert.throws(() => store.archive(a.id, A, 1), /memory_revision_conflict/);
  assert.equal(store.read(a.id, A).title, "v2");
});

test("an archived note is gone from list, search and read, in the file and the index, and survives a rebuild", () => {
  const { root, store } = fresh();
  const a = put(store, { title: "Gone soon", body: "findable-word" });
  const keep = put(store, { title: "Kept", body: "findable-word" });
  const out = store.archive(a.id, A, a.revision);
  assert.equal(out.revision, 2);
  assert.deepEqual(store.list(A).map((card) => card.id), [keep.id]);
  assert.deepEqual(store.search("findable-word", A).map((hit) => hit.id), [keep.id]);
  assert.throws(() => store.read(a.id, A), /memory_forbidden|memory_not_found/);
  assert.throws(() => store.readCard(a.id, A), /memory_not_found/);
  assert.match(readFileSync(join(root, "notes", `${a.id}.md`), "utf8"), /"status":"archived"/);
  const db = new DatabaseSync(join(root, "index.sqlite"));
  assert.equal((db.prepare("SELECT status FROM notes WHERE id = ?").get(a.id) as { status: string }).status, "archived");
  db.close();
  store.rebuildIndex();
  assert.deepEqual(store.list(A).map((card) => card.id), [keep.id]);
  // An archived id is never brought back by a write, and archiving twice is a not-found.
  assert.throws(() => put(store, { id: a.id, expectedRevision: 2 }), /memory_not_found/);
  assert.throws(() => store.archive(a.id, A, 2), /memory_not_found/);
});

test("the outside-content source is kept on the card and stays until the owner writes", () => {
  const { store } = fresh();
  const n = store.upsert({
    expectedRevision: null, title: "From a page", tags: [], body: "x", botId: A,
    source: "model-after-outside-content", expiresAt: null, sessionId: "s",
  });
  assert.equal(store.list(A)[0].source, "model-after-outside-content");
  // The model editing it in a clean turn keeps the mark.
  put(store, { id: n.id, expectedRevision: 1, body: "y", source: "model" });
  assert.equal(store.readCard(n.id, A).source, "model-after-outside-content");
  // The owner's edit clears it.
  put(store, { id: n.id, expectedRevision: 2, body: "z", source: "owner" });
  assert.equal(store.readCard(n.id, A).source, "owner");
  const plain = put(store, { title: "Plain" });
  assert.equal(store.readCard(plain.id, A).source, "model");
});

test("readCard returns the whole note with revision and source, and refuses another bot", () => {
  const { store } = fresh();
  const long = "w".repeat(3000);
  const a = put(store, { body: long });
  const card = store.readCard(a.id, A);
  assert.equal(card.body, long);
  assert.equal(card.revision, 1);
  assert.equal(card.truncated, false);
  assert.throws(() => store.readCard(a.id, B), /memory_forbidden/);
  assert.equal(store.list(A)[0].revision, 1, "the list carries the revision too");
});

test("an id that differs only in case from an existing note is refused on a case-insensitive disk", () => {
  const { root, store } = fresh();
  const probe = join(root, "Case-Probe");
  writeFileSync(probe, "x");
  const insensitive = existsSync(join(root, "case-probe"));
  put(store, { id: "case-note", title: "Lower" });
  if (insensitive) {
    assert.throws(() => put(store, { id: "CASE-NOTE", expectedRevision: 1, title: "Upper" }), /memory_id_conflict/);
    assert.equal(store.list(A).length, 1, "the index gained no second row");
  } else {
    // A case-sensitive disk keeps two separate files, so there is nothing to collide.
    assert.equal(put(store, { id: "CASE-NOTE", title: "Upper" }).id, "CASE-NOTE");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, botTag, resetMemoryDir, tagsForBot } from "../agent/lib/memory.ts";

test("upsert search read and revision conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  const created = store.upsert({
    expectedRevision: null,
    title: "Writing preference",
    tags: ["writing"],
    body: "Use short sentences.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "00000000-0000-4000-8000-000000000002",
  });
  const hits = store.search("short", "desktop");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, created.id);
  const read = store.read(created.id, "desktop");
  assert.match(read.body, /short sentences/);
  assert.throws(
    () => store.upsert({
      id: created.id,
      expectedRevision: 99,
      title: "Writing preference",
      tags: ["writing"],
      body: "changed",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_revision_conflict/,
  );
});

test("phone audience cannot read desktop notes", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  const created = store.upsert({
    expectedRevision: null,
    title: "Desktop only",
    tags: ["private"],
    body: "Stay on the Mac.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  assert.equal(store.search("Mac", "shared-phone").length, 0);
  assert.throws(() => store.read(created.id, "shared-phone"), /memory_forbidden/);
});

test("secret-like bodies are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  assert.throws(
    () => store.upsert({
      expectedRevision: null,
      title: "keys",
      tags: [],
      body: "api_key=not-a-real-secret-but-blocked",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_secret_refused/,
  );
});

test("rebuild index from markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Rebuild me",
    tags: ["index"],
    body: "Persian سلام and emoji 🙂 and code const x = 1;",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  const rebuilt = store.rebuildIndex();
  assert.equal(rebuilt.indexed, 1);
  assert.equal(store.search("سلام", "desktop").length, 1);
});

test("list returns desktop notes and hides phone audience", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Desktop note",
    tags: ["pref"],
    body: "Short sentences.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  store.upsert({
    expectedRevision: null,
    title: "Phone note",
    tags: ["phone"],
    body: "Not for the Mac list.",
    audience: "shared-phone",
    expiresAt: null,
    sessionId: "s",
  });
  const listed = store.list("desktop");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Desktop note");
  assert.equal(listed[0].tags[0], "pref");
  assert.equal(store.list("shared-phone").length, 1);
});

test("fts operator characters in a query do not throw", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Pricing",
    tags: ["pricing"],
    body: "Short sentences about pricing.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  for (const query of ['"', "OR", "*", "(", "pricing AND"]) {
    assert.doesNotThrow(() => store.search(query, "desktop"), `query ${query}`);
  }
  assert.equal(store.search("pricing", "desktop").length, 1);
  assert.equal(store.search("*", "desktop").length, 0);
});

test("note ids cannot traverse out of the notes directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  assert.throws(() => store.read("../outside", "desktop"), /memory_id_invalid/);
  assert.throws(
    () => store.upsert({
      id: "../outside",
      expectedRevision: null,
      title: "t",
      tags: [],
      body: "x",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_id_invalid/,
  );
});

test("an update cannot move a note across the audience boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  const created = store.upsert({
    expectedRevision: null,
    title: "Private",
    tags: [],
    body: "desktop only",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  assert.throws(
    () => store.upsert({
      id: created.id,
      expectedRevision: 1,
      title: "Private",
      tags: [],
      body: "desktop only",
      audience: "shared-phone",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_audience_change/,
  );
});

test("revision is enforced across two stores on the same directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const first = new MemoryStore(root);
  const second = new MemoryStore(root);
  const created = first.upsert({
    expectedRevision: null,
    title: "Shared",
    tags: [],
    body: "one",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  second.upsert({
    id: created.id,
    expectedRevision: 1,
    title: "Shared",
    tags: [],
    body: "two",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  assert.throws(
    () => first.upsert({
      id: created.id,
      expectedRevision: 1,
      title: "Shared",
      tags: [],
      body: "three",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_revision_conflict/,
  );
  assert.equal(first.read(created.id, "desktop").body, "two");
});

test("list can isolate notes to one bot tag", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "CEO pref",
    tags: tagsForBot(["writing"], "ceo"),
    body: "Short sentences.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  store.upsert({
    expectedRevision: null,
    title: "SEO pref",
    tags: tagsForBot(["seo"], "seo"),
    body: "Keyword notes.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  const ceo = store.list("desktop", 100, "ceo");
  const seo = store.list("desktop", 100, "seo");
  assert.equal(ceo.length, 1);
  assert.equal(ceo[0].title, "CEO pref");
  assert.equal(ceo[0].tags.includes(botTag("ceo")), true);
  assert.equal(seo.length, 1);
  assert.equal(seo[0].title, "SEO pref");
  assert.equal(store.list("desktop", 100, "missing").length, 0);
});

test("list applies the bot filter before the limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  const mine = store.upsert({
    expectedRevision: null,
    title: "Oldest note",
    tags: tagsForBot([], "target"),
    body: "Mine, and the oldest.",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  // Every other note must land in a strictly later millisecond so the old
  // limit-first SQL had no room left for the target bot's own note.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 100; i += 1) {
    store.upsert({
      expectedRevision: null,
      title: `Other ${i}`,
      tags: tagsForBot([], "other"),
      body: "Not for the target bot.",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    });
  }
  const listed = store.list("desktop", 100, "target");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, mine.id);
});

test("an offset expiry is normalised to a UTC instant and the note stays live", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Offset expiry",
    tags: [],
    body: "Still valid tomorrow.",
    audience: "desktop",
    // One hour ahead of the Z instant the schema accepts too.
    expiresAt: "2099-01-01T12:00:00+01:00",
    sessionId: "s",
  });
  const listed = store.list("desktop");
  assert.equal(listed.length, 1);
  const raw = readFileSync(join(root, "notes", `${listed[0].id}.md`), "utf8");
  const meta = JSON.parse(raw.split("\n")[1]) as { expiresAt: string };
  assert.equal(meta.expiresAt, "2099-01-01T11:00:00.000Z");
  assert.equal(store.search("Still valid", "desktop").length, 1);
  assert.throws(
    () => store.upsert({
      expectedRevision: null,
      title: "Bad expiry",
      tags: [],
      body: "unparsable",
      audience: "desktop",
      expiresAt: "not-a-time",
      sessionId: "s",
    }),
    /memory_meta/,
  );
});

test("tagsForBot keeps the bot tag when the note already carries eight user tags", () => {
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const tagged = tagsForBot(eight, "ceo");
  assert.equal(tagged.length, 8);
  assert.equal(tagged.includes(botTag("ceo")), true);
  assert.equal(tagged[7], botTag("ceo"));
  assert.deepEqual(tagged.slice(0, 7), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("ordinary text with sk- is saved; a real key shape is still refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  for (const body of ["my task-list for today", "desk-setup notes", "risk-taking is fine"]) {
    assert.doesNotThrow(
      () => store.upsert({
        expectedRevision: null,
        title: "Notes",
        tags: [],
        body,
        audience: "desktop",
        expiresAt: null,
        sessionId: "s",
      }),
      `body ${body}`,
    );
  }
  assert.throws(
    () => store.upsert({
      expectedRevision: null,
      title: "Key",
      tags: [],
      body: "sk-abcdefghijklmnopqrst",
      audience: "desktop",
      expiresAt: null,
      sessionId: "s",
    }),
    /memory_secret_refused/,
  );
});

test("a legacy invalid note id is skipped instead of poisoning list and search", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Good",
    tags: [],
    body: "searchable target",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  // A pre-existing index row whose id is unsafe as a file name, as an older
  // build could have written before ids were validated.
  const db = new DatabaseSync(join(root, "index.sqlite"));
  db.exec(
    "INSERT INTO notes (id, revision, body_sha, audience, tags, title, updated_at, expires_at, status) " +
      "VALUES ('my_note', 1, 'x', 'desktop', '', 'Legacy', '2020-01-01T00:00:00.000Z', NULL, 'active')",
  );
  db.exec("INSERT INTO notes_fts (title, tags, body, id) VALUES ('Legacy', '', 'legacy body', 'my_note')");
  db.close();

  assert.doesNotThrow(() => store.list("desktop"));
  assert.equal(store.list("desktop").length, 1);
  assert.equal(store.search("searchable", "desktop").length, 1);
  assert.equal(store.search("legacy", "desktop").length, 0);
  assert.equal(store.skippedRowCount() > 0, true);
});

test("rebuild counts an invalid id as rejected and keeps the good rows", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  store.upsert({
    expectedRevision: null,
    title: "Good",
    tags: [],
    body: "kept",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
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
  assert.equal(store.list("desktop").length, 1);
});

test("a crash between note rename and index insert is repaired on the next open", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-mem-"));
  resetMemoryDir(root);
  const store = new MemoryStore(root);
  const created = store.upsert({
    expectedRevision: null,
    title: "Crash",
    tags: [],
    body: "before the crash",
    audience: "desktop",
    expiresAt: null,
    sessionId: "s",
  });
  // Simulate the crash window: the markdown rename landed with new content but
  // the index was never updated, and the dirty marker was never cleared.
  const meta = {
    schemaVersion: 1,
    id: created.id,
    revision: 1,
    title: "Crash",
    tags: [],
    audience: "desktop",
    createdAt: "x",
    updatedAt: "x",
    expiresAt: null,
    sourceSessionId: "s",
    approvedBy: "owner",
    status: "active",
  };
  writeFileSync(join(root, "notes", `${created.id}.md`), `---\n${JSON.stringify(meta)}\n---\nrecovered body`);
  writeFileSync(join(root, "index.dirty"), `${created.id}\n`);
  assert.equal(store.search("recovered", "desktop").length, 0, "index is stale before repair");

  const reopened = new MemoryStore(root);
  assert.equal(reopened.search("recovered", "desktop").length, 1);
  assert.equal(existsSync(join(root, "index.dirty")), false);
});

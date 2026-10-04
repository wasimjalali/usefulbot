import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDirLock } from "../../shared/dir-lock.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { statePath } from "../../shared/stack.ts";

/**
 * Every note is desktop memory. `shared-phone` rows from before ownership
 * existed fold into `desktop` in the index migration below.
 */
export type Audience = "desktop";

/**
 * Who wrote the note last: the owner (Settings), the model (memory_upsert), or
 * the model in a turn that had read outside content (a page, an app result, a
 * file, a handoff). The last one is sticky: the model editing such a note
 * keeps the mark, and only the owner's edit or delete clears it.
 */
export type NoteSource = "owner" | "model" | "model-after-outside-content";
const NOTE_SOURCES: readonly string[] = ["owner", "model", "model-after-outside-content"];

export interface NoteMeta {
  schemaVersion: 1;
  id: string;
  revision: number;
  title: string;
  /** User tags only. Ownership lives in `botId`, never in a tag. */
  tags: string[];
  audience: Audience;
  /**
   * The bot this note belongs to, immutable once written. Search, read and
   * upsert all check it, so one bot cannot see or overwrite another's notes.
   */
  botId: string;
  source: NoteSource;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  sourceSessionId: string;
  approvedBy: string;
  status: "active" | "archived";
}

export interface MemoryExcerpt {
  id: string;
  revision: number;
  title: string;
  /** Who wrote it last: a tool that returns a note marks the turn when this is outside-sourced. */
  source: NoteSource;
  body: string;
  truncated: boolean;
}

export interface MemoryNoteCard extends MemoryExcerpt {
  tags: string[];
  updatedAt: string;
  source: NoteSource;
}

/** Index schema: 2 added `bot_id` and folded `shared-phone` into `desktop`. */
const INDEX_SCHEMA_VERSION = 2;
/** The legacy ownership tag, read only by the migration. */
const BOT_TAG_PREFIX = "bot:";
/** Search and list return previews this long; `read` returns the whole note. */
const PREVIEW_CHARS = 1024;
const NOTE_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;
// Long enough to wait out a first-open migration of a big store.
const LOCK_TIMEOUT_MS = 30_000;
/** Note ids are file names; anything else is a path traversal or a bad key. */
function assertNoteId(id: string): void {
  if (!NOTE_ID_PATTERN.test(id)) {
    throw new Error("memory_id_invalid");
  }
}

/**
 * Turn a free-text query into a safe FTS5 MATCH string. FTS5 operators (OR,
 * NOT, quotes, parens, `*`) in a user query throw a syntax error and fail the
 * whole turn; quoting every token makes the same string a literal phrase
 * search. A query with no word characters has no terms and matches nothing.
 */
function ftsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((term) => `"${term}"`).join(" ");
}

const SECRET_MARKERS = [
  "api_key",
  "api-key",
  "apikey",
  "begin private",
  "password=",
  "passwd=",
  "secret=",
  "token=",
  "bearer ",
  "authorization:",
  "-----begin",
];

/**
 * A bare `sk-` marker refused ordinary words such as "task-list" or
 * "desk-setup", so the tripwire now looks for a real key shape: `sk-` followed
 * by a long alphanumeric run. Real provider keys match; prose does not.
 */
const SECRET_KEY_PATTERN = /sk-[A-Za-z0-9]{16,}/;

function containsSecret(lowered: string): boolean {
  if (SECRET_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return SECRET_KEY_PATTERN.test(lowered);
}

export function memoryRoot(): string {
  const fromEnv = process.env.UB_MEMORY_ROOT;
  if (fromEnv) return fromEnv;
  return statePath("memory");
}

/**
 * A note's meta as this build reads it, whatever wrote the file. A note from
 * before ownership carries its bot in a `bot:<id>` tag; an untagged one
 * belongs to the Generalist. `legacy` says the file on disk should be
 * rewritten into the current shape (the migration does that once).
 */
function normalizeMeta(rec: Record<string, unknown>): { meta: NoteMeta; legacy: boolean } {
  const tags = Array.isArray(rec.tags) ? rec.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const botTagId = tags.find((tag) => tag.startsWith(BOT_TAG_PREFIX))?.slice(BOT_TAG_PREFIX.length) ?? "";
  const botId = typeof rec.botId === "string" && rec.botId !== ""
    ? rec.botId
    : botTagId !== "" ? botTagId : DEFAULT_BOT_ID;
  // Every expiry check compares strings with a UTC instant, so an offset form
  // is rewritten to UTC here (and the file with it, by the migration). An
  // expiry that is not a time at all makes the note malformed.
  let expiresAt: string | null = null;
  if (typeof rec.expiresAt === "string") {
    const at = Date.parse(rec.expiresAt);
    if (!Number.isFinite(at)) throw new Error("note_format");
    expiresAt = new Date(at).toISOString();
  }
  const source: NoteSource = typeof rec.source === "string" && NOTE_SOURCES.includes(rec.source) ? rec.source as NoteSource : "model";
  const legacy = typeof rec.botId !== "string"
    || rec.botId === ""
    || rec.audience !== "desktop"
    || rec.source !== source
    || expiresAt !== (rec.expiresAt ?? null)
    || tags.some((tag) => tag.startsWith(BOT_TAG_PREFIX));
  const meta = {
    ...(rec as unknown as NoteMeta),
    tags: tags.filter((tag) => !tag.startsWith(BOT_TAG_PREFIX)),
    audience: "desktop" as const,
    expiresAt,
    botId,
    source,
  };
  return { meta, legacy };
}

function parseNote(raw: string): { meta: NoteMeta; body: string; legacy: boolean } {
  const lines = raw.split("\n");
  if (lines[0] !== "---" || lines[2] !== "---") {
    throw new Error("note_format");
  }
  const parsed = JSON.parse(lines[1]) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("note_format");
  const rec = parsed as Record<string, unknown>;
  // The record must carry what the index needs, or it is a malformed note and
  // is rejected here rather than failing an insert later.
  if (
    typeof rec.id !== "string"
    || !Number.isInteger(rec.revision) || (rec.revision as number) < 1
    || typeof rec.title !== "string"
    || typeof rec.updatedAt !== "string"
    || (rec.expiresAt !== null && rec.expiresAt !== undefined && typeof rec.expiresAt !== "string")
    || (rec.status !== "active" && rec.status !== "archived")
  ) {
    throw new Error("note_format");
  }
  const { meta, legacy } = normalizeMeta(rec);
  const body = lines.slice(3).join("\n");
  return { meta, body, legacy };
}

/** The note file's text, or null when it vanished; any other failure throws. */
function readNoteFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function serializeNote(meta: NoteMeta, body: string): string {
  return `---\n${JSON.stringify(meta)}\n---\n${body}`;
}

/** A note as search and list show it: the body clipped to a preview. */
function previewOf(note: { id: string; revision: number; title: string; source: NoteSource }, body: string): MemoryExcerpt {
  return {
    id: note.id,
    revision: note.revision,
    title: note.title,
    source: note.source,
    body: body.slice(0, PREVIEW_CHARS),
    truncated: body.length > PREVIEW_CHARS,
  };
}

export class MemoryStore {
  readonly notesDir: string;
  readonly indexPath: string;
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly dirtyPath: string;
  private skippedRows = 0;
  /** Note files the last migration or rebuild could not parse, by name. */
  migrationRejected: string[] = [];

  constructor(root: string = memoryRoot()) {
    this.root = root;
    this.notesDir = join(root, "notes");
    this.indexPath = join(root, "index.sqlite");
    this.dirtyPath = join(root, "index.dirty");
    mkdirSync(this.notesDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.indexPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrateIfNeeded();
    this.repairIfDirty();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        body_sha TEXT NOT NULL,
        audience TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        tags TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, id UNINDEXED);
    `);
  }

  private schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  /**
   * One-time migration to ownership, safe to run twice and from two processes
   * (the web server and the agent both open the store). Under the store lock
   * it rewrites every legacy note file into the current shape (bot from the
   * `bot:<id>` tag, untagged notes to the Generalist, `shared-phone` to
   * `desktop`), then rebuilds the index with the `bot_id` column.
   */
  private migrateIfNeeded(): void {
    if (this.schemaVersion() >= INDEX_SCHEMA_VERSION) {
      this.createTables();
      return;
    }
    const release = this.acquire();
    try {
      // Re-checked under the lock: the other process may have finished first.
      if (this.schemaVersion() >= INDEX_SCHEMA_VERSION) {
        this.createTables();
        return;
      }
      for (const name of readdirSync(this.notesDir)) {
        if (!name.endsWith(".md")) continue;
        const path = join(this.notesDir, name);
        // An operational failure (a read, a rename) aborts the migration
        // before it is marked done, so the next open retries. Only a note
        // that is itself malformed is skipped, and the rebuild reports it.
        const raw = readNoteFile(path);
        if (raw === null) continue;
        let note: ReturnType<typeof parseNote>;
        try {
          note = parseNote(raw);
        } catch {
          continue;
        }
        const { meta, body, legacy } = note;
        if (!legacy || !NOTE_ID_PATTERN.test(meta.id)) continue;
        const tmp = join(this.notesDir, `.${meta.id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
        writeFileSync(tmp, serializeNote(meta, body), { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(tmp, path);
      }
      this.db.exec("DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS notes_fts;");
      this.createTables();
      const rebuilt = this.rebuildRows();
      this.migrationRejected = rebuilt.rejectedFiles;
      if (rebuilt.rejectedFiles.length > 0) {
        console.warn(`[useful-bot] memory migration skipped ${rebuilt.rejectedFiles.length} malformed note file(s): ${rebuilt.rejectedFiles.join(", ")}`);
      }
      this.db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
    } finally {
      release();
    }
  }

  /** Rows that could not be read during the last list or search. */
  skippedRowCount(): number {
    return this.skippedRows;
  }

  /** Release the SQLite handle; the tools share one store per process. */
  close(): void {
    this.db.close();
  }

  /**
   * A write marks the store dirty before the markdown rename and clears the
   * marker only after the row is indexed. A crash in between leaves the marker,
   * so the next open rebuilds the index from the markdown files and removes the
   * skew. The marker is written first, so it is present whenever a rename may
   * have landed without a matching index update.
   */
  private markDirty(id: string): void {
    try {
      writeFileSync(this.dirtyPath, `${id}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
    } catch { /* the marker is best effort; list/search still skip bad rows */ }
  }

  private clearDirty(): void {
    try { rmSync(this.dirtyPath, { force: true }); } catch { /* ignore */ }
  }

  private repairIfDirty(): void {
    if (!existsSync(this.dirtyPath)) return;
    try {
      this.rebuildIndex();
      this.clearDirty();
    } catch {
      // Leave the marker so a later open retries; reads already skip bad rows.
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
  }

  private acquire(): () => void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Owned lock: a live holder (a long migration, say) is never robbed by a
    // timer; only a dead holder's lock is reclaimed.
    return acquireDirLock(join(this.root, "index.lock"), {
      timeoutMs: LOCK_TIMEOUT_MS,
      errorCode: "memory_store_locked",
    });
  }

  rebuildIndex(): { indexed: number; rejected: number; rejectedFiles: string[] } {
    const release = this.acquire();
    try {
      return this.rebuildRows();
    } finally {
      release();
    }
  }

  /**
   * The rebuild itself; the caller holds the store lock. A malformed note is
   * rejected and named in `rejectedFiles`; an operational failure (an
   * unreadable file, a failed insert) throws, so nothing is marked done.
   */
  private rebuildRows(): { indexed: number; rejected: number; rejectedFiles: string[] } {
    let indexed = 0;
    const rejectedFiles: string[] = [];
    this.transaction(() => {
      this.db.exec("DELETE FROM notes; DELETE FROM notes_fts;");
      for (const name of readdirSync(this.notesDir)) {
        if (!name.endsWith(".md")) continue;
        const raw = readNoteFile(join(this.notesDir, name));
        if (raw === null) continue;
        let note: ReturnType<typeof parseNote>;
        try {
          note = parseNote(raw);
        } catch {
          rejectedFiles.push(name);
          continue;
        }
        // A legacy or hand-edited file can carry an id that is unsafe as a
        // file name. Skip it rather than poison the whole index.
        if (!NOTE_ID_PATTERN.test(note.meta.id)) {
          rejectedFiles.push(name);
          continue;
        }
        this.insertIndex(note.meta, note.body);
        indexed += 1;
      }
    });
    return { indexed, rejected: rejectedFiles.length, rejectedFiles };
  }

  /**
   * A bot's own notes matching a query. The bot filter and the expiry check
   * are in the SQL, before LIMIT: the index holds every bot's notes, so
   * filtering afterwards would let other bots' notes fill the window.
   */
  search(query: string, botId: string): MemoryExcerpt[] {
    if (!botId) throw new Error("memory_bot_required");
    const now = new Date().toISOString();
    let rows: Array<{ id: string }>;
    if (query.trim() === "") {
      rows = this.db.prepare(
        "SELECT id FROM notes WHERE status = 'active' AND bot_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC, id LIMIT 5",
      ).all(botId, now) as Array<{ id: string }>;
    } else {
      const match = ftsQuery(query);
      if (match === "") return [];
      rows = this.db.prepare(
        `SELECT notes.id AS id FROM notes_fts
         JOIN notes ON notes.id = notes_fts.id
         WHERE notes_fts MATCH ? AND notes.status = 'active' AND notes.bot_id = ?
           AND (notes.expires_at IS NULL OR notes.expires_at > ?)
         ORDER BY rank, notes.updated_at DESC, notes.id
         LIMIT 5`,
      ).all(match, botId, now) as Array<{ id: string }>;
    }
    const excerpts: MemoryExcerpt[] = [];
    for (const row of rows) {
      const excerpt = this.readExcerpt(row.id, botId);
      if (excerpt) excerpts.push(excerpt);
    }
    return excerpts;
  }

  /**
   * How many live notes a bot has, however many a page of them shows. Counted
   * from the index, where `list` also checks each note's file. They cannot
   * diverge for long: every write puts the file first and the index second
   * under one lock, and an open that finds the dirty marker rebuilds the index
   * from the files, so the only gap is a note whose file is unreadable, which
   * `list` skips and this still counts (an over-count by one, never under).
   */
  countLive(botId: string): number {
    if (!botId) throw new Error("memory_bot_required");
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM notes WHERE status = 'active' AND bot_id = ? AND (expires_at IS NULL OR expires_at > ?)",
    ).get(botId, new Date().toISOString()) as { c: number };
    return row.c;
  }

  list(botId: string, limit = 100): MemoryNoteCard[] {
    if (!botId) throw new Error("memory_bot_required");
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      "SELECT id FROM notes WHERE status = 'active' AND bot_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC, id LIMIT ?",
    ).all(botId, now, limit) as Array<{ id: string }>;
    const cards: MemoryNoteCard[] = [];
    for (const row of rows) {
      try {
        const { meta, body } = parseNote(readFileSync(join(this.notesDir, `${row.id}.md`), "utf8"));
        // The index is a cache of the files: a row whose file now says
        // another owner, or an expiry, is not this bot's live note.
        if (!this.isLiveFor(meta, botId)) continue;
        cards.push({ ...previewOf(meta, body), tags: meta.tags, updatedAt: meta.updatedAt });
      } catch {
        this.skippedRows += 1;
      }
    }
    return cards;
  }

  private isLiveFor(meta: NoteMeta, botId: string): boolean {
    if (meta.botId !== botId || meta.status !== "active") return false;
    return meta.expiresAt === null || meta.expiresAt > new Date().toISOString();
  }

  /**
   * An index row can outlive or disagree with its markdown file (a legacy id, a
   * deleted file, a crash mid-write). One bad row must not fail the whole read,
   * so it is skipped and counted; `read` keeps the strict id check for callers
   * that name a single note. A preview, clipped: only `read` returns a whole note.
   */
  private readExcerpt(id: string, botId: string): MemoryExcerpt | null {
    try {
      const note = this.read(id, botId);
      return previewOf(note, note.body);
    } catch {
      this.skippedRows += 1;
      return null;
    }
  }

  /**
   * One note, whole (up to the 8,192-byte write cap). Refused for a bot that
   * does not own it, and an expired note reads as gone.
   */
  read(id: string, botId: string): MemoryExcerpt {
    assertNoteId(id);
    if (!botId) throw new Error("memory_bot_required");
    const path = join(this.notesDir, `${id}.md`);
    if (!existsSync(path)) {
      throw new Error("memory_not_found");
    }
    const { meta, body } = parseNote(readFileSync(path, "utf8"));
    if (meta.botId !== botId || meta.status !== "active") {
      throw new Error("memory_forbidden");
    }
    if (meta.expiresAt !== null && meta.expiresAt <= new Date().toISOString()) {
      throw new Error("memory_not_found");
    }
    return {
      id: meta.id,
      revision: meta.revision,
      title: meta.title,
      source: meta.source,
      body,
      truncated: false,
    };
  }

  upsert(input: {
    id?: string;
    expectedRevision: number | null;
    title: string;
    tags: string[];
    body: string;
    /** The bot writing. A new note is owned by it; an existing one must be. */
    botId: string;
    source: NoteSource;
    expiresAt: string | null;
    sessionId: string;
  }): { id: string; revision: number } {
    if (!input.botId) throw new Error("memory_bot_required");
    if (Buffer.byteLength(input.body, "utf8") > 8192) {
      throw new Error("memory_too_large");
    }
    if (input.title.length > 120 || input.tags.length > 8) {
      throw new Error("memory_meta");
    }
    if (input.id !== undefined) assertNoteId(input.id);
    // The schema accepts an offset timestamp, but the index compares the
    // stored string against a Z-form now: an offset expiry would sort
    // wrongly, so every value is normalised to a UTC instant at write time.
    if (input.expiresAt !== null && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error("memory_meta");
    }
    const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
    const lowered = `${input.title}\n${input.body}`.toLowerCase();
    if (containsSecret(lowered)) {
      throw new Error("memory_secret_refused");
    }
    const release = this.acquire();
    try {
      const count = (this.db.prepare("SELECT COUNT(*) AS c FROM notes WHERE status = 'active'").get() as { c: number }).c;
      const id = input.id ?? randomUUID();
      const existingPath = join(this.notesDir, `${id}.md`);
      let revision = 1;
      let source: NoteSource = input.source;
      const now = new Date().toISOString();
      if (existsSync(existingPath)) {
        const prev = parseNote(readFileSync(existingPath, "utf8"));
        // A case-insensitive disk finds `abc.md` for the id `ABC`; writing it
        // would index a second row. Ids differing only in case are refused.
        if (prev.meta.id !== id) throw new Error("memory_id_conflict");
        // Ownership is the first check, under the write lock and before the
        // revision check, so a bot that guessed another bot's id learns
        // nothing about its revision and cannot overwrite it. A note is
        // never retagged.
        if (prev.meta.botId !== input.botId) {
          throw new Error("memory_forbidden");
        }
        // An archived note is gone: it is never brought back by a write.
        if (prev.meta.status !== "active") throw new Error("memory_not_found");
        if (input.expectedRevision !== prev.meta.revision) {
          throw new Error("memory_revision_conflict");
        }
        revision = prev.meta.revision + 1;
        // The outside-content mark outlasts the model's own edits.
        if (input.source === "model" && prev.meta.source === "model-after-outside-content") {
          source = "model-after-outside-content";
        }
      } else if (count >= 10_000) {
        throw new Error("memory_capacity");
      }
      const meta: NoteMeta = {
        schemaVersion: 1,
        id,
        revision,
        title: input.title,
        // The legacy ownership tag is never stored: owner is `botId`.
        tags: input.tags.filter((tag) => !tag.startsWith(BOT_TAG_PREFIX)),
        audience: "desktop",
        botId: input.botId,
        source,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        sourceSessionId: input.sessionId,
        approvedBy: "owner",
        status: "active",
      };
      const raw = serializeNote(meta, input.body);
      const tmp = join(this.notesDir, `.${id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
      try {
        writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("memory_revision_conflict");
        }
        throw error;
      }
      // The marker is written before the rename so a crash between the rename
      // and the index insert is repaired on the next open.
      this.markDirty(id);
      try {
        renameSync(tmp, existingPath);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw error;
      }
      this.transaction(() => this.insertIndex(meta, input.body));
      this.clearDirty();
      return { id, revision };
    } finally {
      release();
    }
  }

  /**
   * Remove a note: its status becomes `archived` in the file and in the index,
   * so list, search and read no longer see it. Ownership is checked first,
   * under the write lock, so a bot that guessed another bot's id learns
   * nothing about its revision; then the revision, so a note edited since it
   * was read is not deleted blind.
   */
  archive(id: string, botId: string, expectedRevision: number): { id: string; revision: number } {
    assertNoteId(id);
    if (!botId) throw new Error("memory_bot_required");
    const release = this.acquire();
    try {
      const path = join(this.notesDir, `${id}.md`);
      const raw = readNoteFile(path);
      if (raw === null) throw new Error("memory_not_found");
      const prev = parseNote(raw);
      if (prev.meta.botId !== botId) throw new Error("memory_forbidden");
      if (prev.meta.status !== "active") throw new Error("memory_not_found");
      if (expectedRevision !== prev.meta.revision) throw new Error("memory_revision_conflict");
      const meta: NoteMeta = {
        ...prev.meta,
        revision: prev.meta.revision + 1,
        updatedAt: new Date().toISOString(),
        status: "archived",
      };
      const tmp = join(this.notesDir, `.${id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
      writeFileSync(tmp, serializeNote(meta, prev.body), { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.markDirty(id);
      try {
        renameSync(tmp, path);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw error;
      }
      this.transaction(() => this.insertIndex(meta, prev.body));
      this.clearDirty();
      return { id, revision: meta.revision };
    } finally {
      release();
    }
  }

  /** One of the bot's live notes, whole, with the fields Settings shows. Refused like `read`. */
  readCard(id: string, botId: string): MemoryNoteCard & { body: string } {
    assertNoteId(id);
    if (!botId) throw new Error("memory_bot_required");
    const path = join(this.notesDir, `${id}.md`);
    const raw = readNoteFile(path);
    if (raw === null) throw new Error("memory_not_found");
    const { meta, body } = parseNote(raw);
    if (meta.botId !== botId) throw new Error("memory_forbidden");
    if (meta.status !== "active" || (meta.expiresAt !== null && meta.expiresAt <= new Date().toISOString())) {
      throw new Error("memory_not_found");
    }
    return { id: meta.id, revision: meta.revision, title: meta.title, source: meta.source, body, truncated: false, tags: meta.tags, updatedAt: meta.updatedAt };
  }

  private insertIndex(meta: NoteMeta, body: string): void {
    const sha = createHash("sha256").update(body).digest("hex");
    this.db.prepare(
      `INSERT INTO notes (id, revision, body_sha, audience, bot_id, tags, title, updated_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         revision=excluded.revision, body_sha=excluded.body_sha, audience=excluded.audience,
         bot_id=excluded.bot_id, tags=excluded.tags, title=excluded.title,
         updated_at=excluded.updated_at, expires_at=excluded.expires_at, status=excluded.status`,
    ).run(meta.id, meta.revision, sha, meta.audience, meta.botId, meta.tags.join(" "), meta.title, meta.updatedAt, meta.expiresAt, meta.status);
    this.db.prepare("DELETE FROM notes_fts WHERE id = ?").run(meta.id);
    this.db.prepare("INSERT INTO notes_fts (title, tags, body, id) VALUES (?, ?, ?, ?)").run(
      meta.title,
      meta.tags.join(" "),
      body,
      meta.id,
    );
  }
}

export function resetMemoryDir(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
}

let sharedStore: MemoryStore | null = null;
let sharedRoot = "";

/**
 * One store per process and root for the memory tools. Each tool call used
 * to open its own SQLite handle that only GC released; sharing one instance
 * keeps the handles bounded. Keyed by the resolved root so a changed
 * UB_MEMORY_ROOT (tests use one per case) does not keep the old directory.
 * Tests and the web route keep using the constructor.
 */
export function sharedMemoryStore(): MemoryStore {
  const root = memoryRoot();
  if (!sharedStore || sharedRoot !== root) {
    sharedStore?.close();
    sharedStore = new MemoryStore(root);
    sharedRoot = root;
  }
  return sharedStore;
}


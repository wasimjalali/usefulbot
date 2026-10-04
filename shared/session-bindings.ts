import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { acquireDirLock } from "./dir-lock.ts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { peekShell } from "./shell-io.ts";
import type { ShellStore } from "./shell-store.ts";
import { statePath } from "./stack.ts";

/**
 * Which bot owns an eve session: the durable identity record behind
 * `activeBotId`, the memory tools and the eve proxy.
 *
 * `SessionGrant` (workspace-store.ts) is a capability cache: capped at 64 and
 * evicted, so it cannot hold identity. This store is identity. A row is
 * written once and never changes, so a session can never be re-pointed at a
 * different bot. There is no eviction cap; a row goes only when its bot is
 * deleted (`unbindBot`).
 *
 * One file, two processes (the web server and the eve agent), so writes go
 * through the same directory lock plus atomic replace as the other stores.
 */

export const SESSION_OWNERS_SCHEMA = 1;

/** Same alphabet as the proxy's session ids: no dots, no slashes. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const BOT_ID = /^.{1,80}$/;

/**
 * `parentId` is set only on a sub-agent's child session: the root session it
 * was delegated from. The proxy refuses to send into such a session.
 */
export type SessionBinding = { botId: string; createdAt: string; parentId?: string };

export type SessionOwnersStore = {
  schemaVersion: 1;
  sessions: Record<string, SessionBinding>;
};

export function defaultSessionOwnersPath(): string {
  if (process.env.UB_SESSION_OWNERS_PATH) return process.env.UB_SESSION_OWNERS_PATH;
  // A test that forgot to isolate this store must not write into the owner's
  // real state folder, so under the runner the default is a per-process temp
  // file. Each test file is its own process.
  if (process.env.NODE_TEST_CONTEXT) return join(tmpdir(), `ub-session-owners-${process.pid}.json`);
  return statePath("session-owners.json");
}

function seedStore(): SessionOwnersStore {
  return { schemaVersion: SESSION_OWNERS_SCHEMA, sessions: {} };
}

/**
 * Strict: a bad shape is refused, never repaired. This is identity, so a row
 * that cannot be read as written must not be dropped quietly (a dropped row
 * is an unbound session) or reinterpreted.
 */
export function parseSessionOwners(raw: unknown): SessionOwnersStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session_owners_invalid");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== SESSION_OWNERS_SCHEMA) throw new Error("session_owners_schema");
  const sessions = rec.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("session_owners_sessions");
  const out: Record<string, SessionBinding> = {};
  for (const [sessionId, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!SESSION_ID.test(sessionId)) throw new Error("session_owners_session_id");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_owners_row");
    const row = value as Record<string, unknown>;
    if (typeof row.botId !== "string" || !BOT_ID.test(row.botId)) throw new Error("session_owners_bot_id");
    if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) {
      throw new Error("session_owners_created_at");
    }
    if (row.parentId !== undefined && (typeof row.parentId !== "string" || !SESSION_ID.test(row.parentId))) {
      throw new Error("session_owners_parent_id");
    }
    out[sessionId] = row.parentId === undefined
      ? { botId: row.botId, createdAt: row.createdAt }
      : { botId: row.botId, createdAt: row.createdAt, parentId: row.parentId };
  }
  return { schemaVersion: SESSION_OWNERS_SCHEMA, sessions: out };
}

function peekStoreFile(path: string): SessionOwnersStore | null {
  if (!existsSync(path)) return null;
  try {
    return parseSessionOwners(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Readers see an unreadable file as an empty one: a session with no row is
 * unbound, and unbound fails closed everywhere. The next write backs the bad
 * file up and says so.
 */
export function readSessionOwners(path = defaultSessionOwnersPath()): SessionOwnersStore {
  return peekStoreFile(path) ?? seedStore();
}

function writeStoreFile(store: SessionOwnersStore, path: string): void {
  const parsed = parseSessionOwners(store);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const LOCK_TIMEOUT_MS = 8000;

function updateStore<T>(
  mutate: (store: SessionOwnersStore) => { store: SessionOwnersStore; result: T },
  path: string,
): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Owned lock: a live writer is never robbed, and only the holder releases.
  const release = acquireDirLock(`${path}.lock`, {
    timeoutMs: LOCK_TIMEOUT_MS,
    errorCode: "session_owners_locked",
  });
  try {
    let previous = peekStoreFile(path);
    if (previous === null && existsSync(path)) {
      const bak = `${path}.invalid.${process.pid}.${Date.now()}`;
      try { renameSync(path, bak); } catch { /* ignore */ }
      console.warn(`[useful-bot] session owners store was unreadable; backed up to ${bak}`);
    }
    const out = mutate(previous ?? seedStore());
    if (out.store !== previous) writeStoreFile(out.store, path);
    return out.result;
  } finally {
    release();
  }
}

/** The bot a session is bound to, or null. No backfill: see `resolveSessionBot`. */
export function readSessionBot(sessionId: string, path = defaultSessionOwnersPath()): string | null {
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  return readSessionOwners(path).sessions[sessionId]?.botId ?? null;
}

/** The root session a child session was delegated from, or null (a root, or unbound). */
export function readSessionParent(sessionId: string, path = defaultSessionOwnersPath()): string | null {
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  return readSessionOwners(path).sessions[sessionId]?.parentId ?? null;
}

/**
 * Bind a session to a bot. Immutable: the same bot again is a no-op, another
 * bot is refused with `session_owner_conflict`.
 */
export function bindSession(
  sessionId: string,
  botId: string,
  at = new Date(),
  path = defaultSessionOwnersPath(),
): "created" | "exists" {
  if (!SESSION_ID.test(sessionId)) throw new Error("session_owners_session_id");
  if (!BOT_ID.test(botId)) throw new Error("session_owners_bot_id");
  return updateStore((store) => {
    const current = store.sessions[sessionId];
    if (current) {
      if (current.botId !== botId) throw new Error("session_owner_conflict");
      return { store, result: "exists" as const };
    }
    return {
      store: {
        ...store,
        sessions: { ...store.sessions, [sessionId]: { botId, createdAt: at.toISOString() } },
      },
      result: "created" as const,
    };
  }, path);
}

/**
 * Bind a verified sub-agent child session to the bot of the session it was
 * delegated from, recording that parent, so eve (which holds every session
 * call to a binding) answers a read of it. Immutable like `bindSession`: the
 * same bot and parent again is a no-op, anything else (another bot, another
 * parent, a session already bound as a root) is `session_owner_conflict`.
 */
export function bindChildSession(
  sessionId: string,
  parentId: string,
  botId: string,
  at = new Date(),
  path = defaultSessionOwnersPath(),
): "created" | "exists" {
  if (!SESSION_ID.test(sessionId) || !SESSION_ID.test(parentId) || sessionId === parentId) {
    throw new Error("session_owners_session_id");
  }
  if (!BOT_ID.test(botId)) throw new Error("session_owners_bot_id");
  return updateStore((store) => {
    const current = store.sessions[sessionId];
    if (current) {
      if (current.botId !== botId || current.parentId !== parentId) throw new Error("session_owner_conflict");
      return { store, result: "exists" as const };
    }
    return {
      store: {
        ...store,
        sessions: { ...store.sessions, [sessionId]: { botId, createdAt: at.toISOString(), parentId } },
      },
      result: "created" as const,
    };
  }, path);
}

const loggedConflicts = new Set<string>();

/**
 * Every session id the shell ties to a bot: a bot's live and carried-over
 * pointers, the sessions it replaced (`previousSessionIds`) and the sessions
 * its recents name. A recent whose bot is no longer on the roster names no one.
 */
function sessionPointers(shell: ShellStore): Array<{ sessionId: string; botId: string }> {
  const out: Array<{ sessionId: string; botId: string }> = [];
  const roster = new Set<string>();
  for (const bot of shell.bots) {
    roster.add(bot.id);
    for (const sessionId of [bot.sessionId, bot.continuedSessionId, ...(bot.previousSessionIds ?? [])]) {
      if (sessionId && SESSION_ID.test(sessionId)) out.push({ sessionId, botId: bot.id });
    }
  }
  for (const recent of shell.recents) {
    if (recent.sessionId && SESSION_ID.test(recent.sessionId) && roster.has(recent.botId)) {
      out.push({ sessionId: recent.sessionId, botId: recent.botId });
    }
  }
  return out;
}

/**
 * Bind every session pointer the roster holds (`sessionId`, `continuedSessionId`,
 * `previousSessionIds`, and the sessions its recents name) that is not bound yet. A pointer naming a session another bot already owns
 * is skipped and logged (once per pair per process): the binding wins over a
 * pointer. Returns how many rows it added.
 */
export function backfillSessionOwners(
  shell: ShellStore,
  at = new Date(),
  path = defaultSessionOwnersPath(),
): number {
  const wanted: Array<{ sessionId: string; botId: string }> = [];
  const known = readSessionOwners(path).sessions;
  // Two bots naming the same unbound session is ambiguous: roster order must
  // not decide who owns it, so neither is bound.
  const claimants = new Map<string, Set<string>>();
  const pointers = sessionPointers(shell);
  for (const { sessionId, botId } of pointers) {
    if (known[sessionId]) continue;
    claimants.set(sessionId, (claimants.get(sessionId) ?? new Set()).add(botId));
  }
  const ambiguous = new Set<string>();
  for (const [sessionId, bots] of claimants) {
    if (bots.size < 2) continue;
    ambiguous.add(sessionId);
    const key = `ambiguous:${sessionId}`;
    if (!loggedConflicts.has(key)) {
      loggedConflicts.add(key);
      console.warn(`[useful-bot] session ${sessionId} is named by ${[...bots].join(", ")}; bound to none`);
    }
  }
  for (const { sessionId, botId } of pointers) {
    if (ambiguous.has(sessionId)) continue;
    const owner = known[sessionId]?.botId;
    if (owner === botId) continue;
    if (owner) {
      const key = `${sessionId}:${botId}`;
      if (!loggedConflicts.has(key)) {
        loggedConflicts.add(key);
        console.warn(`[useful-bot] session ${sessionId} is bound to ${owner}; the pointer on ${botId} was skipped`);
      }
      continue;
    }
    wanted.push({ sessionId, botId });
  }
  if (wanted.length === 0) return 0;
  return updateStore((store) => {
    const sessions = { ...store.sessions };
    let added = 0;
    for (const item of wanted) {
      // Re-checked under the lock: another process may have bound it since.
      const current = sessions[item.sessionId];
      if (current) {
        if (current.botId !== item.botId) {
          const key = `${item.sessionId}:${item.botId}`;
          if (!loggedConflicts.has(key)) {
            loggedConflicts.add(key);
            console.warn(`[useful-bot] session ${item.sessionId} is bound to ${current.botId}; the pointer on ${item.botId} was skipped`);
          }
        }
        continue;
      }
      sessions[item.sessionId] = { botId: item.botId, createdAt: at.toISOString() };
      added += 1;
    }
    return added === 0
      ? { store, result: 0 }
      : { store: { ...store, sessions }, result: added };
  }, path);
}

/**
 * The bot a session belongs to: the stored binding, else one backfill from the
 * roster's pointers and a second look. Null means unbound.
 */
export function resolveSessionBot(
  sessionId: string,
  shell: ShellStore | null = peekShell(),
  path = defaultSessionOwnersPath(),
): string | null {
  const bound = readSessionBot(sessionId, path);
  if (bound) return bound;
  if (!shell || !SESSION_ID.test(sessionId)) return null;
  if (!sessionPointers(shell).some((pointer) => pointer.sessionId === sessionId)) return null;
  backfillSessionOwners(shell, new Date(), path);
  return readSessionBot(sessionId, path);
}

/**
 * May `botId` carry `sessionId` over into a new session? Only if the session is
 * its own: bound to it, or unbound and named by no other bot. A session bound
 * to another bot, or one two bots point at (ambiguous, so unbound), is not.
 */
export function sessionCarriesOverFor(
  sessionId: string,
  botId: string,
  shell: ShellStore | null = peekShell(),
  path = defaultSessionOwnersPath(),
): boolean {
  // A sub-agent's child session is read only; it is never carried over.
  if (readSessionParent(sessionId, path) !== null) return false;
  const owner = resolveSessionBot(sessionId, shell, path);
  if (owner !== null) return owner === botId;
  const claimants = shell ? sessionPointers(shell).filter((pointer) => pointer.sessionId === sessionId) : [];
  // No binding and no pointer at all is an unknown session, not an owned one.
  return claimants.length > 0 && claimants.every((pointer) => pointer.botId === botId);
}

/** Drop every row of a bot that was deleted. The only way a row leaves. */
export function unbindBot(botId: string, path = defaultSessionOwnersPath()): number {
  if (!botId) return 0;
  const known = readSessionOwners(path).sessions;
  if (!Object.values(known).some((row) => row.botId === botId)) return 0;
  return updateStore((store) => {
    const sessions: Record<string, SessionBinding> = {};
    let removed = 0;
    for (const [id, row] of Object.entries(store.sessions)) {
      if (row.botId === botId) removed += 1;
      else sessions[id] = row;
    }
    return removed === 0 ? { store, result: 0 } : { store: { ...store, sessions }, result: removed };
  }, path);
}

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./stack.ts";

export type BrowserSession = {
  callerId: string;
  profile: string;
  csrf: string;
  expiresAt: number;
  /**
   * The credential row this session was minted from (spec S9): the gate
   * re-resolves it per request so a revoked or expired credential kills its
   * sessions without a restart. Null for a desktop auto-session, which is not
   * bound to a credential.
   */
  credentialId: string | null;
};

export function defaultWebSessionsPath(): string {
  if (process.env.UB_WEB_SESSIONS_PATH) return process.env.UB_WEB_SESSIONS_PATH;
  return statePath("web-sessions.json");
}

export function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function load(path = defaultWebSessionsPath()): Record<string, BrowserSession> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: Record<string, BrowserSession> };
    return parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
  } catch {
    // A corrupt file must not be silently replaced: keep the evidence aside
    // so the next write starts from a fresh file.
    const bak = `${path}.invalid.${Date.now()}`;
    try { renameSync(path, bak); } catch { /* ignore */ }
    return {};
  }
}

function save(sessions: Record<string, BrowserSession>, path = defaultWebSessionsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const now = Date.now();
  const kept: Record<string, BrowserSession> = {};
  for (const [key, rec] of Object.entries(sessions)) {
    if (rec && rec.expiresAt > now) kept[key] = rec;
  }
  try {
    writeFileSync(tmp, `${JSON.stringify({ sessions: kept })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Stale below timeout, or one crashed holder makes every writer fail for the
 * whole stale window instead of clearing the corpse. The gap between them is
 * the margin a live holder gets before its lock is stolen mid-fsync.
 */
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 3000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  try {
    Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback for runtimes without Atomics.wait */
    }
  }
}

/**
 * Locked read-modify-write for the session file. A double login plus a logout
 * can overlap, and each writes the whole map; without the lock one write can
 * lose the other's session or resurrect a dropped one.
 */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) break;
      sleep(15);
    }
  }
  if (!held) throw new Error("web_sessions_locked");
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* ignore */ }
  }
}

export function putBrowserSession(token: string, rec: BrowserSession, path = defaultWebSessionsPath()): void {
  withLock(path, () => {
    const sessions = load(path);
    sessions[sessionKey(token)] = rec;
    save(sessions, path);
  });
}

export function getBrowserSession(token: string, path = defaultWebSessionsPath()): BrowserSession | null {
  const rec = load(path)[sessionKey(token)];
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}

export function dropBrowserSession(token: string, path = defaultWebSessionsPath()): void {
  withLock(path, () => {
    const sessions = load(path);
    delete sessions[sessionKey(token)];
    save(sessions, path);
  });
}

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A cross-process lock held by the operating system. Each lock is a SQLite
 * file next to the store (`<lock>.sqlite`); the holder keeps `BEGIN EXCLUSIVE`
 * open on it and releasing is closing the transaction. The kernel drops the
 * lock when the process dies, so there is no stale lock to reclaim, no owner
 * file and no pid check. Synchronous, like the stores that use it.
 *
 * Re-entering a lock this process already holds would deadlock on itself, so
 * it throws `dir_lock_reentered` instead.
 *
 * This replaces an older mkdir-based lock. A leftover `<lock>` directory from
 * it is simply ignored. No exclusion against the old protocol is needed: the
 * app stops the previous version's services before it swaps the runtime
 * (`stopOwnServices` before `RuntimeInstall.prepare`, macos/Sources/
 * UsefulBotApp/AppModel.swift:601-607), so an old-protocol writer never runs
 * alongside new code.
 */

// Holding the connection here keeps it alive for as long as the lock is held,
// whatever the caller does with the release handle.
const held = new Map<string, DatabaseSync>();

export function acquireDirLock(
  lock: string,
  options: { timeoutMs: number; errorCode: string },
): () => void {
  const file = `${lock}.sqlite`;
  if (held.has(file)) throw new Error("dir_lock_reentered");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
  } catch { /* the file may not exist until first use */ }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.timeoutMs))}`);
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    db.close();
    const code = (err as { errcode?: number }).errcode;
    // SQLITE_BUSY (5) after the busy timeout, or SQLITE_LOCKED (6).
    if (code === 5 || code === 6 || /locked|busy/i.test(String((err as Error).message))) {
      throw new Error(options.errorCode);
    }
    throw err;
  }
  held.set(file, db);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(file);
    try { db.exec("ROLLBACK"); } catch { /* nothing was written */ }
    db.close();
  };
}

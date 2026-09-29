import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SessionOwners {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS owners (session_id TEXT PRIMARY KEY, principal TEXT NOT NULL)");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try { chmodSync(file, 0o600); } catch { /* file may not exist yet */ }
    }
  }

  claim(sessionId: string, principal: string): "ok" | "forbidden" {
    // Insert-or-ignore then re-select is atomic under SQLite's primary key, so
    // two concurrent first claims cannot both decide they created the row.
    this.db.prepare("INSERT OR IGNORE INTO owners (session_id, principal) VALUES (?, ?)").run(sessionId, principal);
    const row = this.db.prepare("SELECT principal FROM owners WHERE session_id = ?").get(sessionId) as
      | { principal: string }
      | undefined;
    return row && row.principal === principal ? "ok" : "forbidden";
  }
}

export function defaultOwnerPath(): string {
  return join(process.env.UB_STATE_ROOT ?? join(process.env.HOME ?? "/tmp", ".useful-bot"), "policy.sqlite");
}

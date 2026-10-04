import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./stack.ts";
import { createHash, randomUUID } from "node:crypto";
import { parseModelSelection, type ModelSelection } from "./session-selection.ts";
// The permission vocabulary is client-safe and lives beside the bot fields
// that carry it; this store only adds persistence on top.
import {
  isGrantableRootPath,
  parseWorkspacePermission,
  type WorkspacePermission,
} from "./shell-store.ts";

export type { WorkspacePermission };
export { parseWorkspacePermission };

/**
 * Workspace grants and project recents.
 *
 * A grant is the per-session answer to "which folder may this conversation
 * work in, and how much may it do there". The web server writes it at turn
 * time from the bot's shell fields; the eve agent process reads it at tool
 * execution time. One file, two processes, so writes go through the same
 * directory-lock + atomic-replace convention as the other stores.
 */

export const WORKSPACE_SCHEMA = 1;
/** Grants outlive their session usefulness quickly; keep the file small. */
export const GRANTS_MAX = 64;
export const PROJECTS_MAX = 12;

export type SessionGrant = {
  sessionId: string;
  /** The attached folder, or null when the bot works under the owner's home. */
  path: string | null;
  permission: WorkspacePermission;
  /**
   * The model the bot runs on, stamped with the permission at turn start. The
   * agent prefers the owning bot's CURRENT selection at a turn's first step;
   * the grant is the fallback for a brand new session no bot owns yet, and the
   * source on the no-turn-id path (it only changes at turn start, so it is
   * stable within a turn). Absent on a grant stamped before this field, or by
   * a caller that passes none; the agent then uses the bot's own selection.
   */
  selection?: ModelSelection;
  updatedAt: string;
};

export type ProjectEntry = {
  id: string;
  path: string;
  name: string;
  lastUsedAt: string;
};

export type WorkspaceStore = {
  schemaVersion: 1;
  grants: SessionGrant[];
  projects: ProjectEntry[];
};

export function defaultWorkspacePath(): string {
  if (process.env.UB_WORKSPACE_STORE_PATH) return process.env.UB_WORKSPACE_STORE_PATH;
  return statePath("workspace.json");
}

function seedStore(at = new Date()): WorkspaceStore {
  return { schemaVersion: WORKSPACE_SCHEMA, grants: [], projects: [] };
}

function parseGrant(raw: unknown): SessionGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const sessionId = typeof rec.sessionId === "string" && rec.sessionId.length > 0 && rec.sessionId.length <= 200
    ? rec.sessionId
    : null;
  // Screened on read as well as on write: a hand-edited or older file must not
  // hand back a grant on `/` or on a credential folder that this build would
  // refuse to create. The tool re-checks too, but a row nothing can use has no
  // business occupying one of the store's slots.
  // A null path is a grant with no folder: the permission alone, applied to
  // the owner's home. A path that fails the screen drops the whole row.
  let path: string | null;
  if (rec.path === null || rec.path === undefined) path = null;
  else if (typeof rec.path === "string" && rec.path.length <= 1024 && isGrantableRootPath(rec.path)) path = rec.path;
  else return null;
  const permission = parseWorkspacePermission(rec.permission);
  if (!sessionId || !permission) return null;
  const selection = parseModelSelection(rec.selection);
  return {
    sessionId,
    path,
    permission,
    ...(selection ? { selection } : {}),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date(0).toISOString(),
  };
}

function parseProject(raw: unknown): ProjectEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 80) return null;
  if (typeof rec.path !== "string" || !rec.path.startsWith("/")) return null;
  if (typeof rec.name !== "string" || rec.name.length === 0) return null;
  return {
    id: rec.id,
    path: rec.path,
    name: rec.name.slice(0, 120),
    lastUsedAt: typeof rec.lastUsedAt === "string" ? rec.lastUsedAt : new Date(0).toISOString(),
  };
}

export function parseWorkspaceStore(raw: unknown): WorkspaceStore {
  if (!raw || typeof raw !== "object") throw new Error("workspace_invalid");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== WORKSPACE_SCHEMA) throw new Error("workspace_schema");
  if (rec.grants !== undefined && !Array.isArray(rec.grants)) throw new Error("workspace_grants");
  if (rec.projects !== undefined && !Array.isArray(rec.projects)) throw new Error("workspace_projects");
  const grants = (rec.grants ?? [])
    .map(parseGrant)
    .filter((grant): grant is SessionGrant => grant !== null);
  const projects = (rec.projects ?? [])
    .map(parseProject)
    .filter((project): project is ProjectEntry => project !== null);
  return {
    schemaVersion: WORKSPACE_SCHEMA,
    grants: dedupeNewest(grants, (grant) => grant.sessionId, (grant) => grant.updatedAt)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-GRANTS_MAX),
    projects: dedupeNewest(projects, (project) => project.path, (project) => project.lastUsedAt)
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
      .slice(-PROJECTS_MAX),
  };
}

/**
 * One row per key, keeping the record with the highest timestamp.
 * First-in-file is not the same as newest: a hand-edited or partially
 * recovered store can hold two rows for one session.
 */
function dedupeNewest<T>(rows: T[], key: (row: T) => string, stamp: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const current = byKey.get(key(row));
    if (!current || stamp(row) >= stamp(current)) byKey.set(key(row), row);
  }
  return [...byKey.values()];
}

function readStoreFile(path: string): WorkspaceStore {
  if (!existsSync(path)) return seedStore();
  try {
    return parseWorkspaceStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // An unreadable store must never block a turn: grants are a capability
    // cache, so starting empty only means tools fall back to the legacy root.
    return seedStore();
  }
}

/** The store as it sits on disk, or null when unreadable. */
function peekStoreFile(path: string): WorkspaceStore | null {
  if (!existsSync(path)) return null;
  try {
    return parseWorkspaceStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeStoreFile(store: WorkspaceStore, path: string): void {
  const parsed = parseWorkspaceStore(store);
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

// Stale below timeout, so a waiter can reclaim a dead lock before giving up.
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 3000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Locked read-modify-write; the web server and the agent both write. */
export function updateWorkspaceStore(
  mutate: (store: WorkspaceStore) => WorkspaceStore,
  path = defaultWorkspacePath(),
): WorkspaceStore {
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
  if (!held) throw new Error("workspace_locked");
  try {
    // Writes must not clobber what they could not read. If the store on disk
    // is corrupt, back it up first and start from the seed, the way the
    // shell store does; a silent overwrite loses the evidence.
    let previous = peekStoreFile(path);
    if (previous === null && existsSync(path)) {
      const bak = `${path}.invalid.${process.pid}.${Date.now()}`;
      try { renameSync(path, bak); } catch { /* ignore */ }
      console.warn(`[useful-bot] workspace store was unreadable; backed up to ${bak}`);
      previous = null;
    }
    const next = mutate(previous ?? seedStore());
    writeStoreFile(next, path);
    return next;
  } finally {
    try { rmdirSync(lock); } catch { /* ignore */ }
  }
}

export function readWorkspaceStore(path = defaultWorkspacePath()): WorkspaceStore {
  return readStoreFile(path);
}

/** The grant for one session, read fresh: permissions change mid-session. */
export function readSessionGrant(sessionId: string, path = defaultWorkspacePath()): SessionGrant | null {
  if (!sessionId) return null;
  return readStoreFile(path).grants.find((grant) => grant.sessionId === sessionId) ?? null;
}

export function upsertSessionGrant(
  input: { sessionId: string; path: string | null; permission: WorkspacePermission; selection?: ModelSelection },
  at = new Date(),
  path = defaultWorkspacePath(),
): void {
  // The grant is a filesystem capability, so it is validated here and not
  // only at the route: agent-exec stamps it from shell fields verbatim.
  if (!input.sessionId || input.sessionId.length > 200) {
    throw new Error("workspace_session_invalid");
  }
  // Segment screen and root refusal, not just "looks absolute": a grant on
  // `/` or on a credential folder must not reach the store even when a caller
  // hands it over typed. No folder at all is the home scope, and valid.
  if (input.path !== null && (input.path.length > 1024 || !isGrantableRootPath(input.path))) {
    throw new Error("workspace_path_invalid");
  }
  // The type says WorkspacePermission; a JS caller can still pass anything,
  // and a value parseGrant later drops would revoke the grant silently.
  if (!parseWorkspacePermission(input.permission)) {
    throw new Error("workspace_permission_invalid");
  }
  updateWorkspaceStore((store) => {
    const stamp = at.toISOString();
    const grant: SessionGrant = { ...input, updatedAt: stamp };
    const grants = [
      ...store.grants.filter((item) => item.sessionId !== input.sessionId),
      grant,
    ]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-GRANTS_MAX);
    return { ...store, grants };
  }, path);
}

/** Detaching a folder must revoke the capability, not just the bot field. */
export function removeSessionGrant(sessionId: string, path = defaultWorkspacePath()): void {
  if (!sessionId) return;
  updateWorkspaceStore((store) => ({
    ...store,
    grants: store.grants.filter((item) => item.sessionId !== sessionId),
  }), path);
}

export function projectIdFor(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 24);
}

export function upsertProject(
  input: { path: string; name: string },
  at = new Date(),
  path = defaultWorkspacePath(),
): ProjectEntry {
  // A recent is what the owner picks from next, so it is screened the same
  // way a grant is: a row nothing may be granted on has no business in the
  // picker.
  if (input.path.length > 1024 || !isGrantableRootPath(input.path)) {
    throw new Error("workspace_path_invalid");
  }
  const entry: ProjectEntry = {
    id: projectIdFor(input.path),
    path: input.path,
    // A folder name comes from the filesystem: strip control characters
    // before it reaches a menu row.
    name: sanitizeName(input.name),
    lastUsedAt: at.toISOString(),
  };
  updateWorkspaceStore((store) => {
    const projects = [
      ...store.projects.filter((item) => item.path !== input.path),
      entry,
    ]
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
      .slice(-PROJECTS_MAX);
    return { ...store, projects };
  }, path);
  return entry;
}

function sanitizeName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 120) || "Project";
}

export function removeProject(id: string, path = defaultWorkspacePath()): void {
  updateWorkspaceStore((store) => ({
    ...store,
    projects: store.projects.filter((item) => item.id !== id),
  }), path);
}

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertConnectionUrl } from "./connection-url.ts";
import { statePath } from "./stack.ts";

/**
 * Owner-approved MCP and OpenAPI connections. Secrets live in Keychain;
 * this file is the catalogue the eve registry and the connect card read.
 * Same write rules as connectors.json: 0600, atomic rename, locked merge.
 */

export type ConnectionKind = "mcp" | "openapi";
export type ConnectionAuthKind = "none" | "apiKey" | "bearer" | "oauth";

export type ConnectionEntry = {
  id: string;
  kind: ConnectionKind;
  name: string;
  url: string;
  description: string;
  authKind: ConnectionAuthKind;
  authHeader: string | null;
  toolsAllow: string[] | null;
  createdAt: string;
};

/**
 * What `upsertConnection` did. `won` is true when `entry` is this caller's own
 * row, whatever id it ended up with, and false when another row already held
 * the URL and this caller has nothing of its own in the store.
 */
export type UpsertOutcome = {
  won: boolean;
  entry: ConnectionEntry;
};

export type ConnectionsStore = {
  schemaVersion: 1;
  connections: ConnectionEntry[];
  updatedAt: string | null;
};

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const AUTH_KINDS = new Set<ConnectionAuthKind>(["none", "apiKey", "bearer", "oauth"]);

export const EXCALIDRAW_CONNECTION: ConnectionEntry = {
  id: "excalidraw",
  kind: "mcp",
  name: "Excalidraw",
  url: "https://mcp.excalidraw.com/mcp",
  description:
    "Official Excalidraw MCP App. Draw hand-drawn diagrams in the chat. Call read_me once, then create_view with Excalidraw elements.",
  authKind: "none",
  authHeader: null,
  toolsAllow: ["read_me", "create_view"],
  createdAt: "2026-09-16T00:00:00.000Z",
};

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

export function connectionsPath(root = process.env.UB_CONNECTIONS_PATH): string {
  if (root) return root;
  return statePath("connections.json");
}

export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isAuthHeaderName(value: unknown): value is string {
  return typeof value === "string" && HEADER.test(value);
}

export function slugifyConnectionId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (isConnectionId(slug)) return slug;
  return "server";
}

export function emptyConnectionsStore(): ConnectionsStore {
  return { schemaVersion: 1, connections: [], updatedAt: null };
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseToolsAllow(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names = raw
    .filter((item): item is string => typeof item === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(item))
    .slice(0, 64);
  return names.length ? [...new Set(names)] : null;
}

function parseEntry(raw: unknown): ConnectionEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!isConnectionId(rec.id)) return null;
  if (rec.kind !== "mcp" && rec.kind !== "openapi") return null;
  const name = clip(rec.name, 80);
  if (!name) return null;
  let url: string;
  try {
    url = assertConnectionUrl(typeof rec.url === "string" ? rec.url : "");
  } catch {
    return null;
  }
  const description = clip(rec.description, 400);
  if (description.length < 3) return null;
  if (typeof rec.authKind !== "string" || !AUTH_KINDS.has(rec.authKind as ConnectionAuthKind)) return null;
  const authKind = rec.authKind as ConnectionAuthKind;
  const authHeader = typeof rec.authHeader === "string" && HEADER.test(rec.authHeader)
    ? rec.authHeader
    : authKind === "apiKey" ? "X-Api-Key" : null;
  return {
    id: rec.id,
    kind: rec.kind,
    name,
    url,
    description,
    authKind,
    authHeader: authKind === "apiKey" ? (authHeader ?? "X-Api-Key") : null,
    toolsAllow: parseToolsAllow(rec.toolsAllow),
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date(0).toISOString(),
  };
}

export function parseConnectionsStore(raw: unknown): ConnectionsStore {
  if (!raw || typeof raw !== "object") throw new Error("connections_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("connections_schema");
  const seen = new Set<string>();
  const connections: ConnectionEntry[] = [];
  for (const item of Array.isArray(rec.connections) ? rec.connections : []) {
    const entry = parseEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    connections.push(entry);
  }
  return {
    schemaVersion: 1,
    connections,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
  };
}

export function readConnectionsStore(path = connectionsPath()): ConnectionsStore {
  if (!existsSync(path)) return emptyConnectionsStore();
  try {
    return parseConnectionsStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    const bak = `${path}.invalid.${Date.now()}`;
    try { renameSync(path, bak); } catch { /* ignore */ }
    return emptyConnectionsStore();
  }
}

export function writeConnectionsStore(store: ConnectionsStore, path = connectionsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

export function updateConnectionsStore<T>(
  fn: (store: ConnectionsStore) => T,
  path = connectionsPath(),
): T {
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
      } catch {
        /* lock vanished; retry */
      }
      if (Date.now() > deadline) break;
      sleep(15);
    }
  }
  if (!held) throw new Error("connections_locked");
  try {
    const existed = existsSync(path);
    const store = readConnectionsStore(path);
    const before = JSON.stringify(store);
    const result = fn(store);
    const after = JSON.stringify(store);
    if (!existed || after !== before) {
      store.updatedAt = new Date().toISOString();
      writeConnectionsStore(store, path);
    }
    return result;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* ignore */
    }
  }
}

export function findConnectionById(id: string, path = connectionsPath()): ConnectionEntry | null {
  return readConnectionsStore(path).connections.find((item) => item.id === id) ?? null;
}

export function findConnectionByUrl(url: string, path = connectionsPath()): ConnectionEntry | null {
  let normalised = "";
  try {
    normalised = assertConnectionUrl(url);
  } catch {
    return null;
  }
  return readConnectionsStore(path).connections.find((item) => item.url === normalised) ?? null;
}

export function allocateConnectionId(name: string, path = connectionsPath()): string {
  const base = slugifyConnectionId(name);
  const taken = new Set(readConnectionsStore(path).connections.map((item) => item.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const id = `${base.slice(0, 60)}-${n}`;
    if (isConnectionId(id) && !taken.has(id)) return id;
  }
  throw new Error("connections_id");
}

/**
 * Insert or replace a connection, and return the row that is now live.
 *
 * A URL may hold one row. Two rows for the same server are both mounted by
 * `agent/connections/registry.ts`, so the model sees every one of that
 * server's tools twice and both copies count against the tool cap. Two cards
 * for one server are reachable: `propose_connection` refuses a URL that is
 * already connected and allows one pending card per thread, but that is per
 * thread, and two bots can each hold a card the owner then authorizes.
 *
 * When another row already holds this URL, that row wins untouched and comes
 * back with `won: false`. It is never merged with the incoming entry: its
 * Keychain item belongs to whatever auth it was connected with, and folding
 * another card's authKind, authHeader or toolsAllow into it would leave the
 * row describing one credential and using another.
 *
 * `won` has to be said out loud rather than inferred. The URL cannot carry it,
 * because a row found by URL has the entry's URL by definition; the id cannot
 * either, because a winner's id is reassigned when the one it asked for turned
 * out to be a different server's. A caller that guesses writes its secret over
 * the winner's.
 *
 * The check is inside the lock because the callers cannot make it atomic:
 * `startConnectionConfirm` awaits a tool-count probe between looking and
 * writing, so two confirms would otherwise both find nothing and both insert.
 */
export function upsertConnection(entry: ConnectionEntry, path = connectionsPath()): UpsertOutcome {
  return updateConnectionsStore((store): UpsertOutcome => {
    const sameUrl = store.connections.find((item) => item.url === entry.url && item.id !== entry.id);
    if (sameUrl) return { won: false, entry: sameUrl };
    const index = store.connections.findIndex((item) => item.id === entry.id);
    if (index < 0) {
      store.connections.push(entry);
      return { won: true, entry };
    }
    if (store.connections[index].url === entry.url) {
      store.connections[index] = entry;
      return { won: true, entry };
    }
    // The id is already a different server's. `allocateConnectionId` only
    // looks at rows that exist, so two cards proposed for servers with the
    // same name, before either is connected, are handed the same id. Replacing
    // here would repoint a live connection at another URL and leave its
    // Keychain item filed under an id that now means something else. The new
    // server gets a free id instead, and the caller reads it off the return.
    const fresh = { ...entry, id: freeConnectionId(store, entry.id) };
    store.connections.push(fresh);
    return { won: true, entry: fresh };
  }, path);
}

/** The first unused id at or after `base`, from a store already held. */
function freeConnectionId(store: ConnectionsStore, base: string): string {
  const taken = new Set(store.connections.map((item) => item.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const id = `${base.slice(0, 60)}-${n}`;
    if (isConnectionId(id) && !taken.has(id)) return id;
  }
  throw new Error("connections_id");
}

/** Drop one row. True when there was one. */
export function removeConnection(id: string, path = connectionsPath()): boolean {
  return updateConnectionsStore((store) => {
    const before = store.connections.length;
    store.connections = store.connections.filter((item) => item.id !== id);
    return store.connections.length < before;
  }, path);
}

/**
 * Insert Excalidraw when the file has no row for that id or URL. Safe to
 * call on every setup; never overwrites an owner-edited row.
 */
export function seedDefaultConnections(path = connectionsPath()): ConnectionEntry {
  return updateConnectionsStore((store) => {
    const existing = store.connections.find(
      (item) => item.id === EXCALIDRAW_CONNECTION.id || item.url === EXCALIDRAW_CONNECTION.url,
    );
    if (existing) return existing;
    store.connections.push({ ...EXCALIDRAW_CONNECTION });
    return EXCALIDRAW_CONNECTION;
  }, path);
}

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./stack.ts";

/**
 * Connectors state: the owner's Composio API key, the stable user id the
 * connected accounts are keyed to, the one Tool Router session the agent
 * reuses, and a cache of which toolkits are connected. Composio is the source
 * of truth for connections; the cache lets the agent tools refuse cheaply when
 * nothing is connected and restrict the session to connected apps.
 *
 * Same shape as providers.json: 0600 JSON, read on demand by both the web and
 * the eve process, and the key never leaves this file except into a Composio
 * client. Writes go through a lock like the routines store, because the web
 * route and an agent tool can both refresh the connected cache.
 */

export interface ConnectorsStore {
  schemaVersion: 1;
  apiKey: string | null;
  userId: string;
  sessionId: string | null;
  connectedToolkits: string[];
  updatedAt: string | null;
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const SLUG = /^[a-z0-9_]{1,64}$/;

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

export function connectorsPath(root = process.env.UB_CONNECTORS_PATH): string {
  if (root) return root;
  return statePath("connectors.json");
}

export function isToolkitSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

export function emptyConnectorsStore(): ConnectorsStore {
  return {
    schemaVersion: 1,
    apiKey: null,
    userId: `ub_${randomBytes(6).toString("hex")}`,
    sessionId: null,
    connectedToolkits: [],
    updatedAt: null,
  };
}

export function last4(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

export function parseConnectorsStore(raw: unknown): ConnectorsStore {
  if (!raw || typeof raw !== "object") throw new Error("connectors_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("connectors_schema");
  if (typeof rec.userId !== "string" || !/^ub_[0-9a-f]{12}$/.test(rec.userId)) {
    throw new Error("connectors_user");
  }
  const apiKey = typeof rec.apiKey === "string" && rec.apiKey ? rec.apiKey : null;
  const sessionId = typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : null;
  const connected = Array.isArray(rec.connectedToolkits)
    ? [...new Set(rec.connectedToolkits.filter(isToolkitSlug))].sort()
    : [];
  return {
    schemaVersion: 1,
    apiKey,
    userId: rec.userId,
    sessionId,
    connectedToolkits: connected,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
  };
}

export function readConnectorsStore(path = connectorsPath()): ConnectorsStore {
  if (!existsSync(path)) return emptyConnectorsStore();
  try {
    return parseConnectorsStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A corrupt file must not throw forever: keep the evidence aside and
    // start empty, the way the shell store reseeds a bad file.
    const bak = `${path}.invalid.${Date.now()}`;
    try { renameSync(path, bak); } catch { /* ignore */ }
    return emptyConnectorsStore();
  }
}

/**
 * Atomic: the other process reads without the lock, so it must see the old
 * file or the new one, never a truncated one. The mode is re-applied on every
 * write, so a file that was ever created lax is tightened the next time the
 * key is touched.
 */
export function writeConnectorsStore(store: ConnectorsStore, path = connectorsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  // The fsync before the rename is what makes the rename mean something: the
  // key and the user id are not derivable, so a torn write here loses them.
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/**
 * Locked read/merge/write. The callback mutates the scratch copy; the file is
 * rewritten only when something changed. A fresh store (no file yet) keeps
 * the user id it was created with once written, so the connected accounts on
 * Composio stay keyed to one id.
 */
export function updateConnectorsStore<T>(
  fn: (store: ConnectorsStore) => T,
  path = connectorsPath(),
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
  if (!held) throw new Error("connectors_locked");
  try {
    const existed = existsSync(path);
    const store = readConnectorsStore(path);
    const before = JSON.stringify(store);
    const result = fn(store);
    const after = JSON.stringify(store);
    if (!existed || after !== before) {
      store.updatedAt = new Date().toISOString();
      writeConnectorsStore(store, path);
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

/**
 * A pasted key often arrives with a newline or a space from the page it was
 * copied off. No key legitimately contains whitespace, so it is stripped
 * rather than refused; a key that is still too short or too long is refused.
 */
export function setConnectorsKey(store: ConnectorsStore, key: string): void {
  const trimmed = normaliseKey(key);
  // A "Composio For You" consumer key (ck_) is for MCP clients; the SDK this
  // app uses needs a Platform project key (ak_). Say so instead of failing
  // later with Composio's generic 401.
  if (/^ck_/i.test(trimmed)) throw new Error("connectors_key_consumer");
  if (trimmed.length < 8 || trimmed.length > 4096) throw new Error("connectors_key");
  if (store.apiKey !== trimmed) {
    // A new key means a new Composio project: the old session and its
    // connections belong to the old one.
    store.sessionId = null;
    store.connectedToolkits = [];
  }
  store.apiKey = trimmed;
}

/**
 * What people paste is rarely just the key: Composio's docs show it as
 * `export COMPOSIO_API_KEY=ak_...`, often quoted. Everything but the key is
 * dropped so the saved value is what Composio expects in the header.
 */
export function normaliseKey(raw: string): string {
  let value = raw.replace(/\s+/g, "");
  value = value.replace(/^(export)?COMPOSIO_API_KEY=/i, "");
  value = value.replace(/^["'`]+|["'`,;]+$/g, "");
  return value;
}

export function clearConnectorsKey(store: ConnectorsStore): void {
  store.apiKey = null;
  store.sessionId = null;
  store.connectedToolkits = [];
}

export function setConnectedToolkits(store: ConnectorsStore, slugs: string[]): void {
  store.connectedToolkits = [...new Set(slugs.filter(isToolkitSlug))].sort();
}

/** What the UI may see. Never the key, the user id or the session id. */
export function publicConnectors(store: ConnectorsStore): {
  hasKey: boolean;
  last4: string | null;
  connectedToolkits: string[];
} {
  return {
    hasKey: store.apiKey !== null,
    last4: store.apiKey ? last4(store.apiKey) : null,
    connectedToolkits: [...store.connectedToolkits],
  };
}

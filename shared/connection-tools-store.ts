import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { MAX_SESSION_TOOLS, MAX_SESSION_TOOL_BYTES } from "./policy.ts";
import { schemaBytesOf, toolWireBytes } from "./tool-wire-size.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { rawSchemaHint, toolInputSchema } from "./json-schema-zod.ts";
import { statePath } from "./stack.ts";

/**
 * Which of a connection's tools a session has asked for, and what each
 * connection's tools are.
 *
 * An MCP server's whole tool set no longer sits in context on every turn:
 * `find_tools` looks through this index and records what it handed over, and
 * the step resolver mounts those. eve can replay a resolver in a fresh
 * process on recovery, so the record has to survive the process, which an
 * in-memory map would not.
 *
 * Same write rules as the other stores here: 0600, atomic rename, locked
 * merge. Nothing in it is a secret: tool names, descriptions and argument
 * schemas, all of them things the model already sees.
 */

export type IndexedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  /**
   * What this tool's arguments weigh on the wire: zod's emission of the
   * converted schema, or the raw schema written into the description when it
   * could not be converted. Not the server's own JSON, which zod re-emits
   * about twice as large. Kept even when the schema itself was not.
   */
  inputSchemaBytes: number;
};

export type ConnectionIndex = {
  fetchedAt: string;
  tools: IndexedTool[];
  /**
   * An OpenAPI connection's operation count and the argument-schema bytes
   * eve builds from its spec. eve turns the spec into tools itself and this
   * side never sees them, so these are what it is weighed by later.
   */
  operations?: number;
  schemaBytes?: number;
  textBytes?: number;
  /** The longest tool name eve builds from the spec, unprefixed. */
  longestName?: number;
  /**
   * The listing was attempted and did not arrive. Kept apart from a listing
   * that came back empty: one is a server this side cannot weigh, the other
   * is a server that weighs nothing.
   */
  failed?: boolean;
};

/**
 * What the last attempt to list a connection's tools found. `ready` and
 * `zero_tools` are the two answers from a server that is working; the rest say
 * why it is not. `malformed` is a listing that arrived with every tool dropped
 * as invalid (a name or schema this app cannot mount).
 */
export type ConnectionState =
  | "pending"
  | "ready"
  | "zero_tools"
  | "auth_failed"
  | "expired"
  | "unreachable"
  | "malformed"
  | "discovery_failed";

const CONNECTION_STATES = new Set<string>([
  "pending", "ready", "zero_tools", "auth_failed", "expired", "unreachable", "malformed", "discovery_failed",
]);

export type ConnectionStatus = {
  state: ConnectionState;
  /**
   * A short code and a short message this app wrote. Never a header, a token
   * or a piece of what the server sent back.
   */
  lastError: { code: string; message: string } | null;
  checkedAt: string;
  /** Tools the owner's bots can reach; null when no listing arrived. */
  toolCount: number | null;
  /** How many listed tools were dropped as invalid. */
  dropped?: number;
};

export type SessionTools = {
  updatedAt: string;
  /** `<connectionId>__<toolName>`, the name eve mounts and the app parses. */
  tools: string[];
};

export type ConnectionToolsStore = {
  schemaVersion: 1;
  index: Record<string, ConnectionIndex>;
  /** Per connection id, beside the listing it describes. */
  status: Record<string, ConnectionStatus>;
  sessions: Record<string, SessionTools>;
  /**
   * Connections removed, and when. A discovery that started before its
   * connection was removed must not write the row back, and the status row
   * that used to say so goes with the connection, so the removal is recorded
   * here, in the same file the writes go to.
   */
  deleted: Record<string, string>;
};

/** Removals remembered. Far more than an owner has connections; the oldest go first. */
const MAX_DELETED = 200;

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
/** A listing older than this is refetched the next time a search needs it. */
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A listing that failed or came back empty is asked for again after this, not
 * after the six hours a good one keeps: an owner who just reconnected should
 * not wait for the cache to forget.
 */
export const LISTING_RETRY_MS = 2 * 60 * 1000;
/** Sessions kept. The oldest go first; a dropped one just re-asks. */
const MAX_SESSIONS = 100;
/**
 * A tool this app can actually mount. The charset is the upstream's, not a
 * guess: a name with a dot or a space in it is refused by the model provider
 * with the same non-retryable error the budgets exist to avoid, so a server
 * that namespaces its tools that way has them dropped here rather than
 * mounted into a turn that cannot run.
 */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,80}$/;

/**
 * The provider validates the mounted name, `<connectionId>__<toolName>`, not
 * the tool's own, against `^[a-zA-Z0-9_-]{1,64}$`. A connection id may run to
 * sixty-four characters and a tool name to eighty, so a tool that passed a
 * screen of its own name could still be refused on the wire, non-retryably,
 * with the session retired behind it.
 */
const MOUNTED_NAME_MAX = 64;

export function isMountableToolName(connectionId: string, name: string): boolean {
  return TOOL_NAME.test(name) && mountedToolName(connectionId, name).length <= MOUNTED_NAME_MAX;
}

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

export function connectionToolsPath(root = process.env.UB_CONNECTION_TOOLS_PATH): string {
  if (root) return root;
  return statePath("connection-tools.json");
}

/** The name eve mounts a connection's tool under, and the app parses back. */
export function mountedToolName(connectionId: string, toolName: string): string {
  return `${connectionId}__${toolName}`;
}

export function emptyConnectionToolsStore(): ConnectionToolsStore {
  return { schemaVersion: 1, index: {}, status: {}, sessions: {}, deleted: {} };
}

function parseTool(raw: unknown): IndexedTool | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== "string" || !TOOL_NAME.test(rec.name)) return null;
  const schema = rec.inputSchema && typeof rec.inputSchema === "object" && !Array.isArray(rec.inputSchema)
    ? rec.inputSchema as Record<string, unknown>
    : null;
  const description = typeof rec.description === "string" ? rec.description.slice(0, 400) : "";
  return {
    name: rec.name,
    description,
    inputSchema: schema,
    inputSchemaBytes: typeof rec.inputSchemaBytes === "number" && Number.isFinite(rec.inputSchemaBytes)
      ? Math.max(0, Math.trunc(rec.inputSchemaBytes))
      : schemaBytesOf(schema),
  };
}

function parseStatus(raw: unknown): ConnectionStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.state !== "string" || !CONNECTION_STATES.has(rec.state)) return null;
  const err = rec.lastError && typeof rec.lastError === "object" ? rec.lastError as Record<string, unknown> : null;
  return {
    state: rec.state as ConnectionState,
    lastError: err && typeof err.code === "string" && typeof err.message === "string"
      ? { code: err.code.slice(0, 80), message: err.message.slice(0, 200) }
      : null,
    checkedAt: typeof rec.checkedAt === "string" ? rec.checkedAt : new Date(0).toISOString(),
    toolCount: typeof rec.toolCount === "number" && Number.isFinite(rec.toolCount)
      ? Math.max(0, Math.trunc(rec.toolCount))
      : null,
    ...(typeof rec.dropped === "number" && Number.isFinite(rec.dropped)
      ? { dropped: Math.max(0, Math.trunc(rec.dropped)) }
      : {}),
  };
}

export function parseConnectionToolsStore(raw: unknown): ConnectionToolsStore {
  if (!raw || typeof raw !== "object") throw new Error("connection_tools_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("connection_tools_schema");
  const store = emptyConnectionToolsStore();
  const index = rec.index && typeof rec.index === "object" ? rec.index as Record<string, unknown> : {};
  for (const [id, value] of Object.entries(index)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const tools = (Array.isArray(row.tools) ? row.tools : [])
      .map(parseTool)
      .filter((tool): tool is IndexedTool => tool !== null)
      .slice(0, 200);
    store.index[id] = {
      fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : new Date(0).toISOString(),
      tools,
      ...(typeof row.operations === "number" && Number.isFinite(row.operations)
        ? { operations: Math.max(0, Math.trunc(row.operations)) }
        : {}),
      ...(typeof row.schemaBytes === "number" && Number.isFinite(row.schemaBytes)
        ? { schemaBytes: Math.max(0, Math.trunc(row.schemaBytes)) }
        : {}),
      ...(typeof row.textBytes === "number" && Number.isFinite(row.textBytes)
        ? { textBytes: Math.max(0, Math.trunc(row.textBytes)) }
        : {}),
      ...(typeof row.longestName === "number" && Number.isFinite(row.longestName)
        ? { longestName: Math.max(0, Math.trunc(row.longestName)) }
        : {}),
      ...(row.failed === true ? { failed: true } : {}),
    };
  }
  const statuses = rec.status && typeof rec.status === "object" ? rec.status as Record<string, unknown> : {};
  for (const [id, value] of Object.entries(statuses)) {
    const status = parseStatus(value);
    if (status) store.status[id] = status;
  }
  const sessions = rec.sessions && typeof rec.sessions === "object"
    ? rec.sessions as Record<string, unknown>
    : {};
  for (const [id, value] of Object.entries(sessions)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const tools = (Array.isArray(row.tools) ? row.tools : [])
      .filter((name): name is string => typeof name === "string" && name.length <= 165 && name.includes("__"))
      .slice(0, MAX_SESSION_TOOLS);
    store.sessions[id] = {
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
      tools: [...new Set(tools)],
    };
  }
  const deleted = rec.deleted && typeof rec.deleted === "object" ? rec.deleted as Record<string, unknown> : {};
  for (const [id, value] of Object.entries(deleted)) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) store.deleted[id] = value;
  }
  return store;
}

/**
 * A read never moves the file aside, even when it cannot parse it. Reads run
 * off the lock, on every step and once per mounted tool, so a reader that
 * quarantined a file another process was halfway through writing would wipe
 * the index and every session's activations mid-turn. This is a cache: an
 * unreadable one is empty, and the writer under the lock is what sets a
 * genuinely corrupt file aside.
 */
export function readConnectionToolsStore(path = connectionToolsPath()): ConnectionToolsStore {
  if (!existsSync(path)) return emptyConnectionToolsStore();
  try {
    return parseConnectionToolsStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyConnectionToolsStore();
  }
}

export function writeConnectionToolsStore(
  store: ConnectionToolsStore,
  path = connectionToolsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

export function updateConnectionToolsStore<T>(
  fn: (store: ConnectionToolsStore) => T,
  path = connectionToolsPath(),
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
  if (!held) throw new Error("connection_tools_locked");
  try {
    const existed = existsSync(path);
    const store = readConnectionToolsStore(path);
    // Under the lock nothing else is writing, so a file that still will not
    // parse is corrupt rather than half-written, and this is where it is set
    // aside.
    if (existed && JSON.stringify(store) === JSON.stringify(emptyConnectionToolsStore())) {
      try {
        const raw = readFileSync(path, "utf8");
        parseConnectionToolsStore(JSON.parse(raw));
      } catch {
        try { renameSync(path, `${path}.invalid.${Date.now()}`); } catch { /* ignore */ }
      }
    }
    const before = JSON.stringify(store);
    const result = fn(store);
    pruneSessions(store);
    const after = JSON.stringify(store);
    if (!existed || after !== before) writeConnectionToolsStore(store, path);
    return result;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* ignore */
    }
  }
}

function pruneSessions(store: ConnectionToolsStore): void {
  const ids = Object.keys(store.sessions);
  if (ids.length <= MAX_SESSIONS) return;
  ids
    .sort((a, b) => Date.parse(store.sessions[b].updatedAt) - Date.parse(store.sessions[a].updatedAt))
    .slice(MAX_SESSIONS)
    .forEach((id) => delete store.sessions[id]);
}

/** Replace one connection's listing. Called after a connect and on a refresh. */
export function putConnectionIndex(
  connectionId: string,
  tools: IndexedTool[],
  path = connectionToolsPath(),
): void {
  updateConnectionToolsStore((store) => {
    store.index[connectionId] = {
      fetchedAt: new Date().toISOString(),
      // Screened here, the one writer every path goes through: a name whose
      // mounted form the provider refuses would be found, activated and
      // mounted, and the refusal retires the session.
      tools: tools.filter((tool) => isMountableToolName(connectionId, tool.name)).slice(0, 200),
    };
  }, path);
  checkedThisRuntime.add(connectionId);
}

/**
 * Record that a listing was tried and did not arrive, so a server that has
 * gone quiet is not refetched at every turn boundary, fifteen seconds at a
 * time, for as long as it stays down.
 */
export function putConnectionListingFailed(
  connectionId: string,
  path = connectionToolsPath(),
): void {
  updateConnectionToolsStore((store) => {
    // What was listed last time is still the best answer a search has, so the
    // attempt is recorded beside it rather than in place of it.
    store.index[connectionId] = {
      fetchedAt: new Date().toISOString(),
      tools: store.index[connectionId]?.tools ?? [],
      failed: true,
    };
  }, path);
}

/**
 * Connections whose listing this process has written. A listing read from the
 * file may be from before a restart (a revoked sign-in, a server that changed
 * its tools), so the first use of each connection in a new process asks again,
 * whatever the file's age says. Not persisted, on purpose.
 */
const checkedThisRuntime = new Set<string>();

/** Whether this process has listed (or been told the state of) this connection yet. */
export function checkedThisRuntimeFor(connectionId: string): boolean {
  return checkedThisRuntime.has(connectionId);
}

/** Test hook: the next use of every connection is its first in a new process. */
export function resetRuntimeChecks(): void {
  checkedThisRuntime.clear();
}

/**
 * Every attempt is stamped when it starts, and the stamps only go up, so two
 * attempts begun in the same millisecond still have an order the store can
 * judge them by. A removal takes a stamp from the same counter, so an attempt
 * begun after it is always later than it.
 */
let lastStamp = 0;
export function nextStamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** When this process removed each connection, as an epoch. Backs up the stored record. */
const removedHere = new Map<string, number>();

/**
 * Whether the connection was removed at or after the moment this write's
 * attempt started. Independent of any status row: removal deletes that.
 */
function removedSince(store: ConnectionToolsStore, connectionId: string, startedAt: string): boolean {
  const mine = Date.parse(startedAt);
  if (!Number.isFinite(mine)) return false;
  const stored = Date.parse(store.deleted[connectionId] ?? "");
  const here = removedHere.get(connectionId) ?? Number.NEGATIVE_INFINITY;
  return Math.max(Number.isFinite(stored) ? stored : Number.NEGATIVE_INFINITY, here) >= mine;
}

/**
 * Whether the stored status was written by an attempt that started after this
 * one did. Attempts are stamped when they start, so a slow one that finishes
 * after a newer one must not put its answer over it.
 */
function supersededBy(store: ConnectionToolsStore, connectionId: string, startedAt: string): boolean {
  const newer = Date.parse(store.status[connectionId]?.checkedAt ?? "");
  const mine = Date.parse(startedAt);
  return Number.isFinite(newer) && Number.isFinite(mine) && newer > mine;
}

/**
 * Record what one attempt to list a connection found, with the listing it
 * produced when there is one. `tools: null` keeps the last listing beside the
 * attempt, which is what a server that merely went quiet should leave behind;
 * a server that answered and refused should pass `[]`.
 *
 * `unlessNewer` is for an attempt that has been running: it writes nothing,
 * and returns false, when an attempt that started later has already written
 * (its `pending` marker included).
 */
export function putConnectionDiscovery(
  connectionId: string,
  outcome: { tools: IndexedTool[] | null; status: ConnectionStatus; unlessNewer?: boolean },
  path = connectionToolsPath(),
): boolean {
  const written = updateConnectionToolsStore((store) => {
    if (removedSince(store, connectionId, outcome.status.checkedAt)) return false;
    if (outcome.unlessNewer && supersededBy(store, connectionId, outcome.status.checkedAt)) return false;
    const broken = outcome.status.state !== "ready" && outcome.status.state !== "zero_tools";
    store.index[connectionId] = {
      fetchedAt: outcome.status.checkedAt,
      tools: (outcome.tools ?? store.index[connectionId]?.tools ?? [])
        .filter((tool) => isMountableToolName(connectionId, tool.name))
        .slice(0, 200),
      ...(broken ? { failed: true } : {}),
    };
    store.status[connectionId] = outcome.status;
    return true;
  }, path);
  if (written) checkedThisRuntime.add(connectionId);
  return written;
}

/**
 * Record that an attempt to list a connection has started. Only the status
 * moves: the listing it had stays beside it, so a refresh of a working server
 * does not empty the search while it runs, and the Connectors page can show
 * the row as checking.
 */
export function putConnectionPending(
  connectionId: string,
  startedAt: string,
  path = connectionToolsPath(),
): void {
  updateConnectionToolsStore((store) => {
    if (removedSince(store, connectionId, startedAt)) return;
    if (supersededBy(store, connectionId, startedAt)) return;
    store.status[connectionId] = {
      state: "pending",
      lastError: null,
      checkedAt: startedAt,
      toolCount: store.status[connectionId]?.toolCount ?? null,
    };
  }, path);
}

/**
 * Record a status with no listing change, for a connection whose tools are
 * eve's. `unlessNewer` as for `putConnectionDiscovery`.
 */
export function putConnectionStatus(
  connectionId: string,
  status: ConnectionStatus,
  path = connectionToolsPath(),
  opts: { unlessNewer?: boolean } = {},
): boolean {
  const written = updateConnectionToolsStore((store) => {
    if (removedSince(store, connectionId, status.checkedAt)) return false;
    if (opts.unlessNewer && supersededBy(store, connectionId, status.checkedAt)) return false;
    store.status[connectionId] = status;
    return true;
  }, path);
  if (written) checkedThisRuntime.add(connectionId);
  return written;
}

export function connectionStatus(
  connectionId: string,
  path = connectionToolsPath(),
): ConnectionStatus | null {
  return readConnectionToolsStore(path).status[connectionId] ?? null;
}

/**
 * Forget a connection's listing and status; its sessions shed the tools on
 * their own. Also records the removal, so a write from an attempt that began
 * before it (a slow discovery, a measurement) is dropped instead of bringing
 * the row back.
 */
export function removeConnectionIndex(connectionId: string, path = connectionToolsPath()): void {
  const at = nextStamp();
  removedHere.set(connectionId, Date.parse(at));
  updateConnectionToolsStore((store) => {
    delete store.index[connectionId];
    delete store.status[connectionId];
    store.deleted[connectionId] = at;
    const ids = Object.keys(store.deleted);
    if (ids.length > MAX_DELETED) {
      ids
        .sort((a, b) => Date.parse(store.deleted[b]) - Date.parse(store.deleted[a]))
        .slice(MAX_DELETED)
        .forEach((id) => delete store.deleted[id]);
    }
  }, path);
  checkedThisRuntime.delete(connectionId);
}

/**
 * Remember how big an OpenAPI connection is, since its tools are eve's.
 * `null` records the attempt without a figure, which is what keeps a spec
 * that cannot be read from being refetched at every turn boundary.
 */
export function putConnectionOperations(
  connectionId: string,
  size: { operations: number; schemaBytes: number; textBytes: number; longestName: number } | null,
  path = connectionToolsPath(),
  /** When the measurement started; nothing is written if the connection was removed since. */
  startedAt?: string,
): void {
  updateConnectionToolsStore((store) => {
    if (startedAt !== undefined && removedSince(store, connectionId, startedAt)) return;
    const last = store.index[connectionId];
    store.index[connectionId] = {
      fetchedAt: new Date().toISOString(),
      tools: [],
      // A measurement that did not arrive records the attempt and says so,
      // rather than reading back later as a connection of no size. The last
      // figures stay beside it: they were admitted under the budget, and
      // dropping them on one timeout unmounted the connection for six hours.
      ...(size === null ? {
        failed: true,
        ...(last?.operations !== undefined ? { operations: last.operations } : {}),
        ...(last?.schemaBytes !== undefined ? { schemaBytes: last.schemaBytes } : {}),
        ...(last?.textBytes !== undefined ? { textBytes: last.textBytes } : {}),
        ...(last?.longestName !== undefined ? { longestName: last.longestName } : {}),
      } : {
        operations: Math.max(0, Math.trunc(size.operations)),
        schemaBytes: Math.max(0, Math.trunc(size.schemaBytes)),
        textBytes: Math.max(0, Math.trunc(size.textBytes)),
        longestName: Math.max(0, Math.trunc(size.longestName)),
      }),
    };
  }, path);
}

export function connectionIndex(
  connectionId: string,
  path = connectionToolsPath(),
): ConnectionIndex | null {
  return readConnectionToolsStore(path).index[connectionId] ?? null;
}

export function indexIsStale(index: ConnectionIndex | null, now = Date.now()): boolean {
  if (!index) return true;
  const at = Date.parse(index.fetchedAt);
  return !Number.isFinite(at) || now - at > INDEX_TTL_MS;
}

/**
 * Whether a connection's tools should be listed again. A working listing keeps
 * for the full TTL; one that failed, came back empty or was never judged is
 * tried again after `LISTING_RETRY_MS`. With a `connectionId`, a connection
 * this process has not listed yet is due whatever its age.
 */
export function listingIsDue(
  index: ConnectionIndex | null,
  status: ConnectionStatus | null,
  now = Date.now(),
  connectionId?: string,
): boolean {
  if (!index) return true;
  if (connectionId !== undefined && !checkedThisRuntime.has(connectionId)) return true;
  const at = Date.parse(status?.checkedAt ?? index.fetchedAt);
  if (!Number.isFinite(at)) return true;
  // A row from before status was kept is judged by what it holds.
  const working = status ? status.state === "ready" : index.failed !== true && index.tools.length > 0;
  return now - at > (working ? INDEX_TTL_MS : LISTING_RETRY_MS);
}

/** What a session has picked up, in the order it picked it up. */
export function sessionTools(sessionId: string, path = connectionToolsPath()): string[] {
  return readConnectionToolsStore(path).sessions[sessionId]?.tools ?? [];
}

export type ActivationOutcome = {
  /** The names now mounted for this session, including ones it already had. */
  tools: string[];
  /** Names refused because the session is already holding its limit. */
  refused: string[];
};

/**
 * What one tool costs on the wire, not just in this index.
 *
 * The router weighs `JSON.stringify(tools)`, where each entry carries its
 * `{"type":"function","function":{…}}` envelope (~96 bytes) and a description
 * that has been through `wrapUntrusted` (184 bytes of preamble and fences).
 * The name, the description and the schema alone undercounted every tool: the
 * router weighs `JSON.stringify(tools)` in UTF-8, where each entry carries a
 * function envelope and a description that has been through `wrapUntrusted`,
 * and `String.length` counts UTF-16 units rather than bytes.
 *
 * The schema is counted once because it reaches the model once: as the
 * converted `parameters`, or, when it could not be converted, written into
 * the description instead.
 */
/**
 * The description a tool is mounted with, built in exactly one place so the
 * mount and the charge are two readings of the same string. The connection's
 * name, then the server's words inside an untrusted envelope, with the raw
 * schema written in when it could not be converted. The fence grows to the
 * longest backtick run in what it wraps, so its size depends on the content;
 * estimating it from a fixed fence let a server undercount itself by
 * kilobytes a tool.
 */
export function mountedDescription(tool: IndexedTool, connectionId: string, connectionName: string): string {
  const { passthrough } = toolInputSchema(tool.inputSchema);
  const words = `${tool.description || tool.name}` + (passthrough ? rawSchemaHint(tool.inputSchema) : "");
  return `${oneLine(connectionName)}: ${wrapUntrusted(`connection:${connectionId}`, words)}`;
}

/** A connection's name goes outside the fence, so it must not carry lines. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function indexedToolBytes(tool: IndexedTool, connectionId = "", connectionName = ""): number {
  return toolWireBytes(
    mountedToolName(connectionId, tool.name),
    mountedDescription(tool, connectionId, connectionName),
    tool.inputSchemaBytes,
  );
}

/**
 * Record that a session may use these tools from now on. The cap is here
 * rather than at the wall the router puts up: past it the model is told it is
 * holding its limit, instead of the turn being refused with an error that
 * retires the session.
 */
export function activateSessionTools(
  sessionId: string,
  names: string[],
  path = connectionToolsPath(),
  sessionConnectionNames: Record<string, string> = {},
): ActivationOutcome {
  return updateConnectionToolsStore((store) => {
    const sizeOf = (name: string): number => {
      const at = name.indexOf("__");
      if (at <= 0) return 200;
      const connectionId = name.slice(0, at);
      const tool = store.index[connectionId]?.tools.find((item) => item.name === name.slice(at + 2));
      // The connection's own name is part of every description it mounts.
      return tool
        ? indexedToolBytes(tool, connectionId, sessionConnectionNames[connectionId] ?? "")
        : toolWireBytes(name, "", 4 * 1024);
    };
    // A tool the index no longer lists cannot be mounted: its server dropped
    // it, or renamed it. Held on, it kept charging the session for a tool it
    // could never call, and ten of them told the model it was holding its
    // limit while holding nothing it could use. They are shed here.
    const listed = (name: string): boolean => {
      const at = name.indexOf("__");
      if (at <= 0) return false;
      return store.index[name.slice(0, at)]?.tools.some((item) => item.name === name.slice(at + 2)) ?? false;
    };
    const current = (store.sessions[sessionId]?.tools ?? []).filter(listed);
    const held = new Set(current);
    let bytes = current.reduce((total, name) => total + sizeOf(name), 0);
    const refused: string[] = [];
    for (const name of names) {
      if (held.has(name)) continue;
      // Nothing is recorded for a tool this side could not mount.
      if (!listed(name)) {
        refused.push(name);
        continue;
      }
      const size = sizeOf(name);
      // Counted as well as capped: forty schemas at the size a server is
      // allowed to publish would clear the router's byte wall on their own.
      if (held.size >= MAX_SESSION_TOOLS || bytes + size > MAX_SESSION_TOOL_BYTES) {
        refused.push(name);
        continue;
      }
      held.add(name);
      bytes += size;
      current.push(name);
    }
    store.sessions[sessionId] = { updatedAt: new Date().toISOString(), tools: current };
    return { tools: [...current], refused };
  }, path);
}

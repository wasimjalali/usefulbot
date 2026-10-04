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

export type SessionTools = {
  updatedAt: string;
  /** `<connectionId>__<toolName>`, the name eve mounts and the app parses. */
  tools: string[];
};

export type ConnectionToolsStore = {
  schemaVersion: 1;
  index: Record<string, ConnectionIndex>;
  sessions: Record<string, SessionTools>;
};

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
/** A listing older than this is refetched the next time a search needs it. */
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
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
  return { schemaVersion: 1, index: {}, sessions: {} };
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
 * Remember how big an OpenAPI connection is, since its tools are eve's.
 * `null` records the attempt without a figure, which is what keeps a spec
 * that cannot be read from being refetched at every turn boundary.
 */
export function putConnectionOperations(
  connectionId: string,
  size: { operations: number; schemaBytes: number; textBytes: number; longestName: number } | null,
  path = connectionToolsPath(),
): void {
  updateConnectionToolsStore((store) => {
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

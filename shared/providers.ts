import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  connectionId,
  parseConnectionId,
  providerDef,
  providerMode,
  PROVIDER_CATALOG as CATALOG_DEFS,
  type AuthMode,
  type KeyHeader,
  type Protocol,
  type ProviderMode,
} from "./provider-catalog.ts";
import { cachedModels, catalogFor } from "./live-models.ts";
import {
  effortLabel,
  humanizeModelId,
  isEffortId,
  isSpeedId,
  modelChats,
  modelIsImageGenerator,
  snapComposer,
  type ComposerGroup,
  type ComposerPublic,
  type EffortId,
  type ModelOption,
  type SpeedId,
} from "./models.ts";
import type { ModelSelection } from "./session-selection.ts";
import { statePath } from "./stack.ts";

/** @deprecated Slice 2 owns provider ids now. Use the catalogue connection id instead. */
export type ProviderId = "opencode-go" | "openai" | "anthropic" | "openrouter" | "google";

const LEGACY_API_CONNECTION: Record<string, string> = {
  "opencode-go": "opencode-go:plan",
  openai: "openai:api",
  anthropic: "anthropic:api",
  openrouter: "openrouter:api",
  google: "google:api",
};

/** @deprecated Use providerMode(id, mode) from ./provider-catalog.ts instead. */
export interface ProviderCatalogItem {
  id: ProviderId;
  name: string;
  kind: "coding-plan" | "api";
  hint: string;
  baseUrl: string;
  compatible: boolean;
  models: { workhorse: string; reviewer: string };
}

/** @deprecated The catalogue moved to ./provider-catalog.ts. */
export const PROVIDER_CATALOG: ProviderCatalogItem[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    kind: "coding-plan",
    hint: "Coding plan key from OpenCode Go.",
    baseUrl: "https://opencode.ai/zen/go/v1",
    compatible: true,
    models: { workhorse: "glm-5.3-flash", reviewer: "glm-5.3" },
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "api",
    hint: "API key from platform.openai.com.",
    baseUrl: "https://api.openai.com/v1",
    compatible: true,
    models: { workhorse: "gpt-4.1-mini", reviewer: "gpt-4.1" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "api",
    hint: "One key for many models, including Claude.",
    baseUrl: "https://openrouter.ai/api/v1",
    compatible: true,
    models: { workhorse: "openai/gpt-4.1-mini", reviewer: "anthropic/claude-sonnet-4" },
  },
  {
    id: "google",
    name: "Google",
    kind: "api",
    hint: "Gemini API key. OpenAI-compatible endpoint.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    compatible: true,
    models: { workhorse: "gemini-2.5-flash", reviewer: "gemini-2.5-pro" },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "api",
    hint: "Claude API key. Route Claude through OpenRouter in this build.",
    baseUrl: "https://api.anthropic.com/v1",
    compatible: false,
    models: { workhorse: "claude-sonnet-4-0", reviewer: "claude-sonnet-4-0" },
  },
];

/** @deprecated Use Credential instead. */
export interface ProviderKeyRec {
  key: string;
  updatedAt: string;
}

export type Credential =
  | { kind: "key"; key: string }
  | {
    kind: "oauth";
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    accountId: string | null;
    /** github-copilot: exchanged inference token */
    exchanged?: { token: string; expiresAt: number };
    /** openai (Sign in with ChatGPT): the issued client id, validated subject, email, granted scopes and retained ID token. A ChatGPT credential without clientId is a legacy Codex sign-in. */
    clientId?: string | null;
    idToken?: string | null;
    scopes?: string[];
    subject?: string | null;
    email?: string | null;
  }
  | { kind: "none" };

export interface Connection {
  id: string;
  providerId: string;
  mode: AuthMode;
  credential: Credential;
  /** Values for ProviderMode.fields (accountId, baseUrl, name). */
  fields: Record<string, string>;
  updatedAt: string;
  /** Last failure the router saw on this connection, cleared on success. */
  lastError: { code: string; at: string } | null;
}

export interface RoleSelection {
  connectionId: string;
  modelId: string;
  effort: EffortId | null;
}

export interface ProviderStore {
  schemaVersion: 2;
  connections: Record<string, Connection>;
  /** Connection the chat (workhorse) uses. */
  activeConnectionId: string | null;
  selectedModel: string | null;
  effort: EffortId | null;
  speed: SpeedId;
  /** Explicit per-role choice; absent role falls back to the active connection and the mode's default. */
  roles: { reviewer?: RoleSelection; image?: RoleSelection };
}

/** @deprecated Slice 2 renders ConnectionPublic now. Kept so the old settings dialog compiles. */
export interface ProviderPublic {
  id: ProviderId;
  name: string;
  kind: "coding-plan" | "api";
  hint: string;
  compatible: boolean;
  connected: boolean;
  last4: string | null;
  source: "settings" | "env" | null;
  active: boolean;
  models: { workhorse: string; reviewer: string };
}

export interface ConnectionPublic {
  id: string;
  providerId: string;
  mode: AuthMode;
  label: string;
  kindLabel: string;
  monogram: string;
  icon: string;
  connected: boolean;
  last4: string | null;
  source: "settings" | "env" | null;
  active: boolean;
  status: "ok" | "expired" | "error";
  lastError: string | null;
  accountId: string | null;
  /** The signed-in account's email for a ChatGPT sign-in, else null. */
  accountLabel: string | null;
  fields: Record<string, string>;
  models: Array<{ id: string; label: string }>;
  /** The catalogue's everyday model for this mode (`defaults.workhorse`), the one first run suggests. */
  defaultModelId: string;
}

export interface CatalogPublic {
  providerId: string;
  mode: AuthMode;
  label: string;
  kindLabel: string;
  monogram: string;
  icon: string;
  hint: string;
  keyUrl: string | null;
  fields: ProviderMode["fields"] | null;
  oauth: boolean;
  connected: boolean;
}

export interface RolePublic {
  connectionId: string | null;
  connectionLabel: string;
  connectionIcon: string;
  modelId: string;
  modelLabel: string;
  effort: EffortId | null;
  effortLabel: string | null;
  efforts: Array<{ id: EffortId; label: string }>;
  models: Array<{ connectionId: string; connectionLabel: string; icon: string; id: string; label: string }>;
}

export function providersPath(root = process.env.UB_PROVIDERS_PATH): string {
  if (root) return root;
  return statePath("providers.json");
}

export function emptyProviderStore(): ProviderStore {
  return {
    schemaVersion: 2,
    connections: {},
    activeConnectionId: null,
    selectedModel: null,
    effort: null,
    speed: "standard",
    roles: {},
  };
}

/**
 * @deprecated Slice 2 resolves modes through the catalogue.
 * Thin shim over providerMode so old callers keep compiling.
 */
export function catalogItem(id: string): ProviderCatalogItem {
  try {
    const { providerId, mode } = parseConnectionId(id);
    const row = providerMode(providerId, mode);
    return {
      id: providerId as ProviderId,
      name: row.label,
      kind: mode === "plan" ? "coding-plan" : "api",
      hint: row.hint,
      baseUrl: row.baseUrl,
      compatible: row.protocol === "openai-chat" && mode !== "oauth",
      models: { ...row.defaults },
    };
  } catch {
    const conn = LEGACY_API_CONNECTION[id];
    if (conn) return catalogItem(conn);
    throw new Error("provider_unknown");
  }
}

export function last4(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCredential(raw: unknown): Credential | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (raw.kind === "key") {
    if (typeof raw.key !== "string" || !raw.key) return null;
    return { kind: "key", key: raw.key };
  }
  if (raw.kind === "oauth") {
    if (typeof raw.accessToken !== "string" || !raw.accessToken) return null;
    const cred: Credential = {
      kind: "oauth",
      accessToken: raw.accessToken,
      refreshToken: typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : null,
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
      accountId: typeof raw.accountId === "string" && raw.accountId ? raw.accountId : null,
    };
    if (isRecord(raw.exchanged) && typeof raw.exchanged.token === "string" && typeof raw.exchanged.expiresAt === "number") {
      cred.exchanged = { token: raw.exchanged.token, expiresAt: raw.exchanged.expiresAt };
    }
    if (typeof raw.clientId === "string" && raw.clientId) cred.clientId = raw.clientId;
    if (typeof raw.idToken === "string" && raw.idToken) cred.idToken = raw.idToken;
    if (Array.isArray(raw.scopes)) cred.scopes = raw.scopes.filter((scope): scope is string => typeof scope === "string");
    if (typeof raw.subject === "string" && raw.subject) cred.subject = raw.subject;
    if (typeof raw.email === "string" && raw.email) cred.email = raw.email;
    return cred;
  }
  if (raw.kind === "none") return { kind: "none" };
  return null;
}

function parseConnection(raw: unknown): Connection | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.providerId !== "string" || typeof raw.mode !== "string") return null;
  let mode: AuthMode;
  let id: string;
  try {
    const parsed = parseConnectionId(raw.id);
    if (parsed.providerId !== raw.providerId || parsed.mode !== raw.mode) return null;
    ({ mode } = parsed);
    id = raw.id;
  } catch {
    return null;
  }
  const credential = parseCredential(raw.credential);
  if (!credential) return null;
  const fields: Record<string, string> = {};
  if (isRecord(raw.fields)) {
    for (const [key, value] of Object.entries(raw.fields)) {
      if (typeof value === "string") fields[key] = value;
    }
  }
  if (typeof raw.updatedAt !== "string") return null;
  let lastError: Connection["lastError"] = null;
  if (isRecord(raw.lastError) && typeof raw.lastError.code === "string" && typeof raw.lastError.at === "string") {
    lastError = { code: raw.lastError.code, at: raw.lastError.at };
  }
  return { id, providerId: raw.providerId, mode, credential, fields, updatedAt: raw.updatedAt, lastError };
}

function parseRoleSelection(raw: unknown): RoleSelection | null {
  if (!isRecord(raw) || typeof raw.connectionId !== "string" || typeof raw.modelId !== "string") return null;
  try {
    parseConnectionId(raw.connectionId);
  } catch {
    return null;
  }
  return {
    connectionId: raw.connectionId,
    modelId: raw.modelId,
    effort: isEffortId(raw.effort) ? raw.effort : null,
  };
}

function migrateV1(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): ProviderStore {
  const next = emptyProviderStore();
  const keys = isRecord(raw.keys) ? raw.keys : {};
  for (const [id, value] of Object.entries(keys)) {
    if (!isRecord(value) || typeof value.key !== "string" || typeof value.updatedAt !== "string") continue;
    // Every v1 key was an api style key, except the OpenCode Go plan key.
    const mode: AuthMode = id === "opencode-go" ? "plan" : "api";
    try {
      providerMode(id, mode);
    } catch {
      continue;
    }
    const connId = connectionId(id, mode);
    next.connections[connId] = {
      id: connId,
      providerId: id,
      mode,
      credential: { kind: "key", key: value.key },
      fields: {},
      updatedAt: value.updatedAt,
      lastError: null,
    };
  }
  const active = typeof raw.activeProviderId === "string" ? raw.activeProviderId : null;
  if (active) {
    // The v1 active provider keeps its connection when it has a stored key.
    // OpenCode Go stays active without one, the env key connects it implicitly.
    const mode: AuthMode = active === "opencode-go" ? "plan" : "api";
    let connId: string | null = null;
    try {
      connId = connectionId(active, mode);
    } catch {
      connId = null;
    }
    if (connId && next.connections[connId]) {
      next.activeConnectionId = connId;
    } else if (active === "opencode-go" && env.UB_OPENCODE_GO_KEY) {
      next.activeConnectionId = connId;
    } else {
      next.activeConnectionId = null;
    }
  }
  next.selectedModel = typeof raw.selectedModel === "string" && raw.selectedModel ? raw.selectedModel : null;
  next.effort = isEffortId(raw.effort) ? raw.effort : null;
  next.speed = isSpeedId(raw.speed) ? raw.speed : "standard";
  return next;
}

export function parseProviderStore(raw: unknown, env: NodeJS.ProcessEnv = process.env): ProviderStore {
  if (!raw || typeof raw !== "object") throw new Error("providers_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion === 1) return migrateV1(rec, env);
  if (rec.schemaVersion !== 2) throw new Error("providers_schema");
  const next = emptyProviderStore();
  if (isRecord(rec.connections)) {
    for (const [id, value] of Object.entries(rec.connections)) {
      const conn = parseConnection(value);
      if (conn && conn.id === id) next.connections[id] = conn;
    }
  }
  // The implicit env Go connection has no stored row, so its active id must
  // survive a write and read back the same way the v1 migration set it.
  const active = typeof rec.activeConnectionId === "string" ? rec.activeConnectionId : null;
  next.activeConnectionId = active && (next.connections[active] || (active === "opencode-go:plan" && env.UB_OPENCODE_GO_KEY))
    ? active
    : null;
  next.selectedModel = typeof rec.selectedModel === "string" && rec.selectedModel ? rec.selectedModel : null;
  next.effort = isEffortId(rec.effort) ? rec.effort : null;
  next.speed = isSpeedId(rec.speed) ? rec.speed : "standard";
  if (isRecord(rec.roles)) {
    const reviewer = parseRoleSelection(rec.roles.reviewer);
    if (reviewer && next.connections[reviewer.connectionId]) next.roles.reviewer = reviewer;
    const image = parseRoleSelection(rec.roles.image);
    if (image && next.connections[image.connectionId]) next.roles.image = image;
  }
  return next;
}

export function readProviderStore(path = providersPath(), env: NodeJS.ProcessEnv = process.env): ProviderStore {
  if (!existsSync(path)) return emptyProviderStore();
  try {
    return parseProviderStore(JSON.parse(readFileSync(path, "utf8")), env);
  } catch {
    // A torn write must not wedge every model call: keep the evidence aside
    // and start empty, the way the shell store reseeds a bad file.
    const bak = `${path}.invalid.${Date.now()}`;
    try { renameSync(path, bak); } catch { /* ignore */ }
    return emptyProviderStore();
  }
}

export function writeProviderStore(store: ProviderStore, path = providersPath()): void {
  const out: ProviderStore = {
    schemaVersion: 2,
    connections: store.connections,
    activeConnectionId: store.activeConnectionId,
    selectedModel: store.selectedModel,
    effort: store.effort,
    speed: store.speed,
    roles: store.roles,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(out)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read, change and write the store under an advisory lock. The router and the
 * web service both write this file, so a plain read then write in one process
 * could drop what the other wrote in between (a connection just added, a token
 * just refreshed). The lock is a directory next to the file: mkdir is atomic
 * on every filesystem this runs on. A lock older than ten seconds is a crash
 * leftover and is taken over.
 */
export function updateProviderStore(
  change: (store: ProviderStore) => ProviderStore,
  path = providersPath(),
  env: NodeJS.ProcessEnv = process.env,
): ProviderStore {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* vanished: retry at once */ }
      if (age > LOCK_STALE_MS) {
        try { rmSync(lock, { recursive: true, force: true }); } catch { /* the other side may have just removed it */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error("providers_locked");
      sleepSync(25);
    }
  }
  try {
    const next = change(readProviderStore(path, env));
    writeProviderStore(next, path);
    return next;
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function checkKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 8 || trimmed.length > 8192) throw new Error("provider_key");
  if (/\s/.test(trimmed)) throw new Error("provider_key");
  return trimmed;
}

/**
 * Plain fields are required and kept on the connection. A secret field (the
 * custom sheet's key) is the credential: optional here, never stored in
 * `fields`, so the public view cannot echo it.
 */
function checkFields(mode: ProviderMode, fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of mode.fields ?? []) {
    if (field.secret) continue;
    const value = fields[field.id];
    if (typeof value !== "string" || !value.trim()) throw new Error("provider_field");
    out[field.id] = value.trim();
  }
  return out;
}

function secretField(mode: ProviderMode, fields: Record<string, string>): string | null {
  for (const field of mode.fields ?? []) {
    if (!field.secret) continue;
    const value = fields[field.id];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Connect or replace a key, plan or local connection. Local mode with no key is valid. */
export function setProviderKey(
  store: ProviderStore,
  providerId: string,
  mode: AuthMode,
  key?: string | null,
  fields?: Record<string, string>,
  now?: Date,
): ProviderStore;
/**
 * @deprecated Pass an explicit mode instead: setProviderKey(store, id, "api", key).
 * Maps the old provider id to its api connection (opencode-go to its plan).
 */
export function setProviderKey(store: ProviderStore, id: ProviderId, key: string): ProviderStore;
export function setProviderKey(
  store: ProviderStore,
  providerId: string,
  modeOrKey: AuthMode | string,
  keyOrUndefined?: string | null,
  fields?: Record<string, string>,
  now: Date = new Date(),
): ProviderStore {
  let mode: AuthMode;
  let key: string | null | undefined;
  if (keyOrUndefined === undefined && typeof modeOrKey === "string" && !["oauth", "plan", "api", "local"].includes(modeOrKey)) {
    mode = (LEGACY_API_CONNECTION[providerId] ?? "openai:api").split(":")[1] as AuthMode;
    key = modeOrKey;
  } else {
    mode = modeOrKey as AuthMode;
    key = keyOrUndefined;
  }
  const row = providerMode(providerId, mode);
  if (mode === "oauth") throw new Error("provider_oauth");
  const cleanFields = checkFields(row, fields ?? {});
  if (!(typeof key === "string" && key.trim())) key = secretField(row, fields ?? {});
  const previous = store.connections[connectionId(providerId, mode)]?.credential;
  let credential: Credential;
  if (typeof key === "string" && key.trim()) {
    credential = { kind: "key", key: checkKey(key) };
  } else if (previous && previous.kind !== "none") {
    // An edit that only changes a field never retypes the key: keep it.
    credential = previous;
  } else if (mode === "local") {
    // Local servers need no key. The custom sheet may still paste one.
    credential = { kind: "none" };
  } else {
    throw new Error("provider_key");
  }
  const id = connectionId(providerId, mode);
  return {
    ...store,
    connections: {
      ...store.connections,
      [id]: {
        id,
        providerId,
        mode,
        credential,
        fields: cleanFields,
        updatedAt: now.toISOString(),
        lastError: null,
      },
    },
  };
}

/** Drop a connection. Clears roles pointing at it and moves active to another connected connection or null. */
export function clearConnection(store: ProviderStore, id: string): ProviderStore {
  if (!store.connections[id]) throw new Error("connection_unknown");
  const connections = { ...store.connections };
  delete connections[id];
  const roles = { ...store.roles };
  if (roles.reviewer?.connectionId === id) delete roles.reviewer;
  if (roles.image?.connectionId === id) delete roles.image;
  let activeConnectionId = store.activeConnectionId === id ? null : store.activeConnectionId;
  if (activeConnectionId && !isConnected(connections[activeConnectionId])) activeConnectionId = null;
  if (!activeConnectionId) {
    activeConnectionId = Object.values(connections).find((conn) => isConnected(conn))?.id ?? null;
  }
  return { ...store, connections, roles, activeConnectionId };
}

/**
 * @deprecated Use clearConnection(store, connectionId) instead.
 * Clears every connection under the old provider id.
 */
export function clearProviderKey(store: ProviderStore, id: ProviderId): ProviderStore {
  let next = store;
  for (const conn of Object.values(store.connections)) {
    if (conn.providerId === id) next = clearConnection(next, conn.id);
  }
  return next;
}

/** Make a connected connection the chat connection. */
/**
 * The env Go key is listed as an implicit connection but has no stored row,
 * so a pick of it stores the row first (source stays the env key: the row
 * carries that key and the same id).
 */
function withImplicit(store: ProviderStore, id: string, env: NodeJS.ProcessEnv): ProviderStore {
  if (store.connections[id] || id !== "opencode-go:plan") return store;
  const implicit = envConnection(env);
  if (!implicit) return store;
  return { ...store, connections: { ...store.connections, [id]: implicit } };
}

export function setActiveConnection(store: ProviderStore, id: string, env: NodeJS.ProcessEnv = process.env): ProviderStore {
  store = withImplicit(store, id, env);
  const conn = store.connections[id];
  if (!conn) throw new Error("connection_unknown");
  if (!isConnected(conn)) throw new Error("provider_disconnected");
  const mode = providerMode(conn.providerId, conn.mode);
  return setComposer({ ...store, activeConnectionId: id }, { modelId: mode.defaults.workhorse });
}

/**
 * @deprecated Use setActiveConnection(store, connectionId) instead.
 * Maps the old provider id to its api connection (opencode-go to its plan).
 */
export function setActiveProvider(store: ProviderStore, id: ProviderId): ProviderStore {
  const conn = LEGACY_API_CONNECTION[id] ?? `${id}:api`;
  return setActiveConnection(store, conn);
}

/** Store an OAuth credential as the provider's oauth connection. */
export function setOAuthCredential(store: ProviderStore, providerId: string, credential: Credential, now = new Date()): ProviderStore {
  if (credential.kind !== "oauth") throw new Error("provider_oauth");
  providerMode(providerId, "oauth");
  const id = connectionId(providerId, "oauth");
  const prev = store.connections[id];
  return {
    ...store,
    connections: {
      ...store.connections,
      [id]: {
        id,
        providerId,
        mode: "oauth",
        credential,
        fields: prev?.fields ?? {},
        updatedAt: now.toISOString(),
        lastError: null,
      },
    },
  };
}

export function setRole(store: ProviderStore, role: "reviewer" | "image", selection: RoleSelection | null, env: NodeJS.ProcessEnv = process.env): ProviderStore {
  if (!selection) {
    // Clearing one role keeps the others; the store has more than one now.
    const roles = { ...store.roles };
    delete roles[role];
    return { ...store, roles };
  }
  store = withImplicit(store, selection.connectionId, env);
  const conn = store.connections[selection.connectionId];
  if (!conn) throw new Error("connection_unknown");
  if (role === "image" && !providerMode(conn.providerId, conn.mode).images) {
    throw new Error("provider_incompatible");
  }
  return { ...store, roles: { ...store.roles, [role]: selection } };
}

export function recordConnectionError(store: ProviderStore, id: string, code: string, now = new Date()): ProviderStore {
  const conn = store.connections[id];
  if (!conn) throw new Error("connection_unknown");
  return {
    ...store,
    connections: {
      ...store.connections,
      [id]: { ...conn, lastError: { code, at: now.toISOString() } },
    },
  };
}

function isConnected(conn: Connection | undefined): boolean {
  if (!conn) return false;
  if (conn.credential.kind !== "none") return true;
  // Local servers need no key. A custom row with a pasted key connects too.
  try {
    return providerMode(conn.providerId, conn.mode).mode === "local";
  } catch {
    return false;
  }
}

function isExpired(conn: Connection): boolean {
  if (conn.credential.kind !== "oauth") return false;
  const direct = conn.credential.expiresAt;
  if (typeof direct === "number" && direct <= Date.now()) return true;
  const swapped = conn.credential.exchanged;
  if (swapped && swapped.expiresAt <= Date.now() && (!direct || direct <= Date.now())) return true;
  return false;
}

/** Implicit env connection for OpenCode Go when nothing is stored. */
function envConnection(env: NodeJS.ProcessEnv): Connection | null {
  if (!env.UB_OPENCODE_GO_KEY) return null;
  return {
    id: "opencode-go:plan",
    providerId: "opencode-go",
    mode: "plan",
    credential: { kind: "key", key: env.UB_OPENCODE_GO_KEY },
    fields: {},
    updatedAt: new Date(0).toISOString(),
    lastError: null,
  };
}

function activeConnection(store: ProviderStore, env: NodeJS.ProcessEnv): Connection | null {
  const conn = store.activeConnectionId ? store.connections[store.activeConnectionId] : undefined;
  if (conn && isConnected(conn)) return conn;
  return null;
}

/** The name a connection shows: a custom server's own name, else the mode label. */
function connectionLabel(conn: Pick<Connection, "providerId" | "mode" | "fields">): string {
  if (conn.providerId === "custom" && conn.fields.name) return conn.fields.name;
  return providerMode(conn.providerId, conn.mode).label;
}

function modelRows(id: string): Array<{ id: string; label: string }> {
  // A model the catalog names image-only (outputs without "text") cannot
  // carry a chat turn, and an image generator belongs to the image picker,
  // so the chat pickers offer neither. A model with no output facts stays:
  // unknown is not a refusal.
  return catalogFor(id)
    .filter((item) => modelChats(item) !== false && !modelIsImageGenerator(item))
    .map((item) => ({ id: item.id, label: item.label }));
}

/**
 * The image picker's list for one connection: the mode's static image models
 * (vendor /models lists do not name them) plus any live row the catalog
 * facts mark as image output.
 */
function imageModelRows(conn: Connection): Array<{ id: string; label: string }> {
  const mode = providerMode(conn.providerId, conn.mode);
  // A live-catalog row only counts when the mode can serve
  // /images/generations; otherwise the picker would offer a role the
  // resolver refuses.
  if (!mode.images) return [];
  const seen = new Set<string>();
  const rows: Array<{ id: string; label: string }> = [];
  const live = catalogFor(conn.id);
  for (const id of mode.images?.models ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label: live.find((item) => item.id === id)?.label ?? humanizeModelId(id) });
  }
  for (const item of live) {
    if (seen.has(item.id) || !modelIsImageGenerator(item)) continue;
    seen.add(item.id);
    rows.push({ id: item.id, label: item.label });
  }
  return rows;
}

/** First connected connection whose mode serves image generation, the active one preferred. */
function firstImageConnection(listed: Connection[], connectedIds: Set<string>, activeId: string | null): Connection | null {
  const capable = listed.filter((conn) => {
    if (!connectedIds.has(conn.id)) return false;
    try {
      return Boolean(providerMode(conn.providerId, conn.mode).images);
    } catch {
      return false;
    }
  });
  return capable.find((conn) => conn.id === activeId) ?? capable[0] ?? null;
}

/** A ChatGPT sign-in made through the old Codex route: it has no issued client id and cannot be refreshed. */
export function isLegacyChatGptCredential(providerId: string, mode: AuthMode, credential: Credential): boolean {
  return providerId === "openai" && mode === "oauth" && credential.kind === "oauth" && !credential.clientId;
}

function connectionStatus(conn: Connection): ConnectionPublic["status"] {
  if (isLegacyChatGptCredential(conn.providerId, conn.mode, conn.credential)) return "expired";
  if (conn.lastError) return "error";
  if (isExpired(conn)) return "expired";
  return "ok";
}

function publicConnection(conn: Connection, activeId: string | null): ConnectionPublic {
  const def = providerDef(conn.providerId);
  const mode = providerMode(conn.providerId, conn.mode);
  return {
    id: conn.id,
    providerId: conn.providerId,
    mode: conn.mode,
    label: connectionLabel(conn),
    kindLabel: mode.kindLabel,
    monogram: def.monogram,
    icon: def.icon,
    connected: true,
    last4: conn.credential.kind === "key" ? last4(conn.credential.key) : null,
    source: "settings",
    active: activeId === conn.id,
    status: connectionStatus(conn),
    lastError: conn.lastError?.code ?? null,
    accountId: conn.credential.kind === "oauth" ? conn.credential.accountId : null,
    accountLabel: conn.providerId === "openai" && conn.mode === "oauth" && conn.credential.kind === "oauth"
      ? conn.credential.email ?? null
      : null,
    fields: { ...conn.fields },
    models: modelRows(conn.id),
    defaultModelId: mode.defaults.workhorse,
  };
}

const MODE_ORDER: AuthMode[] = ["oauth", "plan", "api", "local"];

export function publicProviders(
  store: ProviderStore,
  env: NodeJS.ProcessEnv = process.env,
): { catalog: CatalogPublic[]; connections: ConnectionPublic[]; roles: { default: RolePublic; reviewer: RolePublic; image: RolePublic } } {
  const implicit = !store.connections["opencode-go:plan"] ? envConnection(env) : null;
  const listed = [...Object.values(store.connections)];
  if (implicit) listed.push(implicit);
  const connectedIds = new Set(
    listed.filter((conn) => isConnected(conn) || conn.id === implicit?.id).map((conn) => conn.id),
  );
  const storedActive = activeConnection(store, env);
  const activeId = storedActive?.id
    // A migrated store can name opencode-go:plan without storing it. The env
    // key still connects it implicitly, so the env row shows as active.
    ?? ((store.activeConnectionId === null || store.activeConnectionId === "opencode-go:plan") && implicit
      ? implicit.id
      : null);

  const catalog: CatalogPublic[] = [];
  for (const order of MODE_ORDER) {
    for (const def of CATALOG_DEFS) {
      const row = def.modes.find((entry) => entry.mode === order);
      if (!row) continue;
      catalog.push({
        providerId: def.id,
        mode: order,
        label: row.label,
        kindLabel: row.kindLabel,
        monogram: def.monogram,
        icon: def.icon,
        hint: row.hint,
        keyUrl: row.keyUrl,
        fields: row.fields ?? null,
        oauth: order === "oauth",
        connected: connectedIds.has(connectionId(def.id, order)),
      });
    }
  }

  const connections = listed
    .filter((conn) => connectedIds.has(conn.id))
    .map((conn) => conn.id === implicit?.id && conn === implicit
      ? {
        id: implicit.id,
        providerId: implicit.providerId,
        mode: implicit.mode,
        label: providerMode("opencode-go", "plan").label,
        kindLabel: providerMode("opencode-go", "plan").kindLabel,
        monogram: providerDef("opencode-go").monogram,
        icon: providerDef("opencode-go").icon,
        connected: true,
        last4: null,
        source: "env" as const,
        active: activeId === implicit.id,
        status: "ok" as const,
        lastError: null,
        accountId: null,
        accountLabel: null,
        fields: {},
        models: modelRows(implicit.id),
        defaultModelId: providerMode("opencode-go", "plan").defaults.workhorse,
      }
      : publicConnection(conn, activeId));

  const pickerModels: RolePublic["models"] = [];
  for (const conn of listed.filter((row) => connectedIds.has(row.id))) {
    const label = connectionLabel(conn);
    const icon = providerDef(conn.providerId).icon;
    for (const row of modelRows(conn.id)) {
      pickerModels.push({ connectionId: conn.id, connectionLabel: label, icon, id: row.id, label: row.label });
    }
  }

  const composer = composerState(store, env);
  const composerConn = listed.find((row) => row.id === composer.connectionId) ?? null;
  const defaultRole: RolePublic = {
    connectionId: composer.connectionId || null,
    connectionLabel: composer.providerName,
    connectionIcon: composerConn ? providerDef(composerConn.providerId).icon : "",
    modelId: composer.modelId,
    modelLabel: composer.modelLabel,
    effort: composer.effort,
    effortLabel: composer.effortLabel,
    efforts: composer.efforts,
    models: pickerModels,
  };

  const reviewerSel = store.roles.reviewer && connectedIds.has(store.roles.reviewer.connectionId)
    ? store.roles.reviewer
    : null;
  let reviewer: RolePublic;
  if (reviewerSel) {
    const conn = listed.find((row) => row.id === reviewerSel.connectionId) ?? null;
    const label = conn ? connectionLabel(conn) : reviewerSel.connectionId;
    const rows = conn ? modelRows(conn.id) : [];
    // The router sends the saved id whatever the live list says, so the chip
    // names that id too rather than the first row of the list.
    const picked = rows.find((row) => row.id === reviewerSel.modelId) ?? null;
    const modelLabel = picked?.label ?? humanizeModelId(reviewerSel.modelId);
    const efforts = picked
      ? (catalogFor(conn?.id ?? reviewerSel.connectionId).find((row) => row.id === picked.id)?.efforts ?? [])
      : [];
    reviewer = {
      connectionId: reviewerSel.connectionId,
      connectionLabel: label,
      connectionIcon: conn ? providerDef(conn.providerId).icon : "",
      modelId: reviewerSel.modelId,
      modelLabel,
      effort: reviewerSel.effort && (efforts as EffortId[]).includes(reviewerSel.effort) ? reviewerSel.effort : null,
      effortLabel: reviewerSel.effort && (efforts as EffortId[]).includes(reviewerSel.effort) ? effortLabel(reviewerSel.effort) : null,
      efforts: (efforts as EffortId[]).map((id) => ({ id, label: effortLabel(id) })),
      models: pickerModels,
    };
  } else {
    reviewer = { ...defaultRole, models: pickerModels };
    const fallbackConn = listed.find((row) => row.id === activeId)
      ?? listed.find((row) => connectedIds.has(row.id))
      ?? null;
    if (fallbackConn) {
      const mode = providerMode(fallbackConn.providerId, fallbackConn.mode);
      const rows = modelRows(fallbackConn.id);
      const picked = rows.find((row) => row.id === mode.defaults.reviewer) ?? rows[0] ?? null;
      if (picked) {
        // The same snap resolveUpstream applies, so the chip and the router
        // agree on the effort the fallback reviewer runs with.
        const snapped = snapComposer(fallbackConn.id, mode.label, picked.id, store.effort, store.speed, catalogFor(fallbackConn.id));
        reviewer = {
          connectionId: fallbackConn.id,
          connectionLabel: connectionLabel(fallbackConn),
          connectionIcon: providerDef(fallbackConn.providerId).icon,
          modelId: snapped.modelId || picked.id,
          modelLabel: snapped.modelLabel || picked.label,
          effort: snapped.effort,
          effortLabel: snapped.effortLabel,
          efforts: snapped.efforts,
          models: pickerModels,
        };
      }
    }
  }

  // The image picker lists only connections whose mode serves image
  // generation. With none connected the role is empty, and the pane hides it.
  const imagePickerModels: RolePublic["models"] = [];
  for (const conn of listed.filter((row) => connectedIds.has(row.id))) {
    const label = connectionLabel(conn);
    const icon = providerDef(conn.providerId).icon;
    for (const row of imageModelRows(conn)) {
      imagePickerModels.push({ connectionId: conn.id, connectionLabel: label, icon, id: row.id, label: row.label });
    }
  }
  const imageSel = store.roles.image && connectedIds.has(store.roles.image.connectionId)
    ? store.roles.image
    : null;
  let image: RolePublic;
  if (imageSel) {
    const conn = listed.find((row) => row.id === imageSel.connectionId) ?? null;
    const picked = imagePickerModels.find((row) => row.connectionId === imageSel.connectionId && row.id === imageSel.modelId) ?? null;
    image = {
      connectionId: imageSel.connectionId,
      connectionLabel: conn ? connectionLabel(conn) : imageSel.connectionId,
      connectionIcon: conn ? providerDef(conn.providerId).icon : "",
      modelId: imageSel.modelId,
      modelLabel: picked?.label ?? humanizeModelId(imageSel.modelId),
      effort: null,
      effortLabel: null,
      efforts: [],
      models: imagePickerModels,
    };
  } else {
    const fallback = firstImageConnection(listed, connectedIds, activeId);
    image = {
      connectionId: fallback?.id ?? null,
      connectionLabel: fallback ? connectionLabel(fallback) : "",
      connectionIcon: fallback ? providerDef(fallback.providerId).icon : "",
      modelId: fallback ? imageModelRows(fallback)[0]?.id ?? "" : "",
      modelLabel: fallback ? imageModelRows(fallback)[0]?.label ?? "" : "",
      effort: null,
      effortLabel: null,
      efforts: [],
      models: imagePickerModels,
    };
  }

  return { catalog, connections, roles: { default: defaultRole, reviewer, image } };
}

/**
 * The store with one call's image model in place of the saved image role.
 * The pick must be a row the image picker offers right now (a connected,
 * image-capable connection's generator), so a bot can choose among the
 * owner's image models but never reach a model or connection outside them.
 * Without a connection id the model id must name exactly one row.
 */
export function withImagePick(
  store: ProviderStore,
  pick: { connectionId?: string; modelId: string },
  env: NodeJS.ProcessEnv = process.env,
): ProviderStore {
  const rows = publicProviders(store, env).roles.image.models
    .filter((row) => row.id === pick.modelId && (!pick.connectionId || row.connectionId === pick.connectionId));
  if (rows.length === 0) throw new Error("image_model_unknown");
  if (rows.length > 1) throw new Error("image_model_ambiguous");
  return { ...store, roles: { ...store.roles, image: { connectionId: rows[0].connectionId, modelId: rows[0].id, effort: null } } };
}

/**
 * @deprecated Slice 2 builds the settings payload from publicProviders.
 * One row per connection in the old shape.
 */
export function legacyProviders(store: ProviderStore, env: NodeJS.ProcessEnv = process.env): ProviderPublic[] {
  const pub = publicProviders(store, env);
  // The old web pane connects from these rows, so every vendor the old
  // shape can key (one row per bare provider id) is listed, connected or
  // not. Sign-in and field-driven modes are out: the old pane cannot
  // collect them. A vendor with a connected row shows that row.
  const rows: ProviderPublic[] = [];
  for (const def of CATALOG_DEFS) {
    const legacyModes = def.modes.filter((mode) => mode.mode !== "oauth" && !(mode.fields && mode.fields.length > 0));
    if (legacyModes.length === 0) continue;
    const connected = pub.connections
      .filter((conn) => conn.providerId === def.id && conn.mode !== "oauth")
      .sort((x, y) => Number(y.active) - Number(x.active))[0];
    const legacyDefault = LEGACY_API_CONNECTION[def.id]?.split(":")[1] as AuthMode | undefined;
    const mode = connected
      ? providerMode(def.id, connected.mode)
      : (legacyModes.find((row) => row.mode === (legacyDefault ?? "api")) ?? legacyModes[0]);
    rows.push({
      id: def.id as ProviderId,
      name: connected?.label ?? mode.label,
      kind: mode.mode === "plan" ? "coding-plan" as const : "api" as const,
      hint: mode.hint,
      compatible: mode.protocol === "openai-chat",
      connected: Boolean(connected),
      last4: connected?.last4 ?? null,
      source: connected?.source ?? null,
      active: connected?.active ?? false,
      models: { ...mode.defaults },
    });
  }
  return rows;
}

/**
 * One group per connected connection, the given one first. Same per
 * connection lists the roles picker reads, so the flyout never disagrees.
 */
function composerGroups(store: ProviderStore, env: NodeJS.ProcessEnv, firstId: string | undefined): ComposerGroup[] {
  const implicit = !store.connections["opencode-go:plan"] ? envConnection(env) : null;
  const listed = [...Object.values(store.connections)];
  if (implicit) listed.push(implicit);
  const connected = listed.filter((conn) => conn.id === implicit?.id || isConnected(conn));
  const ordered = [...connected].sort((a, b) => {
    if (a.id === firstId) return -1;
    if (b.id === firstId) return 1;
    return 0;
  });
  return ordered.map((row) => ({
    connectionId: row.id,
    label: connectionLabel(row),
    icon: providerDef(row.providerId).icon,
    models: modelRows(row.id),
  }));
}

export function composerState(store: ProviderStore, env: NodeJS.ProcessEnv = process.env): ComposerPublic {
  const envActive = !store.activeConnectionId || store.activeConnectionId === "opencode-go:plan";
  const conn = activeConnection(store, env)
    ?? ((envActive && env.UB_OPENCODE_GO_KEY) ? envConnection(env) : null);
  const groups = composerGroups(store, env, conn?.id);
  if (!conn) {
    return {
      providerId: "",
      connectionId: "",
      providerName: "",
      modelId: "",
      modelLabel: "",
      effort: null,
      effortLabel: null,
      speed: "standard",
      efforts: [],
      speeds: [],
      models: [],
      groups,
      available: false,
    };
  }
  const mode = providerMode(conn.providerId, conn.mode);
  const def = providerDef(conn.providerId);
  return snapComposer(
    conn.id,
    conn.providerId === "custom" && conn.fields.name ? conn.fields.name : def.name,
    store.selectedModel ?? mode.defaults.workhorse,
    store.effort,
    store.speed,
    catalogFor(conn.id),
    groups,
  );
}

export function setComposer(
  store: ProviderStore,
  patch: { modelId?: string; effort?: EffortId | null; speed?: SpeedId },
): ProviderStore {
  const next = { ...store };
  if (patch.modelId !== undefined) next.selectedModel = patch.modelId;
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.speed !== undefined) next.speed = patch.speed;
  const snapped = composerState(next);
  return {
    ...next,
    selectedModel: snapped.modelId || null,
    effort: snapped.effort,
    speed: snapped.speed,
  };
}

/**
 * What the composer sends when the owner picks a model: "<connectionId>::<modelId>"
 * switches the chat connection and the model in one write, so the next turn
 * goes to that connection with its own credential, whichever connection was
 * active before. A bare model id keeps the connection and changes the model.
 */
export function pickComposerModel(store: ProviderStore, pick: string, env: NodeJS.ProcessEnv = process.env): ProviderStore {
  const sep = pick.lastIndexOf("::");
  if (sep < 0) return setComposer(store, { modelId: pick });
  const connId = pick.slice(0, sep);
  const modelId = pick.slice(sep + 2);
  parseConnectionId(connId);
  const next = setActiveConnection(store, connId, env);
  return modelId ? setComposer(next, { modelId }) : next;
}

/**
 * A bot's own pick cannot be served: its connection is gone or signed out, or
 * its model left a live list. Carries the code the router and the apps map to
 * a plain sentence. Never a reason to run something else: the caller refuses.
 */
export class ModelSelectionUnavailableError extends Error {
  readonly code = "model_selection_unavailable";
  readonly reason: "connection_missing" | "provider_disconnected" | "model_missing";
  constructor(reason: "connection_missing" | "provider_disconnected" | "model_missing") {
    super("model_selection_unavailable");
    this.reason = reason;
  }
}

/** The connection a selection names, including the implicit env-key Go plan row. */
function selectionConnection(store: ProviderStore, id: string, env: NodeJS.ProcessEnv): Connection | undefined {
  return store.connections[id] ?? (id === "opencode-go:plan" ? envConnection(env) ?? undefined : undefined);
}

/**
 * The vendor's own list as last fetched, or empty when there is none. Same
 * lookup as `catalogFor` minus its static fallback: the static list is only the
 * mode's two defaults, so a model absent from it says nothing, while one absent
 * from a fetched list was really removed.
 */
function liveCatalog(id: string): ModelOption[] {
  const live = cachedModels(id);
  if (live.length > 0) return live;
  try {
    return cachedModels(parseConnectionId(id).providerId);
  } catch {
    return [];
  }
}

/**
 * Can this selection carry a turn right now. A model is only refused when a
 * fetched list exists and lacks it: custom servers, Ollama and LM Studio
 * often have no list, and a free-form id there must go through.
 */
export function selectionAvailability(
  store: ProviderStore,
  selection: ModelSelection,
  env: NodeJS.ProcessEnv = process.env,
): { available: true } | { available: false; reason: ModelSelectionUnavailableError["reason"] } {
  const conn = selectionConnection(store, selection.connectionId, env);
  if (!conn) return { available: false, reason: "connection_missing" };
  if (!isConnected(conn)) return { available: false, reason: "provider_disconnected" };
  const live = liveCatalog(conn.id);
  if (live.length > 0 && !live.some((item) => item.id === selection.modelId)) {
    return { available: false, reason: "model_missing" };
  }
  return { available: true };
}

/**
 * The composer for one bot's selection. Effort and speed snap to the stored
 * model's own levels, but a model that is missing is shown as stored, with
 * `available: false`, and never replaced by another one.
 */
export function botComposerState(
  store: ProviderStore,
  selection: ModelSelection,
  env: NodeJS.ProcessEnv = process.env,
): ComposerPublic {
  const conn = selectionConnection(store, selection.connectionId, env);
  const usable = conn !== undefined && isConnected(conn);
  const groups = composerGroups(store, env, usable ? conn.id : selection.connectionId);
  if (!conn || !usable) {
    let providerId = selection.connectionId;
    let providerName = "";
    try {
      providerId = parseConnectionId(selection.connectionId).providerId;
      providerName = providerDef(providerId).name;
    } catch {
      /* a connection id the catalogue no longer knows shows blank, still unavailable */
    }
    return {
      providerId,
      connectionId: selection.connectionId,
      providerName,
      modelId: selection.modelId,
      modelLabel: humanizeModelId(selection.modelId),
      effort: selection.effort,
      effortLabel: selection.effort ? effortLabel(selection.effort) : null,
      speed: selection.speed,
      efforts: [],
      speeds: [],
      models: [],
      groups,
      available: false,
    };
  }
  const name = conn.providerId === "custom" && conn.fields.name ? conn.fields.name : providerDef(conn.providerId).name;
  const snapped = snapComposer(conn.id, name, selection.modelId, selection.effort, selection.speed, catalogFor(conn.id), groups, true);
  return { ...snapped, available: selectionAvailability(store, selection, env).available };
}

/**
 * What a bot with no model of its own runs on: the model the old global chip
 * showed and the router used, which is `composerState`'s resolution of the
 * last pick (its list-first stand-in for a stored model that dropped out of a
 * live list, the env Go plan fallback), with that model's snapped effort and
 * speed. Null when that cannot carry a turn (nothing connected yet), so a
 * caller never pins a bot to a pick that would only be refused later.
 */
export function effectiveDefault(store: ProviderStore, env: NodeJS.ProcessEnv = process.env): ModelSelection | null {
  const composer = composerState(store, env);
  if (!composer.connectionId || !composer.modelId) return null;
  const selection: ModelSelection = {
    connectionId: composer.connectionId,
    modelId: composer.modelId,
    effort: composer.effort,
    speed: composer.speed,
  };
  return selectionAvailability(store, selection, env).available ? selection : null;
}

/**
 * One bot's pick, applied to that bot's selection and nothing else. Returns the
 * new selection and the store with the last pick moved to it (the default for
 * bots that have not chosen). The requested connection and model are stored
 * exactly: nothing here goes through the substituting `setComposer` snap, so a
 * model that is not in the connection's fetched list is refused
 * (`model_selection_unavailable`) instead of replaced by the list's first.
 * Effort and speed snap to that model's own levels with the exact lookup. A
 * free-form id on a connection with no fetched list is stored as is.
 */
export function applyBotPick(
  store: ProviderStore,
  base: ModelSelection,
  patch: { modelId?: string; effort?: EffortId | null; speed?: SpeedId },
  env: NodeJS.ProcessEnv = process.env,
): { store: ProviderStore; selection: ModelSelection } {
  let selection = base;
  if (patch.modelId !== undefined) {
    // "<connectionId>::<modelId>" names the connection; a bare id means "on this bot's connection".
    const sep = patch.modelId.lastIndexOf("::");
    const connId = sep < 0 ? base.connectionId : patch.modelId.slice(0, sep);
    const modelId = sep < 0 ? patch.modelId : patch.modelId.slice(sep + 2);
    if (sep >= 0) parseConnectionId(connId);
    if (!modelId) throw new ModelSelectionUnavailableError("model_missing");
    selection = { ...base, connectionId: connId, modelId };
    const verdict = selectionAvailability(store, selection, env);
    if (!verdict.available) throw new ModelSelectionUnavailableError(verdict.reason);
  }
  if (patch.modelId !== undefined || patch.effort !== undefined || patch.speed !== undefined) {
    // The RESULTING selection, so an effort-only or speed-only pick on a bot
    // whose model or connection is gone is refused too, with nothing written.
    const verdict = selectionAvailability(store, selection, env);
    if (!verdict.available) throw new ModelSelectionUnavailableError(verdict.reason);
    const conn = selectionConnection(store, selection.connectionId, env);
    if (!conn || !isConnected(conn)) throw new ModelSelectionUnavailableError(conn ? "provider_disconnected" : "connection_missing");
    const name = conn.providerId === "custom" && conn.fields.name ? conn.fields.name : providerDef(conn.providerId).name;
    const snapped = snapComposer(
      conn.id,
      name,
      selection.modelId,
      patch.effort !== undefined ? patch.effort : selection.effort,
      patch.speed !== undefined ? patch.speed : selection.speed,
      catalogFor(conn.id),
      [],
      true,
    );
    selection = { ...selection, effort: snapped.effort, speed: snapped.speed };
  }
  return {
    selection,
    // The implicit env-key Go plan row is materialized as setActiveConnection does.
    store: {
      ...withImplicit(store, selection.connectionId, env),
      activeConnectionId: selection.connectionId,
      selectedModel: selection.modelId,
      effort: selection.effort,
      speed: selection.speed,
    },
  };
}

function substituteBaseUrl(mode: ProviderMode, fields: Record<string, string>): string {
  return mode.baseUrl.replace(/\{(\w+)\}/g, (_, name: string) => fields[name] ?? "");
}

function credentialKey(credential: Credential): string {
  if (credential.kind === "key") return credential.key;
  // Slice 3 refreshes and rotates these. Until then the router sends the best
  // token it has, the same way the old code sent its single key.
  if (credential.kind === "oauth") return credential.exchanged?.token ?? credential.accessToken;
  return "";
}

export function resolveUpstream(
  store: ProviderStore,
  alias: "workhorse" | "reviewer" | "image",
  env: NodeJS.ProcessEnv = process.env,
  /**
   * A turn's frozen selection (workhorse only). Resolved exactly: that
   * connection with its current credential, that model, effort and speed
   * snapped to what the model takes. A selection that cannot be served throws
   * `model_selection_unavailable`; there is no fallback to the env key, to
   * another connection or to the last pick.
   */
  selection?: ModelSelection,
): {
  connection: Connection;
  mode: ProviderMode;
  providerId: string;
  modelId: string;
  effort: EffortId | null;
  speed: SpeedId;
  baseUrl: string;
  protocol: Protocol;
  keyHeader: KeyHeader;
  credential: Credential;
  opencodeSession: boolean;
  fallback: boolean;
  /** @deprecated Use modelId instead. Kept so the router compiles until slice 4. */
  model: string;
  /** @deprecated Use credential instead. Kept so the router compiles until slice 4. */
  key: string;
} {
  if (alias === "image") {
    // The picked connection wins; otherwise the first connected connection
    // whose mode serves /images/generations, the chat connection preferred.
    // Chat aliases fall back to the Go plan env key; there is no image
    // fallback, so nothing connected is a plain refusal, not a surprise call.
    const implicit = !store.connections["opencode-go:plan"] ? envConnection(env) : null;
    const listed = implicit ? [...Object.values(store.connections), implicit] : Object.values(store.connections);
    const sel = store.roles.image;
    const selConn = sel ? listed.find((conn) => conn.id === sel.connectionId) : undefined;
    const picked = selConn && isConnected(selConn)
      ? selConn
      : firstImageConnection(listed, new Set(listed.filter(isConnected).map((conn) => conn.id)), store.activeConnectionId);
    if (!picked) throw new Error("provider_incompatible");
    const mode = providerMode(picked.providerId, picked.mode);
    const models = imageModelRows(picked);
    const modelId = (sel && sel.connectionId === picked.id ? sel.modelId : "") || models[0]?.id || mode.images?.models[0];
    if (!modelId || !mode.images) throw new Error("provider_incompatible");
    const baseUrl = picked.providerId === "opencode-go" && env.UB_OPENCODE_GO_BASE
      ? env.UB_OPENCODE_GO_BASE
      : substituteBaseUrl(mode, picked.fields);
    return {
      connection: picked,
      mode,
      providerId: picked.providerId,
      modelId,
      effort: null,
      speed: "standard",
      baseUrl,
      protocol: mode.protocol,
      keyHeader: mode.keyHeader,
      credential: picked.credential,
      opencodeSession: mode.opencodeSession ?? false,
      fallback: !(sel && sel.connectionId === picked.id),
      model: modelId,
      key: credentialKey(picked.credential),
    };
  }
  if (selection && alias === "workhorse") {
    const verdict = selectionAvailability(store, selection, env);
    if (!verdict.available) throw new ModelSelectionUnavailableError(verdict.reason);
    const chosen = selectionConnection(store, selection.connectionId, env) as Connection;
    const mode = providerMode(chosen.providerId, chosen.mode);
    const name = chosen.providerId === "custom" && chosen.fields.name
      ? chosen.fields.name
      : providerDef(chosen.providerId).name;
    const snapped = snapComposer(chosen.id, name, selection.modelId, selection.effort, selection.speed, catalogFor(chosen.id), [], true);
    const baseUrl = chosen.providerId === "opencode-go" && env.UB_OPENCODE_GO_BASE
      ? env.UB_OPENCODE_GO_BASE
      : substituteBaseUrl(mode, chosen.fields);
    return {
      connection: chosen,
      mode,
      providerId: chosen.providerId,
      modelId: selection.modelId,
      effort: snapped.effort,
      speed: snapped.speed,
      baseUrl,
      protocol: mode.protocol,
      keyHeader: mode.keyHeader,
      credential: chosen.credential,
      opencodeSession: mode.opencodeSession ?? false,
      fallback: false,
      model: selection.modelId,
      key: credentialKey(chosen.credential),
    };
  }
  const live = activeConnection(store, env);
  const reviewerSel = alias === "reviewer" && store.roles.reviewer
    ? store.roles.reviewer
    : null;
  const picked = reviewerSel && store.connections[reviewerSel.connectionId]
    && isConnected(store.connections[reviewerSel.connectionId])
    ? store.connections[reviewerSel.connectionId]
    : live;

  if (picked) {
    const mode = providerMode(picked.providerId, picked.mode);
    const name = picked.providerId === "custom" && picked.fields.name
      ? picked.fields.name
      : providerDef(picked.providerId).name;
    const composer = composerState({ ...store, activeConnectionId: picked.id }, env);
    // An explicit reviewer choice wins. Otherwise the reviewer follows the
    // active connection with the mode's reviewer default, not the workhorse.
    const snapped = alias === "reviewer" && !reviewerSel
      ? snapComposer(picked.id, name, mode.defaults.reviewer, store.effort, store.speed, catalogFor(picked.id))
      : composer;
    const modelId = reviewerSel ? reviewerSel.modelId : (snapped.modelId || mode.defaults.workhorse);
    const effort = reviewerSel ? reviewerSel.effort : snapped.effort;
    // Local dev and tests point the Go plan at a fixture upstream.
    const baseUrl = picked.providerId === "opencode-go" && env.UB_OPENCODE_GO_BASE
      ? env.UB_OPENCODE_GO_BASE
      : substituteBaseUrl(mode, picked.fields);
    return {
      connection: picked,
      mode,
      providerId: picked.providerId,
      modelId,
      effort,
      speed: snapped.speed,
      baseUrl,
      protocol: mode.protocol,
      keyHeader: mode.keyHeader,
      credential: picked.credential,
      opencodeSession: mode.opencodeSession ?? false,
      fallback: false,
      model: modelId,
      key: credentialKey(picked.credential),
    };
  }
  const goKey = store.connections["opencode-go:plan"]?.credential
    ?? (env.UB_OPENCODE_GO_KEY ? { kind: "key", key: env.UB_OPENCODE_GO_KEY } as Credential : null);
  const usable = goKey && goKey.kind === "key" ? goKey.key : null;
  if (!usable) throw new Error("upstream_credential_missing");
  const mode = providerMode("opencode-go", "plan");
  const goComposer = snapComposer(
    "opencode-go:plan",
    providerDef("opencode-go").name,
    alias === "reviewer" ? mode.defaults.reviewer : mode.defaults.workhorse,
    store.effort,
    store.speed,
    catalogFor("opencode-go:plan"),
  );
  const modelId = alias === "reviewer" ? mode.defaults.reviewer : (goComposer.modelId || mode.defaults.workhorse);
  const baseUrl = (env.UB_OPENCODE_GO_BASE || mode.baseUrl).replace(/\{(\w+)\}/g, "");
  const credential: Credential = { kind: "key", key: usable };
  return {
    connection: {
      id: "opencode-go:plan",
      providerId: "opencode-go",
      mode: "plan",
      credential,
      fields: {},
      updatedAt: new Date(0).toISOString(),
      lastError: null,
    },
    mode,
    providerId: "opencode-go",
    modelId,
    effort: goComposer.effort,
    speed: goComposer.speed,
    baseUrl,
    protocol: mode.protocol,
    keyHeader: mode.keyHeader,
    credential,
    opencodeSession: true,
    fallback: store.activeConnectionId !== "opencode-go:plan",
    model: modelId,
    key: usable,
  };
}

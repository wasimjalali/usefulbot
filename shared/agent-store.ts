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
import type { ConnectionAuthKind, ConnectionKind } from "./connections-store.ts";

/**
 * Local agent state: the open connect cards (proposals) and the idempotency
 * keys of agent tool calls. Both the Next server (UI actions) and the engine
 * (agent tools) write here, so every mutation is a locked read/merge/write.
 * The transcript does not live here: chat rows are in the engine's session
 * files.
 */

export const AGENT_SCHEMA = 1;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Stale below timeout, or one crashed holder makes every writer fail for the
 * whole stale window instead of clearing the corpse. The gap between them is
 * the margin a live holder gets before its lock is stolen mid-fsync.
 */
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 3000;
const TEXT_MAX = 4000;

export type ConnectPhase = "proposed" | "waiting" | "connected" | "expired";
/**
 * A server card has one phase more: `failed`, for a connect that finished its
 * sign-in or credential but whose tools could not be listed. `reason` says
 * which of the connection states it was.
 */
export type ConnectServerPhase = ConnectPhase | "failed";

export type ConnectAppProposal = {
  kind: "connectApp";
  slug: string;
  name: string;
  logo: string | null;
  /** One line from the bot: what it will do there. */
  purpose: string;
  sourceBotId: string | null;
  threadId: string;
  phase: ConnectPhase;
  /** Composio connected-account id once authorize ran. */
  accountId: string | null;
  waitingSince: string | null;
  /** Filled when connected; null when the count call failed. */
  toolCount: number | null;
  /** The key of the resume system turn, once it is accepted; the card leaves the dock then. */
  resumeKey?: string | null;
};

export type ConnectServerProposal = {
  kind: "connectServer";
  connectionKind: ConnectionKind;
  connectionId: string;
  name: string;
  description: string;
  /** Full URL, validated at propose. Never returned to the model. */
  url: string;
  /** Hostname only, for the card. */
  urlHost: string;
  purpose: string;
  authKind: ConnectionAuthKind;
  authHeader: string | null;
  sourceBotId: string | null;
  threadId: string;
  phase: ConnectServerPhase;
  /** Why the card is `failed`: a connection state code such as `auth_failed`. Null otherwise. */
  reason?: string | null;
  /** OAuth authorize host, once waiting. The app opens only this host. */
  redirectHost: string | null;
  waitingSince: string | null;
  toolCount: number | null;
  resumeKey?: string | null;
};

export type ProposalPayload = ConnectAppProposal | ConnectServerProposal;
export type ProposalKind = ProposalPayload["kind"];

export type Proposal = ProposalPayload & {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "confirmed" | "dismissed";
};

export type AgentStore = {
  schemaVersion: 1;
  proposals: Proposal[];
  /** Idempotency keys for agent tool calls, newest last. */
  reserves: string[];
};

export type ReserveKind = "proposal" | "image";

export function agentStorePath(): string {
  if (process.env.UB_AGENT_STORE_PATH) return process.env.UB_AGENT_STORE_PATH;
  return statePath("agents.json");
}

export function newProposalId(): string {
  return `prp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * The id a proposal is filed under: the bot's id. A connect card belongs to the
 * bot that raised it, not to one chat, so it follows the owner to any chat.
 * (The field is still called `threadId`; it is the bot id.)
 */
export function threadIdFor(botId: string): string {
  return botId;
}

function clip(value: unknown, max = TEXT_MAX): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isId(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function emptyStore(): AgentStore {
  return { schemaVersion: 1, proposals: [], reserves: [] };
}

/** A card of any other kind is ignored: never listed, never confirmable. */
function isProposalKind(value: unknown): value is ProposalKind {
  return value === "connectApp" || value === "connectServer";
}

function parseProposal(raw: unknown): Proposal | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!isId(rec.id, 120) || !isProposalKind(rec.kind)) return null;
  if (typeof rec.threadId !== "string") return null;
  const status: Proposal["status"] = rec.status === "confirmed" || rec.status === "dismissed"
    ? rec.status
    : "pending";
  const base = {
    id: rec.id,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date(0).toISOString(),
    expiresAt: typeof rec.expiresAt === "string" ? rec.expiresAt : new Date(0).toISOString(),
    status,
    sourceBotId: isId(rec.sourceBotId) ? rec.sourceBotId : null,
    threadId: clip(rec.threadId, 80),
  };
  if (rec.kind === "connectApp") {
    const phase: ConnectPhase = rec.phase === "waiting" || rec.phase === "connected" || rec.phase === "expired"
      ? rec.phase
      : "proposed";
    return {
      ...base,
      kind: "connectApp",
      slug: clip(rec.slug, 80),
      name: clip(rec.name, 80),
      logo: typeof rec.logo === "string" && rec.logo ? rec.logo.slice(0, 500) : null,
      purpose: clip(rec.purpose, 120),
      phase,
      accountId: isId(rec.accountId, 120) ? rec.accountId : null,
      waitingSince: typeof rec.waitingSince === "string" ? rec.waitingSince : null,
      toolCount: typeof rec.toolCount === "number" && Number.isFinite(rec.toolCount)
        ? Math.max(0, Math.trunc(rec.toolCount))
        : null,
      resumeKey: isId(rec.resumeKey, 200) ? rec.resumeKey : null,
    };
  }
  if (rec.kind === "connectServer") {
    const phase: ConnectServerPhase = rec.phase === "waiting" || rec.phase === "connected" || rec.phase === "expired"
      || rec.phase === "failed"
      ? rec.phase
      : "proposed";
    const authKind: ConnectionAuthKind = rec.authKind === "apiKey" || rec.authKind === "bearer" || rec.authKind === "oauth"
      ? rec.authKind
      : "none";
    return {
      ...base,
      kind: "connectServer",
      connectionKind: "mcp",
      connectionId: clip(rec.connectionId, 80),
      name: clip(rec.name, 80),
      description: clip(rec.description, 400),
      url: clip(rec.url, 2048),
      urlHost: clip(rec.urlHost, 253),
      purpose: clip(rec.purpose, 120),
      authKind,
      authHeader: typeof rec.authHeader === "string" && rec.authHeader ? rec.authHeader.slice(0, 64) : null,
      phase,
      reason: phase === "failed" && typeof rec.reason === "string" && /^[a-z_]{1,40}$/.test(rec.reason)
        ? rec.reason
        : null,
      redirectHost: typeof rec.redirectHost === "string" && rec.redirectHost ? rec.redirectHost.slice(0, 253) : null,
      waitingSince: typeof rec.waitingSince === "string" ? rec.waitingSince : null,
      toolCount: typeof rec.toolCount === "number" && Number.isFinite(rec.toolCount)
        ? Math.max(0, Math.trunc(rec.toolCount))
        : null,
      resumeKey: isId(rec.resumeKey, 200) ? rec.resumeKey : null,
    };
  }
  return null;
}

export function parseAgentStore(raw: unknown): AgentStore {
  if (!raw || typeof raw !== "object") return emptyStore();
  const rec = raw as Record<string, unknown>;
  // Unknown top-level keys are ignored, not fatal: a newer build may add one,
  // and losing every transcript over a forward-compatible field is worse.
  if (rec.schemaVersion !== AGENT_SCHEMA) return emptyStore();
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.proposals) ? rec.proposals : []) {
    const proposal = parseProposal(item);
    if (proposal && !seen.has(proposal.id)) {
      seen.add(proposal.id);
      proposals.push(proposal);
    }
  }
  return { schemaVersion: 1, proposals, reserves: Array.isArray(rec.reserves) ? rec.reserves.filter((key): key is string => isId(key, 200)).slice(-1000) : [] };
}

export function readAgentStore(path = agentStorePath()): AgentStore {
  if (!existsSync(path)) return emptyStore();
  try {
    return parseAgentStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * If the file on disk cannot be parsed as the current schema, move it aside
 * before the next write, so a crash never destroys the only copy of every open
 * card.
 */
function backupIncompatible(path: string): void {
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw && typeof raw === "object" && raw.schemaVersion === AGENT_SCHEMA) return;
  } catch {
    /* fall through to backup */
  }
  try {
    renameSync(path, `${path}.invalid.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`);
  } catch { /* ignore */ }
}

export function writeAgentStore(store: AgentStore, path = agentStorePath()): void {
  const parsed = parseAgentStore(store);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  backupIncompatible(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  try {
    // Sync callers must not spin the event loop while another process holds
    // the lock; Atomics.wait parks the thread without burning CPU.
    Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback for runtimes without Atomics.wait */
    }
  }
}

/**
 * Cross-process lock for read/merge/write cycles. Sync by design: every caller
 * is a short request-scoped or tool-scoped action.
 */
export function withAgentStore<T>(fn: (store: AgentStore) => T, path = agentStorePath()): T {
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
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) rmdirSync(lock);
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) break;
      sleep(15);
    }
  }
  if (!held) throw new Error("agent_store_locked");
  try {
    const before = readAgentStore(path);
    const scratch = parseAgentStore(JSON.parse(JSON.stringify(before)));
    const result = fn(scratch);
    writeAgentStore(scratch, path);
    return result;
  } finally {
    if (held) {
      try { rmdirSync(lock); } catch { /* ignore */ }
    }
  }
}

export function createProposal<P extends ProposalPayload>(
  payload: P,
  path = agentStorePath(),
): P & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status"> {
  type Stored = P & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status">;
  return withAgentStore((store) => {
    const now = Date.now();
    const proposal = {
      ...payload,
      id: newProposalId(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      status: "pending",
    } as Stored;
    store.proposals.push(proposal);
    const keep = store.proposals.filter((item) => Date.now() - Date.parse(item.createdAt) < PROPOSAL_TTL_MS * 7);
    store.proposals = keep.slice(-80);
    return proposal;
  }, path);
}

/**
 * Confirmable-once claim. Returns the proposal only to the caller that flipped
 * it out of pending; everyone else gets null. Two concurrent confirms can
 * therefore never apply the same action twice.
 */
export function claimProposal(
  id: string,
  status: "confirmed" | "dismissed",
  path = agentStorePath(),
): Proposal | null {
  return withAgentStore((store) => {
    const proposal = store.proposals.find((item) => item.id === id);
    if (!proposal || proposal.status !== "pending") return null;
    // An expired proposal is not confirmable, even though it still reads as
    // pending until the snapshot filters it out. An unparsable expiry counts
    // as expired too, so a corrupt proposal is refused the way the pending
    // list already refuses it. Dismissing stays allowed so the card can
    // always be cleared.
    const expiresAt = Date.parse(proposal.expiresAt);
    if (status === "confirmed" && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return null;
    proposal.status = status;
    return proposal;
  }, path);
}

/**
 * Put a claimed proposal back to pending when applying its action failed, so
 * the owner can try again instead of the card being silently consumed.
 */
export function reopenProposal(id: string, path = agentStorePath()): void {
  withAgentStore((store) => {
    const proposal = store.proposals.find((item) => item.id === id);
    if (proposal && proposal.status === "confirmed") proposal.status = "pending";
  }, path);
}

export function listPendingProposals(threadId: string, path = agentStorePath()): Proposal[] {
  const now = Date.now();
  return readAgentStore(path).proposals.filter((item) => (
    item.status === "pending"
    && item.threadId === threadId
    && Date.parse(item.expiresAt) > now
  ));
}

export function readProposal(id: string, path = agentStorePath()): Proposal | null {
  return readAgentStore(path).proposals.find((item) => item.id === id) ?? null;
}

/** Patch one proposal under the store lock. Returns the patched record or null. */
export function updateProposal(
  id: string,
  patch: (proposal: Proposal) => void,
  path = agentStorePath(),
): Proposal | null {
  return withAgentStore((store) => {
    const proposal = store.proposals.find((item) => item.id === id);
    if (!proposal) return null;
    patch(proposal);
    return proposal;
  }, path);
}

export function listProposalsOfKind<K extends ProposalKind>(
  kind: K,
  path = agentStorePath(),
): Array<Extract<Proposal, { kind: K }>> {
  return readAgentStore(path).proposals.filter(
    (item): item is Extract<Proposal, { kind: K }> => item.kind === kind,
  );
}

export function reserveKey(kind: ReserveKind, requestId: string): string {
  return `sent:${kind}:${requestId}`;
}

export function isReserved(key: string, path = agentStorePath()): boolean {
  return readAgentStore(path).reserves.includes(key);
}

/**
 * Claim an idempotency slot for an agent tool call so a retried step cannot
 * raise the same card or draw the same image twice. The model supplies the request id.
 */
export function reserveSend(kind: ReserveKind, requestId: string, path = agentStorePath()): boolean {
  return withAgentStore((store) => {
    const key = reserveKey(kind, requestId);
    if (store.reserves.includes(key)) return false;
    store.reserves.push(key);
    store.reserves = store.reserves.slice(-1000);
    return true;
  }, path);
}

/**
 * Give an idempotency slot back when the work it guarded did not survive.
 * Without this, a crash between reserve and queue would burn the request id.
 */
export function releaseSend(kind: ReserveKind, requestId: string, path = agentStorePath()): void {
  withAgentStore((store) => {
    const key = reserveKey(kind, requestId);
    store.reserves = store.reserves.filter((item) => item !== key);
  }, path);
}

/** The open (pending, unexpired) cards the bot raised, for GET /api/proposals. */
export function openProposals(botId: string, path = agentStorePath()): Proposal[] {
  return listPendingProposals(threadIdFor(botId), path);
}

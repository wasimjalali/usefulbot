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
import { DESCRIPTION_MAX, PROPOSE_DESCRIPTION_MAX } from "./shell-store.ts";
import type { ConnectionAuthKind, ConnectionKind } from "./connections-store.ts";

/**
 * Local multi-agent state: per-thread event transcripts and pending
 * confirmations. Both the Next server (UI actions) and the eve agent process
 * (agent tools) write here, so every mutation is a locked read/merge/write.
 * The log is append-only and deduplicated by event id.
 */

export const AGENT_SCHEMA = 1;
export const EVENT_CAP_PER_THREAD = 300;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Stale below timeout, or one crashed holder makes every writer fail for the
 * whole stale window instead of clearing the corpse. The gap between them is
 * the margin a live holder gets before its lock is stolen mid-fsync.
 */
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 3000;
const TEXT_MAX = 4000;

export type ThreadKind = "bot" | "group";

export type AgentEventKind =
  | "user"
  | "assistant"
  | "handoff"
  | "post"
  | "note"
  | "proposal"
  | "widget"
  | "image"
  | "page";

export type AgentEvent = {
  id: string;
  at: string;
  kind: AgentEventKind;
  text: string;
  authorBotId: string | null;
  authorName: string | null;
  targetBotIds: string[];
  proposalId: string | null;
  handoffId: string | null;
  widgetId: string | null;
  /**
   * The media item the row renders: a generated image, or on a "page" row
   * the Library entry of an HTML file the bot wrote.
   */
  imageId: string | null;
  /**
   * Set on the host's "connected" note: the app or server that was just
   * added, so the chat can draw it as a card with its logo instead of a line
   * of text. The note keeps its text, so a reader that ignores these still
   * says the same thing.
   */
  connectedName: string | null;
  connectedLogo: string | null;
};

export type BotProfileDraft = {
  name: string;
  petname: string;
  title: string;
  /** Absent means the description is unchanged: the card leaves it alone. */
  description?: string;
  avatarShape: string | null;
  avatarColor: string | null;
};

export type BotProposal = {
  kind: "createBot";
  name: string;
  /** Working name while the bot is being onboarded, e.g. New Bot 2. */
  petname: string;
  title: string;
  description: string;
  sectionId: string | null;
  sourceBotId: string | null;
  threadId: string;
  brief: string;
  /**
   * The bot whose tool call raised the card. Confirming re-checks that bot's
   * authority against the live roster; a card with no proposer is refused.
   */
  proposerId?: string;
};

export type GroupProposal = {
  kind: "createGroup";
  name: string;
  memberIds: string[];
  /** The group's standing instructions, stored and confirmed like a bot's. */
  description: string;
  sourceBotId: string | null;
  threadId: string;
  /** See `BotProposal.proposerId`. */
  proposerId?: string;
};

export type ProfileProposal = {
  kind: "updateBotProfile";
  botId: string;
  patch: BotProfileDraft;
  /**
   * The target's `profileRevision` when the card was raised. The confirm path
   * refuses the card once the profile has moved on (shell-store.ts).
   */
  baseRevision: number;
  sourceBotId: string | null;
  threadId: string;
  /** See `BotProposal.proposerId`. */
  proposerId?: string;
};

export type FanoutProposal = {
  kind: "fanout";
  message: string;
  targetIds: string[];
  groupId: string | null;
  sourceBotId: string | null;
  threadId: string;
};

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
  /** The resume handoff, once queued; the card leaves the dock when it lands. */
  handoffId: string | null;
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
  handoffId: string | null;
};

export type ProposalPayload = BotProposal | GroupProposal | ProfileProposal | FanoutProposal | ConnectAppProposal | ConnectServerProposal;
export type ProposalKind = ProposalPayload["kind"];

export type Proposal = ProposalPayload & {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "confirmed" | "dismissed";
};

export type AgentThread = {
  id: string;
  kind: ThreadKind;
  botId: string;
  sessionId: string;
  updatedAt: string;
  events: AgentEvent[];
};

export type AgentStore = {
  schemaVersion: 1;
  threads: AgentThread[];
  proposals: Proposal[];
  /** Idempotency keys for agent tool calls, newest last. */
  reserves: string[];
};

export type ReserveKind = "handoff" | "post" | "proposal" | "image";

const EVENT_KINDS = new Set<AgentEventKind>([
  "user",
  "assistant",
  "handoff",
  "post",
  "note",
  "proposal",
  "widget",
  "image",
  "page",
]);

export function agentStorePath(): string {
  if (process.env.UB_AGENT_STORE_PATH) return process.env.UB_AGENT_STORE_PATH;
  return statePath("agents.json");
}

export function newEventId(prefix = "evt"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function newProposalId(): string {
  return `prp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Threads are keyed by bot, not by eve session: a session id can be created by
 * the UI mid-turn, so grouping by the current session would strand the earlier
 * messages of the same conversation.
 */
export function threadIdFor(botId: string): string {
  return botId;
}

function clip(value: unknown, max = TEXT_MAX): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * A proposal description over its cap is refused, never clipped. A stored
 * card that is over (hand-edited file) is dropped by the parser, since the
 * card must show exactly the text that would be written.
 */
function descriptionWithin(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? null : text;
}

function isId(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function emptyStore(): AgentStore {
  return { schemaVersion: 1, threads: [], proposals: [], reserves: [] };
}

function parseEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  // Unknown fields are ignored, never fatal: a newer build may add one and an
  // older build must not drop the event (and then prune it on the next write).
  if (!isId(rec.id, 120)) return null;
  if (typeof rec.kind !== "string" || !EVENT_KINDS.has(rec.kind as AgentEventKind)) return null;
  const at = typeof rec.at === "string" ? rec.at : new Date(0).toISOString();
  const targets = Array.isArray(rec.targetBotIds)
    ? rec.targetBotIds.filter((id): id is string => isId(id)).slice(0, 8)
    : [];
  return {
    id: rec.id,
    at,
    kind: rec.kind as AgentEventKind,
    text: clip(rec.text),
    authorBotId: isId(rec.authorBotId) ? rec.authorBotId : null,
    authorName: clip(rec.authorName, 80) || null,
    targetBotIds: targets,
    proposalId: isId(rec.proposalId, 120) ? rec.proposalId : null,
    handoffId: isId(rec.handoffId, 120) ? rec.handoffId : null,
    widgetId: isId(rec.widgetId, 120) ? rec.widgetId : null,
    imageId: isId(rec.imageId, 120) ? rec.imageId : null,
    connectedName: clip(rec.connectedName, 80) || null,
    connectedLogo: typeof rec.connectedLogo === "string" && rec.connectedLogo.length <= 500 ? rec.connectedLogo : null,
  };
}

function parseThread(raw: unknown): AgentThread | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!isId(rec.id) || !isId(rec.botId)) return null;
  if (rec.kind !== "bot" && rec.kind !== "group") return null;
  const events: AgentEvent[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.events) ? rec.events : []) {
    const event = parseEvent(item);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  return {
    id: rec.id,
    kind: rec.kind,
    botId: rec.botId,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date(0).toISOString(),
    events: events.slice(-EVENT_CAP_PER_THREAD),
  };
}

function isProposalKind(value: unknown): value is ProposalKind {
  return value === "createBot"
    || value === "createGroup"
    || value === "updateBotProfile"
    || value === "fanout"
    || value === "connectApp"
    || value === "connectServer";
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
  if (rec.kind === "createBot") {
    const description = descriptionWithin(rec.description, PROPOSE_DESCRIPTION_MAX);
    if (description === null) return null;
    return {
      ...base,
      kind: "createBot",
      name: clip(rec.name, 80),
      petname: clip(rec.petname, 80),
      title: clip(rec.title, 24),
      description,
      sectionId: isId(rec.sectionId) ? rec.sectionId : null,
      brief: clip(rec.brief, 1000),
      proposerId: isId(rec.proposerId) ? rec.proposerId : "",
    };
  }
  if (rec.kind === "createGroup") {
    const memberIds = Array.isArray(rec.memberIds)
      ? rec.memberIds.filter((id): id is string => isId(id)).slice(0, 6)
      : [];
    const description = descriptionWithin(rec.description, DESCRIPTION_MAX);
    if (description === null) return null;
    return {
      ...base,
      kind: "createGroup",
      name: clip(rec.name, 80),
      memberIds,
      description,
      proposerId: isId(rec.proposerId) ? rec.proposerId : "",
    };
  }
  if (rec.kind === "updateBotProfile") {
    const patchRaw = (rec.patch ?? {}) as Record<string, unknown>;
    // Present only when the card changes it; an absent one stays absent.
    const description = typeof patchRaw.description === "string"
      ? descriptionWithin(patchRaw.description, DESCRIPTION_MAX)
      : undefined;
    if (description === null) return null;
    return {
      ...base,
      kind: "updateBotProfile",
      proposerId: isId(rec.proposerId) ? rec.proposerId : "",
      botId: isId(rec.botId) ? rec.botId : "",
      // A card with no recorded revision is stale by construction: -1 never
      // matches a bot's revision.
      baseRevision: Number.isInteger(rec.baseRevision) && (rec.baseRevision as number) >= 0
        ? (rec.baseRevision as number)
        : -1,
      patch: {
        name: clip(patchRaw.name, 80),
        petname: clip(patchRaw.petname, 80),
        title: clip(patchRaw.title, 24),
        ...(description !== undefined ? { description } : {}),
        avatarShape: typeof patchRaw.avatarShape === "string" ? patchRaw.avatarShape : null,
        avatarColor: typeof patchRaw.avatarColor === "string" ? patchRaw.avatarColor : null,
      },
    };
  }
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
      handoffId: isId(rec.handoffId, 120) ? rec.handoffId : null,
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
    const connectionKind: ConnectionKind = rec.connectionKind === "openapi" ? "openapi" : "mcp";
    return {
      ...base,
      kind: "connectServer",
      connectionKind,
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
      handoffId: isId(rec.handoffId, 120) ? rec.handoffId : null,
    };
  }
  const targetIds = Array.isArray(rec.targetIds)
    ? rec.targetIds.filter((id): id is string => isId(id)).slice(0, 8)
    : [];
  return {
    ...base,
    kind: "fanout",
    message: clip(rec.message, 2000),
    targetIds,
    groupId: isId(rec.groupId) ? rec.groupId : null,
  };
}

export function parseAgentStore(raw: unknown): AgentStore {
  if (!raw || typeof raw !== "object") return emptyStore();
  const rec = raw as Record<string, unknown>;
  // Unknown top-level keys are ignored, not fatal: a newer build may add one,
  // and losing every transcript over a forward-compatible field is worse.
  if (rec.schemaVersion !== AGENT_SCHEMA) return emptyStore();
  const threads: AgentThread[] = [];
  for (const item of Array.isArray(rec.threads) ? rec.threads : []) {
    const thread = parseThread(item);
    if (thread) threads.push(thread);
  }
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.proposals) ? rec.proposals : []) {
    const proposal = parseProposal(item);
    if (proposal && !seen.has(proposal.id)) {
      seen.add(proposal.id);
      proposals.push(proposal);
    }
  }
  return { schemaVersion: 1, threads, proposals, reserves: Array.isArray(rec.reserves) ? rec.reserves.filter((key): key is string => isId(key, 200)).slice(-1000) : [] };
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
 * before the next write. A crash during migration must never destroy the only
 * copy of every transcript.
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

function upsertThread(store: AgentStore, botId: string, kind: ThreadKind, sessionId: string): AgentThread {
  let thread = store.threads.find((item) => item.id === threadIdFor(botId));
  if (!thread) {
    thread = {
      id: threadIdFor(botId),
      kind,
      botId,
      sessionId,
      updatedAt: new Date(0).toISOString(),
      events: [],
    };
    store.threads.push(thread);
  }
  thread.kind = kind;
  if (sessionId && sessionId !== thread.sessionId) thread.sessionId = sessionId;
  return thread;
}

export function listThreadEvents(botId: string, path = agentStorePath()): AgentEvent[] {
  const thread = readAgentStore(path).threads.find((item) => item.id === threadIdFor(botId));
  return thread ? thread.events.slice() : [];
}

/**
 * Every widget id a stored thread event still names, across every thread, or
 * null when the store cannot be read.
 *
 * The sweep needs the whole set, not one bot's: a record is an orphan only
 * when nothing anywhere points at it. It also needs to know the difference
 * between "nothing references a widget" and "this file would not parse".
 * `readAgentStore` answers both with an empty store, and a sweep run on that
 * would delete every drawing on the machine. This is the same reason
 * `sweepOrphanState` reads the roster with `peekShell` rather than
 * `readShell`.
 */
export function referencedWidgetIds(path = agentStorePath()): Set<string> | null {
  // A store that is not there yet references nothing, which is true rather
  // than unknown: there are no threads, so there is nothing to keep.
  if (!existsSync(path)) return new Set();
  let store: AgentStore;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // `parseAgentStore` answers a wrong shape or a schema it does not know
    // with an empty store rather than throwing, on purpose: losing every
    // transcript over a forward-compatible field would be worse. Here that
    // same empty store would read as "nothing references a widget", so the
    // shape is checked before it is parsed.
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (rec.schemaVersion !== AGENT_SCHEMA) return null;
    // `threads: []` is a real empty store and every widget is then genuinely
    // an orphan. A missing or non-array `threads` is a file this build cannot
    // read, and `parseAgentStore` would answer it with the same empty list.
    if (!Array.isArray(rec.threads)) return null;
    store = parseAgentStore(raw);
  } catch {
    return null;
  }
  const ids = new Set<string>();
  for (const thread of store.threads) {
    for (const event of thread.events) {
      if (event.widgetId) ids.add(event.widgetId);
    }
  }
  return ids;
}

export function appendAgentEvent(
  botId: string,
  input: {
    kind: AgentEventKind;
    text: string;
    threadKind?: ThreadKind;
    sessionId?: string;
    authorBotId?: string | null;
    authorName?: string | null;
    targetBotIds?: string[];
    proposalId?: string | null;
    handoffId?: string | null;
    widgetId?: string | null;
    imageId?: string | null;
    connectedName?: string | null;
    connectedLogo?: string | null;
    id?: string;
  },
  path = agentStorePath(),
): AgentEvent {
  return withAgentStore((store) => {
    const thread = upsertThread(store, botId, input.threadKind ?? "bot", input.sessionId ?? "");
    const event: AgentEvent = {
      id: input.id ?? newEventId(),
      at: new Date().toISOString(),
      kind: input.kind,
      text: clip(input.text),
      authorBotId: input.authorBotId ?? null,
      authorName: input.authorName ? clip(input.authorName, 80) : null,
      targetBotIds: (input.targetBotIds ?? []).slice(0, 8),
      proposalId: input.proposalId ?? null,
      handoffId: input.handoffId ?? null,
      widgetId: input.widgetId ?? null,
      imageId: input.imageId ?? null,
      connectedName: input.connectedName ? clip(input.connectedName, 80) : null,
      connectedLogo: input.connectedLogo ?? null,
    };
    const existing = thread.events.findIndex((item) => item.id === event.id);
    if (existing >= 0) return thread.events[existing];
    // A handoff can be delivered more than once after a crash; the same side
    // of the same handoff must never land twice in one transcript.
    if (event.handoffId) {
      const duplicate = thread.events.find((item) => (
        item.handoffId === event.handoffId && item.kind === event.kind
      ));
      if (duplicate) return duplicate;
    }
    thread.events.push(event);
    if (thread.events.length > EVENT_CAP_PER_THREAD) {
      thread.events.splice(0, thread.events.length - EVENT_CAP_PER_THREAD);
    }
    thread.updatedAt = event.at;
    return event;
  }, path);
}

/** Refuse a card whose description is over its cap (see `descriptionWithin`). */
function assertProposalDescription(payload: ProposalPayload): void {
  const check = (text: string, max: number) => {
    if (text.trim().length > max) throw new Error("shell_description_too_long");
  };
  if (payload.kind === "createBot") check(payload.description, PROPOSE_DESCRIPTION_MAX);
  else if (payload.kind === "createGroup") check(payload.description, DESCRIPTION_MAX);
  else if (payload.kind === "updateBotProfile") {
    if (payload.patch.description !== undefined) check(payload.patch.description, DESCRIPTION_MAX);
  }
}

export function createProposal<P extends ProposalPayload>(
  payload: P,
  path = agentStorePath(),
): P & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status"> {
  type Stored = P & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status">;
  assertProposalDescription(payload);
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
 * Raise a profile card unless the target bot already has one waiting: one
 * pending profile proposal per bot. The check and the write share one lock, so
 * two concurrent calls cannot both land. Returns null when one is pending.
 */
export function createProfileProposalOnce(
  payload: ProfileProposal,
  path = agentStorePath(),
): (ProfileProposal & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status">) | null {
  type Stored = ProfileProposal & Pick<Proposal, "id" | "createdAt" | "expiresAt" | "status">;
  assertProposalDescription(payload);
  return withAgentStore((store) => {
    const now = Date.now();
    const waiting = store.proposals.some((item) => (
      item.kind === "updateBotProfile"
      && item.botId === payload.botId
      && item.status === "pending"
      && Date.parse(item.expiresAt) > now
    ));
    if (waiting) return null;
    const proposal = {
      ...payload,
      id: newProposalId(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      status: "pending",
    } as Stored;
    store.proposals.push(proposal);
    store.proposals = store.proposals.slice(-80);
    return proposal;
  }, path);
}

/** Working name for a bot that is still being onboarded, e.g. "New Bot 2". */
export function nextPetname(store: { bots: Array<{ name: string }> }): string {
  for (let index = 1; index <= 99; index += 1) {
    const candidate = `New Bot ${index}`;
    if (!store.bots.some((bot) => bot.name.toLowerCase() === candidate.toLowerCase())) return candidate;
  }
  return "New Bot";
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
 * send the same handoff twice. The model supplies the request id.
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

export function clearThread(botId: string, path = agentStorePath()): void {  withAgentStore((store) => {
    const thread = store.threads.find((item) => item.id === threadIdFor(botId));
    if (thread) {
      thread.events = [];
      thread.sessionId = "";
      thread.updatedAt = new Date().toISOString();
    }
  }, path);
}

/**
 * Drop a deleted bot's thread outright. `clearThread` is for a bot that stays:
 * it empties the log and keeps the row. Nothing ever reads the row of a bot
 * that no longer exists, so leaving one behind only grows the file.
 */
export function deleteThread(botId: string, path = agentStorePath()): boolean {
  return withAgentStore((store) => {
    const id = threadIdFor(botId);
    const before = store.threads.length;
    // Keyed on `id`, like every other lookup here. `sweepOrphanThreads` keeps a
    // row when either field is live, and the asymmetry is on purpose: in a
    // hand-edited store where the two diverge, `{id: live, botId: deleted}` is
    // operationally the live bot's thread, so deleting the other bot must not
    // take it. A row both of whose bots are gone is the sweep's to collect.
    store.threads = store.threads.filter((item) => item.id !== id);
    return store.threads.length !== before;
  }, path);
}

/**
 * Drop every thread whose bot is gone from the roster. Same reason as
 * `sweepOrphanRoutines`: the roster and this store have separate locks, so a
 * delete that fails between them would otherwise leave the transcript behind
 * for good, and the delete dialog promises it is gone.
 */
export function sweepOrphanThreads(liveBotIds: Iterable<string>, path = agentStorePath()): string[] {
  const live = new Set<string>();
  for (const botId of liveBotIds) {
    live.add(botId);
    live.add(threadIdFor(botId));
  }
  // An empty roster reads as a failed shell load, not as an empty app.
  if (live.size === 0) return [];
  // Either field is enough, which is looser than `deleteThread` on purpose: a
  // sweep deletes rows nobody asked it to, so it errs towards keeping, and a
  // hand-edited row that still names one live bot is not an orphan.
  const owned = (thread: AgentThread) => live.has(thread.id) || live.has(thread.botId);
  return withAgentStore((store) => {
    const orphans = store.threads.filter((thread) => !owned(thread));
    if (orphans.length === 0) return [];
    store.threads = store.threads.filter(owned);
    return orphans.map((thread) => thread.id);
  }, path);
}

export function threadSnapshot(botId: string, path = agentStorePath()): {
  events: AgentEvent[];
  proposals: Proposal[];
} {
  const store = readAgentStore(path);
  const thread = store.threads.find((item) => item.id === threadIdFor(botId));
  const now = Date.now();
  return {
    events: thread ? thread.events.slice() : [],
    proposals: store.proposals.filter((item) => (
      item.threadId === threadIdFor(botId)
      && item.status === "pending"
      && Date.parse(item.expiresAt) > now
    )),
  };
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
import { statePath } from "../../shared/stack.ts";
import { POLICY_APPROVAL_TTL_MS } from "../../shared/policy.ts";
import { authoritySessionId, isBotContextMissing, type ActiveBotContext } from "./active-bot.ts";

/**
 * One boot epoch per process. Records carry the epoch that requested them, and
 * consume rejects any other epoch, so an approval that was granted but not yet
 * used when the agent restarted cannot be replayed after the restart. The UI
 * process only decides; it never consumes, so its different epoch is harmless.
 */
const BOOT_EPOCH = randomUUID();
const LOCK_TIMEOUT_MS = 5000;
/**
 * Settled records are pruned once they are this far past their own expiry, so
 * the file stays bounded while a card that was just decided is still visible
 * to a slow poll.
 */
const PRUNE_GRACE_MS = 60 * 60 * 1000;
/**
 * A crashed holder must be reclaimable well before the acquire deadline, or
 * every caller blocks for the difference and then throws. Stale stays under the
 * timeout so a reclaim plus a retry still fits inside it.
 */
const LOCK_STALE_MS = 2000;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

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

/**
 * Every tool whose action the owner has to approve before it runs. Deleting a
 * bot or a routine is irreversible, so an agent asks here rather than writing.
 */
export type ApprovalTool =
  | "bash"
  | "write_file"
  | "memory.upsert"
  | "memory.delete"
  | "delete_bot"
  | "remove_section"
  | "clear_history"
  | "delete_routine"
  | "create_routine"
  | "update_routine"
  | "connector"
  // One tool of a connected MCP server, run by this app rather than by eve:
  // the tools it mounts on demand are its own to gate.
  | "connection"
  | "install_cli";
export type ApprovalDecision = "approve" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface ApprovalAction {
  tool: ApprovalTool;
  canonicalArgs: string;
  cwd: string;
  targetRevision: string | null;
  backend: string;
  toolVersion: string;
}

export interface StoredApproval {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  tool: ApprovalTool;
  actionSha256: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** Boot epoch of the process that requested the action. */
  epoch?: string;
  /** For a sub-agent's card: the root session whose chat the card belongs to. */
  rootSessionId?: string;
  /** True when a sub-agent's child session raised the card. */
  subagent?: boolean;
}

export type PendingApproval = Pick<
  StoredApproval,
  "id" | "tool" | "preview" | "actionSha256" | "createdAt" | "expiresAt" | "sessionId" | "rootSessionId" | "subagent"
>;

/** The subset of an eve ToolContext an approval record needs for attribution. */
export type ApprovalActorContext = ActiveBotContext & {
  session?: { turn?: { id?: string } };
  callId?: string;
};

/**
 * Who a card is for. A sub-agent's child (eve's `ctx.session.parent`) raises
 * the card from its own session, and the record also names its root session,
 * the chat the card belongs to, and says a sub-agent raised it. A child that
 * cannot be verified keeps its own session as the root (the card still shows,
 * marked as a sub-agent's).
 */
export function approvalActor(ctx?: ApprovalActorContext): {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  rootSessionId?: string;
  subagent?: true;
} {
  const actor = {
    sessionId: ctx?.session?.id ?? "live",
    turnId: ctx?.session?.turn?.id ?? "live",
    toolCallId: ctx?.callId ?? "live",
  };
  if (!ctx?.session?.parent) return actor;
  let rootSessionId = actor.sessionId;
  try {
    rootSessionId = authoritySessionId(ctx) ?? actor.sessionId;
  } catch (err) {
    if (!isBotContextMissing(err)) throw err;
  }
  return { ...actor, rootSessionId, subagent: true };
}

export function defaultApprovalsPath(): string {
  if (process.env.UB_APPROVALS_PATH) return process.env.UB_APPROVALS_PATH;
  return statePath("approvals.json");
}

/**
 * Cross-process lock for a read/merge/write cycle. Both the Next server and the
 * eve agent process hold their own ApprovalStore, and every persist writes the
 * whole record map, so an unlocked load/mutate/save can drop the other writer's
 * decision. The directory lock keeps one writer at a time.
 */
function withFileLock<T>(lockPath: string | null, fn: () => T): T {
  if (!lockPath) return fn();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmdirSync(lockPath);
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) break;
      sleep(15);
    }
  }
  if (!held) throw new Error("approvals_locked");
  try {
    return fn();
  } finally {
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function actionSha256(action: ApprovalAction): string {
  const payload = JSON.stringify({
    tool: action.tool,
    canonicalArgs: action.canonicalArgs,
    cwd: action.cwd,
    targetRevision: action.targetRevision,
    backend: action.backend,
    toolVersion: action.toolVersion,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export class ApprovalStore {
  readonly records = new Map<string, StoredApproval>();
  private seq = 0;
  private readonly now: () => number;
  private readonly persistPath: string | null;
  private readonly epoch: string;

  constructor(
    now: () => number = Date.now,
    persistPath: string | null = null,
    epoch: string = BOOT_EPOCH,
  ) {
    this.now = now;
    this.persistPath = persistPath;
    this.epoch = epoch;
    this.load();
  }

  private locked<T>(fn: () => T): T {
    return withFileLock(this.persistPath ? `${this.persistPath}.lock` : null, fn);
  }

  request(input: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    tool: ApprovalTool;
    actionSha256: string;
    preview: string;
    rootSessionId?: string;
    subagent?: boolean;
  }): StoredApproval {
    return this.locked(() => {
      this.load();
      this.seq += 1;
      const createdAt = this.now();
      const record: StoredApproval = {
        id: this.persistPath
          ? `apr_${randomUUID().replaceAll("-", "").slice(0, 16)}`
          : `apr_${this.seq.toString().padStart(4, "0")}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        tool: input.tool,
        actionSha256: input.actionSha256,
        preview: input.preview,
        createdAt,
        expiresAt: createdAt + POLICY_APPROVAL_TTL_MS,
        status: "pending",
        epoch: this.epoch,
        ...(input.subagent ? { rootSessionId: input.rootSessionId ?? input.sessionId, subagent: true } : {}),
      };
      this.records.set(record.id, record);
      this.persist();
      return record;
    });
  }

  decide(id: string, decision: ApprovalDecision, presentedHash: string): StoredApproval {
    return this.locked(() => {
      this.load();
      const record = this.records.get(id);
      if (!record) {
        throw new Error(`approval_not_found:${id}`);
      }
      this.refreshExpiry(record);
      if (record.status !== "pending") {
        throw new Error(`approval_not_pending:${record.status}`);
      }
      if (!hashesEqual(record.actionSha256, presentedHash)) {
        throw new Error("approval_hash_mismatch");
      }
      record.status = decision === "approve" ? "approved" : "denied";
      this.persist();
      return record;
    });
  }

  consume(id: string, presentedHash: string): StoredApproval {
    return this.locked(() => {
      this.load();
      const record = this.records.get(id);
      if (!record) {
        throw new Error(`approval_not_found:${id}`);
      }
      this.refreshExpiry(record);
      if (!hashesEqual(record.actionSha256, presentedHash)) {
        throw new Error("approval_hash_mismatch");
      }
      if (record.status === "consumed") {
        throw new Error("approval_replay");
      }
      if (record.status === "denied") {
        throw new Error("approval_denied");
      }
      if (record.status === "expired") {
        throw new Error("approval_expired");
      }
      if (record.status !== "approved") {
        throw new Error(`approval_not_approved:${record.status}`);
      }
      // A record from a previous process boot is not valid after a restart.
      if (record.epoch !== this.epoch) {
        record.status = "expired";
        this.persist();
        throw new Error("approval_expired");
      }
      record.status = "consumed";
      this.persist();
      return record;
    });
  }

  get(id: string): StoredApproval | undefined {
    return this.locked(() => {
      this.load();
      const record = this.records.get(id);
      if (!record) return undefined;
      const before = record.status;
      this.refreshExpiry(record);
      if (record.status !== before) this.persist();
      return record;
    });
  }

  listPending(): PendingApproval[] {
    return this.locked(() => {
      this.load();
      let changed = false;
      const out: PendingApproval[] = [];
      for (const record of this.records.values()) {
        const before = record.status;
        this.refreshExpiry(record);
        if (record.status !== before) changed = true;
        if (record.status === "pending") {
          out.push({
            id: record.id,
            tool: record.tool,
            preview: record.preview,
            actionSha256: record.actionSha256,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            sessionId: record.sessionId,
            ...(record.subagent ? { rootSessionId: record.rootSessionId, subagent: true } : {}),
          });
        }
      }
      if (changed) this.persist();
      out.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      return out;
    });
  }

  /**
   * A stopped session can no longer act on its cards: retire them now, the
   * pending ones and the approved ones not yet consumed (an approval granted
   * just before Stop must not run after it). A consumed card has already run.
   * A root's cancel also retires its sub-agents' cards unless `children: false`
   * is passed (the app's automatic cancel of a stopped-report turn).
   */
  expireSession(sessionId: string, options: { children?: boolean } = {}): number {
    // Fail closed by default: an owner's Stop on a root also retires the cards
    // of its sub-agents, so a child whose own cancel never landed cannot act on
    // an approval granted before the Stop. Only the app's automatic cancel of a
    // stopped-report turn passes children: false, since it must not expire the
    // cards of sub-agents the owner did not stop.
    const children = options.children ?? true;
    return this.locked(() => {
      this.load();
      let expired = 0;
      for (const record of this.records.values()) {
        const inScope = record.sessionId === sessionId || (children && record.rootSessionId === sessionId);
        if ((record.status === "pending" || record.status === "approved") && inScope) {
          record.status = "expired";
          expired += 1;
        }
      }
      if (expired) this.persist();
      return expired;
    });
  }

  invalidateOnRestart(): void {
    this.locked(() => {
      this.load();
      for (const record of this.records.values()) {
        if (record.status === "pending" || record.status === "approved") {
          record.status = "expired";
        }
      }
      this.persist();
    });
  }

  private refreshExpiry(record: StoredApproval): void {
    if (record.status === "pending" && this.now() >= record.expiresAt) {
      record.status = "expired";
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    this.records.clear();
    if (!existsSync(this.persistPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as { records?: StoredApproval[] };
      const rows = Array.isArray(parsed.records) ? parsed.records : [];
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || typeof row.actionSha256 !== "string") continue;
        this.records.set(row.id, row);
      }
    } catch {
      this.records.clear();
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    // Nothing consumes a settled record, so dropping the ones past the grace
    // window here keeps every write path from rewriting an unbounded file.
    const cutoff = this.now() - POLICY_APPROVAL_TTL_MS - PRUNE_GRACE_MS;
    for (const [id, record] of this.records) {
      if (record.status !== "pending" && record.expiresAt < cutoff) this.records.delete(id);
    }
    mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({ records: [...this.records.values()] })}\n`;
    try {
      writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const fd = openSync(tmp, "r");
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, this.persistPath);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }
}

export async function waitUntilNotPending(
  store: ApprovalStore,
  id: string,
  timeoutMs = POLICY_APPROVAL_TTL_MS,
  intervalMs = 250,
): Promise<StoredApproval> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readWhileWaiting(store, id);
    // A transient lock timeout is not a decision; keep waiting instead of
    // treating it as a missing approval or aborting the wait.
    if (record === "locked") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (!record) throw new Error(`approval_not_found:${id}`);
    if (record.status !== "pending") return record;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const expired = readWhileWaiting(store, id);
  if (expired === "locked") throw new Error("approval_expired");
  if (expired && expired.status !== "pending") return expired;
  throw new Error("approval_expired");
}

function readWhileWaiting(store: ApprovalStore, id: string): StoredApproval | undefined | "locked" {
  try {
    return store.get(id);
  } catch (error) {
    if ((error as Error).message === "approvals_locked") return "locked";
    throw error;
  }
}

export async function executeIfApproved<T>(
  store: ApprovalStore,
  id: string,
  presentedHash: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  store.consume(id, presentedHash);
  return await fn();
}

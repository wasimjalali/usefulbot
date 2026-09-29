import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadKind } from "./agent-store.ts";

/**
 * Durable bot-to-bot delivery queue. A handoff is written by the sending agent
 * tool and delivered later by the web server, so a send never blocks the
 * sender's turn. One JSON file per record: writers only create files, the
 * consumer only rewrites or deletes them, so concurrent processes cannot
 * clobber a shared document.
 */

export const HANDOFF_SCHEMA = 1;
export const HANDOFF_ATTEMPTS_MAX = 3;
export const HANDOFF_TEXT_MAX = 4000;
export const HANDOFF_LIST_MAX = 50;
/** Refuse a bot-to-bot chain past this many hops; A to B to A cannot ping-pong. */
export const HANDOFF_DEPTH_MAX = 3;
/** Delivered records are pruned after this; failed ones keep longer. */
const HANDOFF_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** Longer than the 120s deliver timeout, so a crashed claim can be retried. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

export type HandoffStatus = "pending" | "delivered" | "failed";

export type HandoffRecord = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceBotId: string;
  sourceName: string;
  targetBotId: string;
  targetName: string;
  /** Set when the reply belongs in a shared room instead of the target 1:1. */
  groupId: string | null;
  groupName: string | null;
  threadKind: ThreadKind;
  message: string;
  status: HandoffStatus;
  attempts: number;
  lastError: string;
  response: string;
  /** Hops from the owner's turn: 0 for an owner-triggered handoff. */
  depth: number;
};

export type HandoffDraft = Pick<
  HandoffRecord,
  "sourceBotId" | "sourceName" | "targetBotId" | "targetName" | "message"
> & {
  groupId?: string | null;
  groupName?: string | null;
  threadKind?: ThreadKind;
  depth?: number;
};

export function handoffDir(): string {
  if (process.env.UB_HANDOFF_DIR) return process.env.UB_HANDOFF_DIR;
  return join(homedir(), ".useful-bot", "handoffs");
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isId(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function newHandoffId(): string {
  return `hnd_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function parseHandoff(raw: unknown): HandoffRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== HANDOFF_SCHEMA) return null;
  if (!isId(rec.id, 120)) return null;
  if (!isId(rec.targetBotId) || !isId(rec.sourceBotId)) return null;
  const status: HandoffStatus = rec.status === "delivered" || rec.status === "failed"
    ? rec.status
    : "pending";
  return {
    schemaVersion: 1,
    id: rec.id,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date(0).toISOString(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date(0).toISOString(),
    sourceBotId: rec.sourceBotId,
    sourceName: clip(rec.sourceName, 80),
    targetBotId: rec.targetBotId,
    targetName: clip(rec.targetName, 80),
    groupId: isId(rec.groupId) ? rec.groupId : null,
    groupName: clip(rec.groupName, 80) || null,
    threadKind: rec.threadKind === "group" ? "group" : "bot",
    message: clip(rec.message, HANDOFF_TEXT_MAX),
    status,
    attempts: typeof rec.attempts === "number" && Number.isInteger(rec.attempts) && rec.attempts >= 0
      ? Math.min(rec.attempts, 20)
      : 0,
    lastError: clip(rec.lastError, 300),
    response: clip(rec.response, 8000),
    depth: typeof rec.depth === "number" && Number.isInteger(rec.depth) && rec.depth >= 0
      ? Math.min(rec.depth, 100)
      : 0,
  };
}

function handoffPath(id: string, dir = handoffDir()): string {
  return join(dir, `${id}.json`);
}

function claimPath(id: string, dir = handoffDir()): string {
  return join(dir, `${id}.claim`);
}

function readClaim(id: string, dir: string): { at: number; token: string } | null {
  try {
    const info = JSON.parse(readFileSync(claimPath(id, dir), "utf8")) as {
      at?: unknown;
      token?: unknown;
    };
    if (typeof info.at !== "number" || typeof info.token !== "string") return null;
    return { at: info.at, token: info.token };
  } catch {
    return null;
  }
}

/**
 * Cross-process delivery claim. O_EXCL creation means exactly one process can
 * hold a record; a claim older than the stale window (process died
 * mid-delivery) is taken over so the record is not stranded. The returned
 * token proves ownership later, so a stale-takeover cannot let the old holder
 * write a second transcript entry.
 */
export function claimHandoff(id: string, dir = handoffDir()): string | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = claimPath(id, dir);
  const stamp = Date.now();
  const token = crypto.randomUUID();
  const create = () => {
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: stamp, token })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return token;
    } catch {
      return null;
    }
  };
  const first = create();
  if (first) return first;
  const current = readClaim(id, dir);
  if (current && stamp - current.at <= CLAIM_STALE_MS) return null;
  // The stale read above is a snapshot, not a lock: read, unlink, create is
  // not atomic, so a live claim another process wrote after the read would be
  // unlinked and stolen. Re-read immediately before deleting and abort when
  // the file no longer holds the claim that was read.
  // A claim that vanished between the reads (released or pruned) is free,
  // so only a file holding a different token stops the takeover.
  const latest = readClaim(id, dir);
  if (latest && latest.token !== current?.token) return null;
  try { unlinkSync(path); } catch { /* ignore */ }
  return create();
}

export function ownsHandoffClaim(id: string, token: string, dir = handoffDir()): boolean {
  const current = readClaim(id, dir);
  return Boolean(current && current.token === token);
}

export function releaseHandoffClaim(id: string, token = "", dir = handoffDir()): void {
  if (token) {
    const current = readClaim(id, dir);
    if (current && current.token !== token) return;
  }
  try { unlinkSync(claimPath(id, dir)); } catch { /* ignore */ }
}

/** Keep the queue directory bounded: old delivered and failed records go. */
function pruneHandoffs(dir: string): void {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - HANDOFF_KEEP_MS;
  for (const name of readdirSync(dir)) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!id) {
      if (name.endsWith(".claim")) {
        // A claim older than the takeover window is already considered dead,
        // so it can go immediately rather than waiting for the record cutoff.
        try {
          const info = JSON.parse(readFileSync(join(dir, name), "utf8")) as { at?: unknown };
          if (typeof info.at === "number" && Date.now() - info.at > CLAIM_STALE_MS) unlinkSync(join(dir, name));
        } catch {
          try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
        }
      }
      continue;
    }
    const record = readHandoff(id, dir);
    if (!record || record.status === "pending") continue;
    if (Date.parse(record.updatedAt) < cutoff) dropHandoff(id, dir);
  }
}

export function writeHandoff(record: HandoffRecord, dir = handoffDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = handoffPath(record.id, dir);
  const tmp = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function queueHandoff(input: HandoffDraft, dir = handoffDir()): HandoffRecord {
  const now = new Date().toISOString();
  const record: HandoffRecord = {
    schemaVersion: 1,
    id: newHandoffId(),
    createdAt: now,
    updatedAt: now,
    sourceBotId: input.sourceBotId,
    sourceName: clip(input.sourceName, 80),
    targetBotId: input.targetBotId,
    targetName: clip(input.targetName, 80),
    groupId: input.groupId ?? null,
    groupName: input.groupName ? clip(input.groupName, 80) : null,
    threadKind: input.threadKind ?? "bot",
    message: clip(input.message, HANDOFF_TEXT_MAX),
    status: "pending",
    attempts: 0,
    lastError: "",
    response: "",
    depth: typeof input.depth === "number" && Number.isInteger(input.depth) && input.depth >= 0
      ? Math.min(input.depth, 100)
      : 0,
  };
  writeHandoff(record, dir);
  try { pruneHandoffs(dir); } catch { /* pruning is best effort */ }
  return record;
}

export function readHandoff(id: string, dir = handoffDir()): HandoffRecord | null {
  const path = handoffPath(id, dir);
  if (!existsSync(path)) return null;
  try {
    return parseHandoff(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function listHandoffs(dir = handoffDir()): HandoffRecord[] {
  if (!existsSync(dir)) return [];
  const rows: HandoffRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readHandoff(name.slice(0, -5), dir);
    if (record) rows.push(record);
  }
  rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return rows;
}

/** Oldest first, so a fan-out is delivered in the order the owner confirmed. */
export function listDeliverable(dir = handoffDir()): HandoffRecord[] {
  // markFailed keeps a retryable record pending until it is terminal, so only
  // pending records are ever deliverable.
  return listHandoffs(dir)
    .filter((record) => record.status === "pending")
    .slice(0, HANDOFF_LIST_MAX);
}

export function markDelivered(
  id: string,
  response: string,
  dir = handoffDir(),
  claimToken = "",
): HandoffRecord | null {
  if (claimToken && !ownsHandoffClaim(id, claimToken, dir)) return null;
  const record = readHandoff(id, dir);
  if (!record) return null;
  const next: HandoffRecord = {
    ...record,
    status: "delivered",
    attempts: record.attempts + 1,
    lastError: "",
    response: clip(response, 8000),
    updatedAt: new Date().toISOString(),
  };
  writeHandoff(next, dir);
  releaseHandoffClaim(id, claimToken, dir);
  return next;
}

export function markFailed(
  id: string,
  error: string,
  dir = handoffDir(),
  claimToken = "",
): HandoffRecord | null {
  if (claimToken && !ownsHandoffClaim(id, claimToken, dir)) return null;
  const record = readHandoff(id, dir);
  if (!record) return null;
  const attempts = record.attempts + 1;
  const next: HandoffRecord = {
    ...record,
    status: attempts >= HANDOFF_ATTEMPTS_MAX ? "failed" : "pending",
    attempts,
    lastError: clip(error, 300),
    updatedAt: new Date().toISOString(),
  };
  writeHandoff(next, dir);
  releaseHandoffClaim(id, claimToken, dir);
  return next;
}

export function dropHandoff(id: string, dir = handoffDir()): void {
  rmSync(handoffPath(id, dir), { force: true });
  releaseHandoffClaim(id, "", dir);
}

/**
 * True if adding source→target would close a wait-cycle in the pending
 * queue (A waits on B waits on C waits on A). Direct A↔B is the common case.
 */
export function pendingHandoffCycle(
  sourceId: string,
  targetId: string,
  skipId = "",
  dir = handoffDir(),
): boolean {
  const pending = listHandoffs(dir).filter((item) => item.status === "pending" && item.id !== skipId)
  const outgoing = new Map<string, string[]>()
  for (const item of pending) {
    const list = outgoing.get(item.sourceBotId) ?? []
    list.push(item.targetBotId)
    outgoing.set(item.sourceBotId, list)
  }
  const seen = new Set<string>()
  const stack = [targetId]
  while (stack.length) {
    const current = stack.pop() as string
    if (current === sourceId) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of outgoing.get(current) ?? []) stack.push(next)
  }
  return false
}

/**
 * Wait until a queued handoff is delivered or fails, or until the timeout.
 * The sending tool uses this so the teammate's reply comes back as tool
 * output instead of dying in the receiver's chat. A timeout returns the
 * last snapshot (still pending) rather than throwing: the pump keeps
 * working and both transcripts still get the reply.
 */
export async function waitForHandoff(
  id: string,
  timeoutMs: number,
  dir = handoffDir(),
  intervalMs = 250,
  signal?: AbortSignal,
): Promise<HandoffRecord | null> {
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const step = Number.isFinite(intervalMs) ? Math.max(10, intervalMs) : 250;
  const start = Date.now();
  let latest = readHandoff(id, dir);
  while (Date.now() - start < budget) {
    // A cancelled turn has nobody left to hand the reply to. The pump still
    // delivers it to both transcripts; only this poll stops.
    if (signal?.aborted) return latest;
    latest = readHandoff(id, dir);
    if (!latest || latest.status === "delivered" || latest.status === "failed") return latest;
    await sleep(step, signal);
  }
  return readHandoff(id, dir);
}

/** setTimeout that gives up early when the turn is cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

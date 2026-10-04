import { readFileSync } from "node:fs";
import { defaultSessionOwnersPath, parseSessionOwners } from "../../shared/session-bindings.ts";
import { isBotContextMissing, subAgentRoot, type ActiveBotContext } from "./active-bot.ts";
import { turnSnapshot } from "./turn-snapshot.ts";

/** The slice of an eve tool or policy context the marker needs. */
export type OutsideCtx = ActiveBotContext & { session?: { id?: string; turn?: { id?: string } } };

/**
 * Whether this turn has read content the owner did not write: a web page, a
 * connected app's answer, a file, a command's output, or another bot's handoff.
 * A note the model writes after that is stored as
 * `model-after-outside-content`, so Settings can show it and the owner can
 * delete it in one click. The marker is per session and turn and lives in this
 * process only: a restart mid-turn forgets it, and the next turn starts clean.
 * Notes saved before this mark existed carry source "model", whatever they were
 * written from.
 *
 * A sub-agent's child marks its root session too, for any turn: eve hands the
 * child's report to the root in a turn of its own, possibly a later one, and
 * the report carries what the child read. That mark fails closed. It is
 * cleared only by an owner-delivered turn, after a report turn has been seen
 * since the last mark and with no child of that root started after that
 * report (`clearRootOutside`); anything that cannot be read keeps it.
 */
const REGISTRY_KEY = Symbol.for("useful-bot.outside-content");
const CAP = 256;
/** Same alphabet as the session store's ids. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

function seen(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (holder[REGISTRY_KEY] ??= new Set());
}

function keyOf(ctx: OutsideCtx | undefined): string | null {
  const sessionId = ctx?.session?.id;
  if (!sessionId) return null;
  return `${sessionId}\u0000${ctx?.session?.turn?.id ?? ""}`;
}

function add(key: string): void {
  const set = seen();
  set.delete(key);
  set.add(key);
  if (set.size > CAP) set.delete(set.values().next().value as string);
}

/** What a sub-agent's reading left on its root session, for any turn of it. */
type RootMark = { markedAt: number; reportAt: number | null };
const ROOTS_KEY = Symbol.for("useful-bot.outside-content.roots");

function roots(): Map<string, RootMark> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RootMark> | undefined>;
  return (holder[ROOTS_KEY] ??= new Map());
}

/**
 * Record that this turn read outside content. A call with no session (a test)
 * is ignored. A verified sub-agent's child marks its root session as well.
 */
export function markOutside(ctx: OutsideCtx | undefined): void {
  const key = keyOf(ctx);
  if (!key) return;
  add(key);
  const parent = ctx?.session?.parent;
  if (!parent) return;
  let rootSessionId: string | null = null;
  try {
    rootSessionId = subAgentRoot(ctx)?.rootSessionId ?? null;
  } catch (err) {
    if (!isBotContextMissing(err)) throw err;
    // Fail closed: a child that cannot be verified still names a root, and what
    // it read must taint that root whatever it claims.
    const claimed = typeof parent === "object" && !Array.isArray(parent) ? (parent as { rootSessionId?: unknown }).rootSessionId : undefined;
    if (typeof claimed === "string" && SESSION_ID.test(claimed)) rootSessionId = claimed;
  }
  if (!rootSessionId) return;
  const marks = roots();
  marks.delete(rootSessionId);
  marks.set(rootSessionId, { markedAt: Date.now(), reportAt: null });
  if (marks.size > CAP) marks.delete(marks.keys().next().value as string);
}

/** The root session started a turn on a sub-agent's report: that reading has now been delivered. */
export function noteRootReport(sessionId: string, now = Date.now()): void {
  const mark = roots().get(sessionId);
  if (mark) mark.reportAt = now;
}

/**
 * A positively owner-delivered turn starts clean of a sub-agent's reading, but
 * only once a report turn was seen since the last mark and no child of this
 * root was recorded after that report (a later child would bring its own
 * reading). It cannot tell which earlier child a report belongs to: a report
 * names a task, not a session, and eve batches reports, so "every recorded
 * child has reported" is not knowable here. A child recorded before the report
 * is therefore taken as reported. An unreadable binding store keeps the mark.
 * Returns whether it cleared.
 */
export function clearRootOutside(sessionId: string): boolean {
  const mark = roots().get(sessionId);
  if (!mark) return false;
  if (mark.reportAt === null || mark.reportAt < mark.markedAt) return false;
  const reportAt = mark.reportAt;
  // The strict read: the lenient one shows a bad file as no children at all.
  let sessions;
  try {
    sessions = parseSessionOwners(JSON.parse(readFileSync(defaultSessionOwnersPath(), "utf8"))).sessions;
  } catch (err) {
    console.error("[outside-content] children could not be read; the sub-agent mark stays", err instanceof Error ? err.message : err);
    return false;
  }
  for (const row of Object.values(sessions)) {
    if (row.parentId === sessionId && !(Date.parse(row.createdAt) <= reportAt)) return false;
  }
  roots().delete(sessionId);
  return true;
}

/** True once a tool marked the turn, or when the turn is a handoff (the snapshot says so). */
export function seenOutside(ctx: OutsideCtx | undefined): boolean {
  const key = keyOf(ctx);
  if (!key) return false;
  const sessionId = ctx?.session?.id as string;
  if (seen().has(key) || roots().has(sessionId)) return true;
  const snapshot = turnSnapshot(sessionId, ctx?.session?.turn?.id);
  return snapshot?.status === "ok" && snapshot.outside;
}

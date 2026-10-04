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

/**
 * Routines: recurring instructions one bot runs on a schedule. Both the Next
 * server (owner actions, the tick scheduler) and the eve agent process (agent
 * tools) write here, so every mutation is a locked read/merge/write onto one
 * atomically replaced JSON document.
 *
 * Schedules are wall-clock in an IANA zone, not fixed offsets: "every Monday
 * at 09:00" has to stay 09:00 across a DST change.
 */

export const ROUTINES_SCHEMA = 1;
export const ROUTINES_PER_BOT_MAX = 50;
export const RUN_HISTORY_MAX = 20;
export const SCHEDULES_MAX = 10;
const NAME_MAX = 80;
const INSTRUCTION_MAX = 4000;
const ERROR_MAX = 300;
/**
 * Stale must stay below timeout: a waiter that gives up before it is allowed
 * to clear a dead lock turns one crashed process into a store nobody can write
 * to for the whole stale window. That inversion (4s wait, 15s stale) is what
 * these two used to have.
 *
 * The gap between them is the margin a live holder gets. Every critical
 * section here is synchronous and small, but it ends in an fsync, and a loaded
 * disk can make that take longer than it reads on paper. Three seconds is far
 * past any healthy write and still well inside the eight a waiter will sit for.
 */
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 3000;
/** How far ahead a weekly search has to look to find the next matching day. */
const SEARCH_DAYS = 8;

export type RoutineSchedule =
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "daily"; time: string }
  | { kind: "once"; date: string; time: string };

export type RoutineRunStatus = "ok" | "failed";

export type RoutineRun = {
  at: string;
  status: RoutineRunStatus;
  sessionId: string | null;
  error: string;
};

export type Routine = {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  schedules: RoutineSchedule[];
  /** IANA zone the wall-clock times are read in. */
  timezone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  runHistory: RoutineRun[];
  /**
   * An out-of-band run the owner asked for through an agent tool. The tool has
   * no desktop session, so it cannot reach the run route; it raises this flag
   * and the next tick picks it up. A manual run never consumes the scheduled
   * slot, so `lastRunAt` is left alone.
   */
  manualRunRequested: boolean;
  /**
   * Fields a newer build wrote that this one does not model. They ride through
   * every read/write untouched, so running an older app for one session does
   * not quietly strip a routine down to the keys it happens to understand.
   */
  extra?: Record<string, unknown>;
};

export type RoutinesStore = {
  schemaVersion: 1;
  routines: Routine[];
  /** Document-level counterpart of `Routine.extra`. */
  extra?: Record<string, unknown>;
};

export type RoutineDraft = {
  botId: string;
  name: string;
  instruction: string;
  schedules?: unknown;
  timezone?: unknown;
  active?: unknown;
};

export type RoutinePatch = {
  name?: unknown;
  instruction?: unknown;
  schedules?: unknown;
  timezone?: unknown;
  active?: unknown;
};

export function routinesStorePath(): string {
  if (process.env.UB_ROUTINES_PATH) return process.env.UB_ROUTINES_PATH;
  return statePath("routines.json");
}

export function newRoutineId(): string {
  return `rtn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Keys this build models; everything else on a routine is carried in `extra`. */
const ROUTINE_KEYS = new Set([
  "id",
  "botId",
  "name",
  "instruction",
  "schedules",
  "timezone",
  "active",
  "createdAt",
  "updatedAt",
  "lastRunAt",
  "runHistory",
  "manualRunRequested",
]);

const STORE_KEYS = new Set(["schemaVersion", "routines"]);

/**
 * Unknown keys off one decoded object. An `extra` already on the record is
 * merged rather than nested, so re-parsing a value this module produced is
 * idempotent.
 */
function collectExtra(rec: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const carried = rec.extra;
  if (carried && typeof carried === "object" && !Array.isArray(carried)) {
    for (const [key, value] of Object.entries(carried as Record<string, unknown>)) {
      // A modelled key smuggled in here would be dropped on the next write
      // without a word, since `plainRoutine` spreads extras first and then
      // overwrites them. Refusing it keeps that silent loss impossible.
      if (known.has(key)) continue;
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    if (key === "extra" || known.has(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The on-disk shape of one routine: carried keys first, modelled keys win. */
function plainRoutine(routine: Routine): Record<string, unknown> {
  return {
    ...(routine.extra ?? {}),
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    instruction: routine.instruction,
    schedules: routine.schedules,
    timezone: routine.timezone,
    active: routine.active,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
    lastRunAt: routine.lastRunAt,
    runHistory: routine.runHistory,
    manualRunRequested: routine.manualRunRequested,
  };
}

/** The on-disk shape of the whole document. */
function plainRoutinesStore(store: RoutinesStore): Record<string, unknown> {
  return {
    ...(store.extra ?? {}),
    schemaVersion: ROUTINES_SCHEMA,
    routines: store.routines.map(plainRoutine),
  };
}

function isId(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function emptyStore(): RoutinesStore {
  return { schemaVersion: 1, routines: [] };
}

// MARK: - Time zones

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function hostTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(zone) ? zone : "UTC";
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zoneParts(at: Date, timeZone: string): ZoneParts {
  const parts = zoneFormatter(timeZone).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Zone offset at an instant, in ms east of UTC. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = zoneParts(at, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function wallMatches(at: Date, timeZone: string, y: number, m: number, d: number, hh: number, mm: number): boolean {
  const parts = zoneParts(at, timeZone);
  return parts.year === y && parts.month === m && parts.day === d && parts.hour === hh && parts.minute === mm;
}

/**
 * The UTC instant for a wall-clock time in a zone.
 *
 * A DST fall-back makes a wall time happen twice; the earlier instant wins so
 * a routine never runs an hour late. A spring-forward makes it not happen at
 * all; the routine then fires at the shifted instant instead of being skipped.
 */
export function zonedWallToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = target - zoneOffsetMs(new Date(target), timeZone);
  const candidates = new Set<number>([
    first,
    target - zoneOffsetMs(new Date(first), timeZone),
    // A shift in the other direction moves the instant across the transition,
    // so the offset a day earlier finds the occurrence the other two miss.
    target - zoneOffsetMs(new Date(target - 86_400_000), timeZone),
  ]);
  const valid = [...candidates].filter((ms) => wallMatches(new Date(ms), timeZone, y, m, d, hh, mm));
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(Math.max(...candidates));
}

// MARK: - Schedules

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The shape check above still passes 2026-02-31, and `Date.UTC` would roll it
 * forward to 3 March and fire the routine on a day the owner never picked. A
 * real civil date is the one that round-trips through the calendar unchanged.
 */
function parseCivilDate(value: string): { year: number; month: number; day: number } | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function parseSchedule(raw: unknown): RoutineSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const time = typeof rec.time === "string" ? rec.time.trim() : "";
  if (!TIME.test(time)) return null;
  if (rec.kind === "daily") return { kind: "daily", time };
  if (rec.kind === "once") {
    const date = typeof rec.date === "string" ? rec.date.trim() : "";
    if (!parseCivilDate(date)) return null;
    return { kind: "once", date, time };
  }
  if (rec.kind === "weekly") {
    if (!Array.isArray(rec.days)) return null;
    const days = [...new Set(
      rec.days.filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6),
    )].sort((left, right) => left - right);
    if (days.length === 0) return null;
    return { kind: "weekly", days, time };
  }
  return null;
}

export function parseSchedules(raw: unknown): RoutineSchedule[] {
  if (!Array.isArray(raw)) return [];
  const out: RoutineSchedule[] = [];
  for (const item of raw) {
    const schedule = parseSchedule(item);
    if (!schedule) continue;
    const key = JSON.stringify(schedule);
    if (out.some((existing) => JSON.stringify(existing) === key)) continue;
    out.push(schedule);
    if (out.length >= SCHEDULES_MAX) break;
  }
  return out;
}

/** The first firing of one schedule strictly after `after`, or null. */
export function nextOccurrence(schedule: RoutineSchedule, timeZone: string, after: Date): Date | null {
  const match = TIME.exec(schedule.time);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (schedule.kind === "once") {
    const date = parseCivilDate(schedule.date);
    if (!date) return null;
    const at = zonedWallToUtc(date.year, date.month, date.day, hh, mm, timeZone);
    return at.getTime() > after.getTime() ? at : null;
  }
  const start = zoneParts(after, timeZone);
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    // Civil-date arithmetic only: UTC here is a calendar, not an instant.
    const civil = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (schedule.kind === "weekly" && !schedule.days.includes(civil.getUTCDay())) continue;
    const at = zonedWallToUtc(
      civil.getUTCFullYear(),
      civil.getUTCMonth() + 1,
      civil.getUTCDate(),
      hh,
      mm,
      timeZone,
    );
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/** The earliest firing across every schedule on a routine. */
export function routineNextRun(routine: Routine, after: Date): Date | null {
  let best: Date | null = null;
  for (const schedule of routine.schedules) {
    const at = nextOccurrence(schedule, routine.timezone, after);
    if (at && (!best || at.getTime() < best.getTime())) best = at;
  }
  return best;
}

/**
 * The occurrence a routine owes `now`, or null when nothing is due.
 * The anchor is the last run, so a Mac that slept through a window catches up
 * with exactly one run instead of replaying every occurrence it missed.
 */
export function routineDueAt(routine: Routine, now: Date): Date | null {
  if (!routine.active || routine.schedules.length === 0) return null;
  const anchor = routine.lastRunAt ? new Date(routine.lastRunAt) : new Date(routine.createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const next = routineNextRun(routine, anchor);
  if (!next) return null;
  return next.getTime() <= now.getTime() ? next : null;
}

// MARK: - Parsing

function parseRun(raw: unknown): RoutineRun | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.at !== "string") return null;
  return {
    at: rec.at,
    status: rec.status === "failed" ? "failed" : "ok",
    sessionId: isId(rec.sessionId, 200) ? rec.sessionId : null,
    error: clip(rec.error, ERROR_MAX),
  };
}

export function parseRoutine(raw: unknown): Routine | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  // Unknown fields are ignored, never fatal: a newer build may add one and an
  // older build must not drop the routine.
  if (!isId(rec.id, 120) || !isId(rec.botId)) return null;
  if (typeof rec.createdAt !== "string" || typeof rec.updatedAt !== "string") return null;
  const history: RoutineRun[] = [];
  for (const item of Array.isArray(rec.runHistory) ? rec.runHistory : []) {
    const run = parseRun(item);
    if (run) history.push(run);
  }
  return {
    id: rec.id,
    botId: rec.botId,
    name: clip(rec.name, NAME_MAX).trim() || "Routine",
    instruction: clip(rec.instruction, INSTRUCTION_MAX),
    schedules: parseSchedules(rec.schedules),
    timezone: isValidTimeZone(rec.timezone) ? rec.timezone : hostTimeZone(),
    active: rec.active !== false,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastRunAt: typeof rec.lastRunAt === "string" ? rec.lastRunAt : null,
    runHistory: history.slice(-RUN_HISTORY_MAX),
    manualRunRequested: rec.manualRunRequested === true,
    extra: collectExtra(rec, ROUTINE_KEYS),
  };
}

export function parseRoutinesStore(raw: unknown): RoutinesStore {
  if (!raw || typeof raw !== "object") return emptyStore();
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== ROUTINES_SCHEMA) return emptyStore();
  const routines: Routine[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.routines) ? rec.routines : []) {
    const routine = parseRoutine(item);
    if (!routine || seen.has(routine.id)) continue;
    seen.add(routine.id);
    routines.push(routine);
  }
  return { schemaVersion: 1, routines, extra: collectExtra(rec, STORE_KEYS) };
}

// MARK: - Storage

export function readRoutinesStore(path = routinesStorePath()): RoutinesStore {
  if (!existsSync(path)) return emptyStore();
  try {
    return parseRoutinesStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * Move a file this build cannot read aside before the next write, so a schema
 * change never silently destroys the only copy of the owner's routines.
 */
function backupIncompatible(path: string): void {
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw && typeof raw === "object" && raw.schemaVersion === ROUTINES_SCHEMA) return;
  } catch {
    /* fall through to backup */
  }
  try {
    renameSync(path, `${path}.invalid.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`);
  } catch { /* ignore */ }
}

export function writeRoutinesStore(store: RoutinesStore, path = routinesStorePath()): void {
  writeSerialized(JSON.stringify(plainRoutinesStore(parseRoutinesStore(store))), path);
}

function writeSerialized(json: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  backupIncompatible(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${json}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
    Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback for runtimes without Atomics.wait */
    }
  }
}

/**
 * Cross-process lock for read/merge/write cycles. The tick scheduler claims a
 * due run inside this lock, which is what makes a routine fire once when two
 * ticks race.
 */
export function withRoutinesStore<T>(fn: (store: RoutinesStore) => T, path = routinesStorePath()): T {
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
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) break;
      sleep(15);
    }
  }
  if (!held) throw new Error("routines_locked");
  try {
    const before = JSON.stringify(plainRoutinesStore(readRoutinesStore(path)));
    const scratch = parseRoutinesStore(JSON.parse(before));
    const result = fn(scratch);
    const after = JSON.stringify(plainRoutinesStore(scratch));
    // A claim that found nothing due, or any other read-only pass, leaves the
    // document byte-identical. Rewriting it would still cost an fsync and move
    // the mtime, which is the signal the stale-lock sweep reads.
    //
    // The snapshot is taken after decoding, so junk on disk (an over-long
    // name, an unknown timezone, a routine with no id) is already gone from
    // both sides of the comparison and no longer gets rewritten away by a pass
    // that changes nothing else. That is deliberate: every read normalises the
    // same way, so nothing downstream ever sees the junk, and healing the file
    // is not worth an fsync on every tick.
    if (after !== before) writeSerialized(after, path);
    return result;
  } finally {
    try { rmdirSync(lock); } catch { /* ignore */ }
  }
}

// MARK: - CRUD

export function listRoutines(botId: string, path = routinesStorePath()): Routine[] {
  return readRoutinesStore(path)
    .routines.filter((routine) => routine.botId === botId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function readRoutine(id: string, path = routinesStorePath()): Routine | null {
  return readRoutinesStore(path).routines.find((routine) => routine.id === id) ?? null;
}

export function createRoutine(draft: RoutineDraft, path = routinesStorePath(), at = new Date()): Routine {
  const name = clip(draft.name, NAME_MAX).trim();
  if (!name) throw new Error("routine_name_required");
  const instruction = clip(draft.instruction, INSTRUCTION_MAX).trim();
  if (!instruction) throw new Error("routine_instruction_required");
  if (!isId(draft.botId)) throw new Error("routine_bot_required");
  // The same shape rule updateRoutine applies: a non-array is a caller bug,
  // not a routine that silently never fires.
  if (draft.schedules !== undefined && !Array.isArray(draft.schedules)) {
    throw new Error("routine_schedules_invalid");
  }
  const schedules = parseSchedules(draft.schedules);
  const stamp = at.toISOString();
  const routine: Routine = {
    id: newRoutineId(),
    botId: draft.botId,
    name,
    instruction,
    schedules,
    timezone: isValidTimeZone(draft.timezone) ? draft.timezone : hostTimeZone(),
    active: draft.active !== false,
    createdAt: stamp,
    updatedAt: stamp,
    lastRunAt: null,
    runHistory: [],
    manualRunRequested: false,
  };
  return withRoutinesStore((store) => {
    const owned = store.routines.filter((item) => item.botId === routine.botId).length;
    if (owned >= ROUTINES_PER_BOT_MAX) throw new Error("routine_limit");
    store.routines.push(routine);
    return routine;
  }, path);
}

export function updateRoutine(
  id: string,
  patch: RoutinePatch,
  path = routinesStorePath(),
  at = new Date(),
): Routine {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine) throw new Error("routine_missing");
    if (patch.name !== undefined) {
      const name = clip(patch.name, NAME_MAX).trim();
      if (!name) throw new Error("routine_name_required");
      routine.name = name;
    }
    if (patch.instruction !== undefined) {
      const instruction = clip(patch.instruction, INSTRUCTION_MAX).trim();
      if (!instruction) throw new Error("routine_instruction_required");
      routine.instruction = instruction;
    }
    if (patch.schedules !== undefined) {
      if (!Array.isArray(patch.schedules)) throw new Error("routine_schedules_invalid");
      routine.schedules = parseSchedules(patch.schedules);
    }
    if (patch.timezone !== undefined) {
      if (!isValidTimeZone(patch.timezone)) throw new Error("routine_timezone_invalid");
      routine.timezone = patch.timezone;
    }
    if (patch.active !== undefined) {
      if (typeof patch.active !== "boolean") throw new Error("routine_active_invalid");
      routine.active = patch.active;
    }
    routine.updatedAt = at.toISOString();
    return { ...routine, schedules: routine.schedules.slice(), runHistory: routine.runHistory.slice() };
  }, path);
}

export function deleteRoutine(id: string, path = routinesStorePath()): boolean {
  return withRoutinesStore((store) => {
    const before = store.routines.length;
    store.routines = store.routines.filter((routine) => routine.id !== id);
    return store.routines.length !== before;
  }, path);
}

/** Drop every routine a deleted bot owned, so nothing keeps firing for it. */
export function deleteRoutinesForBot(botId: string, path = routinesStorePath()): number {
  return withRoutinesStore((store) => {
    const before = store.routines.length;
    store.routines = store.routines.filter((routine) => routine.botId !== botId);
    return before - store.routines.length;
  }, path);
}

/**
 * Drop every routine whose bot is gone from the roster. The delete path
 * already sweeps a bot's routines, but it cannot be atomic with the roster
 * write: the two stores have separate locks, so a crash or a contended lock
 * between them leaves a routine that comes due forever for a bot nobody can
 * see. The tick calls this, which makes that state self-healing instead of
 * permanent.
 */
export function sweepOrphanRoutines(liveBotIds: Iterable<string>, path = routinesStorePath()): string[] {
  const live = new Set(liveBotIds);
  // An empty roster is not a reason to delete everything; that reads as a
  // failed shell load, not as every bot having been removed.
  if (live.size === 0) return [];
  return withRoutinesStore((store) => {
    const orphans = store.routines.filter((routine) => !live.has(routine.botId));
    if (orphans.length === 0) return [];
    store.routines = store.routines.filter((routine) => live.has(routine.botId));
    return orphans.map((routine) => routine.id);
  }, path);
}

export function appendRoutineRun(
  id: string,
  run: { status: RoutineRunStatus; sessionId?: string | null; error?: string },
  path = routinesStorePath(),
  at = new Date(),
): RoutineRun | null {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine) return null;
    const entry: RoutineRun = {
      at: at.toISOString(),
      status: run.status,
      sessionId: run.sessionId && isId(run.sessionId, 200) ? run.sessionId : null,
      error: clip(run.error, ERROR_MAX),
    };
    routine.runHistory.push(entry);
    if (routine.runHistory.length > RUN_HISTORY_MAX) {
      routine.runHistory.splice(0, routine.runHistory.length - RUN_HISTORY_MAX);
    }
    routine.updatedAt = entry.at;
    return entry;
  }, path);
}

/**
 * Take ownership of one due occurrence. `lastRunAt` moves to the claim time
 * before the lock is released, so a second tick that raced this one recomputes
 * the schedule and finds nothing due.
 */
export function claimDueRoutine(
  id: string,
  now = new Date(),
  path = routinesStorePath(),
): { routine: Routine; dueAt: string } | null {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine) return null;
    const dueAt = routineDueAt(routine, now);
    if (!dueAt) return null;
    // The claim time, not the missed slot: anchoring on the slot would make a
    // long sleep replay one run per tick until the backlog caught up.
    routine.lastRunAt = now.toISOString();
    routine.updatedAt = routine.lastRunAt;
    return {
      routine: { ...routine, schedules: routine.schedules.slice(), runHistory: routine.runHistory.slice() },
      dueAt: dueAt.toISOString(),
    };
  }, path);
}

/**
 * Ask for an out-of-band run. Returns false when the routine is gone or a
 * request is already waiting, so a repeated tool call cannot queue two runs.
 */
export function requestRoutineRun(id: string, path = routinesStorePath()): boolean {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine || routine.manualRunRequested) return false;
    routine.manualRunRequested = true;
    routine.updatedAt = new Date().toISOString();
    return true;
  }, path);
}

/**
 * Take ownership of a requested run. Clearing the flag inside the lock is what
 * makes the run happen once when two ticks race.
 */
export function claimManualRun(id: string, path = routinesStorePath()): { routine: Routine } | null {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine || !routine.manualRunRequested) return null;
    routine.manualRunRequested = false;
    routine.updatedAt = new Date().toISOString();
    return {
      routine: { ...routine, schedules: routine.schedules.slice(), runHistory: routine.runHistory.slice() },
    };
  }, path);
}

/**
 * Take ownership of a run the owner started from the pane. The Test run button
 * does not need a waiting request, but it has to consume one if there is one:
 * otherwise the tick claims the same request a moment later and the routine
 * runs twice. Taking the ticket inside the store lock is what serialises the
 * two paths, since their in-flight sets live in different processes.
 */
export function claimRunNow(id: string, path = routinesStorePath()): { routine: Routine } | null {
  return withRoutinesStore((store) => {
    const routine = store.routines.find((item) => item.id === id);
    if (!routine) return null;
    if (routine.manualRunRequested) {
      routine.manualRunRequested = false;
      routine.updatedAt = new Date().toISOString();
    }
    return {
      routine: { ...routine, schedules: routine.schedules.slice(), runHistory: routine.runHistory.slice() },
    };
  }, path);
}

/** Every routine the next tick owes work for: requested runs and due ones. */
export function pendingRoutines(now = new Date(), path = routinesStorePath()): Routine[] {
  return readRoutinesStore(path)
    .routines.filter((routine) => routine.manualRunRequested || routineDueAt(routine, now) !== null)
    .sort((left, right) => {
      // A run the owner asked for goes before the scheduled backlog.
      if (left.manualRunRequested !== right.manualRunRequested) return left.manualRunRequested ? -1 : 1;
      const leftDue = routineDueAt(left, now)?.getTime() ?? 0;
      const rightDue = routineDueAt(right, now)?.getTime() ?? 0;
      return leftDue - rightDue || left.id.localeCompare(right.id);
    });
}

/** Every routine whose next occurrence has passed, oldest due first. */
export function dueRoutines(now = new Date(), path = routinesStorePath()): Routine[] {
  return readRoutinesStore(path)
    .routines.filter((routine) => routineDueAt(routine, now) !== null)
    .sort((left, right) => {
      const leftDue = routineDueAt(left, now)?.getTime() ?? 0;
      const rightDue = routineDueAt(right, now)?.getTime() ?? 0;
      return leftDue - rightDue || left.id.localeCompare(right.id);
    });
}

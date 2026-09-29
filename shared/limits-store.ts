import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGGREGATE_LIMITS, CALLER_LIMITS } from "./policy.ts";

/**
 * The owner's daily token budget for the model router, the one number the
 * usage settings can move.
 *
 * `shared/policy.ts` ships the designed shape of a day: the desktop caller may
 * spend 30M input and 3M output, and the aggregate ceiling sits just above so
 * one caller cannot starve the rest. Those relationships are the point, so the
 * override is a single budget (the desktop input allowance) and every other
 * 24h token limit moves with it by the same factor. Request counts and rates
 * are untouched: this is a spend control, not a throttle.
 *
 * Same shape as the other stores: 0600 JSON under ~/.useful-bot, written
 * atomically, read on demand by the router and the web routes.
 */

export interface LimitsStore {
  schemaVersion: 1;
  /** Desktop input tokens per rolling 24 hours. `null` means the shipped default. */
  dailyTokenBudget: number | null;
  updatedAt: string | null;
}

/** The shipped budget, and the baseline every override is a factor of. */
export const DEFAULT_DAILY_TOKEN_BUDGET = CALLER_LIMITS.desktop.input24h;
/** Below this the desktop cannot finish a normal turn; above it, a typo costs real money. */
export const MIN_DAILY_TOKEN_BUDGET = 1_000_000;
export const MAX_DAILY_TOKEN_BUDGET = 500_000_000;
/** The budget moves in whole millions, which is how the control is labelled. */
export const DAILY_TOKEN_BUDGET_STEP = 1_000_000;

export function limitsPath(root = process.env.UB_LIMITS_PATH): string {
  if (root) return root;
  return join(process.env.HOME ?? "/tmp", ".useful-bot/limits.json");
}

export function emptyLimitsStore(): LimitsStore {
  return { schemaVersion: 1, dailyTokenBudget: null, updatedAt: null };
}

/**
 * A budget the store will accept, or `undefined` for anything else.
 *
 * Whole tokens, anywhere in range. It deliberately does not snap to the
 * stepper's million: a budget typed as 3.5M has to be stored as 3,500,000, not
 * rounded up to 4,000,000, because rounding a spend limit up is a raise the
 * owner did not ask for.
 */
export function normalizeBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const whole = Math.round(value);
  if (whole < MIN_DAILY_TOKEN_BUDGET || whole > MAX_DAILY_TOKEN_BUDGET) return undefined;
  return whole;
}

export function parseLimitsStore(raw: unknown): LimitsStore {
  if (!raw || typeof raw !== "object") throw new Error("limits_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("limits_schema");
  // An out-of-range or corrupt budget falls back to the shipped default rather
  // than throwing: a bad file must not take the router down.
  const budget = rec.dailyTokenBudget === null ? null : normalizeBudget(rec.dailyTokenBudget) ?? null;
  return {
    schemaVersion: 1,
    dailyTokenBudget: budget,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
  };
}

export function readLimitsStore(path = limitsPath()): LimitsStore {
  if (!existsSync(path)) return emptyLimitsStore();
  try {
    return parseLimitsStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Unreadable or malformed: the shipped limits still apply. Failing open to
    // "no limit" would be the dangerous reading of a broken file.
    return emptyLimitsStore();
  }
}

export function writeLimitsStore(store: LimitsStore, path = limitsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface EffectiveLimits {
  dailyTokenBudget: number;
  caller: { rpm: number; requests24h: number; input24h: number; output24h: number };
  aggregate: { requests24h: number; input24h: number; output24h: number };
}

/** Scale a shipped 24h token limit by the budget factor. `0` means unlimited. */
function scaled(limit: number, factor: number): number {
  if (limit <= 0) return limit;
  return Math.max(1, Math.round(limit * factor));
}

export function effectiveLimits(
  profile: keyof typeof CALLER_LIMITS,
  budget: number | null,
): EffectiveLimits {
  const caller = CALLER_LIMITS[profile];
  const applied = budget ?? DEFAULT_DAILY_TOKEN_BUDGET;
  const factor = applied / DEFAULT_DAILY_TOKEN_BUDGET;
  return {
    dailyTokenBudget: applied,
    caller: {
      rpm: caller.rpm,
      requests24h: caller.requests24h,
      input24h: scaled(caller.input24h, factor),
      output24h: scaled(caller.output24h, factor),
    },
    aggregate: {
      requests24h: AGGREGATE_LIMITS.requests24h,
      input24h: scaled(AGGREGATE_LIMITS.input24h, factor),
      output24h: scaled(AGGREGATE_LIMITS.output24h, factor),
    },
  };
}

const CACHE_TTL_MS = 2_000;
// Keyed by path: the tests and any process with more than one store must not
// read each other's budget out of one shared slot.
const cache = new Map<string, { budget: number | null; at: number; mtimeMs: number }>();

/**
 * The budget as the router should enforce it right now. The file is on the hot
 * path of every model call, so it is stat-checked rather than re-read, and only
 * every couple of seconds: a change from the settings pane lands within one
 * turn without a restart, and a steady stream costs one `stat` per 2s.
 */
export function currentBudget(path = limitsPath()): number | null {
  const now = Date.now();
  const entry = cache.get(path);
  // Within the window the cached answer stands, so a raise or a cut reaches
  // the router within about two seconds rather than instantly. That is the
  // deliberate trade for not stat-ing the file on every model call, and it is
  // safe in both directions: the window is shorter than a turn.
  if (entry && now - entry.at < CACHE_TTL_MS) return entry.budget;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (entry && entry.mtimeMs === mtimeMs) {
    cache.set(path, { ...entry, at: now });
    return entry.budget;
  }
  const budget = readLimitsStore(path).dailyTokenBudget;
  cache.set(path, { budget, at: now, mtimeMs });
  return budget;
}

/** Drop the cached budget so the next read hits the file. */
export function resetBudgetCache(path?: string): void {
  if (path === undefined) cache.clear();
  else cache.delete(path);
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AGGREGATE_LIMITS, CALLER_LIMITS } from "./policy.ts";
import { statePath } from "./stack.ts";

/**
 * The owner's daily budgets for the model router: tokens and requests, the two
 * numbers the usage settings can move.
 *
 * `shared/policy.ts` ships the designed shape of a day: the desktop caller may
 * spend 30M input and 3M output, and the aggregate ceiling sits just above so
 * one caller cannot starve the rest. Those relationships are the point, so each
 * override is a single number and every related limit moves with it by the same
 * factor, computed against the policy's baseline (not against the default the
 * owner starts at). The token budget scales every 24h token limit; the request
 * budget replaces the desktop and phone request count and scales the aggregate
 * request count. Per-minute rates are untouched.
 *
 * There is no product ceiling on either budget. The only upper bound is the
 * largest integer JS and Swift's Int can both carry exactly, and a value above
 * it is refused, never clamped.
 *
 * Same shape as the other stores: 0600 JSON under ~/.useful-bot, written
 * atomically, read on demand by the router and the web routes.
 */

export interface LimitsStore {
  schemaVersion: 1;
  /** Desktop input tokens per rolling 24 hours. `null` means the shipped default. */
  dailyTokenBudget: number | null;
  /**
   * Desktop and phone model requests per rolling 24 hours. `null` means the
   * shipped default. A file written before this field existed has none, which
   * parses as `null`, so the schema stays at 1.
   */
  dailyRequestBudget: number | null;
  updatedAt: string | null;
}

/** The policy's own desktop numbers: the shape every override is a factor of. */
export const BASELINE_DAILY_TOKEN_BUDGET = CALLER_LIMITS.desktop.input24h;
export const BASELINE_DAILY_REQUEST_BUDGET = CALLER_LIMITS.desktop.requests24h;
/** What applies while the store holds `null`. */
export const DEFAULT_DAILY_TOKEN_BUDGET = 500_000_000;
export const DEFAULT_DAILY_REQUEST_BUDGET = 5_000;
/** Below this the desktop cannot finish a normal turn. */
export const MIN_DAILY_TOKEN_BUDGET = 1_000_000;
export const MIN_DAILY_REQUEST_BUDGET = 1;
/** The only ceiling: past this a number stops being exact in JSON and in Swift. */
export const MAX_DAILY_BUDGET = Number.MAX_SAFE_INTEGER;
/** The token stepper moves in whole millions, which is how the control is labelled. */
export const DAILY_TOKEN_BUDGET_STEP = 1_000_000;
export const DAILY_REQUEST_BUDGET_STEP = 500;

export function limitsPath(root = process.env.UB_LIMITS_PATH): string {
  if (root) return root;
  return statePath("limits.json");
}

export function emptyLimitsStore(): LimitsStore {
  return { schemaVersion: 1, dailyTokenBudget: null, dailyRequestBudget: null, updatedAt: null };
}

export type BudgetCheck =
  | { ok: true; value: number }
  | { ok: false; error: string; message: string };

/**
 * A token budget the store will accept, or the rule it broke.
 *
 * Whole tokens, from the floor up to the safe integer; a fractional count is
 * refused, never rounded. It deliberately does not snap to the stepper's
 * million: a budget typed as 3.5M has to be stored as 3,500,000, not rounded up
 * to 4,000,000, because rounding a spend limit up is a raise the owner did not
 * ask for.
 */
export function checkTokenBudget(value: unknown): BudgetCheck {
  // Validate before anything else: rounding first turned 1000000.5 into
  // 1000001 and let 999999.6 through the floor. The macOS app converts "3.5M"
  // to whole tokens itself, so a fractional count here is a bug upstream.
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: "token_budget_invalid", message: "Type the token budget as a whole number of tokens." };
  }
  const whole = value;
  if (whole < MIN_DAILY_TOKEN_BUDGET) {
    return { ok: false, error: "token_budget_min", message: "Has to be at least 1M tokens." };
  }
  if (whole > MAX_DAILY_BUDGET) {
    return {
      ok: false,
      error: "token_budget_max",
      message: `Has to be at most ${MAX_DAILY_BUDGET.toLocaleString("en-US")} tokens.`,
    };
  }
  return { ok: true, value: whole };
}

/** A request budget the store will accept, or the rule it broke. Whole requests only. */
export function checkRequestBudget(value: unknown): BudgetCheck {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: "request_budget_invalid", message: "Type the request budget as a whole number." };
  }
  if (value < MIN_DAILY_REQUEST_BUDGET) {
    return { ok: false, error: "request_budget_min", message: "Has to be at least 1 request." };
  }
  if (value > MAX_DAILY_BUDGET) {
    return {
      ok: false,
      error: "request_budget_max",
      message: `Has to be at most ${MAX_DAILY_BUDGET.toLocaleString("en-US")} requests.`,
    };
  }
  return { ok: true, value };
}

/** The stored-file view of {@link checkTokenBudget}: the value, or `undefined`. */
export function normalizeBudget(value: unknown): number | undefined {
  const checked = checkTokenBudget(value);
  return checked.ok ? checked.value : undefined;
}

function normalizeRequestBudget(value: unknown): number | undefined {
  const checked = checkRequestBudget(value);
  return checked.ok ? checked.value : undefined;
}

export type LimitsUpdate =
  | { ok: true; store: LimitsStore }
  | { ok: false; error: string; message: string };

/**
 * Apply a PUT body to the store. Either budget may be present; an absent one is
 * left as it is, `null` restores that budget's default, and anything else must
 * pass its check. One bad field refuses the whole update, so nothing half applies.
 */
export function applyLimitsUpdate(store: LimitsStore, body: unknown, now: string): LimitsUpdate {
  const missing = {
    ok: false as const,
    error: "budget_missing",
    message: "Send dailyTokenBudget, dailyRequestBudget or both.",
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return missing;
  const rec = body as Record<string, unknown>;
  const hasTokens = rec.dailyTokenBudget !== undefined;
  const hasRequests = rec.dailyRequestBudget !== undefined;
  if (!hasTokens && !hasRequests) return missing;
  const next: LimitsStore = { ...store, updatedAt: now };
  if (hasTokens) {
    if (rec.dailyTokenBudget === null) {
      next.dailyTokenBudget = null;
    } else {
      const checked = checkTokenBudget(rec.dailyTokenBudget);
      if (!checked.ok) return checked;
      next.dailyTokenBudget = checked.value;
    }
  }
  if (hasRequests) {
    if (rec.dailyRequestBudget === null) {
      next.dailyRequestBudget = null;
    } else {
      const checked = checkRequestBudget(rec.dailyRequestBudget);
      if (!checked.ok) return checked;
      next.dailyRequestBudget = checked.value;
    }
  }
  return { ok: true, store: next };
}

export function parseLimitsStore(raw: unknown): LimitsStore {
  if (!raw || typeof raw !== "object") throw new Error("limits_format");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== 1) throw new Error("limits_schema");
  // A corrupt or out-of-bounds budget falls back to the shipped default rather
  // than throwing: a bad file must not take the router down. A missing request
  // budget (a file from before it existed) is the same null.
  return {
    schemaVersion: 1,
    dailyTokenBudget: rec.dailyTokenBudget === null ? null : normalizeBudget(rec.dailyTokenBudget) ?? null,
    dailyRequestBudget: rec.dailyRequestBudget === null ? null : normalizeRequestBudget(rec.dailyRequestBudget) ?? null,
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
  dailyRequestBudget: number;
  caller: { rpm: number; requests24h: number; input24h: number; output24h: number };
  aggregate: { requests24h: number; input24h: number; output24h: number };
}

/**
 * Scale a shipped 24h limit by `budget / baseline`. `0` means unlimited. The
 * arithmetic is exact (BigInt, rounded half up once) so a budget near the safe
 * integer scales to itself when the ratio is 1, and the result is held to the
 * safe integer so a 10-figure budget can never turn a limit into an inexact
 * number.
 */
function scaled(limit: number, budget: number, baseline: number): number {
  if (limit <= 0) return limit;
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(budget) || !Number.isSafeInteger(baseline) || baseline <= 0) {
    throw new Error("limits_budget");
  }
  const numerator = BigInt(limit) * BigInt(budget);
  const divisor = BigInt(baseline);
  const rounded = (numerator * 2n + divisor) / (divisor * 2n);
  const capped = rounded > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : rounded;
  return Math.max(1, Number(capped));
}

export function effectiveLimits(
  profile: keyof typeof CALLER_LIMITS,
  budget: number | null,
  requestBudget: number | null = null,
): EffectiveLimits {
  const caller = CALLER_LIMITS[profile];
  const tokens = budget ?? DEFAULT_DAILY_TOKEN_BUDGET;
  const requests = requestBudget ?? DEFAULT_DAILY_REQUEST_BUDGET;
  const tokenLimit = (limit: number) => scaled(limit, tokens, BASELINE_DAILY_TOKEN_BUDGET);
  // The phone profile carries the desktop budget verbatim (one owner budget), so
  // both take the owner's budgets; every other caller (reviewer, eval) keeps its
  // shipped limits, so raising the owner's day never widens theirs.
  const ownerBudget = profile === "desktop" || profile === "phone";
  return {
    dailyTokenBudget: tokens,
    dailyRequestBudget: requests,
    caller: {
      rpm: caller.rpm,
      requests24h: ownerBudget ? requests : caller.requests24h,
      input24h: ownerBudget ? tokenLimit(caller.input24h) : caller.input24h,
      output24h: ownerBudget ? tokenLimit(caller.output24h) : caller.output24h,
    },
    aggregate: {
      requests24h: scaled(AGGREGATE_LIMITS.requests24h, requests, BASELINE_DAILY_REQUEST_BUDGET),
      input24h: tokenLimit(AGGREGATE_LIMITS.input24h),
      output24h: tokenLimit(AGGREGATE_LIMITS.output24h),
    },
  };
}

const CACHE_TTL_MS = 2_000;
interface CachedBudgets {
  tokens: number | null;
  requests: number | null;
  at: number;
  mtimeMs: number;
}
// Keyed by path: the tests and any process with more than one store must not
// read each other's budget out of one shared slot.
const cache = new Map<string, CachedBudgets>();

function cachedBudgets(path: string): CachedBudgets {
  const now = Date.now();
  const entry = cache.get(path);
  // Within the window the cached answer stands, so a raise or a cut reaches
  // the router within about two seconds rather than instantly. That is the
  // deliberate trade for not stat-ing the file on every model call, and it is
  // safe in both directions: the window is shorter than a turn.
  if (entry && now - entry.at < CACHE_TTL_MS) return entry;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (entry && entry.mtimeMs === mtimeMs) {
    const refreshed = { ...entry, at: now };
    cache.set(path, refreshed);
    return refreshed;
  }
  const store = readLimitsStore(path);
  const fresh = { tokens: store.dailyTokenBudget, requests: store.dailyRequestBudget, at: now, mtimeMs };
  cache.set(path, fresh);
  return fresh;
}

/**
 * The budgets as the router should enforce them right now. The file is on the
 * hot path of every model call, so it is stat-checked rather than re-read, and
 * only every couple of seconds: a change from the settings pane lands within
 * one turn without a restart, and a steady stream costs one `stat` per 2s.
 */
export function currentBudget(path = limitsPath()): number | null {
  return cachedBudgets(path).tokens;
}

export function currentRequestBudget(path = limitsPath()): number | null {
  return cachedBudgets(path).requests;
}

/** Drop the cached budgets so the next read hits the file. */
export function resetBudgetCache(path?: string): void {
  if (path === undefined) cache.clear();
  else cache.delete(path);
}

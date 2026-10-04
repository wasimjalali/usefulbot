import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { LimitStore } from "../../../../router/src/limits.ts";
import {
  applyLimitsUpdate,
  currentBudget,
  currentRequestBudget,
  DAILY_REQUEST_BUDGET_STEP,
  DAILY_TOKEN_BUDGET_STEP,
  DEFAULT_DAILY_REQUEST_BUDGET,
  DEFAULT_DAILY_TOKEN_BUDGET,
  effectiveLimits,
  MIN_DAILY_REQUEST_BUDGET,
  MIN_DAILY_TOKEN_BUDGET,
  readLimitsStore,
  resetBudgetCache,
  writeLimitsStore,
} from "../../../../shared/limits-store.ts";
import { parseConnectionId } from "../../../../shared/provider-catalog.ts";
import { readProviderStore } from "../../../../shared/providers.ts";
import { routerDbPath } from "../../../../shared/stack.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** The caller every bot in this app shares, and the one the caps are for. */
const DESKTOP_CALLER = "desktop";

function usageDbPath(): string {
  return routerDbPath();
}

// The pane polls every few seconds, so one store per process path: a fresh
// LimitStore per request leaks its sqlite handle until GC and re-runs the
// migration each time.
let sharedStore: LimitStore | null = null;
let sharedPath = "";
function usageStore(): LimitStore {
  const path = usageDbPath();
  if (!sharedStore || sharedPath !== path) {
    sharedStore = new LimitStore(path);
    sharedPath = path;
  }
  return sharedStore;
}

/**
 * The limits are per rolling 24 hours, so the meter reads the same window.
 * The week is reported alongside it as history, never as the number compared
 * against the cap: the old page divided a seven-day total by a one-day limit
 * and showed a bar that could sit past full while nothing was throttled.
 */
function payload() {
  const store = usageStore();
  // The caps below belong to the desktop caller, so the totals must too. An
  // aggregate summary measured against one caller's budget is a meter that
  // does not match the limit it is drawn under.
  const today = store.summarize(DESKTOP_CALLER, Date.now(), DAY_MS);
  const week = store.summarize(DESKTOP_CALLER, Date.now(), WEEK_MS);
  const budget = currentBudget();
  const requestBudget = currentRequestBudget();
  const limits = effectiveLimits("desktop", budget, requestBudget);
  const providers = readProviderStore();
  return {
    ok: true,
    ...today,
    // What the router actually charges against the cap: observed usage plus
    // the turns it has reserved for and not yet reconciled. Reporting only the
    // observed half is how a meter shows room on a day the router is already
    // refusing turns.
    charged: {
      input_tokens: today.observed_input_tokens + (today.reserved_input_tokens ?? 0),
      output_tokens: today.observed_output_tokens + (today.reserved_output_tokens ?? 0),
    },
    week: {
      observed_input_tokens: week.observed_input_tokens,
      observed_output_tokens: week.observed_output_tokens,
      requests: week.requests,
      window_start: week.window_start,
    },
    by_model: week.by_model,
    activeProviderId: providers.activeConnectionId ? parseConnectionId(providers.activeConnectionId).providerId : null,
    caps: {
      requests24h: limits.caller.requests24h,
      input24h: limits.caller.input24h,
      output24h: limits.caller.output24h,
    },
    budget: {
      tokens: limits.dailyTokenBudget,
      isDefault: budget === null,
      default: DEFAULT_DAILY_TOKEN_BUDGET,
      min: MIN_DAILY_TOKEN_BUDGET,
      // No product ceiling: `null` max means only the safe integer bounds it.
      max: null,
      step: DAILY_TOKEN_BUDGET_STEP,
    },
    requestBudget: {
      requests: limits.dailyRequestBudget,
      isDefault: requestBudget === null,
      default: DEFAULT_DAILY_REQUEST_BUDGET,
      min: MIN_DAILY_REQUEST_BUDGET,
      max: null,
      step: DAILY_REQUEST_BUDGET_STEP,
    },
  };
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  return NextResponse.json(payload());
}

/**
 * Move the daily token budget, the daily request budget or both. Desktop session, CSRF header and rate limit,
 * the same gate every other state-changing route uses: this one decides how
 * much the owner can spend in a day.
 */
export async function PUT(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`usage:${gate.session.callerId}`, 30)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    // An absent field is left alone, `null` restores that budget's default, and
    // anything else must pass its check: a fat-fingered value is refused with
    // the rule it broke, never clamped into something the owner did not ask for.
    const update = applyLimitsUpdate(readLimitsStore(), body, new Date().toISOString());
    if (!update.ok) {
      return NextResponse.json({ ok: false, error: update.error, message: update.message }, { status: 400 });
    }
    writeLimitsStore(update.store);
    // The router caches the budget for a couple of seconds; this process holds
    // its own copy, so drop it now rather than answering with a stale number.
    resetBudgetCache();
    return NextResponse.json(payload());
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

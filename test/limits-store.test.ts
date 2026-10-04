import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLimitsUpdate,
  BASELINE_DAILY_REQUEST_BUDGET,
  BASELINE_DAILY_TOKEN_BUDGET,
  checkRequestBudget,
  checkTokenBudget,
  currentBudget,
  currentRequestBudget,
  DEFAULT_DAILY_REQUEST_BUDGET,
  DEFAULT_DAILY_TOKEN_BUDGET,
  effectiveLimits,
  emptyLimitsStore,
  MAX_DAILY_BUDGET,
  MIN_DAILY_REQUEST_BUDGET,
  MIN_DAILY_TOKEN_BUDGET,
  normalizeBudget,
  readLimitsStore,
  resetBudgetCache,
  writeLimitsStore,
} from "../shared/limits-store.ts";
import { AGGREGATE_LIMITS, CALLER_LIMITS } from "../shared/policy.ts";

function sandbox(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const path = join(dir, "limits.json");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rejected(result: { ok: boolean; error?: string; message?: string }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error, code);
  assert.ok(result.message && result.message.length > 0, "a rejection names the rule");
  assert.ok(!result.message.includes("—"), "no em dash in user-facing copy");
}

test("the shipped numbers: 500M tokens and 5,000 requests a day, against the policy baseline", () => {
  assert.equal(DEFAULT_DAILY_TOKEN_BUDGET, 500_000_000);
  assert.equal(DEFAULT_DAILY_REQUEST_BUDGET, 5_000);
  assert.equal(BASELINE_DAILY_TOKEN_BUDGET, CALLER_LIMITS.desktop.input24h);
  assert.equal(BASELINE_DAILY_REQUEST_BUDGET, CALLER_LIMITS.desktop.requests24h);
  assert.equal(MAX_DAILY_BUDGET, Number.MAX_SAFE_INTEGER);
  assert.equal(MIN_DAILY_TOKEN_BUDGET, 1_000_000);
  assert.equal(MIN_DAILY_REQUEST_BUDGET, 1);
});

test("a token budget has no product ceiling, only the safe-integer one", () => {
  for (const ok of [MIN_DAILY_TOKEN_BUDGET, 500_000_000, 1_000_000_000, 10_000_000_000, Number.MAX_SAFE_INTEGER]) {
    const r = checkTokenBudget(ok);
    assert.deepEqual(r, { ok: true, value: ok });
  }
  rejected(checkTokenBudget(Number.MAX_SAFE_INTEGER + 1), "token_budget_max");
  rejected(checkTokenBudget(1e300), "token_budget_max");
  rejected(checkTokenBudget(Number.POSITIVE_INFINITY), "token_budget_invalid");
});

test("a token budget below the floor, or not a number, is refused with the rule named", () => {
  rejected(checkTokenBudget(MIN_DAILY_TOKEN_BUDGET - 1), "token_budget_min");
  rejected(checkTokenBudget(0), "token_budget_min");
  rejected(checkTokenBudget(-5_000_000), "token_budget_min");
  rejected(checkTokenBudget(Number.NaN), "token_budget_invalid");
  rejected(checkTokenBudget("500000000"), "token_budget_invalid");
  rejected(checkTokenBudget(undefined), "token_budget_invalid");
  rejected(checkTokenBudget(true), "token_budget_invalid");
  rejected(checkTokenBudget({}), "token_budget_invalid");
  assert.match((checkTokenBudget(0) as { message: string }).message, /at least 1M tokens/);
});

test("whole tokens are kept as typed, never snapped to the stepper's million", () => {
  assert.deepEqual(checkTokenBudget(3_500_000), { ok: true, value: 3_500_000 });
  assert.deepEqual(checkTokenBudget(30_600_000), { ok: true, value: 30_600_000 });
  assert.equal(normalizeBudget(30_400_000), 30_400_000);
  assert.equal(normalizeBudget(MIN_DAILY_TOKEN_BUDGET - 1), undefined);
  assert.equal(normalizeBudget(Number.MAX_SAFE_INTEGER + 1), undefined);
  assert.equal(normalizeBudget("30000000"), undefined);
});

test("a fractional token count is refused as invalid, never rounded into or across a bound", () => {
  // Rounding before validating turned 1000000.5 into 1000001 and let 999999.6
  // through the floor. The macOS app converts "3.5M" to whole tokens itself.
  for (const fractional of [1_000_000.5, 999_999.6, 999_999.4, 30_600_000.4, 3_500_000.000001, 1e6 + 0.1, -0.5, 0.2]) {
    rejected(checkTokenBudget(fractional), "token_budget_invalid");
    assert.equal(normalizeBudget(fractional), undefined, String(fractional));
  }
  // Whole numbers keep their own errors: the floor and the safe-integer ceiling.
  rejected(checkTokenBudget(999_999), "token_budget_min");
  rejected(checkTokenBudget(Number.MAX_SAFE_INTEGER + 1), "token_budget_max");
  // A fractional value inside a PUT body refuses the whole update.
  const start = { ...emptyLimitsStore(), dailyRequestBudget: 7_000 };
  rejected(applyLimitsUpdate(start, { dailyTokenBudget: 1_000_000.5 }, "2026-10-01T00:00:00.000Z"), "token_budget_invalid");
  rejected(applyLimitsUpdate(start, { dailyTokenBudget: 999_999.6, dailyRequestBudget: 10 }, "2026-10-01T00:00:00.000Z"), "token_budget_invalid");
});

test("a stored file with a fractional token budget falls back to the default, not a rounded value", () => {
  const box = sandbox();
  try {
    writeFileSync(box.path, JSON.stringify({ schemaVersion: 1, dailyTokenBudget: 1_000_000.5, dailyRequestBudget: 10, updatedAt: null }));
    const store = readLimitsStore(box.path);
    assert.equal(store.dailyTokenBudget, null);
    assert.equal(store.dailyRequestBudget, 10);
  } finally {
    box.cleanup();
  }
});

test("scaling is exact integer math: the identity budget stays exact up to the safe integer", () => {
  // desktop input24h is the baseline itself, so a budget scales by exactly 1.
  for (const budget of [9_007_199_254_740_987, 9_007_199_254_740_991, 4_503_599_627_370_497, 8_999_999_999_999_999]) {
    const limits = effectiveLimits("desktop", budget, null);
    assert.equal(limits.dailyTokenBudget, budget);
    assert.equal(limits.caller.input24h, budget, `desktop input ${budget}`);
  }
  assert.equal(effectiveLimits("phone", 9_007_199_254_740_987, null).caller.input24h, 9_007_199_254_740_987);
  // Request budgets too: the desktop count is the budget verbatim, the aggregate a ratio.
  assert.equal(effectiveLimits("desktop", null, 9_007_199_254_740_987).caller.requests24h, 9_007_199_254_740_987);
  // A ratio rounds half up on exact integers and never exceeds the safe integer.
  const big = effectiveLimits("desktop", 9_007_199_254_740_987, 9_007_199_254_740_987);
  assert.equal(big.aggregate.requests24h, Number.MAX_SAFE_INTEGER);
  assert.equal(big.aggregate.input24h, Number.MAX_SAFE_INTEGER);
  // Half rounds up: 1 request of 4,000 baseline against an aggregate of N.
  assert.equal(effectiveLimits("desktop", null, 1).aggregate.requests24h, Math.max(1, Math.round(AGGREGATE_LIMITS.requests24h / 4_000)));
});

test("a request budget: 1 up to the safe integer, whole numbers only", () => {
  for (const ok of [1, 100, 4_000, 5_000, 1_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(checkRequestBudget(ok), { ok: true, value: ok });
  }
  rejected(checkRequestBudget(0), "request_budget_min");
  rejected(checkRequestBudget(-1), "request_budget_min");
  rejected(checkRequestBudget(0.5), "request_budget_invalid");
  rejected(checkRequestBudget(4_000.5), "request_budget_invalid");
  rejected(checkRequestBudget(Number.NaN), "request_budget_invalid");
  rejected(checkRequestBudget("5000"), "request_budget_invalid");
  rejected(checkRequestBudget(null), "request_budget_invalid");
  rejected(checkRequestBudget(Number.MAX_SAFE_INTEGER + 1), "request_budget_max");
  assert.match((checkRequestBudget(0) as { message: string }).message, /at least 1 request/);
});

test("every 24h token limit is a factor of the baseline, so the aggregate cannot cap a raise", () => {
  const shipped = effectiveLimits("desktop", null, null);
  assert.equal(shipped.dailyTokenBudget, 500_000_000);
  assert.equal(shipped.dailyRequestBudget, 5_000);
  // The default 500M sits 16.67x above the 30M baseline; the designed ratios hold.
  assert.equal(shipped.caller.input24h, 500_000_000);
  assert.equal(shipped.caller.output24h, Math.round(CALLER_LIMITS.desktop.output24h * 500_000_000 / 30_000_000));
  assert.equal(shipped.caller.output24h, 50_000_000);
  assert.equal(shipped.aggregate.input24h, Math.round(AGGREGATE_LIMITS.input24h * 500_000_000 / 30_000_000));
  assert.ok(shipped.aggregate.input24h > shipped.caller.input24h);
  assert.ok(shipped.aggregate.output24h > shipped.caller.output24h);

  // At the baseline itself the policy numbers come out exactly.
  const baseline = effectiveLimits("desktop", BASELINE_DAILY_TOKEN_BUDGET, BASELINE_DAILY_REQUEST_BUDGET);
  assert.equal(baseline.caller.input24h, CALLER_LIMITS.desktop.input24h);
  assert.equal(baseline.caller.output24h, CALLER_LIMITS.desktop.output24h);
  assert.equal(baseline.caller.requests24h, CALLER_LIMITS.desktop.requests24h);
  assert.equal(baseline.aggregate.input24h, AGGREGATE_LIMITS.input24h);
  assert.equal(baseline.aggregate.output24h, AGGREGATE_LIMITS.output24h);
  assert.equal(baseline.aggregate.requests24h, AGGREGATE_LIMITS.requests24h);
  // Rates are not a spend control and do not move.
  assert.equal(shipped.caller.rpm, CALLER_LIMITS.desktop.rpm);

  // A profile with no token limits keeps none: 0 means unlimited, not 1.
  assert.equal(effectiveLimits("ops", 10_000_000_000, 10_000).caller.input24h, 0);
  assert.equal(effectiveLimits("ops", 10_000_000_000, 10_000).caller.requests24h, 0);
});

test("10B tokens and a huge request budget scale in whole safe integers, with no overflow", () => {
  const big = effectiveLimits("desktop", 10_000_000_000, 5_000);
  assert.equal(big.caller.input24h, 10_000_000_000);
  assert.equal(big.caller.output24h, 1_000_000_000);
  assert.equal(big.aggregate.input24h, Math.round(AGGREGATE_LIMITS.input24h * 10_000_000_000 / 30_000_000));
  assert.ok(big.aggregate.input24h > big.caller.input24h);

  const max = effectiveLimits("phone", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  for (const n of [
    max.dailyTokenBudget, max.dailyRequestBudget, max.caller.input24h, max.caller.output24h,
    max.caller.requests24h, max.aggregate.input24h, max.aggregate.output24h, max.aggregate.requests24h,
  ]) {
    assert.ok(Number.isSafeInteger(n), `${n} stays a safe integer`);
    assert.ok(n >= 1);
  }
  assert.equal(max.caller.input24h, Number.MAX_SAFE_INTEGER);
  assert.ok(max.aggregate.input24h >= max.caller.input24h);
});

test("the request budget replaces the desktop and phone count and scales the aggregate by the same factor", () => {
  for (const profile of ["desktop", "phone"] as const) {
    const five = effectiveLimits(profile, null, null);
    assert.equal(five.caller.requests24h, 5_000);
    assert.equal(five.aggregate.requests24h, Math.round(AGGREGATE_LIMITS.requests24h * 5_000 / 4_000));
    const low = effectiveLimits(profile, null, 100);
    assert.equal(low.caller.requests24h, 100);
    assert.equal(low.aggregate.requests24h, Math.round(AGGREGATE_LIMITS.requests24h * 100 / 4_000));
    const one = effectiveLimits(profile, null, 1);
    assert.equal(one.caller.requests24h, 1);
    assert.ok(one.aggregate.requests24h >= 1);
  }
  // Other callers keep their own counts.
  assert.equal(effectiveLimits("reviewer", null, 9_999).caller.requests24h, CALLER_LIMITS.reviewer.requests24h);
  // ...and their own token caps: the 500M default and a 10B raise never widen them.
  for (const profile of ["reviewer", "eval"] as const) {
    for (const budget of [null, 10_000_000_000]) {
      const limits = effectiveLimits(profile, budget, null);
      assert.equal(limits.caller.input24h, CALLER_LIMITS[profile].input24h);
      assert.equal(limits.caller.output24h, CALLER_LIMITS[profile].output24h);
    }
  }
  // The two budgets are independent: tokens do not move requests, nor the reverse.
  assert.equal(effectiveLimits("desktop", 10_000_000_000, null).caller.requests24h, 5_000);
  assert.equal(effectiveLimits("desktop", null, 9_000).caller.input24h, 500_000_000);
});

test("an old limits.json without the request field parses as null, and is still schema 1", () => {
  const box = sandbox();
  try {
    writeFileSync(box.path, JSON.stringify({ schemaVersion: 1, dailyTokenBudget: 45_000_000, updatedAt: "2026-09-01T00:00:00.000Z" }));
    const store = readLimitsStore(box.path);
    assert.equal(store.dailyTokenBudget, 45_000_000, "an explicit stored value is kept");
    assert.equal(store.dailyRequestBudget, null);
    assert.equal(store.schemaVersion, 1);
    assert.equal(effectiveLimits("desktop", store.dailyTokenBudget, store.dailyRequestBudget).caller.requests24h, 5_000);
    assert.equal(effectiveLimits("desktop", null, null).dailyTokenBudget, 500_000_000);
  } finally {
    box.cleanup();
  }
});

test("a corrupt or unsafe file falls back to the defaults, never to no limit", () => {
  const box = sandbox();
  try {
    writeFileSync(box.path, "{ not json");
    assert.deepEqual(readLimitsStore(box.path).dailyTokenBudget, null);
    for (const bad of [1e300, "9", -4, 0, 0.5, Number.MAX_SAFE_INTEGER + 1000]) {
      writeFileSync(box.path, JSON.stringify({ schemaVersion: 1, dailyTokenBudget: bad, dailyRequestBudget: bad }));
      const store = readLimitsStore(box.path);
      assert.equal(store.dailyTokenBudget, null, `token ${bad}`);
      assert.equal(store.dailyRequestBudget, null, `request ${bad}`);
    }
    // A 10B budget is a real value now, not corruption.
    writeFileSync(box.path, JSON.stringify({ schemaVersion: 1, dailyTokenBudget: 10_000_000_000, dailyRequestBudget: 250_000 }));
    const ok = readLimitsStore(box.path);
    assert.equal(ok.dailyTokenBudget, 10_000_000_000);
    assert.equal(ok.dailyRequestBudget, 250_000);
  } finally {
    box.cleanup();
  }
});

test("applyLimitsUpdate: each field on its own, null restores a default, junk is refused untouched", () => {
  const start = { ...emptyLimitsStore(), dailyTokenBudget: 45_000_000, dailyRequestBudget: 7_000 };
  const now = "2026-10-01T00:00:00.000Z";

  const tokensOnly = applyLimitsUpdate(start, { dailyTokenBudget: 10_000_000_000 }, now);
  assert.equal(tokensOnly.ok, true);
  if (tokensOnly.ok) {
    assert.equal(tokensOnly.store.dailyTokenBudget, 10_000_000_000);
    assert.equal(tokensOnly.store.dailyRequestBudget, 7_000, "setting tokens leaves requests alone");
    assert.equal(tokensOnly.store.updatedAt, now);
  }

  const requestsOnly = applyLimitsUpdate(start, { dailyRequestBudget: 1_000_000 }, now);
  assert.equal(requestsOnly.ok, true);
  if (requestsOnly.ok) {
    assert.equal(requestsOnly.store.dailyTokenBudget, 45_000_000, "setting requests leaves tokens alone");
    assert.equal(requestsOnly.store.dailyRequestBudget, 1_000_000);
  }

  const both = applyLimitsUpdate(start, { dailyTokenBudget: 1_000_000_000, dailyRequestBudget: 4_000 }, now);
  assert.equal(both.ok && both.store.dailyTokenBudget, 1_000_000_000);
  assert.equal(both.ok && both.store.dailyRequestBudget, 4_000);

  const resetTokens = applyLimitsUpdate(start, { dailyTokenBudget: null }, now);
  assert.equal(resetTokens.ok && resetTokens.store.dailyTokenBudget, null);
  assert.equal(resetTokens.ok && resetTokens.store.dailyRequestBudget, 7_000);

  rejected(applyLimitsUpdate(start, { dailyTokenBudget: Number.MAX_SAFE_INTEGER + 1 }, now), "token_budget_max");
  rejected(applyLimitsUpdate(start, { dailyTokenBudget: 0 }, now), "token_budget_min");
  rejected(applyLimitsUpdate(start, { dailyRequestBudget: 2.5 }, now), "request_budget_invalid");
  rejected(applyLimitsUpdate(start, { dailyRequestBudget: "lots" }, now), "request_budget_invalid");
  // One bad field refuses the whole update: nothing half applies.
  rejected(applyLimitsUpdate(start, { dailyTokenBudget: 2_000_000_000, dailyRequestBudget: 0 }, now), "request_budget_min");
  // An empty or non-object body names the problem too.
  rejected(applyLimitsUpdate(start, {}, now), "budget_missing");
  rejected(applyLimitsUpdate(start, null, now), "budget_missing");
  rejected(applyLimitsUpdate(start, [], now), "budget_missing");
});

test("the budget cache is per file, and a change shows within the 2s window", () => {
  const first = sandbox();
  const second = sandbox();
  try {
    resetBudgetCache();
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 60_000_000, dailyRequestBudget: 10 }, first.path);
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 5_000_000, dailyRequestBudget: 20 }, second.path);
    assert.equal(currentBudget(first.path), 60_000_000);
    assert.equal(currentBudget(second.path), 5_000_000);
    assert.equal(currentRequestBudget(first.path), 10);
    assert.equal(currentRequestBudget(second.path), 20);

    resetBudgetCache(first.path);
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: null }, first.path);
    assert.equal(currentBudget(first.path), null);
    assert.equal(currentRequestBudget(first.path), null);
    assert.equal(currentBudget(second.path), 5_000_000);
  } finally {
    resetBudgetCache();
    first.cleanup();
    second.cleanup();
  }
});

test("a cut made on disk is enforced once the 2s cache window has passed, with no restart", () => {
  const box = sandbox();
  const realNow = Date.now();
  let clock = realNow;
  const stub = mock.method(Date, "now", () => clock);
  try {
    resetBudgetCache();
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 900_000_000, dailyRequestBudget: 9_000 }, box.path);
    assert.equal(currentBudget(box.path), 900_000_000);
    // Another process writes a cut inside the window; force a distinct mtime.
    writeFileSync(box.path, `${JSON.stringify({ ...emptyLimitsStore(), dailyTokenBudget: 2_000_000, dailyRequestBudget: 3 })}\n`);
    const later = new Date(realNow + 60_000);
    utimesSync(box.path, later, later);
    clock = realNow + 1_000;
    assert.equal(currentBudget(box.path), 900_000_000, "inside the window the cached answer stands");
    clock = realNow + 2_100;
    assert.equal(currentBudget(box.path), 2_000_000);
    assert.equal(currentRequestBudget(box.path), 3);
  } finally {
    stub.mock.restore();
    resetBudgetCache();
    box.cleanup();
  }
});

test("a written store survives the round trip at 0600, both budgets", () => {
  const box = sandbox();
  try {
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 10_000_000_000, dailyRequestBudget: 250_000 }, box.path);
    const stored = readLimitsStore(box.path);
    assert.equal(stored.dailyTokenBudget, 10_000_000_000);
    assert.equal(stored.dailyRequestBudget, 250_000);
    assert.equal(stored.schemaVersion, 1);
    assert.ok(existsSync(box.path));
    assert.equal(statSync(box.path).mode & 0o777, 0o600);
  } finally {
    box.cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBudget,
  DEFAULT_DAILY_TOKEN_BUDGET,
  effectiveLimits,
  emptyLimitsStore,
  MAX_DAILY_TOKEN_BUDGET,
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

test("a budget outside the range the UI offers is refused, not clamped", () => {
  assert.equal(normalizeBudget(MIN_DAILY_TOKEN_BUDGET - 1), undefined);
  assert.equal(normalizeBudget(MAX_DAILY_TOKEN_BUDGET + 1), undefined);
  assert.equal(normalizeBudget("30000000"), undefined);
  assert.equal(normalizeBudget(Number.NaN), undefined);
  assert.equal(normalizeBudget(Number.POSITIVE_INFINITY), undefined);
  // Whole tokens, never snapped up: 3.5M stays 3.5M rather than becoming a
  // 4M budget the owner did not type.
  assert.equal(normalizeBudget(3_500_000), 3_500_000);
  assert.equal(normalizeBudget(30_400_000), 30_400_000);
  assert.equal(normalizeBudget(30_600_000.4), 30_600_000);
});

test("every 24h token limit moves with the budget, so the aggregate cannot cap a raise", () => {
  const shipped = effectiveLimits("desktop", null);
  assert.equal(shipped.dailyTokenBudget, DEFAULT_DAILY_TOKEN_BUDGET);
  assert.equal(shipped.caller.input24h, CALLER_LIMITS.desktop.input24h);
  assert.equal(shipped.caller.output24h, CALLER_LIMITS.desktop.output24h);
  assert.equal(shipped.aggregate.input24h, AGGREGATE_LIMITS.input24h);

  const doubled = effectiveLimits("desktop", DEFAULT_DAILY_TOKEN_BUDGET * 2);
  assert.equal(doubled.caller.input24h, CALLER_LIMITS.desktop.input24h * 2);
  assert.equal(doubled.caller.output24h, CALLER_LIMITS.desktop.output24h * 2);
  assert.equal(doubled.aggregate.input24h, AGGREGATE_LIMITS.input24h * 2);
  assert.equal(doubled.aggregate.output24h, AGGREGATE_LIMITS.output24h * 2);
  // The aggregate stays above the caller's share at any budget, which is the
  // headroom the shipped numbers were chosen for.
  assert.ok(doubled.aggregate.input24h > doubled.caller.input24h);
  // Rates and request counts are not a spend control and do not move.
  assert.equal(doubled.caller.rpm, CALLER_LIMITS.desktop.rpm);
  assert.equal(doubled.caller.requests24h, CALLER_LIMITS.desktop.requests24h);

  // A profile with no token limits keeps none: 0 means unlimited, not 1.
  assert.equal(effectiveLimits("ops", DEFAULT_DAILY_TOKEN_BUDGET * 2).caller.input24h, 0);
});

test("a corrupt or out-of-range file falls back to the shipped budget", () => {
  const box = sandbox();
  try {
    writeFileSync(box.path, "{ not json");
    assert.equal(readLimitsStore(box.path).dailyTokenBudget, null);
    writeFileSync(box.path, JSON.stringify({ schemaVersion: 1, dailyTokenBudget: 9_000_000_000 }));
    assert.equal(readLimitsStore(box.path).dailyTokenBudget, null);
    // Failing open to "no limit" would be the dangerous reading of a bad file.
    assert.equal(effectiveLimits("desktop", readLimitsStore(box.path).dailyTokenBudget).caller.input24h,
      CALLER_LIMITS.desktop.input24h);
  } finally {
    box.cleanup();
  }
});

test("the budget cache is per file, so one store cannot answer for another", () => {
  const first = sandbox();
  const second = sandbox();
  try {
    resetBudgetCache();
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 60_000_000 }, first.path);
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 5_000_000 }, second.path);
    assert.equal(currentBudget(first.path), 60_000_000);
    assert.equal(currentBudget(second.path), 5_000_000);
    // And again from the cache, still not crossed.
    assert.equal(currentBudget(first.path), 60_000_000);
    assert.equal(currentBudget(second.path), 5_000_000);

    resetBudgetCache(first.path);
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: null }, first.path);
    assert.equal(currentBudget(first.path), null);
    assert.equal(currentBudget(second.path), 5_000_000);
  } finally {
    resetBudgetCache();
    first.cleanup();
    second.cleanup();
  }
});

test("a written budget survives the round trip at 0600", () => {
  const box = sandbox();
  try {
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 45_000_000 }, box.path);
    const stored = readLimitsStore(box.path);
    assert.equal(stored.dailyTokenBudget, 45_000_000);
    assert.equal(stored.schemaVersion, 1);
  } finally {
    box.cleanup();
  }
});

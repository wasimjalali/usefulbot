import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRoutineRun,
  claimDueRoutine,
  createRoutine,
  deleteRoutine,
  deleteRoutinesForBot,
  dueRoutines,
  listRoutines,
  claimManualRun,
  claimRunNow,
  nextOccurrence,
  parseRoutinesStore,
  pendingRoutines,
  requestRoutineRun,
  parseSchedule,
  parseSchedules,
  readRoutine,
  readRoutinesStore,
  routineDueAt,
  routineNextRun,
  RUN_HISTORY_MAX,
  sweepOrphanRoutines,
  updateRoutine,
  zonedWallToUtc,
  type Routine,
} from "../shared/routines-store.ts";
import { peekShell, readShell, shellWasReseeded, writeShell } from "../shared/shell-io.ts";
import { SWEEP_INTERVAL_MS, resetSweepClock, sweepOrphanState, sweepOrphanStateIfDue } from "../web/lib/agent-exec.ts";

function sandbox(): { path: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ub-routines-"));
  const previous = process.env.UB_ROUTINES_PATH;
  const path = join(dir, "routines.json");
  process.env.UB_ROUTINES_PATH = path;
  return {
    path,
    restore() {
      if (previous === undefined) delete process.env.UB_ROUTINES_PATH;
      else process.env.UB_ROUTINES_PATH = previous;
    },
  };
}

function weekly(days: number[], time: string) {
  return { kind: "weekly" as const, days, time };
}

// MARK: - Schedule math

test("zonedWallToUtc keeps the wall clock across a DST change", () => {
  // Berlin is UTC+1 in winter and UTC+2 in summer; 09:00 local stays 09:00.
  const winter = zonedWallToUtc(2026, 1, 12, 9, 0, "Europe/Berlin");
  assert.equal(winter.toISOString(), "2026-01-12T08:00:00.000Z");
  const summer = zonedWallToUtc(2026, 7, 13, 9, 0, "Europe/Berlin");
  assert.equal(summer.toISOString(), "2026-07-13T07:00:00.000Z");
});

test("zonedWallToUtc takes the first instant of an ambiguous fall-back hour", () => {
  // 2026-10-25 02:30 happens twice in Berlin: 00:30Z (CEST) and 01:30Z (CET).
  const at = zonedWallToUtc(2026, 10, 25, 2, 30, "Europe/Berlin");
  assert.equal(at.toISOString(), "2026-10-25T00:30:00.000Z");
});

test("zonedWallToUtc shifts a spring-forward gap instead of skipping it", () => {
  // 2026-03-29 02:30 does not exist in Berlin; the clock jumps 02:00 to 03:00.
  const at = zonedWallToUtc(2026, 3, 29, 2, 30, "Europe/Berlin");
  assert.equal(at.toISOString(), "2026-03-29T01:30:00.000Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  assert.equal(parts, "03:30");
});

test("nextOccurrence walks weekly, daily and one-shot schedules", () => {
  const zone = "Europe/Berlin";
  // 2026-09-14 is a Monday.
  const monday = new Date("2026-09-14T06:00:00.000Z");
  const nextMonday = nextOccurrence(weekly([1], "09:00"), zone, monday);
  assert.equal(nextMonday?.toISOString(), "2026-09-14T07:00:00.000Z");

  // Strictly after: the same instant does not match itself again.
  const after = nextOccurrence(weekly([1], "09:00"), zone, new Date("2026-09-14T07:00:00.000Z"));
  assert.equal(after?.toISOString(), "2026-09-21T07:00:00.000Z");

  const daily = nextOccurrence({ kind: "daily", time: "23:30" }, zone, monday);
  assert.equal(daily?.toISOString(), "2026-09-14T21:30:00.000Z");

  const once = nextOccurrence({ kind: "once", date: "2026-12-24", time: "18:00" }, zone, monday);
  assert.equal(once?.toISOString(), "2026-12-24T17:00:00.000Z");
  // A one-shot in the past never fires again.
  assert.equal(nextOccurrence({ kind: "once", date: "2020-01-01", time: "18:00" }, zone, monday), null);
});

test("weekly 09:00 stays 09:00 local across the spring change", () => {
  const zone = "Europe/Berlin";
  // The Sunday before the 2026-03-29 transition, looking for the next Monday.
  const before = new Date("2026-03-23T08:00:00.000Z");
  const nextRun = nextOccurrence(weekly([1], "09:00"), zone, before);
  assert.equal(nextRun?.toISOString(), "2026-03-30T07:00:00.000Z");
});

test("routineNextRun takes the earliest schedule and routineDueAt anchors on the last run", () => {
  const routine: Routine = {
    id: "rtn_x",
    botId: "bot-a",
    name: "Check",
    instruction: "Run the check.",
    schedules: [weekly([1], "09:00"), { kind: "daily", time: "07:00" }],
    timezone: "Europe/Berlin",
    active: true,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    lastRunAt: null,
    runHistory: [],
    manualRunRequested: false,
  };
  // Daily 07:00 Berlin beats weekly Monday 09:00 Berlin on the same day.
  const next = routineNextRun(routine, new Date("2026-09-14T00:00:00.000Z"));
  assert.equal(next?.toISOString(), "2026-09-14T05:00:00.000Z");

  // Nothing is due before the occurrence.
  assert.equal(routineDueAt(routine, new Date("2026-09-14T04:00:00.000Z")), null);
  assert.equal(routineDueAt(routine, new Date("2026-09-14T05:30:00.000Z"))?.toISOString(), "2026-09-14T05:00:00.000Z");
  // The anchor moves with the last run, and the day's second schedule still
  // gets its own occurrence.
  const ranDaily = { ...routine, lastRunAt: "2026-09-14T05:30:00.000Z" };
  assert.equal(routineDueAt(ranDaily, new Date("2026-09-14T08:00:00.000Z"))?.toISOString(), "2026-09-14T07:00:00.000Z");
  const ranBoth = { ...routine, lastRunAt: "2026-09-14T07:30:00.000Z" };
  assert.equal(routineDueAt(ranBoth, new Date("2026-09-14T22:00:00.000Z")), null);
  assert.equal(routineDueAt(ranBoth, new Date("2026-09-15T06:00:00.000Z"))?.toISOString(), "2026-09-15T05:00:00.000Z");

  // Inactive routines never come due.
  assert.equal(routineDueAt({ ...routine, active: false }, new Date("2026-09-14T05:30:00.000Z")), null);
  // Neither does a routine with no schedule.
  assert.equal(routineDueAt({ ...routine, schedules: [] }, new Date("2026-09-14T05:30:00.000Z")), null);
});

test("parseSchedules keeps the supported kinds and drops the rest", () => {
  const parsed = parseSchedules([
    { kind: "weekly", days: [1, 1, 9, 3], time: "09:00" },
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "07:30" },
    { kind: "once", date: "2026-13-01", time: "07:30" },
    { kind: "once", date: "2026-12-01", time: "07:30" },
    { kind: "monthly", time: "07:30" },
    { kind: "weekly", days: [1, 3], time: "09:00" },
  ]);
  assert.deepEqual(parsed, [
    { kind: "weekly", days: [1, 3], time: "09:00" },
    { kind: "daily", time: "07:30" },
    { kind: "once", date: "2026-12-01", time: "07:30" },
  ]);
});

// MARK: - Store

test("routine CRUD round-trips through the locked store", () => {
  const box = sandbox();
  try {
    const created = createRoutine({
      botId: "bot-a",
      name: "  Weekly SEO check  ",
      instruction: "  Check rankings and draft a post.  ",
      schedules: [weekly([1], "09:00")],
      timezone: "Europe/Berlin",
    });
    assert.equal(created.name, "Weekly SEO check");
    assert.equal(created.instruction, "Check rankings and draft a post.");
    assert.equal(created.active, true);
    assert.equal(created.lastRunAt, null);

    assert.equal(listRoutines("bot-a").length, 1);
    assert.equal(listRoutines("bot-b").length, 0);
    assert.equal(readRoutine(created.id)?.id, created.id);

    const toggled = updateRoutine(created.id, { active: false });
    assert.equal(toggled.active, false);
    assert.equal(readRoutine(created.id)?.active, false);

    const renamed = updateRoutine(created.id, { name: "SEO", schedules: [{ kind: "daily", time: "08:15" }] });
    assert.equal(renamed.name, "SEO");
    assert.deepEqual(renamed.schedules, [{ kind: "daily", time: "08:15" }]);

    assert.throws(() => updateRoutine(created.id, { name: "   " }), /routine_name_required/);
    assert.throws(() => updateRoutine(created.id, { timezone: "Mars/Olympus" }), /routine_timezone_invalid/);
    assert.throws(() => updateRoutine("rtn_nope", { name: "x" }), /routine_missing/);
    assert.throws(
      () => createRoutine({ botId: "bot-a", name: "", instruction: "do it" }),
      /routine_name_required/,
    );
    assert.throws(
      () => createRoutine({ botId: "bot-a", name: "x", instruction: "  " }),
      /routine_instruction_required/,
    );
    // A malformed schedules value must fail the create like updateRoutine
    // does, not become a live routine that never fires.
    assert.throws(
      () => createRoutine({ botId: "bot-a", name: "Broken", instruction: "x", schedules: "daily" }),
      /routine_schedules_invalid/,
    );

    assert.equal(deleteRoutine(created.id), true);
    assert.equal(deleteRoutine(created.id), false);
    assert.equal(listRoutines("bot-a").length, 0);
  } finally {
    box.restore();
  }
});

test("run history is bounded and deleting a bot takes its routines", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Daily",
      instruction: "Do the thing.",
      schedules: [{ kind: "daily", time: "09:00" }],
    });
    for (let index = 0; index < RUN_HISTORY_MAX + 5; index += 1) {
      appendRoutineRun(routine.id, { status: index % 2 === 0 ? "ok" : "failed", sessionId: `ses_${index}` });
    }
    const stored = readRoutine(routine.id);
    assert.equal(stored?.runHistory.length, RUN_HISTORY_MAX);
    assert.equal(stored?.runHistory.at(-1)?.sessionId, `ses_${RUN_HISTORY_MAX + 4}`);
    assert.equal(appendRoutineRun("rtn_nope", { status: "ok" }), null);

    createRoutine({ botId: "bot-b", name: "Other", instruction: "Do it.", schedules: [] });
    assert.equal(deleteRoutinesForBot("bot-a"), 1);
    assert.equal(listRoutines("bot-a").length, 0);
    assert.equal(listRoutines("bot-b").length, 1);
  } finally {
    box.restore();
  }
});

test("a due routine fires once when two ticks race", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Weekly",
      instruction: "Draft the report.",
      schedules: [weekly([1], "09:00")],
      timezone: "Europe/Berlin",
    }, undefined, new Date("2026-09-13T00:00:00.000Z"));

    const now = new Date("2026-09-14T07:00:30.000Z");
    assert.equal(dueRoutines(now).map((item) => item.id).join(), routine.id);

    const first = claimDueRoutine(routine.id, now);
    assert.equal(first?.dueAt, "2026-09-14T07:00:00.000Z");
    // The racing tick sees the moved anchor and finds nothing to run.
    assert.equal(claimDueRoutine(routine.id, now), null);
    assert.deepEqual(dueRoutines(now), []);
    assert.equal(readRoutine(routine.id)?.lastRunAt, now.toISOString());

    // The following Monday is due again.
    const nextWeek = new Date("2026-09-21T07:00:05.000Z");
    assert.equal(claimDueRoutine(routine.id, nextWeek)?.dueAt, "2026-09-21T07:00:00.000Z");
  } finally {
    box.restore();
  }
});

test("a long sleep catches up with exactly one run", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Daily",
      instruction: "Do the thing.",
      schedules: [{ kind: "daily", time: "09:00" }],
      timezone: "Europe/Berlin",
    }, undefined, new Date("2026-09-01T00:00:00.000Z"));
    // Two weeks of missed windows collapse into one claim.
    const wake = new Date("2026-09-14T12:00:00.000Z");
    assert.ok(claimDueRoutine(routine.id, wake));
    assert.equal(claimDueRoutine(routine.id, wake), null);
  } finally {
    box.restore();
  }
});

test("an unreadable or future-schema file reads as empty and is moved aside on write", () => {
  const box = sandbox();
  try {
    writeFileSync(box.path, "{not json", "utf8");
    assert.deepEqual(readRoutinesStore(), { schemaVersion: 1, routines: [] });
    writeFileSync(box.path, JSON.stringify({ schemaVersion: 99, routines: [] }), "utf8");
    assert.deepEqual(readRoutinesStore(), { schemaVersion: 1, routines: [] });
    const created = createRoutine({ botId: "bot-a", name: "A", instruction: "b", schedules: [] });
    assert.equal(readRoutine(created.id)?.name, "A");
  } finally {
    box.restore();
  }
});

test("parseRoutinesStore drops malformed rows and duplicate ids", () => {
  const store = parseRoutinesStore({
    schemaVersion: 1,
    routines: [
      { id: "rtn_a", botId: "bot-a", name: "A", instruction: "x", createdAt: "t", updatedAt: "t", nextField: 1 },
      { id: "rtn_a", botId: "bot-a", name: "dupe", instruction: "x", createdAt: "t", updatedAt: "t" },
      { id: "rtn_b", name: "no bot", instruction: "x", createdAt: "t", updatedAt: "t" },
      null,
    ],
  });
  assert.equal(store.routines.length, 1);
  assert.equal(store.routines[0].name, "A");
  assert.equal(store.routines[0].active, true);
});

// MARK: - API guards
//
// Route modules import `next/server`, which only resolves under the bundler, so
// they cannot be invoked from the node test runner. This asserts the source
// contract instead: every routines route has to carry the same desktop gate,
// CSRF check and rate limit as its neighbours, and the read path must not be
// reachable without a session.

const ROUTE_ROOT = join(import.meta.dirname, "..", "web", "app", "api", "routines");

function routeSource(...parts: string[]): string {
  return readFileSync(join(ROUTE_ROOT, ...parts), "utf8");
}

test("every routines route is behind the desktop gate", () => {
  for (const parts of [["route.ts"], ["[id]", "route.ts"], ["[id]", "run", "route.ts"]]) {
    const source = routeSource(...parts);
    const where = parts.join("/");
    // requireOwner rejects a missing session, a non-owner profile, an
    // unknown ingress class and any origin that is not this loopback server.
    assert.match(source, /requireOwner\(request\)/, `${where} misses requireOwner`);
    assert.match(source, /isGateError\(gate\)\)\s*return gate\.error/, `${where} ignores the gate result`);
  }
});

test("routines writes require the CSRF token and a rate-limit bucket", () => {
  for (const parts of [["route.ts"], ["[id]", "route.ts"], ["[id]", "run", "route.ts"]]) {
    const source = routeSource(...parts);
    const where = parts.join("/");
    assert.match(source, /x-ub-csrf/, `${where} misses the CSRF header read`);
    assert.match(source, /csrf !== gate\.session\.csrf/, `${where} misses the CSRF comparison`);
    assert.match(source, /rateLimited\(/, `${where} misses the rate limit`);
  }
  // The read path is a GET on the collection only; no other route exposes one.
  assert.match(routeSource("route.ts"), /export async function GET/);
  assert.doesNotMatch(routeSource("[id]", "route.ts"), /export async function GET/);
  assert.doesNotMatch(routeSource("[id]", "run", "route.ts"), /export async function GET/);
});

test("the manual run route refuses to start without the agent credential", () => {
  const source = routeSource("[id]", "run", "route.ts");
  assert.match(source, /if \(!agentsEnabled\(\)\)/);
  assert.match(source, /agent_credential_missing/);
  // The gate runs before anything reads or starts a routine. The start call
  // is the claim: the route answers after the claim, so a claim failure can
  // still be mapped to a status instead of vanishing into a voided run.
  assert.ok(source.indexOf("requireOwner") < source.indexOf("startRoutineNow"));
});

// MARK: - Agent-requested runs

test("a requested run is claimed once and does not consume the scheduled slot", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Weekly",
      instruction: "Draft the report.",
      schedules: [weekly([1], "09:00")],
      timezone: "Europe/Berlin",
    }, undefined, new Date("2026-09-13T00:00:00.000Z"));

    assert.equal(requestRoutineRun(routine.id), true);
    // A second ask while one is waiting must not queue a second run.
    assert.equal(requestRoutineRun(routine.id), false);
    assert.equal(requestRoutineRun("rtn_nope"), false);

    const quiet = new Date("2026-09-13T06:00:00.000Z");
    assert.deepEqual(dueRoutines(quiet), []);
    assert.equal(pendingRoutines(quiet).map((item) => item.id).join(), routine.id);

    assert.ok(claimManualRun(routine.id));
    // The racing tick finds the request already taken.
    assert.equal(claimManualRun(routine.id), null);
    assert.deepEqual(pendingRoutines(quiet), []);
    // The scheduled Monday is untouched by the manual run.
    assert.equal(readRoutine(routine.id)?.lastRunAt, null);
    assert.equal(routineDueAt(readRoutine(routine.id)!, new Date("2026-09-14T07:30:00.000Z"))?.toISOString(),
      "2026-09-14T07:00:00.000Z");
  } finally {
    box.restore();
  }
});

test("pendingRoutines puts a requested run before the scheduled backlog", () => {
  const box = sandbox();
  try {
    const seeded = new Date("2026-09-13T00:00:00.000Z");
    const scheduled = createRoutine({
      botId: "bot-a",
      name: "Scheduled",
      instruction: "x",
      schedules: [{ kind: "daily", time: "09:00" }],
      timezone: "Europe/Berlin",
    }, undefined, seeded);
    const asked = createRoutine({
      botId: "bot-a",
      name: "Asked",
      instruction: "x",
      schedules: [],
      timezone: "Europe/Berlin",
    }, undefined, seeded);
    requestRoutineRun(asked.id);
    const now = new Date("2026-09-14T12:00:00.000Z");
    assert.deepEqual(pendingRoutines(now).map((item) => item.name), ["Asked", "Scheduled"]);
  } finally {
    box.restore();
  }
});

test("a key a newer build wrote survives a read, a write and a re-parse", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Keep",
      instruction: "x",
      schedules: [{ kind: "daily", time: "09:00" }],
    });
    const raw = JSON.parse(readFileSync(box.path, "utf8")) as Record<string, unknown>;
    (raw.routines as Record<string, unknown>[])[0].futureField = { nested: true };
    raw.futureDoc = "keep me";
    writeFileSync(box.path, JSON.stringify(raw));

    updateRoutine(routine.id, { name: "Renamed" });

    const after = JSON.parse(readFileSync(box.path, "utf8")) as Record<string, unknown>;
    const first = (after.routines as Record<string, unknown>[])[0];
    assert.deepEqual(first.futureField, { nested: true });
    assert.equal(after.futureDoc, "keep me");
    assert.equal(first.name, "Renamed");
    // The carrier itself never reaches the file, and re-parsing what we wrote
    // must not nest one `extra` inside another.
    assert.ok(!("extra" in first));
    assert.ok(!("extra" in after));
    assert.deepEqual(readRoutinesStore().routines[0].extra, { futureField: { nested: true } });
  } finally {
    box.restore();
  }
});

test("a modelled key smuggled into extra is refused, not silently dropped", () => {
  const box = sandbox();
  try {
    createRoutine({ botId: "bot-a", name: "Real", instruction: "x", schedules: [] });
    const raw = JSON.parse(readFileSync(box.path, "utf8")) as Record<string, unknown>;
    (raw.routines as Record<string, unknown>[])[0].extra = { name: "Impostor", other: 1 };
    writeFileSync(box.path, JSON.stringify(raw));
    const parsed = readRoutinesStore().routines[0];
    assert.equal(parsed.name, "Real");
    assert.deepEqual(parsed.extra, { other: 1 });
  } finally {
    box.restore();
  }
});

test("a pass that changes nothing does not rewrite the file", () => {
  const box = sandbox();
  try {
    createRoutine({
      botId: "bot-a",
      name: "Idle",
      instruction: "x",
      schedules: [{ kind: "daily", time: "09:00" }],
    });
    // The write path replaces the file, so the inode is the proof: identical
    // bytes would survive a rewrite, and mtime is filesystem-granular.
    const before = statSync(box.path);
    // Nothing is due, so the claim returns null without touching the document.
    assert.equal(claimDueRoutine("rtn_missing", new Date("2026-09-14T12:00:00.000Z")), null);
    const after = statSync(box.path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    box.restore();
  }
});

test("claimRunNow consumes a waiting request so the tick cannot claim it too", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({ botId: "bot-a", name: "Manual", instruction: "x", schedules: [] });
    assert.equal(requestRoutineRun(routine.id), true);
    const claim = claimRunNow(routine.id);
    assert.equal(claim?.routine.id, routine.id);
    // The ticket is spent: the pump's own claim finds nothing waiting.
    assert.equal(claimManualRun(routine.id), null);
    assert.equal(readRoutine(routine.id)?.manualRunRequested, false);
  } finally {
    box.restore();
  }
});

test("claimRunNow works without a waiting request and leaves the schedule alone", () => {
  const box = sandbox();
  try {
    const routine = createRoutine({
      botId: "bot-a",
      name: "Tested",
      instruction: "x",
      schedules: [{ kind: "daily", time: "09:00" }],
      timezone: "Europe/Berlin",
    });
    assert.equal(claimRunNow(routine.id)?.routine.name, "Tested");
    // A Test run never consumes the next scheduled slot.
    assert.equal(readRoutine(routine.id)?.lastRunAt, null);
    assert.equal(claimRunNow("rtn_missing"), null);
  } finally {
    box.restore();
  }
});

test("a date the calendar does not have is refused", () => {
  assert.equal(parseSchedule({ kind: "once", date: "2026-02-31", time: "09:00" }), null);
  assert.equal(parseSchedule({ kind: "once", date: "2025-02-29", time: "09:00" }), null);
  assert.equal(parseSchedule({ kind: "once", date: "2026-04-31", time: "09:00" }), null);
  assert.deepEqual(
    parseSchedule({ kind: "once", date: "2024-02-29", time: "09:00" }),
    { kind: "once", date: "2024-02-29", time: "09:00" },
  );
  // And it never reaches the scheduler through a hand-edited file either.
  assert.equal(
    nextOccurrence({ kind: "once", date: "2026-02-31", time: "09:00" }, "UTC", new Date("2026-01-01T00:00:00.000Z")),
    null,
  );
});

test("routines whose bot is gone are swept, and an empty roster sweeps nothing", () => {
  const box = sandbox();
  try {
    const live = createRoutine({ botId: "bot-a", name: "Live", instruction: "x", schedules: [] });
    const orphan = createRoutine({ botId: "bot-gone", name: "Orphan", instruction: "x", schedules: [] });
    // An empty roster reads as a failed shell load, never as "delete it all".
    assert.deepEqual(sweepOrphanRoutines([]), []);
    assert.equal(readRoutinesStore().routines.length, 2);
    assert.deepEqual(sweepOrphanRoutines(["bot-a"]), [orphan.id]);
    assert.deepEqual(readRoutinesStore().routines.map((item) => item.id), [live.id]);
    // Idempotent, and it really does not rewrite: a sweep that found nothing
    // must leave the same file behind, not an identical copy of it.
    const before = statSync(box.path);
    assert.deepEqual(sweepOrphanRoutines(["bot-a"]), []);
    assert.equal(statSync(box.path).ino, before.ino);
  } finally {
    box.restore();
  }
});

test("peekShell refuses to repair, so a sweep never runs against a reseed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-peek-"));
  const path = join(dir, "shell.json");
  // Missing and corrupt both read as "no roster", which is what stops the
  // sweep deleting every bot's data against a freshly seeded single-bot store.
  assert.equal(peekShell(path), null);
  writeFileSync(path, "{ not json");
  assert.equal(peekShell(path), null);
  // And the repairing read is left exactly as it was: it still reseeds.
  assert.equal(readShell(path).bots.length > 0, true);
  // Which peekShell now reads back, because the file is valid again.
  assert.equal(peekShell(path)?.bots.length, readShell(path).bots.length);
});

test("a reseeded roster is marked, and the mark clears when it is rebuilt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-reseed-"));
  const path = join(dir, "shell.json");

  // A fresh install is a seed, not a reseed: nothing was lost, so nothing has
  // to be protected from the sweep.
  const fresh = readShell(path);
  assert.equal(shellWasReseeded(path), false);
  assert.equal(fresh.bots.length >= 1, true);

  // A store this build cannot read is renamed aside and replaced with a stub.
  // That stub parses, so `peekShell` cannot tell it from the owner's roster:
  // the marker is the only thing that can.
  writeFileSync(path, "{ not json");
  readShell(path);
  assert.equal(shellWasReseeded(path), true);
  assert.notEqual(peekShell(path), null);

  // Rebuilt or restored, the roster is the owner's again and the mark goes.
  const rebuilt = readShell(path);
  rebuilt.bots = [...rebuilt.bots, { ...rebuilt.bots[0], id: "bot-second", name: "Second" }];
  writeShell(rebuilt, path);
  assert.equal(shellWasReseeded(path), false);
});

test("the sweep stands down while the roster is a recovery stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-sweep-gate-"));
  const shellPath = join(dir, "shell.json");
  const routinesPath = join(dir, "routines.json");
  const previous = {
    shell: process.env.UB_SHELL_PATH,
    routines: process.env.UB_ROUTINES_PATH,
    agents: process.env.UB_AGENT_STORE_PATH,
    images: process.env.UB_IMAGES_DIR,
    widgets: process.env.UB_WIDGETS_DIR,
    media: process.env.UB_MEDIA_INDEX_PATH,
  };
  process.env.UB_SHELL_PATH = shellPath;
  process.env.UB_ROUTINES_PATH = routinesPath;
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  // The sweep also clears images and drawings no event names. Against this
  // empty store that is every one of them, so they must be temp dirs too:
  // pointing at the real ones deleted the owner's images on every test run.
  process.env.UB_IMAGES_DIR = join(dir, "images");
  process.env.UB_WIDGETS_DIR = join(dir, "widgets");
  process.env.UB_MEDIA_INDEX_PATH = join(dir, "media.json");
  try {
    const shell = readShell(shellPath);
    shell.bots = [...shell.bots, { ...shell.bots[0], id: "bot-second", name: "Second" }];
    writeShell(shell, shellPath);
    createRoutine({ botId: "bot-second", name: "Live", instruction: "x", schedules: [] });
    createRoutine({ botId: "bot-gone", name: "Orphan", instruction: "x", schedules: [] });

    // The roster is the owner's, so the orphan goes and the live one stays.
    // Through the tick's throttle: the first call sweeps, a second one a
    // tick later does not, and one a minute later does.
    resetSweepClock();
    assert.equal(sweepOrphanStateIfDue(1_000).length, 1);
    assert.deepEqual(readRoutinesStore().routines.map((item) => item.name), ["Live"]);
    createRoutine({ botId: "bot-gone", name: "Orphan-later", instruction: "x", schedules: [] });
    assert.deepEqual(sweepOrphanStateIfDue(1_000 + 2_500), []);
    assert.equal(readRoutinesStore().routines.length, 2);
    assert.equal(sweepOrphanStateIfDue(1_000 + SWEEP_INTERVAL_MS).length, 1);
    assert.deepEqual(readRoutinesStore().routines.map((item) => item.name), ["Live"]);

    // Now lose the roster. Both routines are orphans against the stub, and
    // that is exactly why the sweep must not run.
    createRoutine({ botId: "bot-gone", name: "Orphan2", instruction: "x", schedules: [] });
    writeFileSync(shellPath, "{ not json");
    readShell(shellPath);
    assert.equal(shellWasReseeded(shellPath), true);
    assert.deepEqual(sweepOrphanState(), []);
    assert.equal(readRoutinesStore().routines.length, 2);

    // Restoring a roster the stub never held takes it out of recovery, and
    // the sweep picks up where it left off.
    const restored = readShell(shellPath);
    restored.bots = [...restored.bots, { ...restored.bots[0], id: "bot-second", name: "Second" }];
    writeShell(restored, shellPath);
    assert.equal(shellWasReseeded(shellPath), false);
    assert.equal(sweepOrphanState().length, 1);
    assert.deepEqual(readRoutinesStore().routines.map((item) => item.name), ["Live"]);
  } finally {
    for (const [key, value] of [
      ["UB_SHELL_PATH", previous.shell],
      ["UB_ROUTINES_PATH", previous.routines],
      ["UB_AGENT_STORE_PATH", previous.agents],
      ["UB_IMAGES_DIR", previous.images],
      ["UB_WIDGETS_DIR", previous.widgets],
      ["UB_MEDIA_INDEX_PATH", previous.media],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the reseed mark tells a restored single-bot backup from the stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-reseed-id-"));
  const path = join(dir, "shell.json");
  // One bot, made long before any reseed: the shape a single-bot owner's
  // backup has, and the shape the stub also has.
  const backup = readShell(path);
  backup.bots = [{ ...backup.bots[0], createdAt: "2020-01-01T00:00:00.000Z" }];
  writeShell(backup, path);
  assert.equal(shellWasReseeded(path), false);

  writeFileSync(path, "{ not json");
  readShell(path);
  assert.equal(shellWasReseeded(path), true);

  // Restoring it brings back the same bot id, so only the creation stamp can
  // say this is the owner's roster and not the stub.
  writeShell(backup, path);
  assert.equal(shellWasReseeded(path), false);
});

test("a mark that cannot be read is treated as a reseed, not as none", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-reseed-bad-"));
  const path = join(dir, "shell.json");
  readShell(path);
  assert.equal(shellWasReseeded(path), false);

  // Corrupt, empty, and structurally valid but naming nothing: each one is a
  // mark whose details are lost, and the safe reading is "still a stub".
  for (const content of ["{ not json", "", '{"at":"x","bots":[]}', '{"at":"x","bots":[1,null]}']) {
    writeFileSync(`${path}.reseeded`, content);
    assert.equal(shellWasReseeded(path), true, `expected a stub for: ${content}`);
    // And it is never cleared on the way past, or the next read would fail open.
    assert.equal(existsSync(`${path}.reseeded`), true);
  }
});

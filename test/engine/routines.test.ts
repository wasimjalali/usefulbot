import assert from "node:assert/strict";
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { EngineError } from "../../agent/engine/protocol.ts";
import { appendRoutineRun, claimManualRun, createRoutine, pendingRoutines, readRoutine, requestRoutineRun, routinesStorePath, tryReadRoutinesStore } from "../../shared/routines-store.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { assertShapes, fixtureLines } from "./shapes.ts";
import { makeWorld, waitForRequests, type World } from "./helpers.ts";

/** Routines (SPEC 5.11): their own chat, the note, the budget, the caps. */

async function routineWorld(options: Parameters<typeof makeWorld>[0] = {}): Promise<{ world: World; chatLinks: Map<string, string | null> }> {
  const chatLinks = new Map<string, string | null>();
  const world = await makeWorld({
    ...options,
    deps: { setRoutineChat: (id, chatId) => { chatLinks.set(id, chatId); }, ...options.deps },
  });
  return { world, chatLinks };
}

function routine(name: string, instruction = `Do ${name}.`) {
  return createRoutine({ botId: DEFAULT_BOT_ID, name, instruction, schedules: [{ kind: "daily", time: "09:00" }] });
}

test("a routine runs in its own chat: a note, no owner bubble, and the run is recorded", async () => {
  const { world, chatLinks } = await routineWorld();
  try {
    const owner = world.newChat();
    const made = routine("Morning summary", "Summarise my morning.");
    world.router.enqueue({ kind: "text", text: "Good morning. Three things today." });
    const started = world.engine.routines.runNow(made.id);
    assert.notEqual(started.chatId, owner, "not the chat the owner is in");
    assert.equal(world.engine.listChats({ botId: DEFAULT_BOT_ID }).current, owner, "the owner's current chat did not move");
    assert.equal(chatLinks.get(made.id), started.chatId);
    const meta = world.engine.host.index.require(started.chatId);
    assert.deepEqual([meta.title, meta.routineId], ["Morning summary", made.id]);
    await world.idle(started.chatId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A subscriber that asks from the start gets the whole run replayed.
    const recorder = world.record(started.chatId, { after: 0, epoch: world.engine.epoch });

    const rows = world.engine.rows(started.chatId, {}).rows;
    assert.deepEqual(rows.map((row) => row.kind), ["note", "assistant"]);
    assert.equal((rows[0] as { text: string; source: string }).text, "Routine Morning summary ran.");
    assert.equal((rows[0] as { source: string }).source, "routine");
    const prompt = JSON.stringify(world.router.requests[0].body.messages);
    assert.match(prompt, /Scheduled run of the routine Morning summary\. Nobody is watching: do not ask questions or wait for cards\./);
    assert.match(prompt, /Summarise my morning\./);

    const run = readRoutine(made.id)?.runHistory.at(-1);
    assert.equal(run?.status, "ok");
    assert.equal(run?.chatId, started.chatId);

    // The shape of a routine's stream is the fixture's.
    const live = recorder.events as Record<string, unknown>[];
    assert.ok(live.some((event) => event.type === "turn.started" && event.origin === "routine" && !("clientId" in event)));
    assert.ok(!live.some((event) => event.type === "message.user"));
    assertShapes(live, fixtureLines("events-routine.ndjson"), { extra: ["activity"] });
  } finally {
    await world.close();
  }
});

test("a second run reuses the chat, and deleting the chat makes the next run start a new one", async () => {
  const { world, chatLinks } = await routineWorld();
  try {
    const made = routine("Weekly review");
    world.router.fallback({ kind: "text", text: "Reviewed." });
    const first = world.engine.routines.runNow(made.id);
    await world.idle(first.chatId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = world.engine.routines.runNow(made.id);
    assert.equal(second.chatId, first.chatId);
    await world.idle(first.chatId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(world.engine.rows(first.chatId, {}).rows.map((row) => row.kind), ["note", "assistant", "note", "assistant"]);
    assert.equal(readRoutine(made.id)?.runHistory.length, 2);

    world.engine.deleteChat(first.chatId);
    const third = world.engine.routines.runNow(made.id);
    assert.notEqual(third.chatId, first.chatId);
    assert.equal(chatLinks.get(made.id), third.chatId);
    await world.idle(third.chatId);
  } finally {
    await world.close();
  }
});

test("at most four run at once, one per routine; the rest wait for the next tick", async () => {
  const { world } = await routineWorld();
  try {
    const made = Array.from({ length: 6 }, (_, i) => routine(`Routine ${i}`));
    for (const item of made) assert.ok(requestRoutineRun(item.id));
    world.router.fallback({ kind: "stall", text: "working" });
    const first = world.engine.routines.tick();
    assert.equal(first.length, 4);
    assert.equal(world.engine.routines.inFlight, 4);
    assert.deepEqual(world.engine.routines.tick(), [], "the cap holds");
    assert.throws(() => world.engine.routines.runNow(first[0]), /routine_busy/, "a routine already running is not started twice");
    await waitForRequests(world, 4);
    world.router.fallback({ kind: "text", text: "done" });
    world.router.release();
    const deadline = Date.now() + 5_000;
    while (world.engine.routines.inFlight > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = world.engine.routines.tick();
    assert.equal(second.length, 2);
    assert.ok(!second.some((id) => first.includes(id)), "the two that waited");
    const done = Date.now() + 5_000;
    while (world.engine.routines.inFlight > 0 && Date.now() < done) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const item of made) assert.equal(readRoutine(item.id)?.runHistory.at(-1)?.status, "ok");
  } finally {
    await world.close();
  }
});

test("a run that overruns its hour, or goes quiet for ten minutes, is stopped and recorded as failed", async () => {
  const { world } = await routineWorld({ engine: { routines: { budgetMs: 150, idleMs: 60_000, checkMs: 20 } } });
  try {
    const slow = routine("Overrun");
    world.router.fallback({ kind: "stall", text: "still going" });
    const started = world.engine.routines.runNow(slow.id);
    await world.idle(started.chatId, 5_000);
    const run = readRoutine(slow.id)?.runHistory.at(-1);
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /longer than an hour/);
    const failure = world.engine.rows(started.chatId, {}).rows.find((row) => row.kind === "failure") as { code: string } | undefined;
    assert.equal(failure?.code, "routine_timeout");
  } finally {
    await world.close();
  }
  const quiet = await routineWorld({ engine: { routines: { budgetMs: 60_000, idleMs: 150, checkMs: 20 } } });
  try {
    const silent = routine("Silent");
    quiet.world.router.fallback({ kind: "hang" });
    const started = quiet.world.engine.routines.runNow(silent.id);
    await quiet.world.idle(started.chatId, 5_000);
    const run = readRoutine(silent.id)?.runHistory.at(-1);
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /ten minutes/);
  } finally {
    await quiet.world.close();
  }
});

test("a routine run waits behind a turn already running in its chat, with no timeout", async () => {
  const { world } = await routineWorld();
  try {
    const made = routine("Behind");
    world.router.fallback({ kind: "text", text: "ran" });
    const first = world.engine.routines.runNow(made.id);
    await world.idle(first.chatId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    world.router.enqueue({ kind: "stall", text: "owner is typing here" });
    world.send(first.chatId, "something else");
    await waitForRequests(world, world.router.requests.length + 1);
    const second = world.engine.routines.runNow(made.id);
    assert.equal(second.queued, true);
    assert.equal(readRoutine(made.id)?.runHistory.length, 1, "not recorded until it has run");
    world.router.release();
    await world.idle(first.chatId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(readRoutine(made.id)?.runHistory.length, 2);
  } finally {
    await world.close();
  }
});

test("a run that fails is recorded with the reason", async () => {
  const { world } = await routineWorld();
  try {
    const made = routine("Doomed");
    world.router.fallback({ kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer." });
    const started = world.engine.routines.runNow(made.id);
    await world.idle(started.chatId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const run = readRoutine(made.id)?.runHistory.at(-1);
    assert.equal(run?.status, "failed");
    assert.equal(run?.error, "The provider didn't answer.");
    // A routine for a bot that is gone cannot start, and says so in its history.
    const orphan = createRoutine({ botId: "bot-gone", name: "Orphan", instruction: "x", schedules: [{ kind: "daily", time: "09:00" }] });
    assert.ok(requestRoutineRun(orphan.id));
    world.engine.routines.tick();
    assert.equal(readRoutine(orphan.id)?.runHistory.at(-1)?.status, "failed");
  } finally {
    await world.close();
  }
});

function chatOf(world: World, routineId: string): string | undefined {
  return world.engine.host.index.all().find((meta) => meta.routineId === routineId)?.chatId;
}

test("review 1: a refused run says nothing ran, and Run now records the refusal", async () => {
  const { world } = await routineWorld();
  try {
    // A bot that is gone refuses the run before Pi sees it.
    const orphan = createRoutine({ botId: "bot-gone", name: "Orphan", instruction: "x", schedules: [{ kind: "daily", time: "09:00" }] });
    assert.throws(() => world.engine.routines.runNow(orphan.id), /bot_missing/);
    const runs = readRoutine(orphan.id)?.runHistory ?? [];
    assert.equal(runs.length, 1, "Run now records the failure");
    assert.equal(runs[0].status, "failed");
    assert.match(runs[0].error ?? "", /bot_missing/);
    const chatId = chatOf(world, orphan.id);
    assert.ok(chatId);
    assert.deepEqual(world.engine.rows(chatId, {}).rows.filter((row) => row.kind === "note"), [], "no 'ran' note for a run that never started");

    // The tick path: same refusal, one failed run, still no note.
    assert.ok(requestRoutineRun(orphan.id));
    world.engine.routines.tick();
    assert.equal(readRoutine(orphan.id)?.runHistory.length, 2);
    assert.deepEqual(world.engine.rows(chatId, {}).rows.filter((row) => row.kind === "note"), []);
  } finally {
    await world.close();
  }
});

test("review 1: a routine store that fails does not take the engine down", async () => {
  const errors: string[] = [];
  const logged = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const crash: Error[] = [];
  const onUncaught = (error: Error) => { crash.push(error); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  let storeDown = true;
  let fragile: ReturnType<typeof routine> | null = null;
  const { world } = await routineWorld({
    engine: {
      routines: {
        tickMs: 20,
        store: {
          // The timer path: a claim that throws inside setInterval.
          pending: (now) => (storeDown && fragile ? [{ ...fragile, manualRunRequested: true }] : pendingRoutines(now)),
          claimManual: (id) => { if (storeDown) throw new Error("store down"); return claimManualRun(id); },
          // The run-end path: recording a finished run throws.
          appendRun: (id, run) => { if (storeDown) throw new Error("store down"); return appendRoutineRun(id, run); },
        },
      },
    },
  });
  const made = routine("Fragile");
  fragile = made;
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(errors.some((line) => line.includes("routine_tick_failed")), "the failed tick was logged");
    assert.equal(world.engine.routines.inFlight, 0);

    world.router.enqueue({ kind: "text", text: "done" });
    const started = world.engine.routines.runNow(made.id);
    await world.idle(started.chatId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(errors.some((line) => line.includes("routine_run_record_failed")), "the lost record was logged");
    assert.equal(world.engine.routines.inFlight, 0, "the run is no longer in flight");
    assert.deepEqual(crash, [], "nothing escaped as an uncaught error or an unhandled rejection");
    storeDown = false;
  } finally {
    console.error = logged;
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    await world.close();
  }
});

test("review 2: an unreadable routines store unlinks nothing", async () => {
  const { world } = await routineWorld();
  try {
    const made = routine("Linked");
    world.router.enqueue({ kind: "text", text: "ok" });
    const started = world.engine.routines.runNow(made.id);
    await world.idle(started.chatId);
    assert.equal(world.engine.host.index.require(started.chatId).routineId, made.id);

    writeFileSync(routinesStorePath(), "{ this is not json");
    world.engine.sweepRoutineLinks();
    assert.equal(world.engine.host.index.require(started.chatId).routineId, made.id, "the link survives a store that cannot be read");

    // Valid JSON under another schema version is just as unreadable.
    writeFileSync(routinesStorePath(), JSON.stringify({ schemaVersion: 99, routines: [] }));
    assert.equal(tryReadRoutinesStore(), null);
    world.engine.sweepRoutineLinks();
    assert.equal(world.engine.host.index.require(started.chatId).routineId, made.id, "a store from another version unlinks nothing");

    // A store that reads fine and no longer has the routine does unlink it.
    writeFileSync(routinesStorePath(), JSON.stringify({ schemaVersion: 1, routines: [] }));
    assert.equal(tryReadRoutinesStore()?.routines.length, 0);
    world.engine.sweepRoutineLinks();
    assert.equal(world.engine.host.index.require(started.chatId).routineId, null);
  } finally {
    await world.close();
  }
});

test("review 2: a busy routines store skips the tick and refuses Run now fast, instead of stalling the engine", async () => {
  const { world } = await routineWorld();
  const lock = `${routinesStorePath()}.lock`;
  const logged = console.error;
  console.error = () => undefined;
  try {
    const made = routine("Locked out");
    assert.ok(requestRoutineRun(made.id));
    mkdirSync(lock);
    const started = Date.now();
    assert.deepEqual(world.engine.routines.tick(), []);
    assert.throws(
      () => world.engine.routines.runNow(made.id),
      (error: unknown) => error instanceof EngineError && error.status === 503 && error.code === "routines_store_busy",
    );
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
    rmdirSync(lock);
    world.router.enqueue({ kind: "text", text: "done" });
    assert.deepEqual(world.engine.routines.tick(), [made.id], "the next tick runs it");
    await world.idle(chatOf(world, made.id) as string);
  } finally {
    console.error = logged;
    rmSync(lock, { recursive: true, force: true });
    await world.close();
  }
});

test("review 3: a busy routines store cannot half-finish a chat delete, and starting a run answers routines_store_busy", async () => {
  let busy = false;
  const { world } = await routineWorld({
    deps: { setRoutineChat: () => { if (busy) throw new Error("routines_locked"); } },
  });
  const logged = console.error;
  console.error = () => undefined;
  try {
    const made = routine("Linked chat");
    world.router.enqueue({ kind: "text", text: "ok" });
    const started = world.engine.routines.runNow(made.id);
    await world.idle(started.chatId);
    world.engine.openChat(started.chatId);
    busy = true;
    const deleted = world.engine.deleteChat(started.chatId);
    assert.equal(world.engine.host.index.get(started.chatId), undefined, "the delete finished");
    assert.equal(world.engine.host.openChatId, null);
    assert.ok(deleted);

    // The routine's chat is gone: the next run must create one, and the busy store refuses it with a retryable 503.
    assert.throws(
      () => world.engine.routines.runNow(made.id),
      (error: unknown) => error instanceof EngineError && error.status === 503 && error.code === "routines_store_busy" && error.fields.retryable === true,
    );
  } finally {
    console.error = logged;
    await world.close();
  }
});

test("review 3: a routine run that waited when the engine stopped is recorded as lost, and a send during the stop is refused", async () => {
  const { world } = await routineWorld();
  try {
    const made = routine("Waiting at shutdown");
    world.router.enqueue({ kind: "text", text: "first run" });
    const first = world.engine.routines.runNow(made.id);
    await world.idle(first.chatId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    world.router.enqueue({ kind: "stall", text: "owner is typing here" });
    world.send(first.chatId, "something else");
    await waitForRequests(world, world.router.requests.length + 1);
    const second = world.engine.routines.runNow(made.id);
    assert.equal(second.queued, true);
    const closing = world.engine.close();
    assert.throws(
      () => world.send(first.chatId, "too late"),
      (error: unknown) => error instanceof EngineError && error.status === 503 && error.code === "engine_stopping",
    );
    assert.throws(() => world.engine.systemTurn(DEFAULT_BOT_ID, "late", "hello"), (error: unknown) => error instanceof EngineError && error.code === "engine_stopping");
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const runs = readRoutine(made.id)?.runHistory ?? [];
    assert.equal(runs.length, 2, "the lost run has a history entry");
    assert.equal(runs.at(-1)?.status, "failed");
    assert.match(runs.at(-1)?.error ?? "", /app stopped/);
  } finally {
    await world.close();
  }
});

test("review 2: a finished run is still recorded when the store is busy at that moment", async () => {
  const { world } = await routineWorld({ engine: { routines: { recordRetryMs: 20 } } });
  const lock = `${routinesStorePath()}.lock`;
  try {
    const made = routine("Recorded late");
    world.router.enqueue({ kind: "stall", text: "working" });
    const started = world.engine.routines.runNow(made.id);
    await waitForRequests(world, 1);
    mkdirSync(lock);
    world.router.release();
    await world.idle(started.chatId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readRoutine(made.id)?.runHistory.length, 0, "not recorded while the lock is held");
    rmdirSync(lock);
    const deadline = Date.now() + 3_000;
    while (readRoutine(made.id)?.runHistory.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readRoutine(made.id)?.runHistory.at(-1)?.status, "ok");
  } finally {
    rmSync(lock, { recursive: true, force: true });
    await world.close();
  }
});

test("review 2: the run's note is filed when its own turn starts, with that turn's id, and never for a run that is dropped", async () => {
  const { world } = await routineWorld();
  try {
    const made = routine("Behind the owner");
    world.router.enqueue({ kind: "text", text: "first run" });
    const first = world.engine.routines.runNow(made.id);
    await world.idle(first.chatId);
    const noteOf = (id: string) => world.engine.rows(id, {}).rows.filter((row) => row.kind === "note");
    assert.equal(noteOf(first.chatId).length, 1);
    const firstNote = noteOf(first.chatId)[0];
    assert.ok(firstNote.turnId, "the note belongs to the run's own turn");
    assert.equal(world.engine.rows(first.chatId, {}).rows.find((row) => row.kind === "assistant")?.turnId, firstNote.turnId);

    // Queued behind an owner turn and then stopped: no note.
    world.router.enqueue({ kind: "stall", text: "owner is typing here" });
    world.send(first.chatId, "something else");
    await waitForRequests(world, world.router.requests.length + 1);
    world.engine.routines.runNow(made.id);
    assert.equal(noteOf(first.chatId).length, 1, "nothing filed while it waits");
    world.engine.cancel(first.chatId);
    await world.idle(first.chatId);
    assert.equal(noteOf(first.chatId).length, 1, "and nothing for a run that was dropped");
  } finally {
    await world.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBotPick,
  botComposerState,
  composerState,
  effectiveDefault,
  ModelSelectionUnavailableError,
  readProviderStore,
  resolveUpstream,
  selectionAvailability,
  updateProviderStore,
} from "../shared/providers.ts";
import {
  botComposer,
  botSelection,
  encodeSelectionHeader,
  lastPick,
  parseSelectionHeader,
  SELECTION_HEADER,
  type ModelSelection,
} from "../shared/session-selection.ts";
import { applyShellAction, parseShell, withBotSelection } from "../shared/shell-store.ts";
import { readShell, updateShell, writeShell } from "../shared/shell-io.ts";
import { readSessionGrant, removeSessionGrant, upsertSessionGrant } from "../shared/workspace-store.ts";
import { exactModelOption, snapComposer } from "../shared/models.ts";
import { catalogFor } from "../shared/live-models.ts";
import { ensureBotSelections, modelSelectionRefusal, pumpHandoffs, startRoutineNow, syncSessionWorkspace } from "../web/lib/agent-exec.ts";
import { applyProvidersDelete, applyProvidersPut, CONNECTION_REMOVED_BOTS_PINNED } from "../web/lib/providers-write.ts";
import { createRoutine, readRoutinesStore } from "../shared/routines-store.ts";
import { queueHandoff, readHandoff } from "../shared/handoffs.ts";
import { listThreadEvents } from "../shared/agent-store.ts";
import { perSessionModel, frozenTurnFor } from "../agent/lib/session-model.ts";
import { windowTokensFor } from "../agent/lib/model-window.ts";
import { buildSnapshot, frozenSelection, snapshotForBot } from "../agent/lib/turn-snapshot.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../shared/policy.ts";
import { routerFetch } from "../agent/lib/router-fetch.ts";
import { routerIds } from "../agent/lib/router-identity.ts";

const PLAIN_UNAVAILABLE = "This bot's model isn't available any more. Pick another model in its chat.";
const GO = "opencode-go:plan";
const OA = "openai:api";

function row(id: string, contextTokens?: number) {
  return {
    id,
    label: id,
    efforts: ["low", "high", "max"],
    defaultEffort: "low",
    speeds: ["standard"],
    defaultSpeed: "standard",
    ...(contextTokens ? { contextTokens } : {}),
  };
}

function connection(id: string, providerId: string, mode: string, key: string) {
  return {
    id,
    providerId,
    mode,
    credential: { kind: "key", key },
    fields: {},
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
}

const KEYS = [
  "UB_PROVIDERS_PATH",
  "UB_MODELS_CACHE_PATH",
  "UB_SHELL_PATH",
  "UB_WORKSPACE_STORE_PATH",
  "UB_ROUTINES_PATH",
  "UB_AGENT_STORE_PATH",
  "UB_HANDOFF_DIR",
  "UB_CHANNEL_JWT",
  "UB_CHANNEL_JWT_SECRET",
  "UB_OPENCODE_GO_KEY",
  "UB_ACTIVE_BOT_ID",
] as const;

/** Every store in a temp dir, with two connections, both listed, and the Go plan as the last pick. */
function withWorld<T>(
  fn: (world: { dir: string; providers: string; shell: string }) => T,
  options: { connections?: Record<string, unknown>; cache?: Record<string, unknown> } = {},
): T {
  const dir = mkdtempSync(join(tmpdir(), "ub-switch-"));
  const providers = join(dir, "providers.json");
  const shell = join(dir, "shell.json");
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.UB_PROVIDERS_PATH = providers;
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  process.env.UB_SHELL_PATH = shell;
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_ROUTINES_PATH = join(dir, "routines.json");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_HANDOFF_DIR = join(dir, "handoffs");
  process.env.UB_CHANNEL_JWT_SECRET = "test-channel-secret";
  delete process.env.UB_CHANNEL_JWT;
  delete process.env.UB_OPENCODE_GO_KEY;
  delete process.env.UB_ACTIVE_BOT_ID;
  writeFileSync(providers, JSON.stringify({
    schemaVersion: 2,
    connections: options.connections ?? {
      [GO]: connection(GO, "opencode-go", "plan", "go-key-12345678"),
      [OA]: connection(OA, "openai", "api", "oa-key-12345678"),
    },
    activeConnectionId: GO,
    selectedModel: "glm-5.3-flash",
    effort: null,
    speed: "standard",
    roles: {},
  }));
  writeFileSync(process.env.UB_MODELS_CACHE_PATH, JSON.stringify({
    schemaVersion: 3,
    providers: options.cache ?? {
      [GO]: { fetchedAt: Date.now(), models: [row("glm-5.3-flash", 1_000_000), row("glm-5", 202_752), row("no-window")] },
      [OA]: { fetchedAt: Date.now(), models: [row("gpt-4.1-mini", 128_000), row("gpt-4.1", 1_047_576)] },
    },
  }));
  const restore = () => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  let result: T;
  try {
    result = fn({ dir, providers, shell });
  } catch (error) {
    restore();
    throw error;
  }
  // An async body keeps the temp stores until it settles.
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

const selGo: ModelSelection = { connectionId: GO, modelId: "glm-5.3-flash", effort: "low", speed: "standard" };
const selGo5: ModelSelection = { connectionId: GO, modelId: "glm-5", effort: "high", speed: "standard" };
const selOa: ModelSelection = { connectionId: OA, modelId: "gpt-4.1", effort: "low", speed: "standard" };

/** A roster with two extra bots, each with the model given (null leaves it unpinned). */
function twoBots(a: ModelSelection | null, b: ModelSelection | null, path: string): { aId: string; bId: string } {
  let store = readShell(path);
  const first = applyShellAction(store, { type: "createBot", name: "Alpha" });
  store = first.store;
  const second = applyShellAction(store, { type: "createBot", name: "Beta" });
  store = second.store;
  store = {
    ...store,
    bots: store.bots.map((bot) => (
      bot.id === first.createdId ? { ...bot, model: a } : bot.id === second.createdId ? { ...bot, model: b } : bot
    )),
  };
  writeShell(store, path);
  return { aId: first.createdId as string, bId: second.createdId as string };
}

/** What the model resolver does at a step: ensure the turn's snapshot for the bot, then take the handle. */
function step<M>(modelFor: (sessionId: string, turnId: string | undefined) => M, sessionId: string, botId: string, turnId: string | undefined): M {
  snapshotForBot(botId, { session: { id: sessionId } }, turnId);
  return modelFor(sessionId, turnId);
}

/** The selection a turn of this bot freezes. */
function frozenFor(sessionId: string, botId: string, turnId: string | undefined) {
  const snapshot = snapshotForBot(botId, { session: { id: sessionId } }, turnId);
  if (snapshot.status !== "ok") assert.fail("no snapshot");
  return snapshot.selection;
}

/** Point a bot's live session at an id. */
function ownSession(botId: string, sessionId: string): void {
  updateShell((current) => ({
    ...current,
    bots: current.bots.map((bot) => (bot.id === botId ? { ...bot, sessionId } : bot)),
  }));
}

test("two bots with different selections resolve different upstreams at the same time", () => {
  withWorld(() => {
    const store = readProviderStore();
    const a = resolveUpstream(store, "workhorse", {}, selGo5);
    const b = resolveUpstream(store, "workhorse", {}, selOa);
    assert.equal(a.providerId, "opencode-go");
    assert.equal(a.modelId, "glm-5");
    assert.equal(a.key, "go-key-12345678");
    assert.equal(a.effort, "high");
    assert.equal(b.providerId, "openai");
    assert.equal(b.modelId, "gpt-4.1");
    assert.equal(b.key, "oa-key-12345678");
    assert.notEqual(a.baseUrl, b.baseUrl);
    // Resolving a selection reads the store and changes nothing: no selection is still the last pick.
    const plain = resolveUpstream(store, "workhorse", {});
    assert.equal(plain.modelId, "glm-5.3-flash");
    assert.equal(plain.providerId, "opencode-go");
  });
});

test("a pick on bot B leaves bot A's stored selection and effort alone", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(selGo, selGo, shell);
    // Another bot picks a different model, then a different effort.
    let store = readProviderStore();
    const bBase = botSelection(readShell(shell).bots.find((bot) => bot.id === bId)!, store);
    const picked = applyBotPick(store, bBase, { modelId: `${OA}::gpt-4.1` });
    updateProviderStore(() => picked.store);
    updateShell((current) => withBotSelection(current, bId, picked.selection), shell);
    store = readProviderStore();
    const effortOnly = applyBotPick(store, picked.selection, { effort: "high" });
    updateShell((current) => withBotSelection(current, bId, effortOnly.selection), shell);

    const after = readShell(shell);
    const a = after.bots.find((bot) => bot.id === aId)!;
    const b = after.bots.find((bot) => bot.id === bId)!;
    assert.deepEqual(a.model, selGo, "A keeps its model, connection, effort and speed");
    assert.equal(b.model?.connectionId, OA);
    assert.equal(b.model?.modelId, "gpt-4.1");
    assert.equal(b.model?.effort, "high");
    // The last pick followed B, but A did not follow the last pick.
    assert.equal(readProviderStore().activeConnectionId, OA);
    assert.deepEqual(botSelection(a, readProviderStore()), selGo);
  });
});

test("ensureBotSelections pins legacy and new bots before the last pick moves, and is idempotent", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(null, selGo5, shell);
    // A legacy roster has no model field at all: it must read as null too.
    const raw = JSON.parse(JSON.stringify(readShell(shell)));
    for (const bot of raw.bots) delete bot.model;
    assert.ok(parseShell(raw).bots.every((bot) => bot.model === null));

    const before = readProviderStore();
    assert.deepEqual(botSelection(readShell(shell).bots.find((bot) => bot.id === aId)!, before), lastPick(before));

    ensureBotSelections();
    const pinned = readShell(shell);
    assert.deepEqual(pinned.bots.find((bot) => bot.id === aId)!.model, lastPick(before));
    assert.deepEqual(pinned.bots.find((bot) => bot.id === bId)!.model, selGo5, "a bot that chose is untouched");
    assert.ok(pinned.bots.every((bot) => bot.model !== null), "the seeded default bot is pinned too");

    // The last pick moves afterwards: nobody follows it.
    const moved = applyBotPick(readProviderStore(), selGo, { modelId: `${OA}::gpt-4.1` });
    updateProviderStore(() => moved.store);
    const afterMove = readShell(shell);
    assert.deepEqual(botSelection(afterMove.bots.find((bot) => bot.id === aId)!, readProviderStore()), lastPick(before));

    ensureBotSelections();
    assert.deepEqual(readShell(shell), afterMove, "a second call changes nothing");
  });
});

test("a turn keeps its selection and window across steps after the store and the bot's pick change, a new turn re-reads", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selGo, null, shell);
    const modelFor = perSessionModel((ids, selection) => ({ ids, selection }), 8, frozenSelection);
    const handle = step(modelFor, "sess-1", aId, "turn-1");
    assert.deepEqual(handle.selection(), { ...selGo, windowTokens: 1_000_000 });

    // Mid turn: the bot's pick moves to another model, the last pick moves, the catalog window changes.
    updateShell((current) => withBotSelection(current, aId, selOa));
    updateProviderStore((current) => ({ ...current, activeConnectionId: OA, selectedModel: "gpt-4.1" }));
    writeFileSync(process.env.UB_MODELS_CACHE_PATH as string, JSON.stringify({
      schemaVersion: 3,
      providers: { [GO]: { fetchedAt: Date.now(), models: [row("glm-5.3-flash", 64_000)] } },
    }));

    // Later steps, a retry and the compaction call are the same turn id.
    for (let index = 0; index < 3; index += 1) {
      assert.equal(step(modelFor, "sess-1", aId, "turn-1"), handle);
      assert.deepEqual(handle.selection(), { ...selGo, windowTokens: 1_000_000 });
      assert.equal(frozenTurnFor("sess-1")?.selection.windowTokens, 1_000_000);
    }
    // The next turn picks up everything that changed.
    assert.equal(step(modelFor, "sess-1", aId, "turn-2"), handle);
    assert.deepEqual(handle.selection(), { ...selOa, windowTokens: UNKNOWN_WINDOW_TOKENS });
    assert.equal(frozenTurnFor("sess-1")?.turnId, "turn-2");
  });
});

test("with no turn id the grant wins over the owner's live pick, so a mid-turn pick waits for the next turn", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selGo, null, shell);
    upsertSessionGrant({ sessionId: "sess-nt", path: null, permission: "auto", selection: selGo });
    const modelFor = perSessionModel((ids, selection) => ({ ids, selection }), 8, frozenSelection);
    const handle = step(modelFor, "sess-nt", aId, undefined);
    assert.equal(handle.selection()?.modelId, selGo.modelId);
    // The owner picks another model mid-turn: the grant is untouched until the next turn starts.
    updateShell((current) => withBotSelection(current, aId, selOa));
    step(modelFor, "sess-nt", aId, undefined);
    assert.equal(handle.selection()?.modelId, selGo.modelId, "the next step keeps the grant's selection");
    // With a turn id the owner's current pick still wins.
    step(modelFor, "sess-nt", aId, "turn-9");
    assert.equal(handle.selection()?.modelId, selOa.modelId);
  });
});

test("every request of a turn sends the frozen selection, through a 429 wait that outlasts a pick", async () => {
  await withWorld(async ({ shell }) => {
    const { aId } = twoBots(selGo5, null, shell);
    const modelFor = perSessionModel((ids, selection) => ({ ids, selection }), 8, frozenSelection);
    const handle = step(modelFor, "sess-2", aId, "turn-1");
    const seen: Array<string | null> = [];
    const fetchStub = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(SELECTION_HEADER));
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { code: "caller_rate_limit", retry_after_ms: 1 } }), { status: 429 })
        : new Response("{}", { status: 200 });
    };
    const send = routerFetch({
      ids: handle.ids,
      selection: handle.selection,
      fetch: fetchStub,
      random: () => 0,
      sleep: async () => {
        // The owner picks another model for this bot while the call waits.
        updateShell((current) => withBotSelection(current, aId, selOa));
        step(modelFor, "sess-2", aId, "turn-1");
      },
    });
    const response = await send("http://router.test/v1/chat/completions", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.deepEqual(parseSelectionHeader(seen[0]), selGo5);

    // No selection getter, no header: the reviewer keeps today's behaviour.
    seen.length = 0;
    await routerFetch({ ids: () => routerIds("sess-3", "t"), fetch: async (_i, init) => {
      seen.push(new Headers(init?.headers).get(SELECTION_HEADER));
      return new Response("{}", { status: 200 });
    } })("http://router.test/v1/chat/completions", { method: "POST" });
    assert.deepEqual(seen, [null]);
  });
});

/** A fake eve: opens a session, then an empty stream. Records the grant at the moment the stream is read. */
function fakeEve(grantAtStream: Array<ReturnType<typeof readSessionGrant>>, sessionId: string) {
  const original = globalThis.fetch;
  let calls = 0;
  let sent = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/stream")) {
      grantAtStream.push(readSessionGrant(sessionId));
      // Echo the envelope the way eve does, then a reply and the end of the turn.
      const lines = [
        { type: "message.received", data: { message: sent } },
        { type: "message.completed", data: { message: "done" } },
        { type: "turn.completed", data: {} },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(lines, { status: 200 });
    }
    if ((init?.method ?? "GET") === "POST") {
      sent = (JSON.parse(String(init?.body)) as { message: string }).message;
      return new Response(JSON.stringify({ sessionId }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
}

test("a routine and a handoff each run on their own bot's selection, not the last pick", async () => {
  await withWorld(async ({ shell }) => {
    const { aId, bId } = twoBots(selGo5, selOa, shell);
    // The last pick is a third model: neither bot may follow it.
    assert.equal(readProviderStore().selectedModel, "glm-5.3-flash");

    const routine = createRoutine({ botId: bId, name: "Daily", instruction: "do it", schedules: [] });
    const routineGrants: Array<ReturnType<typeof readSessionGrant>> = [];
    let eve = fakeEve(routineGrants, "sess-routine-b");
    try {
      await startRoutineNow(routine.id);
    } finally {
      eve.restore();
    }
    assert.equal(routineGrants.length, 1);
    assert.deepEqual(routineGrants[0]?.selection, selOa);
    assert.equal(readRoutinesStore().routines[0].runHistory[0].status, "ok");

    const sender = readShell(shell).bots[0];
    const handoff = queueHandoff({
      sourceBotId: sender.id,
      sourceName: sender.name,
      targetBotId: aId,
      targetName: "Alpha",
      message: "please look at this",
    });
    const handoffGrants: Array<ReturnType<typeof readSessionGrant>> = [];
    eve = fakeEve(handoffGrants, "sess-handoff-a");
    try {
      const result = await pumpHandoffs(1);
      assert.deepEqual(result.failed, []);
    } finally {
      eve.restore();
    }
    assert.equal(handoffGrants.length, 1);
    assert.deepEqual(handoffGrants[0]?.selection, selGo5);
    assert.equal(readHandoff(handoff.id)?.status, "delivered");
  });
});

test("the chip names no model with nothing connected, and keeps a chosen model that is gone", async () => {
  withWorld(() => {
    const store = readProviderStore();
    const none = { ...store, connections: {} };
    // Never chose, nothing connected: the built-in default is not the owner's pick.
    const unchosen = botComposer({ model: null }, none);
    assert.equal(unchosen.modelLabel, "");
    assert.equal(unchosen.modelId, "");
    assert.equal(unchosen.available, false);
    // Chose a model, its provider is gone: still named and unavailable.
    const chosen: ModelSelection = { connectionId: GO, modelId: "glm-5.3-flash", effort: null, speed: "standard" };
    const kept = botComposer({ model: chosen }, none);
    assert.equal(kept.modelId, "glm-5.3-flash");
    assert.notEqual(kept.modelLabel, "");
    assert.equal(kept.available, false);
    // A connected provider whose chosen model left its list: named, unavailable.
    const gone: ModelSelection = { connectionId: GO, modelId: "glm-gone", effort: null, speed: "standard" };
    const goneComposer = botComposer({ model: gone }, store);
    assert.equal(goneComposer.modelId, "glm-gone");
    assert.notEqual(goneComposer.modelLabel, "");
    assert.equal(goneComposer.available, false);
    // Connected, never chose: follows the last pick as before.
    assert.equal(botComposer({ model: null }, store).modelId, botComposerState(store, botSelection({ model: null }, store)).modelId);
  });
});

test("a missing model or a removed connection refuses with model_selection_unavailable and never substitutes", async () => {
  await withWorld(async ({ shell }) => {
    const store = readProviderStore();
    // The model left the fetched list.
    const gone: ModelSelection = { connectionId: GO, modelId: "glm-gone", effort: "high", speed: "standard" };
    assert.deepEqual(selectionAvailability(store, gone), { available: false, reason: "model_missing" });
    const composer = botComposerState(store, gone);
    assert.equal(composer.modelId, "glm-gone", "shown as stored, not replaced by the list's first model");
    assert.equal(composer.available, false);
    assert.equal(composer.effort, "high");
    assert.throws(() => resolveUpstream(store, "workhorse", {}, gone), (error: unknown) => (
      error instanceof ModelSelectionUnavailableError && error.code === "model_selection_unavailable"
    ));
    // A pick that would re-snap effort is refused for it, not quietly moved to another model.
    const exact = snapComposer(GO, "Go", "glm-gone", "high", "standard", catalogFor(GO), [], true);
    assert.equal(exact.modelId, "glm-gone");
    assert.equal(exactModelOption("glm-gone", catalogFor(GO)), null);
    assert.equal(snapComposer(GO, "Go", "glm-gone", "high", "standard", catalogFor(GO)).modelId, "glm-5.3-flash", "the legacy composer keeps its old fallback");

    // The connection is gone.
    const orphan: ModelSelection = { connectionId: "anthropic:api", modelId: "claude-x", effort: null, speed: "standard" };
    assert.deepEqual(selectionAvailability(store, orphan), { available: false, reason: "connection_missing" });
    assert.equal(botComposerState(store, orphan).available, false);
    assert.throws(() => resolveUpstream(store, "workhorse", {}, orphan), /model_selection_unavailable/);
    // And no fallback to the env key for another connection's pick. The Go plan
    // itself, provisioned by the env key alone, is that same connection.
    assert.throws(
      () => resolveUpstream({ ...store, connections: {} }, "workhorse", { UB_OPENCODE_GO_KEY: "env-key-12345678" }, selOa),
      /model_selection_unavailable/,
    );
    assert.equal(
      resolveUpstream({ ...store, connections: {} }, "workhorse", { UB_OPENCODE_GO_KEY: "env-key-12345678" }, selGo).key,
      "env-key-12345678",
    );

    // A routine and a handoff for a bot in this state fail with that code and never reach eve.
    const { aId, bId } = twoBots(gone, orphan, shell);
    const routine = createRoutine({ botId: bId, name: "Daily", instruction: "do it", schedules: [] });
    const eve = fakeEve([], "sess-never");
    try {
      await assert.rejects(startRoutineNow(routine.id), /model_selection_unavailable/);
      const run = readRoutinesStore().routines[0].runHistory[0];
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /model_selection_unavailable/);
      const notes = listThreadEvents(bId).map((event) => ("text" in event ? String(event.text) : ""));
      assert.ok(notes.some((text) => text.includes(PLAIN_UNAVAILABLE)), "the transcript note says it in plain words");
      assert.ok(!notes.some((text) => text.includes("model_selection_unavailable")), "the note never shows the code");

      const handoff = queueHandoff({
        sourceBotId: bId,
        sourceName: "Beta",
        targetBotId: aId,
        targetName: "Alpha",
        message: "hello",
      });
      const result = await pumpHandoffs(1);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].error, PLAIN_UNAVAILABLE);
      // Terminal on the first attempt: another try cannot bring the model back.
      assert.equal(readHandoff(handoff.id)?.status, "failed");
      assert.equal(readHandoff(handoff.id)?.attempts, 1);
      assert.match(readHandoff(handoff.id)?.lastError ?? "", /model_selection_unavailable/);
      const senderNotes = listThreadEvents(bId).map((event) => ("text" in event ? String(event.text) : ""));
      assert.ok(senderNotes.some((text) => text.includes(`failed: ${PLAIN_UNAVAILABLE}`)), "the sender's note is plain too");
      assert.equal(eve.calls(), 0, "nothing was sent to eve");
    } finally {
      eve.restore();
    }
  });
});

test("a free-form model id on a connection with no fetched list is not refused", () => {
  withWorld(() => {
    const ollama = connection("ollama:local", "ollama", "local", "x");
    const store = { ...readProviderStore(), connections: { ...readProviderStore().connections, "ollama:local": { ...ollama, credential: { kind: "none" }, fields: { baseUrl: "http://localhost:11434/v1" } } } };
    const free: ModelSelection = { connectionId: "ollama:local", modelId: "my-private-model:7b", effort: null, speed: "standard" };
    assert.deepEqual(selectionAvailability(store as never, free), { available: true });
    assert.equal(botComposerState(store as never, free).available, true);
    assert.equal(botComposerState(store as never, free).modelId, "my-private-model:7b");
  });
});

test("an unknown window is 32768, and only the selected model's own window counts", () => {
  withWorld(() => {
    assert.equal(UNKNOWN_WINDOW_TOKENS, 32_768);
    assert.equal(windowTokensFor(selGo), 1_000_000);
    // Listed, no window.
    assert.equal(windowTokensFor({ ...selGo, modelId: "no-window" }), 32_768);
    // Not listed: never the first row's 1,000,000.
    assert.equal(windowTokensFor({ ...selGo, modelId: "not-in-the-list" }), 32_768);
    // A connection with no list at all.
    assert.equal(windowTokensFor({ connectionId: "ollama:local", modelId: "x", effort: null, speed: "standard" }), 32_768);
  });
});

test("selections survive a restart: shell, grant and header are read back from disk", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selGo5, null, shell);
    const fresh = parseShell(JSON.parse(JSON.stringify(readShell(shell))));
    assert.deepEqual(fresh.bots.find((bot) => bot.id === aId)?.model, selGo5);

    const bot = readShell(shell).bots.find((item) => item.id === aId)!;
    syncSessionWorkspace("sess-restart", bot);
    assert.deepEqual(readSessionGrant("sess-restart")?.selection, selGo5);
    // A null-model bot is stamped with the last pick, which ensureBotSelections has already pinned for real turns.
    const unpinned = readShell(shell).bots.find((item) => item.model === null)!;
    syncSessionWorkspace("sess-restart-2", unpinned);
    assert.deepEqual(readSessionGrant("sess-restart-2")?.selection, lastPick(readProviderStore()));
  });
});

test("the selection header round trips and a malformed one throws", () => {
  const odd: ModelSelection = { connectionId: "custom:local", modelId: "café/ünï-7b:q4_K_M", effort: "xhigh", speed: "fast" };
  for (const sel of [selGo, selOa, odd, { ...selGo, effort: null }]) {
    const encoded = encodeSelectionHeader(sel);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseSelectionHeader(encoded), sel);
  }
  assert.equal(parseSelectionHeader(null), null);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [
    "",
    "not base64 !!",
    Buffer.from("not json").toString("base64url"),
    b64([]),
    b64({ connectionId: "", modelId: "m", effort: null, speed: "standard" }),
    b64({ connectionId: GO, modelId: 5, effort: null, speed: "standard" }),
    b64({ connectionId: GO, modelId: "m", effort: "turbo", speed: "standard" }),
    b64({ connectionId: GO, modelId: "m", effort: null, speed: "warp" }),
    "A".repeat(5000),
  ]) {
    assert.throws(() => parseSelectionHeader(bad), /selection_header_invalid/, `expected a throw for ${bad.slice(0, 30)}`);
  }
  assert.throws(() => encodeSelectionHeader({ ...selGo, modelId: "" }), /selection_header_invalid/);
});

/** The two files a refused write must leave byte for byte as they were. */
function snapshotStores(providers: string, shell: string): [string | null, string | null] {
  return [
    existsSync(providers) ? readFileSync(providers, "utf8") : null,
    existsSync(shell) ? readFileSync(shell, "utf8") : null,
  ];
}

test("fresh install: connecting a provider leaves a null bot inheriting the new default, and a send is not refused", async () => {
  await withWorld(async ({ shell }) => {
    // Nothing connected: the seeded bot has no model, and its send is refused by the proxy before eve.
    const before = readShell(shell).bots[0];
    assert.equal(before.model, null);
    assert.equal(effectiveDefault(readProviderStore()), null, "nothing usable to pin to yet");
    const refusal = modelSelectionRefusal(before, readProviderStore());
    assert.ok(refusal, "no connection: refused");
    assert.equal(refusal.status, 409);
    assert.deepEqual(await refusal.json(), {
      ok: false,
      error: "model_selection_unavailable",
      message: "This bot's model or its connection is no longer available. Pick a model for it again.",
    });

    // Connect OpenAI (no botId): no pin, the bot follows the new default.
    const { store } = applyProvidersPut({ providerId: "openai", mode: "api", key: "oa-key-12345678" });
    const after = readShell(shell).bots[0];
    assert.equal(after.model, null, "connect does not pin");
    assert.equal(botSelection(after, store).connectionId, OA);
    assert.deepEqual(botSelection(after, store), effectiveDefault(store));
    assert.equal(modelSelectionRefusal(after, readProviderStore()), null, "the send goes through");
  }, { connections: {}, cache: {} });
});

test("a chip pick on bot B pins bot A (null) to the effective default first, so A's stamp keeps the old model", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(null, null, shell);
    const oldDefault = effectiveDefault(readProviderStore());
    assert.ok(oldDefault);
    assert.equal(oldDefault.connectionId, GO);

    const { store, bot } = applyProvidersPut({ botId: bId, modelId: `${OA}::gpt-4.1` });
    assert.equal(bot?.model?.connectionId, OA);
    assert.equal(store.activeConnectionId, OA, "the last pick followed B");
    const roster = readShell(shell);
    const a = roster.bots.find((item) => item.id === aId)!;
    assert.deepEqual(a.model, oldDefault, "A was pinned to what its chip showed");
    assert.ok(roster.bots.every((item) => item.model !== null), "every inheriting bot was pinned");
    syncSessionWorkspace("sess-pin-a", a);
    assert.deepEqual(readSessionGrant("sess-pin-a")?.selection, oldDefault);
  });
});

test("upgrade: a stored model missing from a live list resolves to the substitute the old chip showed, and a pick pins that, not the missing id", () => {
  withWorld(({ shell }) => {
    // glm-5.3-flash (the stored pick) left the fetched list.
    const { aId, bId } = twoBots(null, null, shell);
    const store = readProviderStore();
    const oldChip = composerState(store);
    assert.notEqual(oldChip.modelId, "glm-5.3-flash", "the old chip substituted another model");
    const a = readShell(shell).bots.find((item) => item.id === aId)!;
    assert.equal(botSelection(a, store).modelId, oldChip.modelId);
    assert.equal(botSelection(a, store).effort, oldChip.effort);
    assert.equal(modelSelectionRefusal(a, readProviderStore()), null, "a null bot still runs on the substitute");

    applyProvidersPut({ botId: bId, modelId: `${OA}::gpt-4.1` });
    const pinned = readShell(shell).bots.find((item) => item.id === aId)!;
    assert.equal(pinned.model?.connectionId, GO);
    assert.equal(pinned.model?.modelId, oldChip.modelId, "pinned to the substitute");
    assert.notEqual(pinned.model?.modelId, "glm-5.3-flash");
  }, {
    cache: {
      [GO]: { fetchedAt: Date.now(), models: [row("glm-5", 202_752), row("no-window")] },
      [OA]: { fetchedAt: Date.now(), models: [row("gpt-4.1-mini", 128_000), row("gpt-4.1", 1_047_576)] },
    },
  });
});

test("signing out a bot's connection resets that bot to inherit the new default", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(selOa, selGo5, shell);
    applyProvidersDelete({ connectionId: OA });
    const roster = readShell(shell);
    assert.equal(roster.bots.find((item) => item.id === aId)!.model, null, "A was on the removed connection");
    assert.deepEqual(roster.bots.find((item) => item.id === bId)!.model, selGo5, "B is untouched");
    const store = readProviderStore();
    assert.deepEqual(botSelection(roster.bots.find((item) => item.id === aId)!, store), effectiveDefault(store));
    assert.equal(effectiveDefault(store)?.connectionId, GO);
  });
});

test("a per-bot pick is exact: an unknown bot is a 404 and a missing model a 400, and both write nothing", () => {
  withWorld(({ providers, shell }) => {
    const { aId } = twoBots(null, selGo5, shell);
    const before = snapshotStores(providers, shell);

    assert.throws(() => applyProvidersPut({ botId: "bot-nope", modelId: `${OA}::gpt-4.1` }), /^Error: shell_bot_missing$/);
    assert.deepEqual(snapshotStores(providers, shell), before, "unknown bot: nothing written");

    // Absent from a non-empty catalog: not replaced by the list's first model.
    assert.throws(() => applyProvidersPut({ botId: aId, modelId: `${GO}::glm-not-listed` }), /model_selection_unavailable/);
    assert.throws(() => applyProvidersPut({ botId: aId, modelId: `${OA}::gpt-not-listed` }), /model_selection_unavailable/);
    // A connection that is not there.
    assert.throws(() => applyProvidersPut({ botId: aId, modelId: "anthropic:api::claude-x" }), /model_selection_unavailable/);
    assert.deepEqual(snapshotStores(providers, shell), before, "refused picks: nothing written, no pin");

    // Listed models are stored exactly, effort snapped to that model.
    const { bot } = applyProvidersPut({ botId: aId, modelId: `${OA}::gpt-4.1-mini`, effort: "max" });
    assert.equal(bot?.model?.modelId, "gpt-4.1-mini");
    assert.equal(bot?.model?.effort, "max");
  });
  // No fetched list for the connection: a free-form id is stored as typed.
  withWorld(({ shell }) => {
    const { aId } = twoBots(null, null, shell);
    const { bot } = applyProvidersPut({ botId: aId, modelId: `${OA}::my-local-model` });
    assert.equal(bot?.model?.connectionId, OA);
    assert.equal(bot?.model?.modelId, "my-local-model");
  }, {
    cache: { [GO]: { fetchedAt: Date.now(), models: [row("glm-5.3-flash", 1_000_000), row("glm-5", 202_752)] } },
  });
});

test("the snapshot reads the providers store before the roster, so a fresh default never pairs with a stale pin", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(null, null, shell);
    const order: string[] = [];
    const snapshot = buildSnapshot(aId, { session: { id: "sess-order" } }, "turn-1", new Date(), {
      store: () => { order.push("store"); return readProviderStore(); },
      shell: () => { order.push("shell"); return readShell(shell); },
    });
    assert.deepEqual(order, ["store", "shell"]);
    assert.equal(snapshot.selection.modelId, "glm-5.3-flash");
  });
});

test("a turn's snapshot survives the handle being evicted: the same turn keeps it, a new turn re-reads", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(selGo, selGo5, shell);
    const modelFor = perSessionModel((ids, selection) => ({ ids, selection }), 1, frozenSelection);
    const first = step(modelFor, "sess-evict-1", aId, "turn-T");
    assert.equal(first.selection()?.modelId, selGo.modelId);

    // Another session steps and the cap of one drops sess-evict-1's handle.
    step(modelFor, "sess-evict-2", bId, "turn-U");

    // Mid turn, the bot's pick moves to another model.
    updateShell((current) => withBotSelection(current, aId, selOa));
    const rebuilt = step(modelFor, "sess-evict-1", aId, "turn-T");
    assert.notEqual(rebuilt, first, "the handle really was rebuilt");
    assert.deepEqual(rebuilt.selection(), { ...selGo, windowTokens: 1_000_000 }, "the same turn keeps the frozen selection");

    step(modelFor, "sess-evict-1", aId, "turn-T2");
    assert.equal(rebuilt.selection()?.modelId, selOa.modelId, "a new turn picks up the pick");
  });
});

test("a turn eve starts by itself (a report) freezes the owner's CURRENT selection, not the stale grant", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selGo, null, shell);
    ownSession(aId, "sess-report");
    // The last proxied turn stamped X; the owner has since picked Y.
    upsertSessionGrant({ sessionId: "sess-report", path: null, permission: "auto", selection: selGo });
    applyProvidersPut({ botId: aId, modelId: `${OA}::gpt-4.1` });
    assert.equal(readSessionGrant("sess-report")?.selection?.connectionId, GO, "the grant still says X");
    assert.equal(frozenFor("sess-report", aId, "turn-r0").connectionId, OA, "the report turn runs on Y");
    assert.equal(frozenFor("sess-report", aId, "turn-r0").modelId, "gpt-4.1");

    // Mid-turn picks apply to the next turn only.
    const modelFor = perSessionModel((ids, selection) => ({ ids, selection }), 8, frozenSelection);
    const handle = step(modelFor, "sess-report", aId, "turn-r1");
    applyProvidersPut({ botId: aId, modelId: `${GO}::glm-5` });
    step(modelFor, "sess-report", aId, "turn-r1");
    assert.equal(handle.selection()?.modelId, "gpt-4.1");
    step(modelFor, "sess-report", aId, "turn-r2");
    assert.equal(handle.selection()?.modelId, "glm-5");
  });
});

test("a report turn after the connection was deleted freezes the usable default, not the deleted connection", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selOa, null, shell);
    ownSession(aId, "sess-gone");
    upsertSessionGrant({ sessionId: "sess-gone", path: null, permission: "auto", selection: selOa });
    applyProvidersDelete({ connectionId: OA });
    assert.equal(readShell(shell).bots.find((bot) => bot.id === aId)!.model, null);
    const frozen = frozenFor("sess-gone", aId, "turn-g");
    assert.equal(frozen.connectionId, GO);
    assert.deepEqual({ ...frozen, windowTokens: undefined }, { ...effectiveDefault(readProviderStore()), windowTokens: undefined });
  });
});

test("an effort-only or speed-only pick on a bot whose model is gone is refused, and nothing is written", () => {
  withWorld(({ providers, shell }) => {
    const gone: ModelSelection = { connectionId: GO, modelId: "glm-retired", effort: "low", speed: "standard" };
    const { aId } = twoBots(gone, null, shell);
    const before = snapshotStores(providers, shell);
    assert.throws(() => applyProvidersPut({ botId: aId, effort: "high" }), /model_selection_unavailable/);
    assert.throws(() => applyProvidersPut({ botId: aId, speed: "standard" }), /model_selection_unavailable/);
    assert.deepEqual(snapshotStores(providers, shell), before, "no pins, no last-pick move");
    assert.throws(
      () => applyBotPick(readProviderStore(), gone, { effort: "high" }),
      (error: unknown) => error instanceof ModelSelectionUnavailableError && error.reason === "model_missing",
    );
  });
});

test("a per-bot PUT with an effort or speed that is not a known id is invalid_request and writes nothing", () => {
  withWorld(({ providers, shell }) => {
    const { aId } = twoBots(null, selGo5, shell);
    const before = snapshotStores(providers, shell);
    assert.throws(() => applyProvidersPut({ botId: aId, modelId: `${OA}::gpt-4.1`, effort: "turbo" }), /^Error: invalid_request$/);
    assert.throws(() => applyProvidersPut({ botId: aId, effort: 5 }), /^Error: invalid_request$/);
    assert.throws(() => applyProvidersPut({ botId: aId, speed: "warp" }), /^Error: invalid_request$/);
    for (const modelId of [5, "", null, {}]) {
      assert.throws(() => applyProvidersPut({ botId: aId, modelId }), /^Error: invalid_request$/);
    }
    assert.deepEqual(snapshotStores(providers, shell), before);
    // null effort is a real value, not an invalid one: it is accepted (and snapped to the model's levels).
    assert.doesNotThrow(() => applyProvidersPut({ botId: aId, effort: null }));
  });
});

test("a DELETE whose bot reset fails twice is refused, the connection stays and the bots are untouched", () => {
  withWorld(({ dir, shell }) => {
    twoBots(selOa, null, shell);
    // A path under a regular file: every shell write fails.
    writeFileSync(join(dir, "not-a-dir"), "x");
    process.env.UB_SHELL_PATH = join(dir, "not-a-dir", "shell.json");
    assert.throws(() => applyProvidersDelete({ connectionId: OA }), (error: unknown) => (
      error instanceof Error && error.message === CONNECTION_REMOVED_BOTS_PINNED
    ));
    assert.notEqual(readProviderStore().connections[OA], undefined, "the providers write did not land");
  });
});

const OA2 = "openai:oauth";
const selOa2: ModelSelection = { connectionId: OA2, modelId: "gpt-4.1", effort: "low", speed: "standard" };
const twoOpenAi = {
  connections: {
    [GO]: connection(GO, "opencode-go", "plan", "go-key-12345678"),
    [OA]: connection(OA, "openai", "api", "oa-key-12345678"),
    [OA2]: connection(OA2, "openai", "oauth", "oa2-key-12345678"),
  },
};

test("a DELETE of two connections whose bot reset fails leaves the roster as it was and both connections stay", () => {
  withWorld(({ dir, shell }) => {
    const { aId, bId } = twoBots(selOa, selOa2, shell);
    const rosterBefore = readFileSync(shell, "utf8");
    // A path under a regular file: the one shell write fails, twice.
    writeFileSync(join(dir, "not-a-dir"), "x");
    process.env.UB_SHELL_PATH = join(dir, "not-a-dir", "shell.json");
    assert.throws(() => applyProvidersDelete({ providerId: "openai" }), (error: unknown) => (
      error instanceof Error && error.message === CONNECTION_REMOVED_BOTS_PINNED
    ));
    process.env.UB_SHELL_PATH = shell;
    assert.equal(readFileSync(shell, "utf8"), rosterBefore, "no bot was reset");
    assert.equal(readShell(shell).bots.find((bot) => bot.id === aId)!.model?.connectionId, OA);
    assert.equal(readShell(shell).bots.find((bot) => bot.id === bId)!.model?.connectionId, OA2);
    assert.notEqual(readProviderStore().connections[OA], undefined, "the providers write did not land");
    assert.notEqual(readProviderStore().connections[OA2], undefined, "the providers write did not land");
  }, twoOpenAi);
});

test("a DELETE of two connections resets the bots on both ids in one go", () => {
  withWorld(({ shell }) => {
    const { aId, bId } = twoBots(selOa, selOa2, shell);
    applyProvidersDelete({ providerId: "openai" });
    const roster = readShell(shell);
    assert.equal(roster.bots.find((bot) => bot.id === aId)!.model, null);
    assert.equal(roster.bots.find((bot) => bot.id === bId)!.model, null);
    assert.equal(readProviderStore().connections[OA], undefined);
    assert.equal(readProviderStore().connections[OA2], undefined);
  }, twoOpenAi);
});

test("a permission or folder re-stamp keeps the turn's stamped selection", async () => {
  await withWorld(async ({ shell }) => {
    const { aId } = twoBots(selGo, null, shell);
    syncSessionWorkspace("sess-keep", readShell().bots.find((bot) => bot.id === aId)!);
    assert.equal(readSessionGrant("sess-keep")?.selection?.modelId, selGo.modelId);
    // The owner picks another model for A mid-turn, then changes its permission.
    updateShell((current) => withBotSelection(current, aId, selGo5));
    const moved = readShell().bots.find((bot) => bot.id === aId)!;
    // The route reads the stamped selection first, because a detach revokes
    // the grant before it re-stamps.
    const prior = readSessionGrant("sess-keep")?.selection;
    removeSessionGrant("sess-keep");
    syncSessionWorkspace("sess-keep", { ...moved, permission: "read_only" }, readProviderStore(), { keptSelection: prior });
    const grant = readSessionGrant("sess-keep");
    assert.equal(grant?.permission, "read_only");
    assert.equal(grant?.selection?.modelId, selGo.modelId);
    // The next turn's stamp (no keepSelection) takes the new pick.
    syncSessionWorkspace("sess-keep", moved);
    assert.equal(readSessionGrant("sess-keep")?.selection?.modelId, selGo5.modelId);
  });
});

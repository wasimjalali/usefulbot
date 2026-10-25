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
import { parseShell, withBotSelection } from "../shared/shell-store.ts";
import { withBot } from "./helpers/roster.ts";
import { readShell, updateShell, writeShell } from "../shared/shell-io.ts";
import { readSessionGrant, removeSessionGrant } from "../shared/workspace-store.ts";
import { exactModelOption, snapComposer } from "../shared/models.ts";
import { catalogFor } from "../shared/live-models.ts";
import { ensureBotSelections, restampWorkspaceGrants, syncSessionWorkspace } from "../web/lib/agent-exec.ts";
import { selectionRefusal } from "../agent/engine/selection-refusal.ts";
import { applyProvidersDelete, applyProvidersPut, CONNECTION_REMOVED_BOTS_PINNED } from "../web/lib/providers-write.ts";
import { windowFor } from "../shared/admission.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../shared/policy.ts";

const PLAIN_UNAVAILABLE = "This bot's model or its connection is no longer available. Pick a model for it again.";
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
  "UB_OPENCODE_GO_KEY",
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
  delete process.env.UB_OPENCODE_GO_KEY;
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
  const first = withBot(readShell(path), "Alpha", { model: a });
  const second = withBot(first.store, "Beta", { model: b });
  writeShell(second.store, path);
  return { aId: first.id, bId: second.id };
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

    // A turn for a bot in this state is refused with the typed code and its plain sentence, never run on another model.
    const { aId, bId } = twoBots(gone, orphan, shell);
    const refused = selectionRefusal(readShell(shell).bots.find((bot) => bot.id === bId)!, store);
    assert.deepEqual(refused, { code: "model_selection_unavailable", message: PLAIN_UNAVAILABLE, status: 409 });
    assert.equal(selectionRefusal(readShell(shell).bots.find((bot) => bot.id === aId)!, store)?.code, "model_selection_unavailable");
    assert.equal(selectionRefusal(readShell(shell).bots[0], store), null, "a bot with a listed model is not refused");
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
    const windowOf = (selection: ModelSelection) => windowFor(selection.connectionId, selection.modelId).windowTokens;
    assert.equal(windowOf(selGo), 1_000_000);
    // Listed, no window.
    assert.equal(windowOf({ ...selGo, modelId: "no-window" }), 32_768);
    // Not listed: never the first row's 1,000,000.
    assert.equal(windowOf({ ...selGo, modelId: "not-in-the-list" }), 32_768);
    // A connection with no list at all.
    assert.equal(windowOf({ connectionId: "ollama:local", modelId: "x", effort: null, speed: "standard" }), 32_768);
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

test("a permission change restamps every chat's grant, not only the current chat's, and keeps each turn's model", () => {
  withWorld(({ shell }) => {
    const { aId } = twoBots(selGo5, null, shell);
    const bot = readShell(shell).bots.find((item) => item.id === aId)!;
    // Two chats with turns under way: the open one and a routine's.
    syncSessionWorkspace("chat-open", bot);
    syncSessionWorkspace("chat-routine", bot, undefined, { keptSelection: selGo });
    updateShell((store) => ({ ...store, bots: store.bots.map((item) => (item.id === aId ? { ...item, permission: "read_only" as const } : item)) }), shell);
    restampWorkspaceGrants(aId);
    assert.equal(readSessionGrant("chat-open")?.permission, "read_only");
    assert.equal(readSessionGrant("chat-routine")?.permission, "read_only");
    assert.deepEqual(readSessionGrant("chat-routine")?.selection, selGo, "the running turn's model is kept");
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
    // Nothing connected: the seeded bot has no model, and its send is refused before the engine.
    const before = readShell(shell).bots[0];
    assert.equal(before.model, null);
    assert.equal(effectiveDefault(readProviderStore()), null, "nothing usable to pin to yet");
    const refusal = selectionRefusal(before, readProviderStore());
    assert.ok(refusal, "no connection: refused");
    assert.deepEqual(refusal, {
      code: "model_selection_unavailable",
      message: "This bot's model or its connection is no longer available. Pick a model for it again.",
      status: 409,
    });

    // Connect OpenAI (no botId): no pin, the bot follows the new default.
    const { store } = applyProvidersPut({ providerId: "openai", mode: "api", key: "oa-key-12345678" });
    const after = readShell(shell).bots[0];
    assert.equal(after.model, null, "connect does not pin");
    assert.equal(botSelection(after, store).connectionId, OA);
    assert.deepEqual(botSelection(after, store), effectiveDefault(store));
    assert.equal(selectionRefusal(after, readProviderStore()), null, "the send goes through");
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
    assert.equal(selectionRefusal(a, readProviderStore()), null, "a null bot still runs on the substitute");

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


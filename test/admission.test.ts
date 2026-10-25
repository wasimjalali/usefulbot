import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admission,
  CONTEXT_TOO_LARGE_TEXT,
  descriptionTooLong,
  envelopeFor,
  OUTPUT_RESERVE_TOKENS,
  SHARED_PROMPT_CHARS,
  TOOL_SCHEMA_CHARS,
  windowFor,
} from "../shared/admission.ts";
import { estimateTokens } from "../shared/context-blocks.ts";
import { EngineUnavailableError } from "../shared/engine-client.ts";
import { readProviderStore } from "../shared/providers.ts";
import { readShell, updateShell, writeShell } from "../shared/shell-io.ts";
import { DEFAULT_BOT_ID, DESCRIPTION_MAX, GENERALIST_SEED_V3 } from "../shared/shell-store.ts";
import { botContextReport } from "../web/lib/agent-exec.ts";
import { startStubEngine, withEnv } from "./web/stub-engine.ts";

// Ways admission can fail:
// 1. a bot whose instructions fill the window is let through, or a normal one is refused;
// 2. the engine's measured prompt and tools are ignored, so the check keeps using the estimate;
// 3. the Settings counter shows the web's guess instead of the engine's numbers, or invents a seed for a bot that has none;
// 4. an engine that is down reads as "fits".

const GO = "opencode-go:plan";
/**
 * The small window every test runs against, derived from the constants so a
 * re-measure of the shared prompt or the tool schemas moves it with them: the
 * fixed parts, plus 2,100 tokens for a short context block (about 300) and
 * about 1,800 spare. That is more than a one-line bot needs and less than the
 * 2,286 an 8,000-character description adds, so a normal bot fits and a full
 * one is refused, whatever the constants are.
 */
const WINDOW = estimateTokens(SHARED_PROMPT_CHARS) + estimateTokens(TOOL_SCHEMA_CHARS) + OUTPUT_RESERVE_TOKENS + 2_100;

const KEYS = ["UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH", "UB_SHELL_PATH"] as const;

function row(id: string, contextTokens: number) {
  return { id, label: `Label ${id}`, efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens };
}

/** Every store in a temp dir; one connection with a small-window model and a 1M one. */
async function withWorld<T>(fn: (world: { shell: string; dir: string }) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-admission-"));
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  writeFileSync(process.env.UB_PROVIDERS_PATH, JSON.stringify({
    schemaVersion: 2,
    connections: {
      [GO]: {
        id: GO, providerId: "opencode-go", mode: "plan", credential: { kind: "key", key: "go-key-12345678" },
        fields: {}, updatedAt: new Date().toISOString(), lastError: null,
      },
    },
    activeConnectionId: GO,
    selectedModel: "small",
    effort: null,
    speed: "standard",
    roles: {},
  }));
  writeFileSync(process.env.UB_MODELS_CACHE_PATH, JSON.stringify({
    schemaVersion: 3,
    providers: { [GO]: { fetchedAt: Date.now(), models: [row("small", WINDOW), row("big", 1_000_000)] } },
  }));
  try {
    return await fn({ shell: process.env.UB_SHELL_PATH, dir });
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const pick = (modelId: string) => ({ connectionId: GO, modelId, effort: null, speed: "standard" as const });

let botSeq = 0;

/**
 * A second bot with the given description and model, written straight into the
 * roster (the app makes only the one): the tests below size bots side by side.
 * Returned by id.
 */
function teammate(shell: string, description: string, modelId = "small") {
  const roster = readShell(shell);
  botSeq += 1;
  const id = `bot-test-${botSeq}`;
  // The description goes in verbatim, as the owner's editor saves it.
  writeShell({
    ...roster,
    bots: [...roster.bots, { ...roster.bots[0], id, name: `Alpha ${botSeq}`, label: "", description, model: pick(modelId), chatId: null }],
  }, shell);
  return id;
}

const botOf = (shell: string, id: string) => readShell(shell).bots.find((bot) => bot.id === id)!;

test("SHARED_PROMPT_CHARS is at least the size of agent/instructions.md", () => {
  const bytes = readFileSync(new URL("../agent/instructions.md", import.meta.url)).length;
  assert.ok(SHARED_PROMPT_CHARS >= bytes, `instructions.md is ${bytes} bytes, the constant says ${SHARED_PROMPT_CHARS}`);
  assert.equal(OUTPUT_RESERVE_TOKENS, 4096);
});

test("a bot with a normal description fits, and a longer set of instructions makes a bigger envelope", async () => {
  await withWorld(({ shell }) => {
    const store = readProviderStore();
    const id = teammate(shell, "Watch rankings.");
    const mate = admission({ bot: botOf(shell, id), store, notesChars: 0 });
    const generalist = admission({ bot: botOf(shell, DEFAULT_BOT_ID), store, notesChars: 0 });
    assert.ok(mate.ok && generalist.ok);
    // The Generalist carries the long shipped text; the other bot has one line.
    assert.ok(generalist.tokens > mate.tokens);
    assert.ok(generalist.tokens - mate.tokens < 400, "the difference is the instructions alone");
    assert.equal(mate.windowTokens, WINDOW);
    assert.equal(mate.modelLabel, "Label small");
    const floor = estimateTokens(SHARED_PROMPT_CHARS) + estimateTokens(TOOL_SCHEMA_CHARS) + OUTPUT_RESERVE_TOKENS;
    assert.ok(mate.tokens > floor, "the context block counts on top of the fixed parts");
  });
});

test("an 8,000-character description is refused on a small window and fits on a large one", async () => {
  await withWorld(({ shell }) => {
    const store = readProviderStore();
    const small = teammate(shell, "x".repeat(DESCRIPTION_MAX), "small");
    const refused = admission({ bot: botOf(shell, small), store, notesChars: 0 });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.code, "context_too_large");
    assert.equal(refused.message, CONTEXT_TOO_LARGE_TEXT);
    assert.match(refused.message, /Shorten its instructions/);
    assert.equal(refused.descriptionChars, DESCRIPTION_MAX);
    const big = teammate(shell, "x".repeat(DESCRIPTION_MAX), "big");
    assert.equal(admission({ bot: botOf(shell, big), store, notesChars: 0 }).ok, true);
  });
});

test("hidden text and notes tip a fitting bot over", async () => {
  await withWorld(({ shell }) => {
    const store = readProviderStore();
    const bot = botOf(shell, teammate(shell, "Watch rankings."));
    const base = admission({ bot, store, notesChars: 0 });
    assert.ok(base.ok);
    const room = base.windowTokens - base.tokens;
    const tooBig = Math.ceil(room * 3.5) + 100;
    assert.equal(admission({ bot, store, notesChars: 0, briefChars: tooBig }).ok, false);
    assert.equal(admission({ bot, store, notesChars: tooBig }).ok, false);
    assert.equal(admission({ bot, store, notesChars: 0, briefChars: 1000 }).ok, true);
  });
});

test("tools the chat picked up count: a bot that fits without them is refused with enough of them", async () => {
  await withWorld(({ shell }) => {
    const store = readProviderStore();
    const bot = botOf(shell, teammate(shell, "Watch rankings."));
    const base = admission({ bot, store, notesChars: 0 });
    assert.ok(base.ok);
    const room = (base.windowTokens - base.tokens) * 3.5;
    assert.equal(admission({ bot, store, notesChars: 0, mountedToolChars: room - 100 }).ok, true);
    assert.equal(admission({ bot, store, notesChars: 0, mountedToolChars: room + 100 }).ok, false);
  });
});

test("the engine's measured prompt and tools replace the estimate, and the estimate stands when none is given", async () => {
  await withWorld(({ shell }) => {
    const store = readProviderStore();
    const bot = botOf(shell, teammate(shell, "Watch rankings."));
    const estimated = envelopeFor({ bot, store, notesChars: 0 });
    const same = envelopeFor({ bot, store, notesChars: 0, promptChars: SHARED_PROMPT_CHARS, toolSchemaChars: TOOL_SCHEMA_CHARS });
    assert.equal(same.tokens, estimated.tokens);
    const measured = envelopeFor({ bot, store, notesChars: 0, promptChars: 3_500, toolSchemaChars: 14_000 });
    assert.equal(
      estimated.tokens - measured.tokens,
      estimateTokens(SHARED_PROMPT_CHARS) - estimateTokens(3_500) + estimateTokens(TOOL_SCHEMA_CHARS) - estimateTokens(14_000),
    );
    // A heavier prompt than the estimate is refused where the estimate would have admitted it.
    assert.equal(admission({ bot, store, notesChars: 0 }).ok, true);
    assert.equal(admission({ bot, store, notesChars: 0, promptChars: 40_000 }).ok, false);
  });
});

test("the cap and the window helpers", async () => {
  await withWorld(() => {
    assert.equal(descriptionTooLong({ description: "x".repeat(DESCRIPTION_MAX) }), false);
    assert.equal(descriptionTooLong({ description: "x".repeat(DESCRIPTION_MAX + 1) }), true);
    assert.deepEqual(windowFor(GO, "small"), { windowTokens: WINDOW, modelLabel: "Label small" });
    // A model the catalog does not list has the default window and shows its id.
    assert.deepEqual(windowFor(GO, "not-listed"), { windowTokens: 32_768, modelLabel: "not-listed" });
  });
});

test("the counter report takes the envelope and the window from the engine, and a seed only for the Generalist", async () => {
  await withWorld(async ({ shell }) => {
    const engine = await startStubEngine();
    try {
      await withEnv({ UB_ENGINE_PORT: String(engine.port), UB_ENGINE_TOKEN: engine.token }, async () => {
        const id = teammate(shell, "Watch rankings.");
        const mate = (await botContextReport(id))!;
        assert.equal(mate.max, DESCRIPTION_MAX);
        assert.equal(mate.descriptionChars, "Watch rankings.".length);
        // The stub's numbers, not the web's own guess.
        assert.equal(mate.windowTokens, 32768);
        assert.equal(mate.envelopeTokens, 9000);
        assert.equal(mate.modelLabel, "Label small");
        assert.equal(mate.fits, true);
        assert.equal(mate.seed, null);
        assert.equal(engine.requests.at(-1)?.path, `/internal/bots/${id}/context`);
        assert.equal(engine.requests.at(-1)?.headers.authorization, `Bearer ${engine.token}`);
        assert.equal(await botContextReport("bot-ghost"), null);

        const generalist = (await botContextReport(DEFAULT_BOT_ID))!;
        assert.deepEqual(generalist.seed, { differs: false, text: GENERALIST_SEED_V3 });
        updateShell((current) => ({
          ...current,
          bots: current.bots.map((bot) => (bot.id === DEFAULT_BOT_ID ? { ...bot, description: `${GENERALIST_SEED_V3}\n\nAlways answer in Spanish.` } : bot)),
        }), shell);
        assert.equal((await botContextReport(DEFAULT_BOT_ID))!.seed?.differs, true);
        // Whitespace alone is not a difference.
        updateShell((current) => ({
          ...current,
          bots: current.bots.map((bot) => (bot.id === DEFAULT_BOT_ID ? { ...bot, description: `  ${GENERALIST_SEED_V3.replace(/\n/g, "\n\n")}  ` } : bot)),
        }), shell);
        assert.equal((await botContextReport(DEFAULT_BOT_ID))!.seed?.differs, false);

        // Over the cap: the report says it does not fit, whatever the envelope is.
        const over = teammate(shell, "x".repeat(DESCRIPTION_MAX + 1), "big");
        const report = (await botContextReport(over))!;
        assert.equal(report.descriptionChars, DESCRIPTION_MAX + 1);
        assert.equal(report.fits, false);
        // An envelope past the window does not fit either.
        engine.answer("GET", `/internal/bots/${id}/context`, 200, { ok: true, windowTokens: 8000, instructionTokens: 10, envelopeTokens: 9000 });
        assert.equal((await botContextReport(id))!.fits, false);
      });
    } finally {
      await engine.close();
    }
  });
});

test("the counter report fails loud when the engine is down, refuses it, or answers nonsense", async () => {
  await withWorld(async ({ shell }) => {
    const engine = await startStubEngine();
    const port = engine.port;
    const id = teammate(shell, "Watch rankings.");
    try {
      await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: engine.token }, async () => {
        engine.answer("GET", `/internal/bots/${id}/context`, 404, { ok: false, error: "bot_not_found" });
        await assert.rejects(botContextReport(id), /bot_not_found/);
        engine.answer("GET", `/internal/bots/${id}/context`, 200, { ok: true, windowTokens: "big" });
        await assert.rejects(botContextReport(id), /engine_context_invalid/);
      });
    } finally {
      await engine.close();
    }
    await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
      await assert.rejects(botContextReport(id), (error: unknown) => error instanceof EngineUnavailableError);
    });
  });
});

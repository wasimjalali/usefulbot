import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillSessionOwners,
  bindChildSession,
  bindSession,
  parseSessionOwners,
  readSessionBot,
  readSessionParent,
  readSessionOwners,
  resolveSessionBot,
  sessionCarriesOverFor,
  unbindBot,
} from "../shared/session-bindings.ts";
import { bindTurnBody, turnRewriteFailure } from "../shared/eve-proxy.ts";
import { applyShellAction, DEFAULT_BOT_ID, type ShellStore } from "../shared/shell-store.ts";
import { readShell, writeShell } from "../shared/shell-io.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";
import { createRoutine, readRoutinesStore } from "../shared/routines-store.ts";
import { queueHandoff, readHandoff } from "../shared/handoffs.ts";
import { activeBotId, authoritySessionId, awaitActiveBotId, BotContextMissingError, subAgentRoot } from "../agent/lib/active-bot.ts";
import { sessionPermission } from "../agent/lib/permission.ts";
import { effectiveRoot } from "../agent/lib/workspace.ts";
import { ApprovalStore } from "../agent/lib/approvals.ts";
import { setApprovalStore } from "../agent/lib/write.ts";
import { pumpHandoffs, startRoutineNow } from "../web/lib/agent-exec.ts";
import clearHistory from "../agent/tools/clear_history.ts";
import createRoutineTool from "../agent/tools/create_routine.ts";
import deleteBot from "../agent/tools/delete_bot.ts";
import deleteRoutine from "../agent/tools/delete_routine.ts";
import listBots from "../agent/tools/list_bots.ts";
import listRoutines from "../agent/tools/list_routines.ts";
import memoryRead from "../agent/tools/memory_read.ts";
import memorySearch from "../agent/tools/memory_search.ts";
import memoryUpsert from "../agent/tools/memory_upsert.ts";
import postToGroup from "../agent/tools/post_to_group.ts";
import proposeBot from "../agent/tools/propose_bot.ts";
import proposeGroup from "../agent/tools/propose_group.ts";
import railAction from "../agent/tools/rail_action.ts";
import runRoutine from "../agent/tools/run_routine.ts";
import sendToBot from "../agent/tools/send_to_bot.ts";
import updateBotProfile from "../agent/tools/update_bot_profile.ts";
import updateRoutine from "../agent/tools/update_routine.ts";
import memoryDelete from "../agent/tools/memory_delete.ts";
import generateImage from "../agent/tools/generate_image.ts";
import installCli from "../agent/tools/install_cli.ts";
import proposeConnector from "../agent/tools/propose_connector.ts";
import proposeConnection from "../agent/tools/propose_connection.ts";
import readFileTool from "../agent/tools/read_file.ts";
import writeFileTool from "../agent/tools/write_file.ts";
import listDirTool from "../agent/tools/list_dir.ts";

type Tool = { execute: (input: never, context: never) => unknown };
async function run<T>(tool: Tool, input: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<T> {
  return await tool.execute(input as never, context as never) as T;
}

const GO = "opencode-go:plan";
const KEYS = [
  "UB_SESSION_OWNERS_PATH",
  "UB_BINDING_WAIT_MS",
  "UB_SHELL_PATH",
  "UB_WORKSPACE_STORE_PATH",
  "UB_ROUTINES_PATH",
  "UB_AGENT_STORE_PATH",
  "UB_HANDOFF_DIR",
  "UB_HANDOFF_WAIT_MS",
  "UB_PROVIDERS_PATH",
  "UB_MODELS_CACHE_PATH",
  "UB_MEMORY_ROOT",
  "UB_CHANNEL_JWT",
  "UB_CHANNEL_JWT_SECRET",
  "UB_ACTIVE_BOT_ID",
] as const;

/** Every store in a temp dir, one connection and a roster of two bots. */
async function withWorld<T>(fn: (world: { dir: string; alpha: string; beta: string; owners: string }) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-bind-"));
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const owners = join(dir, "session-owners.json");
  process.env.UB_SESSION_OWNERS_PATH = owners;
  process.env.UB_BINDING_WAIT_MS = "150";
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_ROUTINES_PATH = join(dir, "routines.json");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_HANDOFF_DIR = join(dir, "handoffs");
  process.env.UB_HANDOFF_WAIT_MS = "0";
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  process.env.UB_MEMORY_ROOT = join(dir, "memory");
  process.env.UB_CHANNEL_JWT_SECRET = "test-channel-secret";
  delete process.env.UB_CHANNEL_JWT;
  delete process.env.UB_ACTIVE_BOT_ID;
  writeFileSync(process.env.UB_PROVIDERS_PATH, JSON.stringify({
    schemaVersion: 2,
    connections: {
      [GO]: {
        id: GO,
        providerId: "opencode-go",
        mode: "plan",
        credential: { kind: "key", key: "go-key-12345678" },
        fields: {},
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
    },
    activeConnectionId: GO,
    selectedModel: "glm-5.3-flash",
    effort: null,
    speed: "standard",
    roles: {},
  }));
  writeFileSync(process.env.UB_MODELS_CACHE_PATH, JSON.stringify({
    schemaVersion: 3,
    providers: {
      [GO]: {
        fetchedAt: Date.now(),
        models: [{
          id: "glm-5.3-flash",
          label: "glm-5.3-flash",
          efforts: ["low"],
          defaultEffort: "low",
          speeds: ["standard"],
          defaultSpeed: "standard",
          contextTokens: 200_000,
        }],
      },
    },
  }));
  let store: ShellStore = readShell();
  const alpha = applyShellAction(store, { type: "createBot", name: "Alpha" });
  store = alpha.store;
  const beta = applyShellAction(store, { type: "createBot", name: "Beta" });
  writeShell(beta.store);
  try {
    return await fn({ dir, alpha: alpha.createdId as string, beta: beta.createdId as string, owners });
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function point(botId: string, sessionId: string): void {
  writeShell(applyShellAction(readShell(), { type: "touchChat", botId, preview: "hi", sessionId }).store);
}

// MARK: - The store

test("a session binds once; the same bot again is a no-op and another bot is refused", async () => {
  await withWorld(({ alpha, beta, owners }) => {
    assert.equal(bindSession("sess-1", alpha), "created");
    assert.equal(bindSession("sess-1", alpha), "exists");
    assert.throws(() => bindSession("sess-1", beta), /session_owner_conflict/);
    assert.equal(readSessionBot("sess-1"), alpha, "the refused write changed nothing");
    assert.equal(readSessionBot("sess-unknown"), null);
    // Ids that are not eve session ids never reach the file.
    assert.throws(() => bindSession("../x", alpha), /session_owners_session_id/);
    assert.throws(() => bindSession("a b", alpha), /session_owners_session_id/);
    assert.deepEqual(Object.keys(readSessionOwners(owners).sessions), ["sess-1"]);
  });
});

test("there is no eviction: a hundred sessions all stay bound", async () => {
  await withWorld(({ alpha }) => {
    for (let i = 0; i < 100; i += 1) bindSession(`sess-many-${i}`, alpha);
    assert.equal(Object.keys(readSessionOwners().sessions).length, 100);
    assert.equal(readSessionBot("sess-many-0"), alpha);
  });
});

test("the parse refuses bad shapes instead of repairing them", () => {
  const good = { schemaVersion: 1, sessions: { s1: { botId: "b", createdAt: "2026-01-01T00:00:00.000Z" } } };
  assert.deepEqual(parseSessionOwners(good).sessions.s1.botId, "b");
  assert.throws(() => parseSessionOwners(null), /session_owners_invalid/);
  assert.throws(() => parseSessionOwners([]), /session_owners_invalid/);
  assert.throws(() => parseSessionOwners({ ...good, schemaVersion: 2 }), /session_owners_schema/);
  assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: [] }), /session_owners_sessions/);
  assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { "../x": good.sessions.s1 } }), /session_owners_session_id/);
  assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { s1: { botId: "", createdAt: "2026-01-01T00:00:00.000Z" } } }), /session_owners_bot_id/);
  assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { s1: { botId: "b", createdAt: "nope" } } }), /session_owners_created_at/);
  assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { s1: "b" } }), /session_owners_row/);
});

test("an unreadable file reads as unbound, and the next write backs it up", async () => {
  await withWorld(({ alpha, dir, owners }) => {
    writeFileSync(owners, "{ not json");
    assert.equal(readSessionBot("sess-1"), null);
    assert.equal(bindSession("sess-1", alpha), "created");
    assert.equal(readSessionBot("sess-1"), alpha);
    assert.equal(readdirSync(dir).some((name) => name.startsWith("session-owners.json.invalid.")), true);
  });
});

test("unbindBot drops one bot's rows and nobody else's", async () => {
  await withWorld(({ alpha, beta }) => {
    bindSession("sess-a1", alpha);
    bindSession("sess-a2", alpha);
    bindSession("sess-b1", beta);
    assert.equal(unbindBot(alpha), 2);
    assert.equal(readSessionBot("sess-a1"), null);
    assert.equal(readSessionBot("sess-b1"), beta);
    assert.equal(unbindBot(alpha), 0);
  });
});

test("backfill binds the roster's pointers and skips a pointer another bot already owns", async () => {
  await withWorld(({ alpha, beta }) => {
    point(alpha, "sess-live-a");
    bindSession("sess-contested", alpha);
    // Beta's live pointer names Alpha's session (a hand edit or a bug), and
    // its continued pointer is an ordinary one.
    const shell = readShell();
    const roster: ShellStore = {
      ...shell,
      bots: shell.bots.map((bot) => (
        bot.id === beta ? { ...bot, sessionId: "sess-contested", continuedSessionId: "sess-cont-b" } : bot
      )),
    };
    assert.equal(backfillSessionOwners(roster), 2);
    assert.equal(readSessionBot("sess-live-a"), alpha);
    assert.equal(readSessionBot("sess-cont-b"), beta);
    assert.equal(readSessionBot("sess-contested"), alpha, "the contested pointer was skipped");
    // Running it again adds nothing.
    assert.equal(backfillSessionOwners(roster), 0);
  });
});

test("resolving an unbound session backfills it from the roster, and the binding wins over a pointer", async () => {
  await withWorld(({ alpha, beta }) => {
    point(alpha, "sess-pointer-a");
    assert.equal(readSessionBot("sess-pointer-a"), null, "nothing wrote it yet");
    assert.equal(resolveSessionBot("sess-pointer-a"), alpha);
    assert.equal(readSessionBot("sess-pointer-a"), alpha, "the backfill persisted it");

    // Beta's pointer now claims Alpha's session: the stored binding stands.
    const shell = readShell();
    writeShell({ ...shell, bots: shell.bots.map((bot) => (bot.id === beta ? { ...bot, sessionId: "sess-pointer-a" } : bot)) });
    assert.equal(resolveSessionBot("sess-pointer-a"), alpha);
    // A session no pointer names stays unbound.
    assert.equal(resolveSessionBot("sess-nobody"), null);
  });
});

// MARK: - Who is acting

test("the acting bot is the session's bound bot, not the selected one or the env pin", async () => {
  await withWorld(({ alpha, beta }) => {
    bindSession("sess-a", alpha);
    const shell = readShell();
    // The roster's selection points somewhere else, and so does the pin.
    process.env.UB_ACTIVE_BOT_ID = beta;
    assert.notEqual(shell.selectedBotId, alpha);
    assert.equal(activeBotId(shell, { session: { id: "sess-a" } }), alpha);
    // The env pin is only the test override for a call with no binding.
    assert.equal(activeBotId(shell, { session: { id: "sess-unbound" } }), beta);
    assert.equal(activeBotId(shell), beta);
    delete process.env.UB_ACTIVE_BOT_ID;
    assert.throws(() => activeBotId(shell, { session: { id: "sess-unbound" } }), BotContextMissingError);
    assert.throws(() => activeBotId(shell), /bot_context_missing/);
  });
});

test("a real session with no binding is refused even while the env pin names a bot", async () => {
  await withWorld(({ beta }) => {
    process.env.UB_ACTIVE_BOT_ID = beta;
    const runner = process.env.NODE_TEST_CONTEXT;
    // Outside the test runner, as in a running app: the pin never stands in
    // for a missing binding. A call with no session at all still takes it.
    delete process.env.NODE_TEST_CONTEXT;
    try {
      assert.throws(() => activeBotId(readShell(), { session: { id: "sess-unbound" } }), /bot_context_missing/);
      assert.equal(activeBotId(readShell()), beta);
    } finally {
      if (runner !== undefined) process.env.NODE_TEST_CONTEXT = runner;
    }
  });
});

test("backfill binds neither bot when two point at the same unbound session", async () => {
  await withWorld(({ alpha, beta }) => {
    const shell = readShell();
    const roster: ShellStore = {
      ...shell,
      bots: shell.bots.map((bot) => (bot.id === alpha || bot.id === beta ? { ...bot, sessionId: "sess-both" } : bot)),
    };
    assert.equal(backfillSessionOwners(roster), 0);
    assert.equal(readSessionBot("sess-both"), null);
    assert.equal(resolveSessionBot("sess-both", roster), null);
    // An ordinary pointer next to it still binds.
    const withOne: ShellStore = {
      ...roster,
      bots: roster.bots.map((bot) => (bot.id === alpha ? { ...bot, continuedSessionId: "sess-alpha-only" } : bot)),
    };
    assert.equal(backfillSessionOwners(withOne), 1);
    assert.equal(readSessionBot("sess-alpha-only"), alpha);
    assert.equal(readSessionBot("sess-both"), null);
  });
});

test("backfill also binds previousSessionIds and recents, and treats a shared one as ambiguous", async () => {
  await withWorld(({ alpha, beta }) => {
    const shell = readShell();
    const recent = (id: string, botId: string, sessionId: string | null) => ({
      id, botId, title: "t", sessionId, preview: "", updatedAt: new Date().toISOString(),
    });
    const roster: ShellStore = {
      ...shell,
      bots: shell.bots.map((bot) => (bot.id === alpha ? { ...bot, previousSessionIds: ["sess-old-a"] } : bot)),
      recents: [
        recent("r1", alpha, "sess-recent-a"),
        recent("r2", beta, "sess-recent-b"),
        // A recent of a bot no longer on the roster names no one.
        recent("r3", "bot-gone", "sess-recent-gone"),
        // Both a bot's previous session and a recent of another bot: ambiguous.
        recent("r4", beta, "sess-old-a"),
        recent("r5", alpha, null),
      ],
    };
    assert.equal(backfillSessionOwners(roster), 2);
    assert.equal(readSessionBot("sess-recent-a"), alpha);
    assert.equal(readSessionBot("sess-recent-b"), beta);
    assert.equal(readSessionBot("sess-recent-gone"), null);
    assert.equal(readSessionBot("sess-old-a"), null, "two bots name it, so neither owns it");
    assert.equal(sessionCarriesOverFor("sess-old-a", alpha, roster), false);
    // Resolving a session only an old pointer names binds it.
    const onlyPrevious: ShellStore = {
      ...roster,
      bots: roster.bots.map((bot) => (bot.id === alpha ? { ...bot, previousSessionIds: ["sess-prev-only"] } : bot)),
      recents: [],
    };
    assert.equal(resolveSessionBot("sess-prev-only", onlyPrevious), alpha);
  });
});

test("a routing or store failure on a create is a controlled refusal, never a forwarded body", () => {
  assert.deepEqual(turnRewriteFailure(new Error("eve_message")), { status: 400, error: "eve_message_invalid" });
  assert.deepEqual(turnRewriteFailure(new Error("workspace_locked")), { status: 503, error: "session_route_failed" });
  assert.deepEqual(turnRewriteFailure("boom"), { status: 503, error: "session_route_failed" });
});

test("a child session is unbound by design and refuses even when its id is bound", async () => {
  await withWorld(async ({ alpha, beta }) => {
    bindSession("sess-child", alpha);
    process.env.UB_ACTIVE_BOT_ID = beta;
    const child = { session: { id: "sess-child", parent: { sessionId: "sess-parent", turn: 1 } } };
    assert.throws(() => activeBotId(readShell(), child), /bot_context_missing/);
    await assert.rejects(awaitActiveBotId(readShell(), child), /bot_context_missing/);
  });
});

test("a just-created session is waited for, then refused when nothing binds it", async () => {
  await withWorld(async ({ alpha }) => {
    const shell = readShell();
    // The proxy binds a moment after the tool starts: the wait picks it up.
    const waiting = awaitActiveBotId(shell, { session: { id: "sess-new" } }, 2_000);
    setTimeout(() => bindSession("sess-new", alpha), 120);
    assert.equal(await waiting, alpha);
    // Nothing ever binds this one: the wait is bounded.
    const started = Date.now();
    await assert.rejects(awaitActiveBotId(shell, { session: { id: "sess-never" } }, 200), /bot_context_missing/);
    const took = Date.now() - started;
    assert.ok(took >= 150 && took < 1_500, `waited ${took} ms`);
  });
});

test("every in-app and memory tool refuses an unbound or child session with bot_context_missing", async () => {
  await withWorld(async ({ alpha }) => {
    setApprovalStore(new ApprovalStore(() => 1_000));
    bindSession("sess-bound", alpha);
    for (const id of ["sess-unbound", "sess-bound"]) {
      upsertSessionGrant({ sessionId: id, path: null, permission: "auto" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    }
    const unbound = { session: { id: "sess-unbound" } };
    const child = { session: { id: "sess-bound", parent: { sessionId: "sess-parent", turn: 1 } } };
    const calls: Array<[string, Tool, Record<string, unknown>]> = [
      ["listBots", listBots, {}],
      ["createRoutine", createRoutineTool, { name: "n", instruction: "i", schedules: [{ kind: "daily", time: "09:00" }] }],
      ["listRoutines", listRoutines, {}],
      ["updateRoutine", updateRoutine, { routineId: "rtn_x", active: false }],
      ["deleteRoutine", deleteRoutine, { routineId: "rtn_x" }],
      ["runRoutine", runRoutine, { routineId: "rtn_x" }],
      ["railAction", railAction, { action: "pin", botId: alpha }],
      ["clearHistory", clearHistory, {}],
      ["deleteBot", deleteBot, { botId: alpha }],
      ["updateBotProfile", updateBotProfile, { description: "x" }],
      ["proposeBot", proposeBot, { name: "X" }],
      ["proposeGroup", proposeGroup, { name: "G", memberIds: ["a", "b"] }],
      ["sendToBot", sendToBot, { botId: alpha, message: "hi" }],
      ["postToGroup", postToGroup, { groupId: "g", message: "hi" }],
      ["memorySearch", memorySearch, { query: "x" }],
      ["memoryRead", memoryRead, { id: "note-1" }],
      ["memoryUpsert", memoryUpsert, { expectedRevision: null, title: "t", tags: [], body: "b", expiresAt: null }],
    ];
    for (const [name, tool, input] of calls) {
      for (const [label, ctx] of [["unbound", unbound], ["child", child]] as const) {
        const result = await run<{ status?: string; error?: string }>(tool, input, ctx);
        assert.deepEqual(
          { status: result?.status, error: result?.error },
          { status: "blocked", error: "bot_context_missing" },
          `${name} (${label})`,
        );
      }
    }
    assert.equal(readRoutinesStore().routines.length, 0);
  });
});

// MARK: - The proxy's identity rule

test("a send into an existing session takes its bot from the binding, never the body", () => {
  const body = JSON.stringify({ message: "hello", botId: "bot-a", continueFrom: "old", retry: true });
  // An unbound session is refused before eve sees it.
  assert.deepEqual(bindTurnBody(body, null), { ok: false, error: "session_unbound" });
  // A body naming another bot is refused.
  assert.deepEqual(bindTurnBody(body, "bot-b"), { ok: false, error: "session_bot_mismatch" });
  // The same bot passes, and the other fields ride along untouched.
  const ok = bindTurnBody(body, "bot-a");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? JSON.parse(ok.body) : null, { message: "hello", botId: "bot-a", continueFrom: "old", retry: true });
  // A body with no bot at all takes the bound one.
  const bare = bindTurnBody(JSON.stringify({ message: "hello" }), "bot-a");
  assert.deepEqual(bare.ok ? JSON.parse(bare.body) : null, { message: "hello", botId: "bot-a" });
  // Anything that is not a JSON object is refused.
  assert.deepEqual(bindTurnBody("nope", "bot-a"), { ok: false, error: "eve_message_invalid" });
  assert.deepEqual(bindTurnBody("[1]", "bot-a"), { ok: false, error: "eve_message_invalid" });
  assert.deepEqual(bindTurnBody(JSON.stringify({ message: "x", botId: 5 }), "bot-a"), { ok: false, error: "session_bot_mismatch" });
});

// MARK: - Server-driven turns bind their sessions

/** A fake eve that opens sessions, retires chosen ones, and echoes each turn. */
function fakeEve(options: { created: string[]; retired?: string[] }) {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; url: string }> = [];
  const lastMessage = new Map<string, string>();
  const created = [...options.created];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const match = /\/eve\/v1\/session(?:\/([^/?]+))?(\/stream|\/cancel)?/.exec(url);
    const id = match?.[1] ?? "";
    if (match?.[2] === "/stream") {
      const lines = [
        { type: "message.received", data: { message: lastMessage.get(id) ?? "" } },
        { type: "message.completed", data: { message: "done" } },
        { type: "turn.completed", data: {} },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(lines, { status: 200 });
    }
    if (match?.[2] === "/cancel") return new Response("{}", { status: 200 });
    if (method === "POST") {
      const message = (JSON.parse(String(init?.body)) as { message: string }).message;
      if (id) {
        if (options.retired?.includes(id)) {
          return new Response(JSON.stringify({ code: "session_not_active" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        lastMessage.set(id, message);
        return new Response(JSON.stringify({ sessionId: id }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const fresh = created.shift();
      assert.ok(fresh, "the fake eve ran out of session ids");
      lastMessage.set(fresh, message);
      return new Response(JSON.stringify({ sessionId: fresh }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("a routine on a bot with no session binds the session eve creates", async () => {
  await withWorld(async ({ alpha }) => {
    const routine = createRoutine({ botId: alpha, name: "Daily", instruction: "do it", schedules: [] });
    const eve = fakeEve({ created: ["sess-routine-new"] });
    try {
      await startRoutineNow(routine.id);
    } finally {
      eve.restore();
    }
    assert.equal(readRoutinesStore().routines[0].runHistory[0].status, "ok");
    assert.equal(readSessionBot("sess-routine-new"), alpha);
  });
});

test("a routine continuing a bot's live session binds it from the pointer", async () => {
  await withWorld(async ({ beta }) => {
    point(beta, "sess-live");
    const routine = createRoutine({ botId: beta, name: "Daily", instruction: "do it", schedules: [] });
    const eve = fakeEve({ created: [] });
    try {
      await startRoutineNow(routine.id);
    } finally {
      eve.restore();
    }
    assert.equal(readRoutinesStore().routines[0].runHistory[0].status, "ok");
    assert.equal(readSessionBot("sess-live"), beta);
  });
});

test("a handoff to a bot with no session binds the session eve creates", async () => {
  await withWorld(async ({ alpha, beta }) => {
    const handoff = queueHandoff({
      sourceBotId: alpha,
      sourceName: "Alpha",
      targetBotId: beta,
      targetName: "Beta",
      message: "please look at this",
    });
    const eve = fakeEve({ created: ["sess-handoff-new"] });
    try {
      const result = await pumpHandoffs(1);
      assert.deepEqual(result.failed, []);
    } finally {
      eve.restore();
    }
    assert.equal(readHandoff(handoff.id)?.status, "delivered");
    assert.equal(readSessionBot("sess-handoff-new"), beta);
  });
});

test("the 409 carry-over binds the replacement session to the same bot", async () => {
  await withWorld(async ({ alpha }) => {
    point(alpha, "sess-retired");
    const routine = createRoutine({ botId: alpha, name: "Daily", instruction: "do it", schedules: [] });
    const eve = fakeEve({ created: ["sess-replacement"], retired: ["sess-retired"] });
    try {
      await startRoutineNow(routine.id);
    } finally {
      eve.restore();
    }
    assert.equal(readRoutinesStore().routines[0].runHistory[0].status, "ok");
    assert.equal(readSessionBot("sess-retired"), alpha);
    assert.equal(readSessionBot("sess-replacement"), alpha);
    assert.equal(readShell().bots.find((bot) => bot.id === alpha)?.sessionId, "sess-replacement");
  });
});

test("a pointer naming another bot's session is refused before eve sees the turn", async () => {
  await withWorld(async ({ alpha, beta }) => {
    bindSession("sess-alpha", alpha);
    // Beta's pointer was edited to name Alpha's session.
    point(beta, "sess-alpha");
    const routine = createRoutine({ botId: beta, name: "Daily", instruction: "do it", schedules: [] });
    const eve = fakeEve({ created: [] });
    try {
      await startRoutineNow(routine.id).catch(() => undefined);
    } finally {
      eve.restore();
    }
    assert.equal(readRoutinesStore().routines[0].runHistory[0].status, "failed");
    assert.match(readRoutinesStore().routines[0].runHistory[0].error ?? "", /session_owner_conflict/);
    assert.equal(eve.calls.length, 0, "no request reached eve");
    assert.equal(readSessionBot("sess-alpha"), alpha);
  });
});

test("a routine on either of two bots naming the same unbound session refuses", async () => {
  await withWorld(async ({ alpha, beta }) => {
    const shell = readShell();
    writeShell({
      ...shell,
      bots: shell.bots.map((bot) => (bot.id === alpha || bot.id === beta ? { ...bot, sessionId: "sess-shared" } : bot)),
    });
    const eve = fakeEve({ created: [] });
    try {
      for (const botId of [alpha, beta]) {
        const routine = createRoutine({ botId, name: `Daily ${botId}`, instruction: "do it", schedules: [] });
        await startRoutineNow(routine.id).catch(() => undefined);
        const run = readRoutinesStore().routines.find((item) => item.id === routine.id)?.runHistory[0];
        assert.equal(run?.status, "failed");
        assert.match(run?.error ?? "", /session_binding_ambiguous/);
      }
    } finally {
      eve.restore();
    }
    assert.equal(eve.calls.length, 0, "nothing reached eve");
    assert.equal(readSessionBot("sess-shared"), null);
  });
});

test("a carry-over is allowed only from the destination bot's own session", async () => {
  await withWorld(({ alpha, beta }) => {
    // Bound to Alpha: Alpha may, Beta may not.
    bindSession("sess-a", alpha);
    assert.equal(sessionCarriesOverFor("sess-a", alpha), true);
    assert.equal(sessionCarriesOverFor("sess-a", beta), false);
    // A session id nothing binds and no bot points at is unknown: nobody may carry it over.
    assert.equal(sessionCarriesOverFor("sess-unknown", alpha), false);
    assert.equal(sessionCarriesOverFor("sess-unknown", beta, readShell()), false);
    assert.equal(sessionCarriesOverFor("sess-unknown", alpha, null), false);
    // Both bots point at one unbound session: ambiguous, so neither may.
    const shell = readShell();
    const both: ShellStore = {
      ...shell,
      bots: shell.bots.map((bot) => (bot.id === alpha || bot.id === beta ? { ...bot, sessionId: "sess-both" } : bot)),
    };
    assert.equal(sessionCarriesOverFor("sess-both", alpha, both), false);
    assert.equal(sessionCarriesOverFor("sess-both", beta, both), false);
    // Only Beta points at it: Beta's own.
    const one: ShellStore = {
      ...shell,
      bots: shell.bots.map((bot) => (bot.id === beta ? { ...bot, sessionId: "sess-only-b" } : bot)),
    };
    assert.equal(sessionCarriesOverFor("sess-only-b", beta, one), true);
    assert.equal(sessionCarriesOverFor("sess-only-b", alpha, one), false);
  });
});

test("the default bot is bound like any other", async () => {
  await withWorld(async () => {
    point(DEFAULT_BOT_ID, "sess-default");
    assert.equal(resolveSessionBot("sess-default"), DEFAULT_BOT_ID);
    assert.equal(existsSync(process.env.UB_SESSION_OWNERS_PATH as string), true);
  });
});

// Failure modes for a child binding, written before the code: a child row must
// say which session it is under and still be a plain bot binding for eve; it
// can never be re-pointed at another bot or parent, a root session never gains
// a parent, a bad parent id is refused on read and write, a child cannot be
// carried over, and deleting the bot takes its children with it.
test("a child session is bound to its parent's bot with the parent recorded, immutably", async () => {
  await withWorld(({ owners, alpha, beta }) => {
    bindSession("root-1", alpha, new Date(), owners);
    assert.equal(bindChildSession("kid-1", "root-1", alpha, new Date(), owners), "created");
    assert.equal(readSessionBot("kid-1", owners), alpha);
    assert.equal(readSessionParent("kid-1", owners), "root-1");
    assert.equal(readSessionParent("root-1", owners), null);
    assert.equal(readSessionParent("ghost", owners), null);
    assert.equal(bindChildSession("kid-1", "root-1", alpha, new Date(), owners), "exists");
    assert.throws(() => bindChildSession("kid-1", "root-1", beta, new Date(), owners), /session_owner_conflict/);
    assert.throws(() => bindChildSession("kid-1", "root-2", alpha, new Date(), owners), /session_owner_conflict/);
    // A root session never becomes a child, and a child never becomes a root.
    assert.throws(() => bindChildSession("root-1", "root-2", alpha, new Date(), owners), /session_owner_conflict/);
    assert.equal(bindSession("kid-1", alpha, new Date(), owners), "exists");
    assert.equal(readSessionParent("kid-1", owners), "root-1");
    assert.throws(() => bindChildSession("kid-2", "bad/id", alpha, new Date(), owners), /session_owners_session_id/);
    assert.throws(() => bindChildSession("kid-2", "kid-2", alpha, new Date(), owners), /session_owners_session_id/);
    // Strict parse: a parent that is not a session id is a bad row.
    assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { k: { botId: "a", createdAt: new Date().toISOString(), parentId: "a/b" } } }), /session_owners_parent_id/);
    assert.throws(() => parseSessionOwners({ schemaVersion: 1, sessions: { k: { botId: "a", createdAt: new Date().toISOString(), parentId: 5 } } }), /session_owners_parent_id/);
    // A child is not carried over into a new session, and goes with its bot.
    assert.equal(sessionCarriesOverFor("kid-1", alpha, null, owners), false);
    assert.equal(sessionCarriesOverFor("root-1", alpha, null, owners), true);
    assert.equal(unbindBot(alpha, owners), 2);
    assert.equal(readSessionParent("kid-1", owners), null);
  });
});

// MARK: - Sub-agent children act as their root session's bot (W5)
//
// Failure modes, written before the code. A child (eve `ctx.session.parent`,
// set by eve and never by the model) must:
//  1. of a bound root, act as the root's bot with the root's grant, whatever
//     the shell pin, UB_ACTIVE_BOT_ID or the child's own rows say;
//  2. of an unbound root, a root that is itself a child, a nested hop
//     (parent.sessionId != rootSessionId), a missing or self-referencing
//     rootSessionId, refuse as bot_context_missing, never fall back to a pin;
//  3. refuse when its bot claim names another bot, or its own row names
//     another bot, another parent, or no parent (bound as a root);
//  4. never exceed the root's permission (a grant stamped on the child id is
//     ignored; a Read only root refuses the child's write);
//  5. never write memory, change the roster, routines, groups or profiles, send
//     to bots, install software or generate images (default deny; reads stay);
//  6. not change bot when the owner moves the pin mid-run;
//  7. not bind the child as a root (its row, once written, has the parent).

type Kid = { session: { id: string; parent: unknown; auth?: { current: { attributes: Record<string, unknown> } | null }; turn?: { id: string } }; callId?: string };
function kid(child: string, root: string, opts: { parent?: unknown; claim?: unknown } = {}): Kid {
  return {
    session: {
      id: child,
      parent: opts.parent ?? { callId: "call-1", rootSessionId: root, sessionId: root, turn: { id: "t0", sequence: 0 } },
      ...(opts.claim === undefined ? {} : { auth: { current: { attributes: { botId: opts.claim } } } }),
      turn: { id: "kt1" },
    },
    callId: "kc1",
  };
}

test("a child of a bound root acts as the root's bot, whatever the pin says, and is recorded under its parent", async () => {
  await withWorld(async ({ alpha, beta, owners }) => {
    bindSession("root-1", alpha, new Date(), owners);
    process.env.UB_ACTIVE_BOT_ID = beta;
    point(beta, "somewhere-else");
    const ctx = kid("kid-1", "root-1");
    assert.equal(activeBotId(readShell(), ctx), alpha);
    assert.equal(await awaitActiveBotId(readShell(), ctx), alpha);
    assert.deepEqual(subAgentRoot(ctx), { rootSessionId: "root-1", botId: alpha });
    // The child row names its parent, so it is never a root binding.
    assert.equal(readSessionBot("kid-1", owners), alpha);
    assert.equal(readSessionParent("kid-1", owners), "root-1");
    // The owner moves the pin to Beta mid-run: the child stays Alpha's.
    writeShell({ ...readShell(), selectedBotId: beta });
    assert.equal(activeBotId(readShell(), kid("kid-1", "root-1")), alpha);
    // A claim that agrees is fine.
    assert.equal(activeBotId(readShell(), kid("kid-2", "root-1", { claim: alpha })), alpha);
    // A non-child is untouched.
    assert.equal(subAgentRoot({ session: { id: "root-1" } }), null);
  });
});

test("a child is refused when its root is unbound, a child, nested or malformed, even under the test pin", async () => {
  await withWorld(async ({ alpha, beta, owners }) => {
    process.env.UB_ACTIVE_BOT_ID = beta;
    bindSession("root-1", alpha, new Date(), owners);
    bindChildSession("kid-root", "root-1", alpha, new Date(), owners);
    const bad: Array<[string, Kid]> = [
      ["unbound root", kid("kid-a", "root-unbound")],
      ["root is itself a child", kid("kid-b", "kid-root")],
      ["nested hop", kid("kid-c", "root-1", { parent: { callId: "c", rootSessionId: "root-1", sessionId: "kid-root", turn: { id: "t", sequence: 0 } } })],
      ["no root id", kid("kid-d", "root-1", { parent: { callId: "c", sessionId: "root-1", turn: { id: "t", sequence: 0 } } })],
      ["root id not a string", kid("kid-e", "root-1", { parent: { callId: "c", rootSessionId: 5, sessionId: "root-1", turn: { id: "t", sequence: 0 } } })],
      ["root id not a session id", kid("kid-f", "root-1", { parent: { callId: "c", rootSessionId: "a/b", sessionId: "a/b", turn: { id: "t", sequence: 0 } } })],
      ["child is its own root", kid("root-1", "root-1")],
      ["parent not an object", kid("kid-g", "root-1", { parent: "root-1" })],
    ];
    for (const [label, ctx] of bad) {
      assert.throws(() => activeBotId(readShell(), ctx), /bot_context_missing/, label);
      await assert.rejects(awaitActiveBotId(readShell(), ctx, 100), /bot_context_missing/, label);
      assert.throws(() => authoritySessionId(ctx), /bot_context_missing/, label);
    }
    // Nothing was bound for a refused child.
    for (const id of ["kid-a", "kid-b", "kid-c", "kid-d", "kid-e", "kid-f", "kid-g"]) assert.equal(readSessionBot(id, owners), null, id);
  });
});

test("a child whose claim or own row disagrees with its root is refused", async () => {
  await withWorld(async ({ alpha, beta, owners }) => {
    bindSession("root-1", alpha, new Date(), owners);
    bindSession("root-2", alpha, new Date(), owners);
    // The claim names another bot.
    assert.throws(() => activeBotId(readShell(), kid("kid-1", "root-1", { claim: beta })), /bot_context_missing/);
    assert.equal(readSessionBot("kid-1", owners), null);
    // A claim that is not a string is no claim (eve projects only strings), the root decides.
    assert.equal(activeBotId(readShell(), kid("kid-1b", "root-1", { claim: 7 })), alpha);
    // The child's own row names another bot, another parent, or no parent.
    bindChildSession("kid-2", "root-1", beta, new Date(), owners);
    assert.throws(() => activeBotId(readShell(), kid("kid-2", "root-1")), /bot_context_missing/);
    bindChildSession("kid-3", "root-2", alpha, new Date(), owners);
    assert.throws(() => activeBotId(readShell(), kid("kid-3", "root-1")), /bot_context_missing/);
    bindSession("kid-4", alpha, new Date(), owners);
    assert.throws(() => activeBotId(readShell(), kid("kid-4", "root-1")), /bot_context_missing/);
    assert.equal(readSessionParent("kid-4", owners), null, "a root row was not turned into a child row");
  });
});

test("a child holds exactly its root's permission and workspace, never its own grant", async () => {
  await withWorld(async ({ alpha, dir, owners }) => {
    const folder = join(realpathSync(dir), "work");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.txt"), "hello");
    setApprovalStore(new ApprovalStore(() => 1_000));
    const store = process.env.UB_WORKSPACE_STORE_PATH;
    bindSession("root-ro", alpha, new Date(), owners);
    bindSession("root-auto", alpha, new Date(), owners);
    bindSession("root-nogrant", alpha, new Date(), owners);
    upsertSessionGrant({ sessionId: "root-ro", path: folder, permission: "read_only" }, new Date(), store);
    upsertSessionGrant({ sessionId: "root-auto", path: folder, permission: "auto" }, new Date(), store);
    // Someone stamps a stronger grant on the child's own id: it must not count.
    upsertSessionGrant({ sessionId: "kid-ro", path: folder, permission: "full_access" }, new Date(), store);
    const ro = kid("kid-ro", "root-ro");
    const auto = kid("kid-auto", "root-auto");
    const none = kid("kid-none", "root-nogrant");
    assert.equal(sessionPermission(ro), "read_only");
    assert.equal(sessionPermission(auto), "auto");
    assert.equal(sessionPermission(none), "read_only");
    assert.equal(effectiveRoot(authoritySessionId(auto)).root, folder);
    // A refused child is Read only for permission, never wider.
    assert.equal(sessionPermission(kid("kid-x", "root-unbound")), "read_only");
    // Read only root: the child's write is refused; nothing lands.
    await assert.rejects(run(writeFileTool, { path: "out.txt", content: "x", expectedSha256: null }, ro), /workspace_read_only/);
    assert.equal(existsSync(join(folder, "out.txt")), false);
    // Auto root with the folder attached: the child writes and reads there.
    await run(writeFileTool, { path: "out.txt", content: "from the child", expectedSha256: null }, auto);
    assert.equal(readFileSync(join(folder, "out.txt"), "utf8"), "from the child");
    const read = await run<{ text: string }>(readFileTool, { path: "a.txt" }, auto);
    assert.match(read.text, /hello/);
    const listed = await run<{ entries?: unknown }>(listDirTool, { path: "." }, auto);
    assert.ok(JSON.stringify(listed).includes("a.txt"));
    // A refused child cannot even read.
    assert.deepEqual(await run(readFileTool, { path: "a.txt" }, kid("kid-y", "root-unbound")), { status: "blocked", error: "bot_context_missing" });
    // The child of an Auto root writing outside the folder is still refused by the root's rules.
    await assert.rejects(run(writeFileTool, { path: "../escape.txt", content: "x", expectedSha256: null }, auto), /path_escape/);
  });
});

test("a child never changes memory, the roster, routines, groups, profiles or installs; it may read", async () => {
  await withWorld(async ({ alpha, owners }) => {
    setApprovalStore(new ApprovalStore(() => 1_000));
    bindSession("root-1", alpha, new Date(), owners);
    upsertSessionGrant({ sessionId: "root-1", path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    const ctx = kid("kid-1", "root-1");
    const refused: Array<[string, Tool, Record<string, unknown>]> = [
      ["memoryUpsert", memoryUpsert, { expectedRevision: null, title: "t", tags: [], body: "b", expiresAt: null }],
      ["memoryDelete", memoryDelete, { id: "note-1", expectedRevision: 1 }],
      ["createRoutine", createRoutineTool, { name: "n", instruction: "i", schedules: [{ kind: "daily", time: "09:00" }] }],
      ["updateRoutine", updateRoutine, { routineId: "rtn_x", active: false }],
      ["deleteRoutine", deleteRoutine, { routineId: "rtn_x" }],
      ["runRoutine", runRoutine, { routineId: "rtn_x" }],
      ["railAction", railAction, { action: "pin", botId: alpha }],
      ["clearHistory", clearHistory, {}],
      ["deleteBot", deleteBot, { botId: alpha }],
      ["updateBotProfile", updateBotProfile, { description: "x" }],
      ["proposeBot", proposeBot, { name: "X" }],
      ["proposeGroup", proposeGroup, { name: "G", memberIds: ["a", "b"] }],
      ["proposeConnector", proposeConnector, { slug: "gmail", purpose: "read mail" }],
      ["proposeConnection", proposeConnection, { kind: "mcp", url: "https://example.com/mcp", name: "X", description: "x", authKind: "none" }],
      ["sendToBot", sendToBot, { botId: alpha, message: "hi" }],
      ["postToGroup", postToGroup, { groupId: "g", message: "hi" }],
      ["generateImage", generateImage, { prompt: "a cat" }],
      ["installCli", installCli, { action: "install", name: "gh" }],
    ];
    for (const [name, tool, input] of refused) {
      const result = await run<{ status?: string; error?: string }>(tool, input, ctx);
      assert.deepEqual({ status: result?.status, error: result?.error }, { status: "blocked", error: "not_available_for_sub_agents" }, name);
    }
    assert.equal(readRoutinesStore().routines.length, 0);
    // Reads work, as the root's bot.
    const bots = await run<{ activeBotId?: string }>(listBots, {}, ctx);
    assert.equal(bots.activeBotId, alpha);
    const searched = await run<{ status?: string; error?: string }>(memorySearch, { query: "x" }, ctx);
    assert.notEqual(searched?.error, "bot_context_missing");
    assert.notEqual(searched?.error, "not_available_for_sub_agents");
    const routines = await run<{ status?: string; error?: string }>(listRoutines, {}, ctx);
    assert.notEqual(routines?.error, "not_available_for_sub_agents");
  });
});

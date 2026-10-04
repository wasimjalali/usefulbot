import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyShellAction, DEFAULT_BOT_ID, orchestratorId, type ShellStore } from "../shared/shell-store.ts";
import { readShell, updateShell, writeShell } from "../shared/shell-io.ts";
import { bindChildSession, bindSession, readSessionBot, readSessionParent, resolveSessionBot } from "../shared/session-bindings.ts";
import { authorizeChildStream, authorizeEveCall, type ChildStreamDeps } from "../web/lib/eve-session-auth.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";
import { renderContext } from "../shared/context-blocks.ts";
import { withBotSelection } from "../shared/shell-store.ts";
import {
  boundBotId,
  ensureTurnSnapshot,
  markSnapshotFailed,
  turnSnapshot,
  type SnapshotCtx,
} from "../agent/lib/turn-snapshot.ts";
import listModels from "../agent/tools/list_models.ts";

process.env.UB_ROUTER_DESKTOP_TOKEN ??= "test-router-token";
const { default: agent } = await import("../agent/agent.ts");
test("the agent leaves eve's per-session input cap off", () => {
  // eve's 40M default paused long chats; the router budgets are the spend guard.
  assert.equal((agent as { limits?: { maxInputTokensPerSession?: unknown } }).limits?.maxInputTokensPerSession, false);
});

const { default: contextResolver } = await import("../agent/instructions/context.ts");

const GO = "opencode-go:plan";
const KEYS = [
  "UB_SESSION_OWNERS_PATH",
  "UB_BINDING_WAIT_MS",
  "UB_SHELL_PATH",
  "UB_WORKSPACE_STORE_PATH",
  "UB_PROVIDERS_PATH",
  "UB_MODELS_CACHE_PATH",
  "UB_ACTIVE_BOT_ID",
] as const;

function modelRow(id: string, contextTokens: number) {
  return {
    id,
    label: id,
    efforts: ["low"],
    defaultEffort: "low",
    speeds: ["standard"],
    defaultSpeed: "standard",
    contextTokens,
  };
}

/** Temp stores, one connection, and a roster of the seeded Generalist plus Alpha and Beta. */
async function withWorld<T>(fn: (world: { alpha: string; beta: string }) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-snap-"));
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.UB_SESSION_OWNERS_PATH = join(dir, "session-owners.json");
  process.env.UB_BINDING_WAIT_MS = "150";
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
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
    providers: { [GO]: { fetchedAt: Date.now(), models: [modelRow("glm-5.3-flash", 200_000), modelRow("glm-5", 100_000)] } },
  }));
  let store: ShellStore = readShell();
  const alpha = applyShellAction(store, { type: "createBot", name: "Alpha", label: "the researcher", description: "Be brief." });
  store = alpha.store;
  const beta = applyShellAction(store, { type: "createBot", name: "Beta" });
  writeShell(beta.store);
  try {
    return await fn({ alpha: alpha.createdId as string, beta: beta.createdId as string });
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function ctxFor(sessionId: string, claim?: unknown, extra: Record<string, unknown> = {}): SnapshotCtx & { session: { turn: { id: string } } } {
  return {
    session: {
      id: sessionId,
      turn: { id: "t1" },
      auth: claim === undefined ? { current: null } : { current: { attributes: { botId: claim, ...extra } } },
    },
    messages: [],
  };
}

/** The eve turn.started and step.started events as the resolvers read them. */
const event = (turnId: string) => ({ type: "turn.started", data: { turnId } });

type Resolver = (event: unknown, ctx: unknown) => unknown;
const turnStarted = (contextResolver as unknown as { events: Record<string, Resolver> }).events["turn.started"];
const stepStarted = (agent as unknown as { model: { events: Record<string, Resolver> } }).model.events["step.started"];

function forgetSnapshots(): void {
  const holder = globalThis as unknown as Record<symbol, { byTurn: Map<string, unknown>; latest: Map<string, string> } | undefined>;
  const reg = holder[Symbol.for("useful-bot.turn-snapshots")];
  reg?.byTurn.clear();
  reg?.latest.clear();
}

async function silenced<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

test("the claim beats the binding lookup, and a claim with no row binds the session", async () => {
  await withWorld(async ({ alpha }) => {
    assert.equal(await boundBotId(ctxFor("sess-claim", alpha)), alpha);
    assert.equal(readSessionBot("sess-claim"), alpha, "the first turn bound the session");
    bindSession("sess-agree", alpha);
    assert.equal(await boundBotId(ctxFor("sess-agree", alpha)), alpha);
  });
});

test("a claim and a binding that differ are refused", async () => {
  await withWorld(async ({ alpha, beta }) => {
    bindSession("sess-mismatch", alpha);
    const { result } = await silenced(() => boundBotId(ctxFor("sess-mismatch", beta)));
    assert.equal(result, null);
    assert.equal(readSessionBot("sess-mismatch"), alpha, "the binding never moves");
  });
});

test("with no claim the binding is used, after a bounded wait for a brand new session", async () => {
  await withWorld(async ({ alpha }) => {
    bindSession("sess-bound", alpha);
    assert.equal(await boundBotId(ctxFor("sess-bound")), alpha);
    // A claim that is not a string is dropped by eve; here it simply reads as none.
    assert.equal(await boundBotId(ctxFor("sess-bound", 7)), alpha);
    // The proxy binds a moment later.
    setTimeout(() => bindSession("sess-late", alpha), 60);
    const started = Date.now();
    assert.equal(await boundBotId(ctxFor("sess-late"), 2_000), alpha);
    assert.ok(Date.now() - started >= 50, "returned before the binding landed");
  });
});

test("neither a claim nor a binding, and a child session, are refused", async () => {
  await withWorld(async ({ alpha }) => {
    const started = Date.now();
    const { result } = await silenced(() => boundBotId(ctxFor("sess-nobody"), 120));
    assert.equal(result, null);
    assert.ok(Date.now() - started >= 100, "it waited for the binding first");
    const child = { ...ctxFor("sess-child", alpha), session: { ...ctxFor("sess-child", alpha).session, parent: { id: "p" } } };
    assert.equal((await silenced(() => boundBotId(child))).result, null);
  });
});

// W5 failure modes: a tool or hook context of a child (it carries `session.parent`)
// resolves to its verified root's bot and shows the root's grant, never its own;
// an unverifiable child, or one claiming another bot, is refused; a resolver
// context of a child (no parent, `kind: "subagent"`) shows the root's grant
// through the child's recorded parent, else the bot's own current chat, and
// never the child id's grant.
test("a child's tool context resolves to its root's bot and grant, and refuses what it cannot verify", async () => {
  await withWorld(async ({ alpha, beta }) => {
    bindSession("root-1", alpha);
    upsertSessionGrant({ sessionId: "root-1", path: null, permission: "read_only" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    // A stronger grant on the child's own id must not count.
    upsertSessionGrant({ sessionId: "kid-1", path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    const parent = { callId: "c", rootSessionId: "root-1", sessionId: "root-1", turn: { id: "t0", sequence: 0 } };
    const toolCtx = { ...ctxFor("kid-1", alpha), session: { ...ctxFor("kid-1", alpha).session, parent } };
    assert.equal(await boundBotId(toolCtx), alpha);
    const snap = await ensureTurnSnapshot(toolCtx, "t1");
    assert.equal(snap?.status, "ok");
    assert.equal(snap?.status === "ok" ? snap.permission : null, "read_only");
    assert.equal(readSessionParent("kid-1"), "root-1");
    // A claim for another bot, an unbound root and a nested hop are refused.
    const wrongClaim = { ...ctxFor("kid-2", beta), session: { ...ctxFor("kid-2", beta).session, parent } };
    assert.equal((await silenced(() => boundBotId(wrongClaim))).result, null);
    const unboundRoot = { ...ctxFor("kid-3", alpha), session: { ...ctxFor("kid-3", alpha).session, parent: { ...parent, rootSessionId: "nope", sessionId: "nope" } } };
    assert.equal((await silenced(() => boundBotId(unboundRoot))).result, null);
    const nested = { ...ctxFor("kid-4", alpha), session: { ...ctxFor("kid-4", alpha).session, parent: { ...parent, sessionId: "kid-1" } } };
    assert.equal((await silenced(() => boundBotId(nested))).result, null);
  });
});

test("a child's resolver context shows the root's grant, never the child id's", async () => {
  forgetSnapshots();
  await withWorld(async ({ alpha }) => {
    bindSession("root-1", alpha);
    upsertSessionGrant({ sessionId: "root-1", path: null, permission: "auto" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    upsertSessionGrant({ sessionId: "kid-1", path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    const resolver = { ...ctxFor("kid-1", alpha), channel: { kind: "subagent" } };
    // The child's recorded parent decides when the proxy has bound it.
    bindChildSession("kid-1", "root-1", alpha);
    const viaRow = await ensureTurnSnapshot(resolver, "t1");
    assert.equal(viaRow?.status === "ok" ? viaRow.permission : null, "auto");
    // Not yet bound: the grant is unknown. Neither the child's own row nor the
    // bot's current chat is read, even when that chat is the bot's own.
    writeShell(applyShellAction(readShell(), { type: "touchChat", botId: alpha, preview: "hi", sessionId: "root-1" }).store);
    upsertSessionGrant({ sessionId: "kid-2", path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
    const viaPointer = await ensureTurnSnapshot({ ...ctxFor("kid-2", alpha), channel: { kind: "subagent" } }, "t1");
    assert.equal(viaPointer?.status, "ok");
    assert.equal(viaPointer?.status === "ok" ? viaPointer.permission : "x", null);
    assert.equal(viaPointer?.status === "ok" ? viaPointer.folder : "x", null);
    assert.match(viaPointer?.status === "ok" ? renderContext(viaPointer.context) : "", /This chat: the same permission and folder as the chat that started you\./);
    // A root-bound child still shows the root's grant (the first branch above).
    assert.match(viaRow?.status === "ok" ? renderContext(viaRow.context) : "", /This chat: Auto,/);
  });
});

test("a sub-agent's child turn never binds the child as a root, so the proxy can bind it under its parent", async () => {
  await withWorld(async ({ alpha }) => {
    const savedSecret = process.env.UB_CHANNEL_JWT_SECRET;
    process.env.UB_CHANNEL_JWT_SECRET = "test-channel-secret";
    try {
      const parent = "wrun_PARENT01";
      const child = "wrun_CHILD01";
      bindSession(parent, alpha);
      // What eve's dynamic resolvers hand a child's step: the root's claim
      // (auth propagates), the subagent channel and no `session.parent`.
      const ctx = { ...ctxFor(child, alpha), channel: { kind: "subagent" } };
      assert.equal(await boundBotId(ctx), alpha);
      assert.equal(readSessionBot(child), null, "the child was bound as a root session");
      // The app names the index of the parent's subagent.called; the proxy
      // reads that one event from eve and binds the child under the parent.
      const call = { type: "subagent.called", data: { sessionId: parent, childSessionId: child, callId: "c" } };
      const reads: number[] = [];
      const deps: ChildStreamDeps = {
        resolveBot: (id) => resolveSessionBot(id),
        readParent: (id) => readSessionParent(id),
        readEventAt: async (_parent, at) => { reads.push(at); return at === 12 ? JSON.stringify(call) : JSON.stringify({ type: "message.appended", data: {} }); },
        bind: (kid, root, bot) => { bindChildSession(kid, root, bot); },
      };
      assert.deepEqual(await authorizeChildStream(parent, child, 11, deps), { ok: false, status: 403, error: "child_session_unverified" });
      assert.equal(readSessionParent(child), null);
      const read = await authorizeChildStream(parent, child, 12, deps);
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.equal(readSessionParent(child), parent);
      // Bound now: the next read needs no `at` and no eve read.
      assert.equal((await authorizeChildStream(parent, child, null, deps)).ok, true);
      assert.deepEqual(reads, [11, 12]);
      // A bound child is read only: a send, an answer or a cancel into it is refused.
      for (const [suffix, body] of [[`session/${child}`, JSON.stringify({ message: "hi" })], [`session/${child}`, JSON.stringify({ inputResponses: [{ requestId: "r", optionId: "continue" }] })], [`session/${child}/cancel`, ""]]) {
        assert.deepEqual(authorizeEveCall("POST", suffix, body, (id) => resolveSessionBot(id)), { ok: false, status: 403, error: "child_session_readonly" }, suffix);
      }
      // The child's next step agrees with the binding the proxy wrote.
      assert.equal(await boundBotId(ctx), alpha);
    } finally {
      if (savedSecret === undefined) delete process.env.UB_CHANNEL_JWT_SECRET;
      else process.env.UB_CHANNEL_JWT_SECRET = savedSecret;
    }
  });
});

test("one snapshot per session and turn: a pick made mid-turn waits for the next turn", async () => {
  await withWorld(async ({ alpha }) => {
    const ctx = ctxFor("sess-once", alpha);
    const first = await ensureTurnSnapshot(ctx, "turn-1");
    assert.equal(first?.status, "ok");
    updateShell((current) => withBotSelection(current, alpha, { connectionId: GO, modelId: "glm-5", effort: "low", speed: "standard" }));
    const again = await ensureTurnSnapshot(ctx, "turn-1");
    assert.equal(again, first, "the same object, never rebuilt");
    assert.equal(first?.status === "ok" && first.selection.modelId, "glm-5.3-flash");
    const next = await ensureTurnSnapshot(ctx, "turn-2");
    assert.equal(next?.status === "ok" && next.selection.modelId, "glm-5");
    assert.equal(next?.status === "ok" && next.selection.windowTokens, 100_000);
  });
});

test("the Generalist's own chat gets Running the team, a teammate does not, a group gets the group variant", async () => {
  await withWorld(async ({ alpha, beta }) => {
    const text = async (botId: string, session: string): Promise<string> => {
      const out = await turnStarted(event("t1"), ctxFor(session, botId)) as { content?: string } | null;
      return out?.content ?? "";
    };
    const generalist = await text(DEFAULT_BOT_ID, "sess-gen");
    assert.match(generalist, /# Running the team/);
    assert.match(generalist, /You are the owner's main assistant/);
    assert.match(generalist, /# This turn/);
    const teammate = await text(alpha, "sess-alpha");
    assert.doesNotMatch(teammate, /# Running the team/);
    assert.match(teammate, /You are Alpha, the researcher\./);
    assert.match(teammate, /<owner-instructions>\nBe brief\.\n<\/owner-instructions>/);
    assert.match(teammate, /first chat with you/);

    writeShell(applyShellAction(readShell(), { type: "createGroup", name: "Crew", memberIds: [alpha, beta], description: "Work together." }).store);
    const groupId = readShell().bots.find((bot) => bot.kind === "group")!.id;
    const group = await text(groupId, "sess-group");
    assert.match(group, /You orchestrate the group Crew\. Members: Alpha \(the researcher\), Beta/);
    assert.doesNotMatch(group, /# Running the team/);

    // The owner deleted the Generalist: the first visible bot orchestrates, without the first sentence.
    writeShell(applyShellAction(readShell(), { type: "deleteBot", botId: DEFAULT_BOT_ID }).store);
    const fallback = await text(orchestratorId(readShell()) as string, "sess-fallback");
    assert.match(fallback, /# Running the team/);
    assert.doesNotMatch(fallback, /You are the owner's main assistant/);
  });
});

test("step.started: a fresh turn gets its model, a recorded resolver failure throws bot_context_missing", async () => {
  await withWorld(async ({ alpha }) => {
    process.env.UB_ROUTER_DESKTOP_TOKEN = "test-router-token";
    const ctx = ctxFor("sess-step", alpha);
    const ok = await stepStarted(event("turn-a"), ctx) as { modelContextWindowTokens: number };
    assert.equal(ok.modelContextWindowTokens, 200_000);

    // The context resolver threw on this turn (a throwing instruction resolver is skipped by eve):
    // the model resolver is where the turn fails.
    markSnapshotFailed("sess-step", "turn-b", alpha);
    const { errors } = await silenced(async () => {
      await assert.rejects(async () => stepStarted(event("turn-b"), ctx), /bot_context_missing/);
    });
    assert.ok(errors.some((line) => line.includes('"event":"bot_context_missing"')), "a counter line is logged");
    // The next turn is unaffected.
    await stepStarted(event("turn-c"), ctx);
  });
});

test("step.started rebuilds a missing snapshot after a restart, and refuses an unbound or mismatched session", async () => {
  await withWorld(async ({ alpha, beta }) => {
    const ctx = ctxFor("sess-restart", alpha);
    await turnStarted(event("turn-r"), ctx);
    assert.equal(turnSnapshot("sess-restart", "turn-r")?.status, "ok");
    forgetSnapshots();
    assert.equal(turnSnapshot("sess-restart", "turn-r"), null);
    const rebuilt = await stepStarted(event("turn-r"), ctx) as { modelContextWindowTokens: number };
    assert.equal(rebuilt.modelContextWindowTokens, 200_000);
    assert.equal(turnSnapshot("sess-restart", "turn-r")?.status, "ok");

    const unbound = await silenced(async () => {
      await assert.rejects(async () => stepStarted(event("turn-u"), ctxFor("sess-unbound")), /bot_context_missing/);
    });
    assert.ok(unbound.errors.length > 0);
    await silenced(async () => {
      await assert.rejects(async () => stepStarted(event("turn-m"), ctxFor("sess-restart", beta)), /bot_context_missing/);
    });
  });
});

test("the context resolver records a failure instead of throwing, so the model resolver refuses", async () => {
  await withWorld(async ({ alpha }) => {
    // The bot vanishes between the claim and the build: the roster no longer has it.
    bindSession("sess-gone", alpha);
    writeShell(applyShellAction(readShell(), { type: "deleteBot", botId: alpha }).store);
    const ctx = ctxFor("sess-gone", alpha);
    const { result } = await silenced(async () => turnStarted(event("turn-x"), ctx));
    assert.equal(result, null, "nothing rendered, nothing thrown");
    await silenced(async () => {
      await assert.rejects(async () => stepStarted(event("turn-x"), ctx), /bot_context_missing/);
    });
  });
});

test("list_models reports the model the turn froze, not the default", async () => {
  await withWorld(async ({ alpha }) => {
    updateShell((current) => withBotSelection(current, alpha, { connectionId: GO, modelId: "glm-5", effort: "low", speed: "standard" }));
    const ctx = ctxFor("sess-lm", alpha);
    const rendered = await turnStarted(event("t1"), ctx) as { content: string };
    const out = await listModels.execute({ kind: "chat" } as never, ctx as never) as { current: { chat: { id: string } } };
    assert.equal(out.current.chat.id, "glm-5");
    assert.match(rendered.content, /Model: glm-5 \(glm-5\) via /);
    // A pick afterwards changes neither the line nor the tool inside this turn.
    updateShell((current) => withBotSelection(current, alpha, { connectionId: GO, modelId: "glm-5.3-flash", effort: "low", speed: "standard" }));
    const still = await listModels.execute({ kind: "chat" } as never, ctx as never) as { current: { chat: { id: string } } };
    assert.equal(still.current.chat.id, "glm-5");
    // A session nobody is bound to has no turn to describe.
    const blocked = await silenced(async () => listModels.execute({ kind: "chat" } as never, ctxFor("sess-lm-nobody") as never));
    assert.deepEqual(blocked.result, { status: "blocked", error: "bot_context_missing" });
  });
});

test("with no turn id a failed mark sticks until the next turn.started, then the turn rebuilds", async () => {
  await withWorld(async ({ alpha }) => {
    const ctx = ctxFor("sess-sticky", alpha);
    markSnapshotFailed("sess-sticky", undefined, alpha);
    const stuck = await ensureTurnSnapshot(ctx, undefined);
    assert.equal(stuck?.status, "failed", "a later step does not rebuild the failure away");
    assert.equal((await ensureTurnSnapshot(ctx, undefined)), stuck);
    const fresh = await ensureTurnSnapshot(ctx, undefined, true);
    assert.equal(fresh?.status, "ok", "turn.started clears it");
    assert.equal((await ensureTurnSnapshot(ctx, undefined))?.status, "ok");
  });
});

test("This chat shows the permission and folder the session grant gives, which is what the tools enforce", async () => {
  await withWorld(async ({ alpha }) => {
    const ctx = ctxFor("sess-grant", alpha);
    // No grant: the tools treat the session as Read only, so that is what is shown.
    const bare = await ensureTurnSnapshot(ctx, "t1");
    assert.equal(bare?.status === "ok" && bare.permission, "read_only");
    assert.equal(bare?.status === "ok" && bare.folder, null);
    upsertSessionGrant({ sessionId: "sess-grant", path: "/Users/someone/Projects/Atlas", permission: "full_access" });
    const granted = await ensureTurnSnapshot(ctx, "t2");
    assert.equal(granted?.status === "ok" && granted.permission, "full_access");
    assert.equal(granted?.status === "ok" && granted.folder, "Atlas");
    assert.match(granted?.status === "ok" ? renderContext(granted.context) : "", /This chat: Full access, folder "Atlas" attached\./);
  });
});

// Taint from a sub-agent to its root. Failure modes: a child's reading never
// reaching the root; the mark dropped on a report whose wording this build does
// not know; dropped by an owner message while a child is still out; kept
// forever after everything reported; a binding store that cannot be read.
import { clearRootOutside, markOutside, noteRootReport, seenOutside } from "../agent/lib/outside-content.ts";
import { isSubAgentReport } from "../agent/lib/turn-snapshot.ts";

function forgetOutside(): void {
  const holder = globalThis as unknown as Record<symbol, { clear(): void } | undefined>;
  holder[Symbol.for("useful-bot.outside-content")]?.clear();
  holder[Symbol.for("useful-bot.outside-content.roots")]?.clear();
}

function kidCtx(child: string, root: string, botId: string) {
  const base = ctxFor(child, botId);
  return { ...base, session: { ...base.session, parent: { callId: "c", rootSessionId: root, sessionId: root, turn: { id: "t0", sequence: 0 } } } };
}

test("a child's outside reading marks its root for any turn", async () => {
  forgetOutside();
  await withWorld(async ({ alpha }) => {
    bindSession("root-1", alpha);
    const rootTurn = (id: string) => ({ session: { id: "root-1", turn: { id } } });
    assert.equal(seenOutside(rootTurn("a")), false);
    markOutside(kidCtx("kid-1", "root-1", alpha));
    assert.equal(seenOutside(rootTurn("a")), true);
    assert.equal(seenOutside(rootTurn("later")), true);
    // A child that cannot be verified still taints the root it names, and nothing else.
    markOutside(kidCtx("kid-9", "nobody", alpha));
    assert.equal(seenOutside({ session: { id: "nobody", turn: { id: "a" } } }), true);
    assert.equal(seenOutside({ session: { id: "somebody-else", turn: { id: "a" } } }), false);
    // A root that is not a session id is ignored.
    markOutside({ ...kidCtx("kid-8", "x", alpha), session: { ...kidCtx("kid-8", "x", alpha).session, parent: { rootSessionId: "../x", sessionId: "../x" } } });
    assert.equal(seenOutside({ session: { id: "../x", turn: { id: "a" } } }), false);
  });
});

test("report turns are recognised by eve's kind first, and by wording or a merged paragraph as a fallback", () => {
  const user = (content: unknown, kind?: string) => ({ role: "user", content, ...(kind ? { kind } : {}) });
  assert.equal(isSubAgentReport([user("hello", "user")]), false);
  // The kind alone is enough, whatever the text says.
  assert.equal(isSubAgentReport([user("the critics finished", "execution.background_task")]), true);
  assert.equal(isSubAgentReport([user("Background task task_ab12 (agent) is completed.\nok")]), true);
  assert.equal(isSubAgentReport([user([{ type: "text", text: "Background task task_ab12 failed." }])]), true);
  // A report merged after other text.
  assert.equal(isSubAgentReport([user("also this\n\nBackground task task_ab12 is completed.")]), true);
  // Only the turn's own input counts: a report before an assistant reply does not.
  assert.equal(isSubAgentReport([user("x", "execution.background_task"), { role: "assistant", content: "ok" }, user("thanks", "user")]), false);
});

test("an unrecognised report keeps the mark; an owner turn clears it only once every child has reported", async () => {
  forgetOutside();
  forgetSnapshots();
  await withWorld(async ({ alpha }) => {
    bindSession("root-1", alpha);
    bindChildSession("kid-1", "root-1", alpha, new Date(Date.now() - 60_000));
    const owner = (messages: SnapshotCtx["messages"]) => ({ ...ctxFor("root-1", alpha, { delivery: "owner" }), messages });
    const rootTurn = { session: { id: "root-1", turn: { id: "t-x" } } };
    markOutside(kidCtx("kid-1", "root-1", alpha));
    // A report in wording nobody knows, no kind: the turn looks like an owner turn. No report was seen, so it keeps the mark.
    await ensureTurnSnapshot(owner([{ role: "user", content: "the critics are done: all clear" }]), "t-a");
    assert.equal(seenOutside(rootTurn), true, "an unrecognised report must not clear the mark");
    // A report turn (by kind) is seen; the next owner message, with no child out, clears.
    await ensureTurnSnapshot(owner([{ role: "user", kind: "execution.background_task", content: "x" }]), "t-b");
    assert.equal(seenOutside(rootTurn), true, "the report turn itself is outside");
    await ensureTurnSnapshot(owner([{ role: "user", kind: "user", content: "thanks" }]), "t-c");
    assert.equal(seenOutside(rootTurn), false);
  });
});

test("an owner turn while a child is still out keeps the mark", async () => {
  forgetOutside();
  forgetSnapshots();
  await withWorld(async ({ alpha }) => {
    bindSession("root-1", alpha);
    bindChildSession("kid-1", "root-1", alpha, new Date(Date.now() - 60_000));
    const owner = (kind: string) => ({ ...ctxFor("root-1", alpha, { delivery: "owner" }), messages: [{ role: "user", kind, content: "x" }] });
    const rootTurn = { session: { id: "root-1", turn: { id: "t-x" } } };
    markOutside(kidCtx("kid-1", "root-1", alpha));
    await ensureTurnSnapshot(owner("execution.background_task"), "t-b");
    // A second child starts after that report and has not reported.
    bindChildSession("kid-2", "root-1", alpha, new Date(Date.now() + 60_000));
    await ensureTurnSnapshot(owner("user"), "t-c");
    assert.equal(seenOutside(rootTurn), true);
    // A new reading resets the report: still kept.
    markOutside(kidCtx("kid-2", "root-1", alpha));
    assert.equal(clearRootOutside("root-1"), false);
    // The first report after the last mark, with kid-2 recorded before it, lets the next owner turn clear.
    noteRootReport("root-1", Date.now() + 120_000);
    assert.equal(clearRootOutside("root-1"), true);
    assert.equal(seenOutside(rootTurn), false);
  });
});

test("an unreadable binding store keeps the mark", async () => {
  forgetOutside();
  await withWorld(async ({ alpha }) => {
    bindSession("root-1", alpha);
    markOutside(kidCtx("kid-1", "root-1", alpha));
    noteRootReport("root-1", Date.now() + 1000);
    const path = process.env.UB_SESSION_OWNERS_PATH as string;
    // A bad row makes the strict reader see an empty store (children unknown), so the mark must not clear on that.
    writeFileSync(path, "not json", "utf8");
    assert.equal((await silenced(async () => clearRootOutside("root-1"))).result, false);
    assert.equal(seenOutside({ session: { id: "root-1", turn: { id: "t" } } }), true);
  });
});

// Stop must stick. Failure modes: a marker written for anything but a verified
// child cancel; the "do not restart" line missing for a cancelled report of a
// stopped child; the line shown for a genuinely failed child, a turn with no
// report, or another root's stop.
import { defaultSubagentStopsPath, readSubagentStops, recordSubagentStop } from "../shared/subagent-stops.ts";

test("a cancelled report of a stopped child carries the do-not-restart line; a failed one does not", async () => {
  forgetSnapshots();
  await withWorld(async ({ alpha }) => {
    const savedRoot = process.env.UB_STATE_ROOT;
    process.env.UB_STATE_ROOT = mkdtempSync(join(tmpdir(), "ub-stops-"));
    const path = defaultSubagentStopsPath();
    try {
      bindSession("root-1", alpha);
      bindSession("root-2", alpha);
      recordSubagentStop({ rootSessionId: "root-1", childSessionId: "kid-1", agentId: "ag_agent:abc123" });
      recordSubagentStop({ rootSessionId: "root-1", childSessionId: "kid-2", agentId: null });
      const cancelled = 'Background task task_ab12 (agent) failed.\n\nError:\n{"code":"SUBAGENT_EXECUTION_FAILED","message":"The agent invocation was cancelled."}';
      const failed = 'Background task task_cd34 (agent) failed.\n\nError:\n{"code":"SUBAGENT_EXECUTION_FAILED","message":"The model call timed out."}';
      const turn = (root: string, text: string | null, id: string) => ({
        ...ctxFor(root, alpha, { delivery: "owner" }),
        messages: text === null ? [] : [{ role: "user", kind: "execution.background_task", content: text }],
      }) as SnapshotCtx;
      const line = async (root: string, text: string | null, id: string) => {
        const snap = await ensureTurnSnapshot(turn(root, text, id), id);
        return snap?.status === "ok" ? renderContext(snap.context) : "";
      };
      assert.match(await line("root-1", cancelled, "t1"), /The owner pressed Stop on these sub-agents: ag_agent:abc123, kid-2\. .*Do not start them again unless the owner asks\./);
      assert.doesNotMatch(await line("root-1", failed, "t2"), /pressed Stop/);
      assert.doesNotMatch(await line("root-1", null, "t3"), /pressed Stop/);
      assert.doesNotMatch(await line("root-2", cancelled, "t4"), /pressed Stop/);
      // An expired stop is forgotten.
      assert.deepEqual(readSubagentStops("root-1", Date.now() + 2 * 60 * 60 * 1000, path), []);
    } finally {
      if (savedRoot === undefined) delete process.env.UB_STATE_ROOT;
      else process.env.UB_STATE_ROOT = savedRoot;
    }
  });
});

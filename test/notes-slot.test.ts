import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore, resetMemoryDir } from "../agent/lib/memory.ts";
import { forgetRecallCache, NOTES_RECORD_ID, notesScope, recallNotes, renderNotesFor } from "../agent/memory/notes.ts";
import notes from "../agent/memory/notes.ts";
import { markOutside, seenOutside } from "../agent/lib/outside-content.ts";
import { ensureTurnSnapshot } from "../agent/lib/turn-snapshot.ts";
import { applyShellAction } from "../shared/shell-store.ts";
import { readShell, writeShell } from "../shared/shell-io.ts";
import { bindSession } from "../shared/session-bindings.ts";

const KEYS = ["UB_SESSION_OWNERS_PATH", "UB_BINDING_WAIT_MS", "UB_SHELL_PATH", "UB_WORKSPACE_STORE_PATH", "UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH"] as const;
const GO = "opencode-go:plan";

async function withWorld<T>(fn: (world: { alpha: string; beta: string }) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-notes-"));
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.UB_SESSION_OWNERS_PATH = join(dir, "session-owners.json");
  process.env.UB_BINDING_WAIT_MS = "100";
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  writeFileSync(process.env.UB_PROVIDERS_PATH, JSON.stringify({
    schemaVersion: 2,
    connections: {
      [GO]: { id: GO, providerId: "opencode-go", mode: "plan", credential: { kind: "key", key: "go-key-12345678" }, fields: {}, updatedAt: new Date().toISOString(), lastError: null },
    },
    activeConnectionId: GO, selectedModel: "glm-5.3-flash", effort: null, speed: "standard", roles: {},
  }));
  let store = readShell();
  const alpha = applyShellAction(store, { type: "createBot", name: "Alpha" });
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

function freshStore(): MemoryStore {
  const root = mkdtempSync(join(tmpdir(), "ub-notes-mem-"));
  resetMemoryDir(root);
  return new MemoryStore(root);
}

function put(store: MemoryStore, botId: string, title: string, body: string, extra: { id?: string; expectedRevision?: number | null } = {}) {
  return store.upsert({
    id: extra.id, expectedRevision: extra.expectedRevision ?? null, title, tags: [], body, botId,
    source: "model", expiresAt: null, sessionId: "s",
  });
}

const recallCtx = (operationId: string, botId: string) => ({ operationId, memory: { scope: { value: botId } } });
const contentOf = (result: ReturnType<typeof recallNotes>) => result?.messages[0].content ?? null;

async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
}

test("scope is the claimed bot, and null (slot off) when nothing can be bound or the claim disagrees", async () => {
  await withWorld(async ({ alpha, beta }) => {
    const session = (id: string, claim?: string) => ({ session: { id, auth: { current: claim ? { attributes: { botId: claim } } : null } } });
    assert.equal(await notesScope(session("s-scope", alpha)), alpha);
    assert.equal(await quiet(() => notesScope(session("s-scope", beta))), null, "mismatched claim");
    assert.equal(await quiet(() => notesScope(session("s-none"))), null, "neither claim nor binding");
    // The defined slot uses the same function.
    const scope = (notes as unknown as { scope: (ctx: unknown) => Promise<string | null> }).scope;
    assert.equal(await scope(session("s-scope", alpha)), alpha);
  });
});

test("scope never throws: a store failure reads as null", async () => {
  const hostile = { session: { id: "s", get parent(): unknown { throw new Error("boom"); } } };
  assert.equal(await quiet(() => notesScope(hostile as never)), null);
});

test("an empty bot gets the sentinel under the fixed record id, never blank", () => {
  const store = freshStore();
  const out = recallNotes(recallCtx("op-empty", "bot-a"), () => store);
  assert.equal(out?.messages[0].id, NOTES_RECORD_ID);
  assert.equal(NOTES_RECORD_ID, "bot-notes");
  assert.match(contentOf(out) ?? "", /No notes yet/);
  assert.ok((contentOf(out) ?? "").trim().length > 0);
});

test("recall holds only this bot's notes, newest first, with the outside-content mark", () => {
  const store = freshStore();
  put(store, "bot-a", "Mine", "my body");
  put(store, "bot-b", "Theirs", "their-canary");
  store.upsert({ expectedRevision: null, title: "From web", tags: [], body: "web body", botId: "bot-a", source: "model-after-outside-content", expiresAt: null, sessionId: "s" });
  const text = contentOf(recallNotes(recallCtx("op-own", "bot-a"), () => store)) ?? "";
  assert.match(text, /Mine/);
  assert.match(text, /written after reading outside content/);
  assert.doesNotMatch(text, /their-canary|Theirs/);
});

test("a replayed operation returns the same bytes even after the owner edits a note", () => {
  const store = freshStore();
  const n = put(store, "bot-a", "Plan", "first");
  const before = contentOf(recallNotes(recallCtx("op-replay", "bot-a"), () => store));
  put(store, "bot-a", "Plan", "second", { id: n.id, expectedRevision: 1 });
  assert.equal(contentOf(recallNotes(recallCtx("op-replay", "bot-a"), () => store)), before);
  // A new operation sees the edit.
  assert.match(contentOf(recallNotes(recallCtx("op-after", "bot-a"), () => store)) ?? "", /second/);
});

test("a replay after a restart returns the persisted bytes, even after the owner edits a note", () => {
  const store = freshStore();
  const n = put(store, "bot-a", "Plan", "v1");
  const first = contentOf(recallNotes(recallCtx("op-restart", "bot-a"), () => store));
  put(store, "bot-a", "Plan", "v2", { id: n.id, expectedRevision: 1 });
  forgetRecallCache();
  assert.equal(contentOf(recallNotes(recallCtx("op-restart", "bot-a"), () => store)), first);
  assert.match(contentOf(recallNotes(recallCtx("op-restart-new", "bot-a"), () => store)) ?? "", /v2/);
});

test("the persisted renders are bounded at 256 files", () => {
  const store = freshStore();
  put(store, "bot-a", "Plan", "v1");
  for (let index = 0; index < 300; index += 1) recallNotes(recallCtx(`op-cap-${index}`, "bot-a"), () => store);
  const files = readdirSync(join(dirname(store.notesDir), "recall")).filter((name) => name.endsWith(".txt"));
  assert.ok(files.length <= 256 && files.length > 200, `kept ${files.length}`);
});

test("renderNotesFor counts \"more\" against the true note count and shows the newest bodies in full", () => {
  const store = freshStore();
  for (let index = 0; index < 70; index += 1) {
    store.upsert({
      expectedRevision: null, title: `Note ${String(index).padStart(2, "0")}`, tags: [], body: `body-${index}`, botId: "bot-a",
      source: "model", expiresAt: null, sessionId: "s",
    });
  }
  const text = renderNotesFor("bot-a", () => store);
  // 6 full + 50 titles are shown: 14 of 70 are behind "more".
  assert.match(text, /14 more: use memory_search\./);
  assert.equal((text.match(/body-\d+/g) ?? []).length, 6, "six bodies, the newest");
  assert.deepEqual(text, renderNotesFor("bot-a", () => store), "deterministic");
});

test("recall never throws: a store error returns null and is logged", async () => {
  const broken = () => { throw new Error("index locked"); };
  const out = await quiet(() => recallNotes(recallCtx("op-broken", "bot-a"), broken as never));
  assert.equal(out, null);
  assert.equal(recallNotes({ operationId: "op-badscope", memory: { scope: { value: ["a", "b"] } } }, () => freshStore()) !== undefined, true);
});

test("a handoff delivery claim marks the turn as having read outside content, an owner delivery does not", async () => {
  await withWorld(async ({ alpha }) => {
    bindSession("s-handoff", alpha);
    bindSession("s-owner", alpha);
    const ctx = (id: string, delivery: string) => ({
      session: { id, turn: { id: "t1" }, auth: { current: { attributes: { botId: alpha, delivery } } } },
    });
    await ensureTurnSnapshot(ctx("s-handoff", "handoff"), "t1");
    await ensureTurnSnapshot(ctx("s-owner", "owner"), "t1");
    assert.equal(seenOutside(ctx("s-handoff", "handoff")), true);
    assert.equal(seenOutside(ctx("s-owner", "owner")), false);
    // A tool marks its own turn only.
    markOutside(ctx("s-owner", "owner"));
    assert.equal(seenOutside(ctx("s-owner", "owner")), true);
    assert.equal(seenOutside({ session: { id: "s-owner", turn: { id: "t2" } } }), false);
    assert.equal(seenOutside(undefined), false);
  });
});

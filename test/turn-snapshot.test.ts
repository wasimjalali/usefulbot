import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BOT_ID, withBotSelection } from "../shared/shell-store.ts";
import { readShell, updateShell } from "../shared/shell-io.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";
import { renderContext } from "../shared/context-blocks.ts";
import { buildSnapshot } from "../agent/lib/turn-snapshot.ts";
import { markOutside, seenOutside } from "../agent/lib/outside-content.ts";

const GO = "opencode-go:plan";
const KEYS = ["UB_STATE_ROOT", "UB_SHELL_PATH", "UB_WORKSPACE_STORE_PATH", "UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH"] as const;

function modelRow(id: string, contextTokens: number) {
  return { id, label: id, efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens };
}

/** Temp stores, one connection with two models, and the default bot. */
async function withWorld<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-snap-"));
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.UB_STATE_ROOT = dir;
  writeFileSync(join(dir, "providers.json"), JSON.stringify({
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
  writeFileSync(join(dir, "models-cache.json"), JSON.stringify({
    schemaVersion: 3,
    providers: { [GO]: { fetchedAt: Date.now(), models: [modelRow("glm-5.3-flash", 200_000), modelRow("glm-5", 100_000)] } },
  }));
  readShell();
  try {
    return await fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("a snapshot holds the pick it was built with: a pick made mid-turn waits for the next turn", async () => {
  await withWorld(() => {
    const first = buildSnapshot(DEFAULT_BOT_ID, "chat-1", "turn-1");
    assert.equal(first.status, "ok");
    assert.equal(first.selection.modelId, "glm-5.3-flash");
    assert.equal(first.selection.windowTokens, 200_000);
    updateShell((current) => withBotSelection(current, DEFAULT_BOT_ID, { connectionId: GO, modelId: "glm-5", effort: "low", speed: "standard" }));
    assert.equal(first.selection.modelId, "glm-5.3-flash", "the object built for the turn does not move");
    const next = buildSnapshot(DEFAULT_BOT_ID, "chat-1", "turn-2");
    assert.equal(next.selection.modelId, "glm-5");
    assert.equal(next.selection.windowTokens, 100_000);
    assert.equal(next.sessionId, "chat-1", "sessionId holds the chat id");
    assert.equal(next.turnId, "turn-2");
  });
});

test("the context is Your bot then This turn, naming the model the turn froze", async () => {
  await withWorld(() => {
    updateShell((current) => withBotSelection(current, DEFAULT_BOT_ID, { connectionId: GO, modelId: "glm-5", effort: "low", speed: "standard" }));
    const snapshot = buildSnapshot(DEFAULT_BOT_ID, "chat-1", "turn-1", { firstChat: true });
    const text = renderContext(snapshot.context);
    assert.ok(text.startsWith("# Your bot"));
    assert.match(text, /You are Useful Bot\./);
    assert.match(text, /# This turn/);
    assert.match(text, /Model: glm-5 \(glm-5\) via /);
    assert.match(text, /first chat with you/);
    assert.doesNotMatch(text, /Running the team/);
    assert.equal(snapshot.model.id, "glm-5");
    assert.doesNotMatch(renderContext(buildSnapshot(DEFAULT_BOT_ID, "chat-1", "turn-2").context), /first chat with you/);
  });
});

test("This chat shows the permission and folder the chat's grant gives, which is what the tools enforce", async () => {
  await withWorld(() => {
    // No grant: the tools treat the chat as Read only, so that is what is shown.
    const bare = buildSnapshot(DEFAULT_BOT_ID, "chat-grant", "t1");
    assert.equal(bare.permission, "read_only");
    assert.equal(bare.folder, null);
    upsertSessionGrant({ chatId: "chat-grant", path: "/Users/someone/Projects/Atlas", permission: "full_access" });
    const granted = buildSnapshot(DEFAULT_BOT_ID, "chat-grant", "t2");
    assert.equal(granted.permission, "full_access");
    assert.equal(granted.folder, "Atlas");
    assert.match(renderContext(granted.context), /This chat: Full access, folder "Atlas" attached\./);
    // Another chat has its own grant.
    assert.equal(buildSnapshot(DEFAULT_BOT_ID, "chat-other", "t3").permission, "read_only");
  });
});

test("a bot that is gone, or a shell that cannot be read, is an error and never a guess", async () => {
  await withWorld(() => {
    assert.throws(() => buildSnapshot("bot-nobody", "chat-1", "t1"), /bot_missing/);
    assert.throws(() => buildSnapshot(DEFAULT_BOT_ID, "chat-1", "t1", { reads: { store: () => { throw new Error("store_unreadable"); }, shell: () => null } }), /store_unreadable/);
    assert.throws(() => buildSnapshot(DEFAULT_BOT_ID, "chat-1", "t1", { reads: { store: () => ({}) as never, shell: () => null } }), /shell_unreadable/);
  });
});

// What the turn read from outside. Failure modes: a mark that leaks into the
// next turn or another chat.
test("outside reading marks its own turn only", () => {
  const turn = (chat: string, id: string) => ({ session: { id: chat, turn: { id } } });
  assert.equal(seenOutside(turn("chat-o", "a")), false);
  markOutside(turn("chat-o", "a"));
  assert.equal(seenOutside(turn("chat-o", "a")), true);
  assert.equal(seenOutside(turn("chat-o", "b")), false, "the next turn starts clean");
  assert.equal(seenOutside(turn("chat-other", "a")), false, "another chat is untouched");
  // No session at all (a bare test call) is ignored both ways.
  markOutside({});
  assert.equal(seenOutside({}), false);
  markOutside(undefined);
  assert.equal(seenOutside(undefined), false);
});

test("the marks are capped, oldest first", () => {
  for (let i = 0; i < 300; i += 1) markOutside({ session: { id: "chat-cap", turn: { id: `t${i}` } } });
  assert.equal(seenOutside({ session: { id: "chat-cap", turn: { id: "t299" } } }), true);
  assert.equal(seenOutside({ session: { id: "chat-cap", turn: { id: "t0" } } }), false, "the oldest mark was dropped");
});

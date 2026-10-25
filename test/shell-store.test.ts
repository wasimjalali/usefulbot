import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellAction,
  checkDescription,
  DEFAULT_BOT_ID,
  DESCRIPTION_MAX,
  isShellActionType,
  parseShell,
  seedStore,
  setBotChat,
} from "../shared/shell-store.ts";
import { readShell, updateShell, writeShell } from "../shared/shell-io.ts";
import { withBot } from "./helpers/roster.ts";

// Ways shell.json v2 can fail:
// 1. a file of another version reads as a roster instead of reseeding;
// 2. a bot still carries a session, recents, lineage or an Earlier-bots flag;
// 3. setBotChat writes a chat for a bot that is not there, or an id no path can hold;
// 4. a removed action (a rail, group, session or Earlier-bots one) is still taken;
// 5. a write from the engine and one from the web drop each other's change.

test("setWorkspace attaches, updates and detaches a conversation folder", () => {
  let store = seedStore();
  store = applyShellAction(store, {
    type: "setWorkspace",
    botId: DEFAULT_BOT_ID,
    workspace: { path: "/tmp/project", permission: "auto" },
  }).store;
  const attached = store.bots[0].workspace;
  assert.equal(attached?.path, "/tmp/project");
  assert.equal(attached?.permission, "auto");
  store = applyShellAction(store, {
    type: "setWorkspace",
    botId: DEFAULT_BOT_ID,
    workspace: { path: "/tmp/project", permission: "full_access" },
  }).store;
  assert.equal(store.bots[0].workspace?.permission, "full_access");
  store = applyShellAction(store, { type: "setWorkspace", botId: DEFAULT_BOT_ID, workspace: null }).store;
  assert.equal(store.bots[0].workspace, null);
});

test("setWorkspace rejects an unknown bot and a malformed grant", () => {
  const store = seedStore();
  assert.throws(
    () => applyShellAction(store, { type: "setWorkspace", botId: "nope", workspace: null }),
    /shell_bot_missing/,
  );
  // A relative path is not a folder the desktop picker could have returned.
  assert.throws(
    () =>
      applyShellAction(store, {
        type: "setWorkspace",
        botId: DEFAULT_BOT_ID,
        workspace: { path: "relative/path", permission: "auto" },
      }),
    /workspace_path_invalid/,
  );
  // An unknown permission word fails the write instead of becoming Auto.
  assert.throws(
    () =>
      applyShellAction(store, {
        type: "setWorkspace",
        botId: DEFAULT_BOT_ID,
        workspace: { path: "/tmp/project", permission: "admin" as never },
      }),
    /workspace_permission_invalid/,
  );
});

test("the one bot's name is fixed: a rename and an updateBot name change are refused", () => {
  const store = seedStore();
  assert.throws(() => applyShellAction(store, { type: "renameBot", botId: DEFAULT_BOT_ID, name: "Jarvis" }), /shell_bot_name_fixed/);
  assert.throws(() => applyShellAction(store, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { name: "Jarvis" } }), /shell_bot_name_fixed/);
  const same = applyShellAction(store, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { name: "Useful Bot", notify: true } }).store;
  assert.equal(same.bots[0].name, "Useful Bot");
  assert.equal(same.bots[0].notify, true);
});

test("the seed store is version 2: the Useful Bot with a chat id and nothing of the old roster", () => {
  const store = seedStore(new Date("2026-09-12T00:00:00Z"));
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.bots.length, 1);
  assert.equal(store.bots[0].id, DEFAULT_BOT_ID);
  assert.equal(store.bots[0].name, "Useful Bot");
  assert.equal(store.bots[0].chatId, null);
  const wire = JSON.parse(JSON.stringify(store)) as Record<string, unknown> & { bots: Array<Record<string, unknown>> };
  for (const key of ["recents", "sections", "collapsedUnassigned", "collapsedHidden"]) assert.equal(key in wire, false, key);
  for (const key of [
    "sessionId", "previousSessionIds", "continuedSessionId", "continuationSettled", "kind", "archived", "archivedAt",
    "petname", "profileRevision", "avatarShape", "avatarColor", "avatarImage", "avatarCustom",
    "pinned", "hidden", "sectionId", "memberIds",
  ]) {
    assert.equal(key in wire.bots[0], false, key);
  }
});

test("a v2 file that still carries removed per-bot fields reads, and writes them back without those fields", () => {
  const seed = seedStore();
  const stale = {
    ...seed,
    recents: [{ id: "r1", botId: DEFAULT_BOT_ID, title: "x", sessionId: "s", preview: "p", updatedAt: "2026-10-01T00:00:00.000Z" }],
    bots: [{ ...seed.bots[0], sessionId: "wrun_1", previousSessionIds: ["wrun_0"], archived: false, kind: "bot", petname: "x", profileRevision: 3, avatarShape: "drop" }],
  };
  const parsed = parseShell(JSON.parse(JSON.stringify(stale)));
  const wire = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown> & { bots: Array<Record<string, unknown>> };
  assert.equal("recents" in wire, false);
  for (const key of ["sessionId", "previousSessionIds", "archived", "kind", "petname", "profileRevision", "avatarShape"]) {
    assert.equal(key in wire.bots[0], false, key);
  }
  assert.equal(parsed.bots[0].chatId, null);
});

test("the actions of the removed rail, groups, sessions and Earlier bots are not actions any more", () => {
  const store = seedStore();
  const removed = [
    { type: "createBot", name: "Second" },
    { type: "deleteBot", botId: "bot-x" },
    { type: "createGroup", name: "Desk", memberIds: [] },
    { type: "createSection", name: "Work" },
    { type: "pin", botId: DEFAULT_BOT_ID },
    { type: "hide", botId: DEFAULT_BOT_ID },
    { type: "sendToBot", botId: DEFAULT_BOT_ID, message: "hi" },
    { type: "select", botId: DEFAULT_BOT_ID },
    { type: "nameBot", botId: DEFAULT_BOT_ID, name: "X" },
    { type: "setSession", botId: DEFAULT_BOT_ID, sessionId: "s" },
    { type: "touchChat", botId: DEFAULT_BOT_ID, preview: "p" },
    { type: "newChat" },
    { type: "clearThread", botId: DEFAULT_BOT_ID },
    { type: "openRecent", recentId: "r" },
    { type: "moveNotes", fromBotId: "bot-x" },
    { type: "removeArchivedBot", botId: "bot-x" },
  ];
  for (const action of removed) {
    assert.equal(isShellActionType(action.type), false, action.type);
    assert.throws(() => applyShellAction(store, action as never), /shell_action_unknown/, action.type);
  }
  for (const type of ["renameBot", "updateBot", "setWorkspace", "setPermission", "connectApp", "connectServer"]) {
    assert.equal(isShellActionType(type), true, type);
  }
  assert.equal(isShellActionType(undefined), false);
  assert.equal(isShellActionType("constructor"), false);
});

test("setBotChat records the chat and its preview, and keeps the preview when none is given", () => {
  const store = seedStore();
  const at = "2026-10-25T12:00:00.000Z";
  const first = setBotChat(store, DEFAULT_BOT_ID, "chat-1", "hello there", at);
  assert.equal(first.bots[0].chatId, "chat-1");
  assert.equal(first.bots[0].lastPreview, "hello there");
  assert.equal(first.bots[0].lastAt, at);
  // A chat made current with no preview keeps the last one.
  const second = setBotChat(first, DEFAULT_BOT_ID, "chat-2", null, "2026-10-25T12:05:00.000Z");
  assert.equal(second.bots[0].chatId, "chat-2");
  assert.equal(second.bots[0].lastPreview, "hello there");
  // No chat at all (the last one was deleted).
  assert.equal(setBotChat(second, DEFAULT_BOT_ID, null, null, at).bots[0].chatId, null);
  // A preview is clipped like every other.
  assert.equal(setBotChat(store, DEFAULT_BOT_ID, "chat-1", "p".repeat(500), at).bots[0].lastPreview.length, 160);
  // The input is not touched.
  assert.equal(store.bots[0].chatId, null);
});

test("setBotChat refuses an unknown bot and an id no path can hold", () => {
  const store = seedStore();
  const at = "2026-10-25T12:00:00.000Z";
  assert.throws(() => setBotChat(store, "nope", "chat-1", "p", at), /shell_bot_missing/);
  assert.throws(() => setBotChat(store, DEFAULT_BOT_ID, "", "p", at), /shell_bot_chat/);
  assert.throws(() => setBotChat(store, DEFAULT_BOT_ID, "x".repeat(81), "p", at), /shell_bot_chat/);
});

test("tolerates unknown keys", () => {
  const store = seedStore();
  // Forward compatibility: a newer build's extra field must not wipe the store.
  const parsed = parseShell({ ...store, extra: true, bots: store.bots.map((bot) => ({ ...bot, extra: 1 })) });
  assert.equal(parsed.bots.length, store.bots.length);
});

test("a roster round-trips through the file, and updateShell keeps both writers' changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  const made = withBot(seedStore(), "Reviewer", { label: "Rev" });
  writeShell(made.store, path);
  const loaded = readShell(path);
  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.bots.length, 2);
  assert.equal(loaded.bots.find((item) => item.id === made.id)?.label, "Rev");
  // The engine records the chat, the web saves the folder: neither drops the other.
  updateShell((store) => setBotChat(store, DEFAULT_BOT_ID, "chat-1", "hi", "2026-10-25T12:00:00.000Z"), path);
  updateShell((store) => applyShellAction(store, { type: "setPermission", botId: DEFAULT_BOT_ID, permission: "read_only" }).store, path);
  const after = readShell(path);
  assert.equal(after.bots[0].chatId, "chat-1");
  assert.equal(after.bots[0].permission, "read_only");
});

test("readShell reseeds a file of any other version, backing it up", () => {
  for (const schemaVersion of [1, 3]) {
    const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
    const path = join(dir, "shell.json");
    writeFileSync(path, `${JSON.stringify({ ...seedStore(), schemaVersion, recents: [] })}\n`);
    const loaded = readShell(path);
    assert.equal(loaded.bots[0].id, DEFAULT_BOT_ID);
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.bots[0].chatId, null);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith("shell.json.invalid.")).length, 1, `version ${schemaVersion}`);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 2);
  }
});

test("a roster naming an ungrantable folder reads back with no workspace", () => {
  const store = parseShell({
    ...seedStore(),
    bots: [{
      ...seedStore().bots[0],
      workspace: { path: "/", permission: "full_access" },
    }],
  });
  // Tolerant, not fatal: the bot keeps working, it just has no folder.
  assert.equal(store.bots[0].workspace, null);
});

test("setWorkspace refuses a root the grants store would reject", () => {
  const base = seedStore();
  const botId = base.bots[0].id;
  for (const bad of ["/", "/Users/someone/.ssh", "/Users/someone/Library/Keychains"]) {
    assert.throws(
      () => applyShellAction(base, {
        type: "setWorkspace",
        botId,
        workspace: { path: bad, permission: "auto" },
      }),
      /workspace_path_invalid/,
      bad,
    );
  }
});

test("setPermission is the bot's own setting, mirrored onto an attached folder", () => {
  let store = seedStore();
  assert.equal(store.bots[0].permission, "auto");
  store = applyShellAction(store, { type: "setPermission", botId: DEFAULT_BOT_ID, permission: "read_only" }).store;
  assert.equal(store.bots[0].permission, "read_only");
  assert.equal(store.bots[0].workspace, null);
  store = applyShellAction(store, {
    type: "setWorkspace",
    botId: DEFAULT_BOT_ID,
    workspace: { path: "/tmp/project", permission: "auto" },
  }).store;
  // Attaching a folder with a permission sets the bot's, so the two never disagree.
  assert.equal(store.bots[0].permission, "auto");
  store = applyShellAction(store, { type: "setPermission", botId: DEFAULT_BOT_ID, permission: "full_access" }).store;
  assert.equal(store.bots[0].permission, "full_access");
  assert.equal(store.bots[0].workspace?.permission, "full_access");
  assert.throws(
    () => applyShellAction(store, { type: "setPermission", botId: "nope", permission: "auto" }),
    /shell_bot_missing/,
  );
  assert.throws(
    () => applyShellAction(store, { type: "setPermission", botId: DEFAULT_BOT_ID, permission: "root" as never }),
    /workspace_permission_invalid/,
  );
  // A roster that kept the permission on the folder only keeps the folder's value.
  const folderOnly = parseShell({
    ...seedStore(),
    bots: seedStore().bots.map((bot) => ({ ...bot, permission: undefined, workspace: { path: "/tmp/p", permission: "read_only" } })),
  });
  assert.equal(folderOnly.bots[0].permission, "read_only");
});

// UB-009: a description is kept to 8,000 characters by refusing, never by clipping.

test("the description cap is 8,000", () => {
  assert.equal(DESCRIPTION_MAX, 8000);
});

test("checkDescription trims, keeps 8,000 and refuses 8,001 without slicing", () => {
  assert.equal(checkDescription(`  ${"a".repeat(8000)}\n`), "a".repeat(8000));
  assert.throws(() => checkDescription("a".repeat(8001)), /shell_description_too_long/);
  assert.throws(() => checkDescription("a".repeat(2001), 2000), /shell_description_too_long/);
});

test("updateBot keeps 8,000 characters and refuses 8,001", () => {
  const ok = "d".repeat(8000);
  const over = "d".repeat(8001);
  const store = seedStore();
  assert.equal(applyShellAction(store, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { description: ok } }).store.bots[0].description, ok);
  assert.throws(() => applyShellAction(store, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { description: over } }), /shell_description_too_long/);
});

test("a refused update leaves the stored description as it was", () => {
  const store = seedStore();
  const kept = applyShellAction(store, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { description: "keep me" } }).store;
  assert.throws(
    () => applyShellAction(kept, { type: "updateBot", botId: DEFAULT_BOT_ID, patch: { notify: true, description: "z".repeat(8001) } }),
    /shell_description_too_long/,
  );
  assert.equal(kept.bots[0].description, "keep me");
  assert.equal(kept.bots[0].notify, false);
});

test("a 9,000-character description in the file is read verbatim and the store is not reseeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  const long = "w".repeat(9000);
  const stored = withBot(seedStore(), "Long", { description: long }).store;
  writeFileSync(path, JSON.stringify(stored), "utf8");
  const loaded = readShell(path);
  assert.equal(loaded.bots.length, 2);
  assert.equal(loaded.bots.find((bot) => bot.name === "Long")?.description, long);
  assert.equal(existsSync(`${path}.reseeded`), false);
  assert.equal(parseShell(JSON.parse(JSON.stringify(stored))).bots[1].description.length, 9000);
});

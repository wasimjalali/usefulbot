import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFaceFor, isAvatarColor, isAvatarShape } from "../shared/bot-face.ts";
import {
  applyShellAction,
  checkDescription,
  DEFAULT_BOT_ID,
  DESCRIPTION_MAX,
  PROPOSE_DESCRIPTION_MAX,
  parseShell,
  pinnedBots,
  searchBots,
  searchShell,
  sectionBots,
  seedStore,
  selectedBot,
  staleSessionIds,
} from "../shared/shell-store.ts";
import { readShell, writeShell } from "../shared/shell-io.ts";

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

test("seed store has compact Generalist in Unassigned", () => {
  const store = seedStore(new Date("2026-09-12T00:00:00Z"));
  assert.equal(store.bots.length, 1);
  assert.equal(store.bots[0].id, DEFAULT_BOT_ID);
  assert.equal(store.bots[0].pinned, true);
  assert.equal(store.bots[0].hidden, false);
  assert.equal(store.bots[0].sectionId, null);
  assert.equal(selectedBot(store).name, "Generalist");
});

function createNamed(store: ReturnType<typeof seedStore>, name: string) {
  return applyShellAction(store, { type: "createBot", name });
}

test("UB-010: three bots on a fresh seed, two pinned, keep the Generalist on top of the pinned group", () => {
  let store = seedStore();
  const a = createNamed(store, "Alpha");
  const b = createNamed(a.store, "Beta");
  const c = createNamed(b.store, "Gamma");
  store = applyShellAction(c.store, { type: "pin", botId: a.createdId! }).store;
  store = applyShellAction(store, { type: "pin", botId: c.createdId! }).store;
  assert.deepEqual(
    pinnedBots(store).map((bot) => bot.name),
    ["Generalist", "Gamma", "Alpha"],
  );
  assert.equal(store.bots[0].id, DEFAULT_BOT_ID);
  assert.deepEqual(store.bots.filter((bot) => !bot.pinned).map((bot) => bot.name), ["Beta"]);
  const d = createNamed(store, "Delta");
  assert.deepEqual(d.store.bots.map((bot) => bot.name), ["Generalist", "Delta", "Gamma", "Beta", "Alpha"]);
});

test("UB-010: unpinned Generalist is not forced back, new bots prepend", () => {
  let store = seedStore();
  store = applyShellAction(store, { type: "pin", botId: DEFAULT_BOT_ID, pinned: false }).store;
  const made = createNamed(store, "Alpha");
  assert.equal(made.store.bots[0].id, made.createdId);
  assert.equal(made.store.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.pinned, false);
});

test("UB-010: re-pinning a Generalist that is not first does not move it, new bots prepend", () => {
  let store = seedStore();
  store = createNamed(store, "Alpha").store;
  store = applyShellAction(store, { type: "pin", botId: DEFAULT_BOT_ID, pinned: false }).store;
  store = createNamed(store, "Beta").store;
  assert.equal(store.bots[0].name, "Beta");
  store = applyShellAction(store, { type: "pin", botId: DEFAULT_BOT_ID, pinned: true }).store;
  assert.equal(store.bots.findIndex((bot) => bot.id === DEFAULT_BOT_ID), 1);
  assert.equal(store.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.pinned, true);
  store = createNamed(store, "Gamma").store;
  assert.deepEqual(store.bots.map((bot) => bot.name), ["Gamma", "Beta", "Generalist", "Alpha"]);
});

test("UB-010: createGroup on a fresh seed keeps the Generalist first", () => {
  let store = seedStore();
  const a = createNamed(store, "Alpha");
  const b = createNamed(a.store, "Beta");
  const group = applyShellAction(b.store, {
    type: "createGroup",
    name: "Desk",
    memberIds: [a.createdId!, b.createdId!],
  });
  assert.deepEqual(group.store.bots.map((bot) => bot.name), ["Generalist", "Desk", "Beta", "Alpha"]);
});

test("UB-010: restart keeps pins and order, and an existing file is not reseeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  let store = readShell(path);
  assert.equal(store.bots[0].pinned, true);
  const a = createNamed(store, "Alpha");
  const b = createNamed(a.store, "Beta");
  store = applyShellAction(b.store, { type: "pin", botId: b.createdId! }).store;
  store = applyShellAction(store, { type: "pin", botId: DEFAULT_BOT_ID, pinned: false }).store;
  writeShell(store, path);
  const loaded = readShell(path);
  assert.deepEqual(loaded.bots.map((bot) => [bot.name, bot.pinned]), store.bots.map((bot) => [bot.name, bot.pinned]));
  assert.equal(loaded.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.pinned, false);
});

test("UB-010: a pre-UB-010 store (unpinned Generalist, last, old name) parses unchanged", () => {
  const seed = seedStore();
  const old = { ...seed.bots[0], name: "Useful Bot", pinned: false };
  const other = createNamed(seed, "Alpha").store.bots.find((bot) => bot.name === "Alpha")!;
  const legacy = { ...seed, selectedBotId: DEFAULT_BOT_ID, bots: [other, old] };
  const parsed = parseShell(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(parsed.bots.map((bot) => [bot.id, bot.name, bot.pinned]), [
    [other.id, "Alpha", false],
    [DEFAULT_BOT_ID, "Useful Bot", false],
  ]);
});

test("create section pin move hide delete and new chat", () => {
  let store = seedStore();
  const section = applyShellAction(store, { type: "createSection", name: "Work" });
  store = section.store;
  const created = applyShellAction(store, {
    type: "createBot",
    name: "Researcher",
    label: "R",
    description: "Looks things up.",
    sectionId: section.createdId,
  });
  store = created.store;
  assert.equal(selectedBot(store).name, "Researcher");
  assert.equal(selectedBot(store).avatarCustom, true);
  assert.equal(isAvatarShape(selectedBot(store).avatarShape), true);
  assert.equal(isAvatarColor(selectedBot(store).avatarColor), true);
  assert.equal(selectedBot(store).avatarShape, defaultFaceFor(created.createdId!).shape);
  assert.equal(selectedBot(store).avatarColor, defaultFaceFor(created.createdId!).color);
  store = applyShellAction(store, { type: "pin", botId: created.createdId! }).store;
  assert.equal(pinnedBots(store).length, 2);
  assert.equal(sectionBots(store, section.createdId!).length, 0);
  store = applyShellAction(store, { type: "pin", botId: created.createdId!, pinned: false }).store;
  store = applyShellAction(store, { type: "move", botId: created.createdId!, sectionId: null }).store;
  assert.equal(sectionBots(store, null).some((bot) => bot.id === created.createdId), true);
  store = applyShellAction(store, { type: "hide", botId: created.createdId! }).store;
  assert.equal(store.bots.find((bot) => bot.id === created.createdId)?.hidden, true);
  assert.equal(store.selectedBotId, DEFAULT_BOT_ID);
  store = applyShellAction(store, { type: "hide", botId: created.createdId!, hidden: false }).store;
  store = applyShellAction(store, { type: "deleteBot", botId: created.createdId! }).store;
  assert.equal(store.bots.length, 1);
  store = applyShellAction(store, { type: "setSession", botId: DEFAULT_BOT_ID, sessionId: "sess-old" }).store;
  store = applyShellAction(store, { type: "touchChat", botId: DEFAULT_BOT_ID, preview: "hello there" }).store;
  const chat = applyShellAction(store, { type: "newChat" });
  store = chat.store;
  assert.equal(store.bots.length, 1);
  assert.equal(selectedBot(store).id, DEFAULT_BOT_ID);
  assert.equal(selectedBot(store).sessionId, null);
  assert.equal(selectedBot(store).lastPreview, "");
  assert.equal(store.recents.length, 1);
  assert.equal(store.recents[0].sessionId, "sess-old");
  assert.equal(store.recents[0].preview, "hello there");
  store = applyShellAction(store, { type: "openRecent", recentId: store.recents[0].id }).store;
  assert.equal(selectedBot(store).sessionId, "sess-old");
});

test("refuses deleting the last bot and tolerates unknown keys", () => {
  const store = seedStore();
  assert.throws(() => applyShellAction(store, { type: "deleteBot", botId: DEFAULT_BOT_ID }), /shell_last_bot/);
  // Forward compatibility: a newer build's extra field must not wipe the store.
  const parsed = parseShell({ ...store, extra: true, bots: store.bots.map((bot) => ({ ...bot, extra: 1 })) });
  assert.equal(parsed.bots.length, store.bots.length);
});

test("group members and persist roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  let store = seedStore();
  const bot = applyShellAction(store, { type: "createBot", name: "Reviewer", label: "Rev" });
  store = bot.store;
  // The default Useful Bot answers untargeted group turns, so it is never a
  // member. A group needs two real bots.
  assert.throws(
    () => applyShellAction(store, {
      type: "createGroup",
      name: "Desk",
      memberIds: [DEFAULT_BOT_ID, bot.createdId!],
    }),
    /shell_group_members/,
  );
  // A group cannot ride a createBot action either: it would seed a memberless
  // group that createGroup's minimum exists to prevent.
  assert.throws(
    () => applyShellAction(store, { type: "createBot", name: "Sneaky", kind: "group" }),
    /shell_group_members/,
  );
  const second = applyShellAction(store, { type: "createBot", name: "Writer" });
  store = second.store;
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Desk",
    memberIds: [bot.createdId!, second.createdId!],
  });
  store = group.store;
  assert.equal(selectedBot(store).kind, "group");
  assert.equal(selectedBot(store).memberIds.length, 2);
  writeShell(store, path);
  const loaded = readShell(path);
  assert.equal(loaded.bots.length, 4);
  assert.equal(searchBots(loaded, "rev").some((item) => item.label === "Rev"), true);
  store = applyShellAction(loaded, { type: "setSession", botId: group.createdId!, sessionId: "sess-1" }).store;
  assert.equal(store.bots.find((item) => item.id === group.createdId)?.sessionId, "sess-1");
});

test("readShell reseeds an incompatible file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, operatorName: "x", bots: [], sections: [] })}\n`);
  const loaded = readShell(path);
  assert.equal(loaded.bots[0].id, DEFAULT_BOT_ID);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.recents.length, 0);
});

test("search palette finds hidden bots and recents", () => {
  let store = seedStore();
  const created = applyShellAction(store, {
    type: "createBot",
    name: "First Frame",
    label: "Video",
    description: "Short form scripts",
  });
  store = created.store;
  store = applyShellAction(store, { type: "touchChat", botId: created.createdId!, preview: "write a script" }).store;
  store = applyShellAction(store, { type: "setSession", botId: created.createdId!, sessionId: "sess-ff" }).store;
  store = applyShellAction(store, { type: "newChat", botId: created.createdId! }).store;
  store = applyShellAction(store, { type: "hide", botId: created.createdId! }).store;
  assert.equal(searchBots(store, "first").some((bot) => bot.id === created.createdId), true);
  assert.equal(searchBots(store, "").some((bot) => bot.id === created.createdId), false);
  const hits = searchShell(store, "script");
  assert.equal(hits.some((hit) => hit.kind === "new-chat"), true);
  assert.equal(hits.some((hit) => hit.kind === "recent" && hit.recent.preview.includes("write a script")), true);
  assert.equal(hits.some((hit) => hit.kind === "bot" && hit.bot.hidden && hit.bot.name === "First Frame"), true);
  const empty = searchShell(store, "");
  assert.equal(empty.some((hit) => hit.kind === "bot" && hit.bot.hidden), false);
  assert.equal(empty.some((hit) => hit.kind === "recent"), true);
  const messages = searchShell(store, "script", "messages");
  assert.equal(messages.every((hit) => hit.kind === "recent"), true);
  const botsOnly = searchShell(store, "first", "bots");
  assert.equal(botsOnly.every((hit) => hit.kind === "bot"), true);
  assert.equal(searchShell(store, "", "groups").length, 0);
  assert.equal(searchShell(store, "script", "files").length, 0);
  assert.equal(searchShell(store, "script", "routines").length, 0);
});

test("parseShell accepts bots without lastPreview from older files", () => {
  const seeded = seedStore(new Date("2026-09-12T00:00:00Z"));
  const raw = JSON.parse(JSON.stringify(seeded)) as {
    bots: Array<Record<string, unknown>>;
    recents?: unknown;
  };
  delete raw.bots[0].lastPreview;
  delete raw.bots[0].lastAt;
  delete raw.bots[0].avatarShape;
  delete raw.bots[0].avatarColor;
  delete raw.bots[0].avatarImage;
  delete raw.bots[0].avatarCustom;
  delete raw.recents;
  const parsed = parseShell(raw);
  assert.equal(parsed.bots[0].lastPreview, "");
  assert.equal(parsed.bots[0].lastAt, null);
  assert.equal(parsed.recents.length, 0);
  assert.equal(parsed.bots[0].avatarCustom, false);
  assert.equal(isAvatarShape(parsed.bots[0].avatarShape), true);
  assert.equal(isAvatarColor(parsed.bots[0].avatarColor), true);
});

test("updateBot writes a custom face", () => {
  let store = seedStore();
  const created = applyShellAction(store, { type: "createBot", name: "SEO" });
  store = applyShellAction(created.store, {
    type: "updateBot",
    botId: created.createdId!,
    patch: { avatarShape: "drop", avatarColor: "gold", avatarCustom: true },
  }).store;
  const bot = store.bots.find((item) => item.id === created.createdId);
  assert.equal(bot?.avatarShape, "drop");
  assert.equal(bot?.avatarColor, "gold");
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

test("staleSessionIds revokes a session nobody holds after the commit", () => {
  const base = seedStore();
  const botId = base.bots[0].id;
  const before = applyShellAction(base, { type: "setSession", botId, sessionId: "sess-old" }).store;
  const after = applyShellAction(before, { type: "setSession", botId, sessionId: "sess-new" }).store;
  const action = { type: "setSession", botId, sessionId: "sess-new" } as const;
  assert.deepEqual(staleSessionIds(action, before, after), ["sess-old"]);
});

test("staleSessionIds leaves a session that only moved between bots", () => {
  const base = applyShellAction(seedStore(), { type: "createBot", name: "Scout" }).store;
  const [first, second] = base.bots;
  const before = applyShellAction(base, { type: "setSession", botId: first.id, sessionId: "sess-1" }).store;
  // The same session is now held by the other bot. Nobody lost the capability,
  // so the diff must not revoke it.
  const moved = applyShellAction(before, { type: "setSession", botId: first.id, sessionId: null }).store;
  const after = applyShellAction(moved, { type: "setSession", botId: second.id, sessionId: "sess-1" }).store;
  const action = { type: "setSession", botId: second.id, sessionId: "sess-1" } as const;
  assert.deepEqual(staleSessionIds(action, before, after), []);
});

test("staleSessionIds catches a detach, where the session id never changes", () => {
  const base = seedStore();
  const botId = base.bots[0].id;
  const withSession = applyShellAction(base, { type: "setSession", botId, sessionId: "sess-1" }).store;
  const before = applyShellAction(withSession, {
    type: "setWorkspace",
    botId,
    workspace: { path: "/tmp", permission: "auto" },
  }).store;
  const action = { type: "setWorkspace", botId, workspace: null } as const;
  const after = applyShellAction(before, action).store;
  assert.deepEqual(staleSessionIds(action, before, after), ["sess-1"]);
});

test("staleSessionIds revokes the deleted bot's session and nobody else's", () => {
  const base = applyShellAction(seedStore(), { type: "createBot", name: "Scout" }).store;
  const [keep, drop] = base.bots;
  const a = applyShellAction(base, { type: "setSession", botId: keep.id, sessionId: "sess-keep" }).store;
  const before = applyShellAction(a, { type: "setSession", botId: drop.id, sessionId: "sess-drop" }).store;
  const action = { type: "deleteBot", botId: drop.id } as const;
  const after = applyShellAction(before, action).store;
  assert.deepEqual(staleSessionIds(action, before, after), ["sess-drop"]);
});

test("staleSessionIds revokes nothing when there is no action", () => {
  const base = applyShellAction(seedStore(), {
    type: "setSession",
    botId: seedStore().bots[0].id,
    sessionId: "sess-1",
  }).store;
  assert.deepEqual(staleSessionIds(undefined, base, base), []);
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
  // A roster from before the bot-level field keeps the folder's value.
  const legacy = parseShell({
    ...seedStore(),
    bots: seedStore().bots.map((bot) => ({ ...bot, permission: undefined, workspace: { path: "/tmp/p", permission: "read_only" } })),
  });
  assert.equal(legacy.bots[0].permission, "read_only");
});

// UB-009: a description is kept to 8,000 characters by refusing, never by clipping.

test("the description caps are 8,000 and 2,000", () => {
  assert.equal(DESCRIPTION_MAX, 8000);
  assert.equal(PROPOSE_DESCRIPTION_MAX, 2000);
});

test("checkDescription trims, keeps 8,000 and refuses 8,001 without slicing", () => {
  assert.equal(checkDescription(`  ${"a".repeat(8000)}\n`), "a".repeat(8000));
  assert.throws(() => checkDescription("a".repeat(8001)), /shell_description_too_long/);
  assert.throws(() => checkDescription("a".repeat(2001), 2000), /shell_description_too_long/);
});

test("every write path keeps 8,000 characters and refuses 8,001", () => {
  const ok = "d".repeat(8000);
  const over = "d".repeat(8001);
  const base = seedStore();
  const withBot = applyShellAction(applyShellAction(base, { type: "createBot", name: "A" }).store, { type: "createBot", name: "B" });
  const store = withBot.store;
  const [a, b] = store.bots.filter((bot) => bot.id !== DEFAULT_BOT_ID).map((bot) => bot.id);
  const members = [a, b];

  assert.equal(applyShellAction(base, { type: "createBot", name: "X", description: ok }).store.bots[1].description, ok);
  assert.throws(() => applyShellAction(base, { type: "createBot", name: "X", description: over }), /shell_description_too_long/);

  const grouped = applyShellAction(store, { type: "createGroup", name: "G", memberIds: members, description: ok });
  assert.equal(grouped.store.bots.find((bot) => bot.id === grouped.createdId)?.description, ok);
  assert.throws(() => applyShellAction(store, { type: "createGroup", name: "G", memberIds: members, description: over }), /shell_description_too_long/);

  assert.equal(applyShellAction(store, { type: "nameBot", botId: a, name: "A", description: ok }).store.bots.find((bot) => bot.id === a)?.description, ok);
  assert.throws(() => applyShellAction(store, { type: "nameBot", botId: a, name: "A", description: over }), /shell_description_too_long/);

  assert.equal(applyShellAction(store, { type: "updateBot", botId: a, patch: { description: ok } }).store.bots.find((bot) => bot.id === a)?.description, ok);
  assert.throws(() => applyShellAction(store, { type: "updateBot", botId: a, patch: { description: over } }), /shell_description_too_long/);
});

test("a refused update leaves the stored description and revision as they were", () => {
  const created = applyShellAction(seedStore(), { type: "createBot", name: "A", description: "keep me" });
  const id = created.createdId ?? "";
  assert.throws(
    () => applyShellAction(created.store, { type: "updateBot", botId: id, patch: { name: "Renamed", description: "z".repeat(8001) } }),
    /shell_description_too_long/,
  );
  const bot = created.store.bots.find((item) => item.id === id);
  assert.equal(bot?.description, "keep me");
  assert.equal(bot?.name, "A");
});

test("a 9,000-character description in the file is read verbatim and the store is not reseeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  const long = "w".repeat(9000);
  const stored = applyShellAction(seedStore(), { type: "createBot", name: "Long", description: "short" }).store;
  stored.bots = stored.bots.map((bot) => (bot.name === "Long" ? { ...bot, description: long } : bot));
  writeFileSync(path, JSON.stringify(stored), "utf8");
  const loaded = readShell(path);
  assert.equal(loaded.bots.length, 2);
  assert.equal(loaded.bots.find((bot) => bot.name === "Long")?.description, long);
  assert.equal(existsSync(`${path}.reseeded`), false);
  assert.equal(parseShell(JSON.parse(JSON.stringify(stored))).bots[1].description.length, 9000);
});

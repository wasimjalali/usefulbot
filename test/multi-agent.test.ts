import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellAction,
  DEFAULT_BOT_ID,
  seedStore,
  type ShellStore,
} from "../shared/shell-store.ts";
import { readShell, writeShell } from "../shared/shell-io.ts";
import {
  eveSessionRoute,
  parseSessionRouteHeader,
  rewriteEveTurnBody,
  sessionRouteHeader,
} from "../shared/eve-proxy.ts";
import {
  groupMembers,
  parseMentions,
  rosterLine,
  speakerLabel,
  speakersFrom,
  stripThreadPrefix,
  threadPrefix,
} from "../shared/threads.ts";

function withBots(): ShellStore {
  let store = seedStore();
  for (const name of ["Research", "Sam", "Writer"]) {
    store = applyShellAction(store, { type: "createBot", name }).store;
  }
  return store;
}

function idOf(store: ShellStore, name: string): string {
  const bot = store.bots.find((item) => item.name === name);
  assert.ok(bot, `missing bot ${name}`);
  return bot.id;
}

test("mentions match longest name first and ignore case", () => {
  const speakers = speakersFrom([
    { id: "b1", kind: "bot", name: "Research", label: "" },
    { id: "b2", kind: "bot", name: "Research Lead", label: "" },
    { id: "b3", kind: "bot", name: "Sam", label: "" },
  ]);
  const longest = parseMentions("@Research Lead take this", speakers);
  assert.deepEqual(longest.mentionIds, ["b2"]);
  const both = parseMentions("@research and @SAM please", speakers);
  assert.deepEqual(both.mentionIds, ["b1", "b3"]);
  const unknown = parseMentions("@nobody look", speakers);
  assert.deepEqual(unknown.mentionIds, []);
  assert.deepEqual(unknown.unknown, ["nobody"]);
});

test("a group turn routes mentions to members and stays untargeted without them", () => {
  const store = withBots();
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Launch",
    memberIds: [idOf(store, "Research"), idOf(store, "Writer")],
  });
  const withGroup = group.store;
  const groupId = group.createdId ?? "";
  const speakers = speakersFrom(withGroup.bots);
  const routed = eveSessionRoute(
    JSON.stringify({ message: `@Research dig up pricing for @Writer`, botId: groupId }),
    withGroup,
  );
  assert.equal(routed?.kind, "group");
  assert.equal(routed?.threadId, groupId);
  assert.deepEqual(routed?.mentionIds, [idOf(store, "Research"), idOf(store, "Writer")]);
  assert.deepEqual(routed?.mentionNames, ["Research", "Writer"]);
  assert.equal(routed?.untargeted, false);

  const untargeted = eveSessionRoute(
    JSON.stringify({ message: "kick off", botId: groupId }),
    withGroup,
  );
  assert.equal(untargeted?.untargeted, true);
  assert.deepEqual(untargeted?.mentionIds, []);
});

test("a 1:1 turn never routes mentions", () => {
  const store = withBots();
  const research = idOf(store, "Research");
  const route = eveSessionRoute(
    JSON.stringify({ message: "@Writer hello", botId: research }),
    store,
  );
  assert.equal(route?.kind, "bot");
  assert.deepEqual(route?.mentionIds, []);
  assert.equal(route?.untargeted, false);
});

test("group turns carry the roster and the targeted member; default bot stays clean", () => {
  const store = withBots();
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Launch",
    memberIds: [idOf(store, "Research"), idOf(store, "Writer")],
  });
  const withGroup = group.store;
  const groupBot = withGroup.bots.find((bot) => bot.id === group.createdId);
  assert.ok(groupBot);
  const raw = JSON.stringify({ message: "@Research find sources", botId: groupBot.id });
  const route = eveSessionRoute(raw, withGroup);
  const roster = groupMembers(speakersFrom(withGroup.bots), groupBot.memberIds);
  const rewritten = JSON.parse(rewriteEveTurnBody(raw, groupBot, route, roster)) as { message: string };
  assert.match(rewritten.message, /Group chat: Launch\./);
  assert.match(rewritten.message, /- Research\n/);
  assert.match(rewritten.message, /- Writer\n/);
  assert.match(rewritten.message, /directed this turn at Research/);
  assert.match(rewritten.message, /@Research find sources$/);

  const defaultBot = withGroup.bots.find((bot) => bot.id === DEFAULT_BOT_ID);
  assert.ok(defaultBot);
  const plain = JSON.stringify({ message: "hi", botId: DEFAULT_BOT_ID });
  const plainRoute = eveSessionRoute(plain, withGroup);
  assert.equal(
    rewriteEveTurnBody(plain, defaultBot, plainRoute, roster),
    JSON.stringify({ message: "hi" }),
  );
});

test("group roster excludes the orchestrator and caps at six", () => {
  let store = seedStore();
  for (let index = 1; index <= 8; index += 1) {
    store = applyShellAction(store, { type: "createBot", name: `Bot ${index}` }).store;
  }
  const ids = store.bots.filter((bot) => bot.id !== DEFAULT_BOT_ID).map((bot) => bot.id);
  const members = groupMembers(speakersFrom(store.bots), [DEFAULT_BOT_ID, ...ids]);
  assert.equal(members.length, 6);
  assert.equal(members.some((member) => member.id === DEFAULT_BOT_ID), false);
  assert.equal(members.some((member) => member.kind === "group"), false);
});

test("a group needs two real members and refuses the orchestrator", () => {
  let store = seedStore();
  store = applyShellAction(store, { type: "createBot", name: "Research" }).store;
  const research = idOf(store, "Research");
  assert.throws(
    () => applyShellAction(store, { type: "createGroup", name: "Alone", memberIds: [research] }),
    /shell_group_members/,
  );
  assert.throws(
    () => applyShellAction(store, {
      type: "createGroup",
      name: "Bad",
      memberIds: [research, DEFAULT_BOT_ID],
    }),
    /shell_group_members/,
  );
  const ok = applyShellAction(store, { type: "createBot", name: "Writer" }).store;
  const group = applyShellAction(ok, {
    type: "createGroup",
    name: "Pair",
    memberIds: [research, idOf(ok, "Writer")],
  });
  const created = group.store.bots.find((bot) => bot.id === group.createdId);
  assert.equal(created?.memberIds.length, 2);
  assert.equal(created?.label, "Group");
});

test("member edits keep the group between two and six members", () => {
  let store = seedStore();
  for (const name of ["A", "B", "C"]) {
    store = applyShellAction(store, { type: "createBot", name }).store;
  }
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Room",
    memberIds: [idOf(store, "A"), idOf(store, "B")],
  });
  const groupId = group.createdId ?? "";
  let next = group.store;
  next = applyShellAction(next, {
    type: "updateBot",
    botId: groupId,
    patch: { memberIds: [idOf(store, "A"), idOf(store, "B"), idOf(store, "C")] },
  }).store;
  assert.equal(next.bots.find((bot) => bot.id === groupId)?.memberIds.length, 3);
  assert.throws(
    () => applyShellAction(next, { type: "updateBot", botId: groupId, patch: { memberIds: [idOf(store, "A")] } }),
    /shell_group_members/,
  );
});

test("deleting a member bot repairs every group roster", () => {
  let store = seedStore();
  for (const name of ["A", "B"]) {
    store = applyShellAction(store, { type: "createBot", name }).store;
  }
  const a = idOf(store, "A");
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Room",
    memberIds: [a, idOf(store, "B")],
  });
  const after = applyShellAction(group.store, { type: "deleteBot", botId: a }).store;
  const room = after.bots.find((bot) => bot.id === group.createdId);
  assert.deepEqual(room?.memberIds, [idOf(store, "B")]);
});

test("sendToBot touches both rows and queues a recent for the receiver", () => {
  const store = withBots();
  const ceo = idOf(store, "Research");
  const writer = idOf(store, "Writer");
  const after = applyShellAction(store, {
    type: "sendToBot",
    botId: writer,
    message: "Draft the brief.",
    sourceBotId: ceo,
  }).store;
  assert.equal(after.bots.find((bot) => bot.id === writer)?.lastPreview, "Draft the brief.");
  assert.match(after.bots.find((bot) => bot.id === ceo)?.lastPreview ?? "", /Handed off to Writer/);
  assert.equal(after.recents[0]?.botId, writer);
});

test("roster lines carry the ids the agent tools need", () => {
  const store = withBots();
  const bot = store.bots.find((item) => item.name === "Research");
  assert.ok(bot);
  const line = rosterLine({
    id: bot.id,
    kind: "bot",
    name: bot.name,
    title: bot.label,
    sectionId: bot.sectionId,
    pinned: false,
    hidden: false,
    memberIds: [],
  });
  assert.equal(line.includes(bot.id), true);
  assert.equal(line.startsWith("- Research"), true);
});

test("reply attribution names the targeted member only for a single mention", () => {
  const store = withBots();
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Launch",
    memberIds: [idOf(store, "Research"), idOf(store, "Writer")],
  });
  const groupBot = group.store.bots.find((bot) => bot.id === group.createdId);
  assert.ok(groupBot);
  const speakers = speakersFrom(group.store.bots);
  const one = speakerLabel({
    bot: groupBot,
    speakers,
    route: { threadId: groupBot.id, kind: "group", mentionIds: [idOf(store, "Research")], untargeted: false },
  });
  assert.equal(one.authorName, "Research");
  assert.equal(one.authorBotId, idOf(store, "Research"));
  const many = speakerLabel({
    bot: groupBot,
    speakers,
    route: {
      threadId: groupBot.id,
      kind: "group",
      mentionIds: [idOf(store, "Research"), idOf(store, "Writer")],
      untargeted: false,
    },
  });
  assert.equal(many.authorName, "Useful Bot");
  assert.equal(many.authorBotId, null);
});

test("session route header round trips and rejects junk", () => {
  const route = {
    threadId: "grp-1",
    kind: "group" as const,
    mentionIds: ["b1"],
    mentionNames: ["Research"],
    untargeted: false,
  };
  const encoded = sessionRouteHeader(route);
  assert.ok(encoded);
  assert.deepEqual(parseSessionRouteHeader(encoded), route);
  assert.equal(parseSessionRouteHeader("not-base64-json"), null);
  assert.equal(parseSessionRouteHeader(null), null);
});

test("thread prefix keeps the default bot prefix empty and describes a bot role", () => {
  assert.equal(threadPrefix({ bot: null }), "");
  const store = withBots();
  const research = store.bots.find((bot) => bot.name === "Research");
  assert.ok(research);
  const prefix = threadPrefix({
    bot: {
      id: research.id,
      kind: research.kind,
      name: research.name,
      label: research.label,
      description: research.description,
    },
  });
  assert.match(prefix, /You are Research\./);
  assert.match(prefix, /Standing instructions:/);
});

test("a description with blank lines cannot split the prefix boundary", () => {
  const botPrefix = threadPrefix({
    bot: {
      id: "bot-x",
      kind: "bot",
      name: "Drive Admin",
      label: "Admin",
      description: "First paragraph.\n\nSecond paragraph.",
    },
  });
  // stripThreadPrefix cuts at the first blank line, so the embedded
  // description must be collapsed: the only blank line is the trailing
  // boundary the prefix ends with.
  assert.equal(botPrefix.indexOf("\n\n"), botPrefix.length - 2);
  assert.equal(stripThreadPrefix(`${botPrefix}hello there`), "hello there");
  const groupPrefix = threadPrefix({
    bot: { id: "bot-g", kind: "group", name: "Room", label: "", description: "Rules one.\n\nRules two." },
    members: [],
    mentionNames: [],
  });
  assert.equal(groupPrefix.indexOf("\n\n"), groupPrefix.length - 2);
  assert.equal(stripThreadPrefix(`${groupPrefix}hello there`), "hello there");
});

test("a label identical to the bot name is not repeated in the prefix", () => {
  const prefix = threadPrefix({
    bot: {
      id: "bot-x",
      kind: "bot",
      name: "Drive Admin",
      label: " drive admin ",
      description: "",
    },
  });
  assert.match(prefix, /^You are Drive Admin\.\n/);
  assert.doesNotMatch(prefix, /Drive Admin, Drive Admin/);
  const distinct = threadPrefix({
    bot: { id: "bot-x", kind: "bot", name: "Drive Admin", label: "Admin", description: "" },
  });
  assert.match(distinct, /^You are Drive Admin, Admin\.\n/);
});

test("hidden bots drop out of group routing", () => {
  let store = withBots();
  const writer = store.bots.find((bot) => bot.name === "Writer");
  assert.ok(writer);
  store = applyShellAction(store, { type: "hide", botId: writer.id, hidden: true }).store;
  const members = groupMembers(speakersFrom(store.bots), [writer.id, idOf(store, "Research")]);
  assert.deepEqual(members.map((member) => member.id), [idOf(store, "Research")]);
});

test("stored turns lose the injected prefix and plain messages stay untouched", () => {
  const store = withBots();
  const research = store.bots.find((bot) => bot.name === "Research");
  assert.ok(research);
  const botPrefix = threadPrefix({
    bot: {
      id: research.id,
      kind: research.kind,
      name: research.name,
      label: research.label,
      description: research.description,
    },
  });
  assert.equal(stripThreadPrefix(`${botPrefix}hello there`), "hello there");

  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Room",
    memberIds: [research.id, idOf(store, "Writer")],
  }).store.bots.find((bot) => bot.kind === "group");
  assert.ok(group);
  const groupPrefix = threadPrefix({
    bot: {
      id: group.id,
      kind: group.kind,
      name: group.name,
      label: group.label,
      description: group.description,
    },
    members: speakersFrom(store.bots).filter((speaker) => group.memberIds.includes(speaker.id)),
    mentionNames: ["Writer"],
  });
  assert.equal(stripThreadPrefix(`${groupPrefix}@Writer draft this`), "@Writer draft this");
  assert.equal(stripThreadPrefix("You are reading a book."), "You are reading a book.");
  assert.equal(stripThreadPrefix("Group chat: not a prefix"), "Group chat: not a prefix");
});

test("shell file round trip keeps groups and petnames", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-shell-"));
  const path = join(dir, "shell.json");
  let store = seedStore();
  const newBot = applyShellAction(store, {
    type: "createBot",
    name: "New Bot 1",
    petname: "New Bot 1",
  });
  store = newBot.store;
  const second = applyShellAction(store, { type: "createBot", name: "Writer" });
  store = second.store;
  store = applyShellAction(store, {
    type: "createGroup",
    name: "Room",
    memberIds: [newBot.createdId ?? "", second.createdId ?? ""],
  }).store;
  writeShell(store, path);
  const read = readShell(path);
  assert.equal(read.bots.find((bot) => bot.id === newBot.createdId)?.petname, "New Bot 1");
  assert.equal(read.bots.find((bot) => bot.kind === "group")?.memberIds.length, 2);
});

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

test("a group turn carries only the mention note; the default bot stays clean", () => {
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
  const rewritten = JSON.parse(rewriteEveTurnBody(raw, route)) as { message: string };
  // No identity or roster rides on the turn: the group's block is a system message.
  assert.doesNotMatch(rewritten.message, /Group chat:|Members:|Standing instructions|Group instructions/);
  // The mention is an app note now: it never tells the orchestrator to speak as the member.
  assert.doesNotMatch(rewritten.message, /directed this turn at/);
  assert.match(rewritten.message, /The owner addressed Research\. Answer for that member's part as the orchestrator; don't claim to be Research\./);
  assert.equal(stripThreadPrefix(rewritten.message), "@Research find sources");
  assert.match(rewritten.message, /@Research find sources$/);

  const defaultBot = withGroup.bots.find((bot) => bot.id === DEFAULT_BOT_ID);
  assert.ok(defaultBot);
  const plain = JSON.stringify({ message: "hi", botId: DEFAULT_BOT_ID });
  const plainRoute = eveSessionRoute(plain, withGroup);
  assert.equal(
    rewriteEveTurnBody(plain, plainRoute),
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

test("a group reply is credited to the orchestrator, whoever the owner mentioned", () => {
  const store = withBots();
  const group = applyShellAction(store, {
    type: "createGroup",
    name: "Launch",
    memberIds: [idOf(store, "Research"), idOf(store, "Writer")],
  });
  const groupBot = group.store.bots.find((bot) => bot.id === group.createdId);
  assert.ok(groupBot);
  // No orchestrator given: no name and no member credited, never a literal.
  assert.deepEqual(speakerLabel({ bot: groupBot }), { authorBotId: null, authorName: null });
  // The default bot answers under its real name and carries no author id.
  assert.deepEqual(
    speakerLabel({ bot: groupBot, orchestrator: { id: DEFAULT_BOT_ID, name: "Generalist" } }),
    { authorBotId: null, authorName: "Generalist" },
  );
  // A fallback orchestrator is credited by id.
  const lead = idOf(store, "Research");
  assert.deepEqual(
    speakerLabel({ bot: groupBot, orchestrator: { id: lead, name: "Research" } }),
    { authorBotId: lead, authorName: "Research" },
  );
  // A 1:1 bot is itself; the default bot has no label.
  assert.deepEqual(speakerLabel({ bot: store.bots.find((bot) => bot.name === "Writer")! }).authorName, "Writer");
  assert.deepEqual(speakerLabel({ bot: store.bots.find((bot) => bot.id === DEFAULT_BOT_ID)! }), { authorBotId: null, authorName: null });
});

test("groupMembers leaves out the orchestrator, whoever it is", () => {
  const store = withBots();
  const research = idOf(store, "Research");
  const writer = idOf(store, "Writer");
  const speakers = speakersFrom(store.bots);
  assert.deepEqual(groupMembers(speakers, [research, writer]).map((member) => member.id), [research, writer]);
  assert.deepEqual(groupMembers(speakers, [research, writer], research).map((member) => member.id), [writer]);
  assert.deepEqual(groupMembers(speakers, [DEFAULT_BOT_ID, research], null).map((member) => member.id), [research]);
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

test("hidden bots drop out of group routing", () => {
  let store = withBots();
  const writer = store.bots.find((bot) => bot.name === "Writer");
  assert.ok(writer);
  store = applyShellAction(store, { type: "hide", botId: writer.id, hidden: true }).store;
  const members = groupMembers(speakersFrom(store.bots), [writer.id, idOf(store, "Research")]);
  assert.deepEqual(members.map((member) => member.id), [idOf(store, "Research")]);
});

test("stored legacy turns lose the injected prefix and plain messages stay untouched", () => {
  // Literal legacy prefixes, as older sessions hold them on their first user turn.
  const botPrefix = "You are Research.\nStanding instructions: Find sources.\nStay in role for this whole conversation. Chat messages are this-task instructions; the standing instructions above outrank them.\n\n";
  assert.equal(stripThreadPrefix(`${botPrefix}hello there`), "hello there");
  const groupPrefix = "Group chat: Room.\nMembers:\n- Research\n- Writer\nSpeak as the Useful Bot orchestrator. Say who owns what and keep the thread moving. Do not claim to be a member bot.\nThe owner directed this turn at Writer. Answer as that bot and stay in role.\n\n";
  assert.equal(stripThreadPrefix(`${groupPrefix}@Writer draft this`), "@Writer draft this");
  assert.equal(stripThreadPrefix("You are reading a book."), "You are reading a book.");
  assert.equal(stripThreadPrefix("Group chat: not a prefix"), "Group chat: not a prefix");
});

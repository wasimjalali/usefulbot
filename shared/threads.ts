import { DEFAULT_BOT_ID, type BotKind } from "./shell-store.ts";
import type { ThreadKind } from "./agent-store.ts";

/**
 * Routing rules for 1:1 threads, group chats and bot-to-bot handoffs.
 * Pure functions only: the agent tools and the eve proxy both share
 * this file, so it must not import anything platform specific.
 */

export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;
export const GROUP_ROSTER_MAX = 6;

/** The subset of a shell bot that routing and attribution need. */
export type Speaker = {
  id: string;
  kind: BotKind;
  name: string;
  title: string;
  hidden?: boolean;
};

export type Route = {
  threadId: string;
  kind: ThreadKind;
  mentionIds: string[];
  /** A group message with no @mention: the orchestrator picks who answers. */
  untargeted: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mention scan. Mentions are matched against the roster rather than by
 * tokenizing after the @, so multi-word names ("@Research Lead") resolve and
 * "@Samantha" does not match a bot named "Sam". Names win over ids, and longer
 * names win over their own prefixes.
 */
export function parseMentions(text: string, bots: Speaker[]): { mentionIds: string[]; unknown: string[] } {
  const mentionIds: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const claim = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    mentionIds.push(id);
  };

  const named = bots
    .map((bot) => ({ bot, name: bot.name.trim() }))
    .filter((item) => item.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  if (named.length > 0) {
    const pattern = named.map((item) => escapeRegExp(item.name)).join("|");
    const at = new RegExp(`@(?:${pattern})(?![\\w-])`, "gi");
    for (const match of text.matchAll(at)) {
      const name = match[0].slice(1).toLowerCase();
      const hit = named.find((item) => item.name.toLowerCase() === name);
      if (hit) claim(hit.bot.id);
    }
  }

  const ids = bots.filter((bot) => /^[\w.:-]+$/.test(bot.id));
  if (ids.length > 0) {
    const pattern = ids.map((bot) => escapeRegExp(bot.id)).join("|");
    const at = new RegExp(`@(${pattern})(?![\\w-])`, "gi");
    for (const match of text.matchAll(at)) {
      const hit = ids.find((bot) => bot.id.toLowerCase() === match[1].toLowerCase());
      if (hit) claim(hit.id);
    }
  }

  const any = /@([^\s@,.;:!?]+)/g;
  for (const match of text.matchAll(any)) {
    const token = match[1];
    const known = named.some((item) => item.name.toLowerCase().startsWith(token.toLowerCase()))
      || ids.some((bot) => bot.id.toLowerCase() === token.toLowerCase());
    if (!known && !unknown.includes(token)) unknown.push(token);
  }
  return { mentionIds, unknown };
}

export function resolveRoute(input: {
  botId: string;
  text: string;
  bots: Speaker[];
  memberIds?: string[];
  /** The orchestrator's id; it is never a member. Defaults to the default bot. */
  orchestrator?: string | null;
}): Route {
  const target = input.bots.find((bot) => bot.id === input.botId) ?? null;
  const kind: ThreadKind = target?.kind === "group" ? "group" : "bot";
  const threadId = input.botId;
  if (kind !== "group") {
    return { threadId, kind, mentionIds: [], untargeted: false };
  }
  const members = groupMembers(input.bots, input.memberIds ?? [], input.orchestrator);
  const scanned = parseMentions(input.text, members);
  return {
    threadId,
    kind,
    mentionIds: scanned.mentionIds,
    untargeted: scanned.mentionIds.length === 0,
  };
}

/**
 * The member bots of a group. The orchestrator is never a member: pass its id
 * (see `orchestratorId` in shell-store.ts); it defaults to the default bot, and
 * null excludes nobody on that ground.
 */
export function groupMembers(
  bots: Speaker[],
  memberIds: string[],
  orchestrator: string | null = DEFAULT_BOT_ID,
): Speaker[] {
  const members: Speaker[] = [];
  for (const id of memberIds) {
    if (members.some((member) => member.id === id)) continue;
    const bot = bots.find((item) => item.id === id) ?? null;
    if (!bot || bot.kind !== "bot" || bot.id === DEFAULT_BOT_ID || bot.id === orchestrator || bot.hidden) continue;
    members.push(bot);
    if (members.length >= GROUP_ROSTER_MAX) break;
  }
  return members;
}

export function speakersFrom(
  bots: Array<{ id: string; kind: BotKind; name: string; label: string; hidden?: boolean }>,
): Speaker[] {
  return bots.map((bot) => ({
    id: bot.id,
    kind: bot.kind,
    name: bot.name,
    title: bot.label,
    hidden: bot.hidden === true,
  }));
}

export type RosterEntry = {
  id: string;
  kind: BotKind;
  name: string;
  title: string;
  sectionId: string | null;
  pinned: boolean;
  hidden: boolean;
  memberIds: string[];
};

/**
 * Plain-text roster handed to the model. Ids are included because every agent
 * tool takes ids, and a model that only knows display names cannot address a
 * teammate reliably.
 */
export function rosterLine(entry: RosterEntry): string {
  const bits = [entry.kind === "group" ? "group" : "bot", entry.id];
  if (entry.title.trim()) bits.push(entry.title.trim());
  if (entry.hidden) bits.push("hidden");
  if (entry.pinned) bits.push("pinned");
  return `- ${entry.name} [${bits.join(", ")}]`;
}

export function groupLine(entry: RosterEntry, names: string[]): string {
  return `- ${entry.name} [group, ${entry.id}] members: ${names.join(", ") || "none"}`;
}

export function speakerFor(speakers: Speaker[], id: string | null): Speaker | null {
  if (!id) return null;
  return speakers.find((bot) => bot.id === id) ?? null;
}

/**
 * The legacy identity prefix older sessions carry on their first user turn.
 * New turns no longer build one (the bot's instructions are a system block);
 * these two shapes are kept only so old history still reads as the owner's
 * message.
 */
const BOT_TURN_PREFIX = /^You are [^\n]+\.\nStanding instructions: /;
const GROUP_TURN_PREFIX = /^Group chat: [^\n]+\.\n/;
/** The default bot's hidden prefix, only present when it carries app notes (see continuation-brief.ts). */
const SESSION_NOTE_PREFIX = /^Session note: the lines below come from the app, not from the owner\.\n/;

/**
 * Remove the identity prefix injected into a stored user turn so the UI can
 * render the owner's original message. Only text matching one of the two
 * prefix shapes is stripped; an ordinary message is returned untouched.
 */
export function stripThreadPrefix(text: string): string {
  if (!BOT_TURN_PREFIX.test(text) && !GROUP_TURN_PREFIX.test(text) && !SESSION_NOTE_PREFIX.test(text)) return text;
  const breakAt = text.indexOf("\n\n");
  return breakAt === -1 ? text : text.slice(breakAt + 2);
}

/**
 * Transcript label for the bot a routed turn is answering as. A group reply is
 * the orchestrator's, whoever the owner mentioned: the member does not speak.
 */
export function speakerLabel(input: {
  bot: { id: string; kind: BotKind; name: string; label: string } | null;
  /** The orchestrator that answers for a group (see `orchestratorId`); with none given the group reply carries no name. */
  orchestrator?: { id: string; name: string } | null;
}): { authorBotId: string | null; authorName: string | null } {
  const bot = input.bot;
  if (!bot || bot.id === DEFAULT_BOT_ID) return { authorBotId: null, authorName: null };
  if (bot.kind !== "group") return { authorBotId: bot.id, authorName: bot.name };
  const orchestrator = input.orchestrator ?? null;
  return {
    authorBotId: orchestrator && orchestrator.id !== DEFAULT_BOT_ID ? orchestrator.id : null,
    authorName: orchestrator?.name ?? null,
  };
}

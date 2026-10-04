/**
 * The system-role context blocks every turn carries after `instructions.md`
 * (UB-009). Pure renderers: they take plain values and return text, and read
 * nothing. Texts follow evals/results/2026-10-01-ub009-council/final/context-blocks.md.
 *
 * Order in a turn: Running the team (the Generalist's own chat only), Your bot,
 * then This turn. The notes block lives in shared/notes-block.ts.
 */

const FIELD_CAP = 80;

// C0 and C1 control characters, DEL and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Serialize one interpolated field: one line, no control characters, at most
 * `cap` characters, with `</` escaped. Names, labels, member names and the folder name go through
 * this, so none of them can start a new line of instructions.
 */
export function flat(value: string, cap = FIELD_CAP): string {
  // "</" is escaped so a field can't carry a closing tag into the text around it.
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().replace(/<\//g, "<\\/").slice(0, cap);
}

/**
 * Wrap text in `<tag>` so its content can't close the boundary: any closing
 * tag inside the text is escaped (`</tag` becomes `<\/tag`, any letter case).
 */
export function fence(tag: string, text: string): string {
  // Whitespace inside the closing tag (`< / tag`) is escaped too: a model reads it as the tag.
  const escaped = text.replace(new RegExp(`<\\s*/\\s*(${tag})`, "gi"), "<\\/$1");
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

/** Rough size for the admission check: about 3.5 characters a token, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

const NO_DESCRIPTION = "None yet. Work as a general assistant within the rules above.";

const RUNNING_FIRST = "You are the owner's main assistant, and the one who builds and runs their other bots.";

/**
 * The Generalist's own-chat block. `fallback` is true when the orchestrator
 * is not `bot-useful` (the owner deleted it): the first sentence is dropped.
 */
export function renderRunningTheTeam({ fallback }: { fallback: boolean }): string {
  const lines = [
    "# Running the team",
    "",
    ...(fallback ? [] : [RUNNING_FIRST, ""]),
    "- Do one-off work yourself. Suggest a teammate only for a recurring job with its own scope, tools or permission, one at a time, and propose it only when the owner asks or agrees.",
    "- `propose_bot`, `update_bot_profile` and `propose_group` only show a card. Nothing exists or changes until the owner confirms, so don't say it does.",
    "- A teammate's instructions are its standing system prompt, read on every turn. Write them in the second person, 80 to 200 words, in this order. Role: \"You are NAME, the owner's JOB.\" Scope: what it handles and where, and what it leaves alone. Boundaries: what it asks before doing and what it never does, written as refusals it can act on. Output: what a finished reply looks like. Leave out secrets, tool names, quoted outside text and copies of these rules. Title: the job in two or three words.",
    "- To hand work over, `send_to_bot` with the task, the limits and what to send back. Teammates don't see this chat.",
    "- Groups: propose 2 to 6 real member bots. You orchestrate a group and are never a member.",
    "- Routines: only when the owner asks for recurring work. `list_routines` first, then say the schedule and time zone back in one line. Every run costs a model call. Prefer pausing to deleting.",
    "- The rail: `rail_action` pins, hides, moves and makes sections. `delete_bot` and `clear_history` can't be undone, so name exactly what goes.",
    "- When the owner asks what you can do, check what's connected and answer for their goal, briefly.",
  ];
  return lines.join("\n");
}

export type ContextBot = { name: string; label: string; description: string };
export type ContextMember = { name: string; label: string };

function ownerText(description: string): string {
  return description.trim() === "" ? NO_DESCRIPTION : description;
}

/** "Your bot" for a plain bot. The description sits in a boundary it can't close. */
export function renderYourBot(bot: ContextBot): string {
  const label = flat(bot.label);
  return [
    "# Your bot",
    "",
    `You are ${flat(bot.name)}${label ? `, ${label}` : ""}.`,
    "",
    "Instructions from the owner, verbatim:",
    fence("owner-instructions", ownerText(bot.description)),
    "Older messages in this chat may start with a hidden \"Standing instructions\" header from an earlier version of the app. These instructions replace it.",
  ].join("\n");
}

/** "Your bot" for a group session: the orchestrator's view of the group. */
export function renderYourGroup(group: ContextBot, members: ContextMember[]): string {
  const list = members
    .map((member) => {
      const label = flat(member.label);
      return label ? `${flat(member.name)} (${label})` : flat(member.name);
    })
    .join(", ");
  return [
    "# Your bot",
    "",
    `You orchestrate the group ${flat(group.name)}. Members: ${list}. Say who owns what, credit who did the work, and keep the thread moving. You are not a member and never speak as one.`,
    "",
    "Group instructions from the owner, verbatim:",
    fence("owner-instructions", ownerText(group.description)),
  ].join("\n");
}

export type ThisTurnPermission = "read_only" | "auto" | "full_access";

const PERMISSION_LABEL: Record<ThisTurnPermission, string> = {
  read_only: "Read only",
  auto: "Auto",
  full_access: "Full access",
};

export type ThisTurn = {
  /** The owner's full name and the name to call them. */
  owner: string;
  first: string;
  /** The moment of the turn. Only its calendar day in `tz` is shown. */
  date: Date;
  tz: string;
  /** Null when the turn cannot name its grant: a sub-agent whose chat is unknown. */
  permission: ThisTurnPermission | null;
  /** The attached folder's name, or null when none is attached. */
  folder: string | null;
  model: { label: string; id: string; connection: string };
  /** The image model this turn would use, or null when none is connected. */
  image: { label: string; id: string } | null;
  /** True only while this bot has no finished turn. */
  firstChat: boolean;
  /** Sub-agent sessions the owner stopped whose cancelled report this turn carries. Absent or empty: none. */
  stopped?: string[];
};

/** Weekday and YYYY-MM-DD for `date` in `tz`. Day granularity keeps the block stable all day. */
function dayIn(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => {
    const found = parts.find((item) => item.type === type)?.value;
    if (!found) throw new Error(`context_date_${type}`);
    return found;
  };
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")}`;
}

export function renderThisTurn(turn: ThisTurn): string {
  const owner = flat(turn.owner);
  const first = flat(turn.first);
  const folder = turn.folder === null
    ? "no folder, working under the owner's home"
    : `folder "${flat(turn.folder)}" attached`;
  const image = turn.image
    ? `generate_image uses ${flat(turn.image.label)} (${flat(turn.image.id)}).`
    : "No image model is connected.";
  const lines = [
    "# This turn",
    "",
    `Owner: ${owner} (call them ${first}). Today: ${dayIn(turn.date, turn.tz)}, time zone ${flat(turn.tz)}.`,
    turn.permission === null
      ? "This chat: the same permission and folder as the chat that started you."
      : `This chat: ${PERMISSION_LABEL[turn.permission]}, ${folder}.`,
    `Model: ${flat(turn.model.label)} (${flat(turn.model.id)}) via ${flat(turn.model.connection)}. Say this when asked what powers you. ${image}`,
  ];
  if (turn.firstChat) lines.push("This is the owner's first chat with you.");
  if (turn.stopped?.length) {
    lines.push(`The owner pressed Stop on these sub-agents: ${turn.stopped.map((id) => flat(id)).join(", ")}. Their cancelled reports are not failures. Do not start them again unless the owner asks.`);
  }
  return lines.join("\n");
}

export type ContextSnapshot = {
  /**
   * Set for the orchestrator's own chat: the "Running the team" block, with
   * `fallback` true when the orchestrator isn't `bot-useful`. Null otherwise
   * (teammates and group sessions).
   */
  running: { fallback: boolean } | null;
  bot: ContextBot;
  /** Set for a group session: the member list, and `bot` is the group. */
  groupMembers: ContextMember[] | null;
  turn: ThisTurn;
};

/** The whole system-role context, blocks in order: Running the team, Your bot, This turn. */
export function renderContext(snapshot: ContextSnapshot): string {
  const blocks: string[] = [];
  if (snapshot.running) blocks.push(renderRunningTheTeam(snapshot.running));
  blocks.push(
    snapshot.groupMembers
      ? renderYourGroup(snapshot.bot, snapshot.groupMembers)
      : renderYourBot(snapshot.bot),
  );
  blocks.push(renderThisTurn(snapshot.turn));
  return blocks.join("\n\n");
}

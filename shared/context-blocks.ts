/**
 * The system-role context blocks every turn carries after `instructions.md`
 * (UB-009). Pure renderers: they take plain values and return text, and read
 * nothing. Texts follow evals/results/2026-10-01-ub009-council/final/context-blocks.md.
 *
 * Order in a turn: Your bot, then This turn. The notes block lives in
 * shared/notes-block.ts.
 */

const FIELD_CAP = 80;

// C0 and C1 control characters, DEL and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Serialize one interpolated field: one line, no control characters, at most
 * `cap` characters, with `</` escaped. Names, labels and the folder name go through
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

export type ContextBot = { name: string; label: string; description: string };

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
  permission: ThisTurnPermission;
  /** The attached folder's name, or null when none is attached. */
  folder: string | null;
  model: { label: string; id: string; connection: string };
  /** The image model this turn would use, or null when none is connected. */
  image: { label: string; id: string } | null;
  /** True only while this bot has no finished turn. */
  firstChat: boolean;
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
    `This chat: ${PERMISSION_LABEL[turn.permission]}, ${folder}.`,
    `Model: ${flat(turn.model.label)} (${flat(turn.model.id)}) via ${flat(turn.model.connection)}. Say this when asked what powers you. ${image}`,
  ];
  if (turn.firstChat) lines.push("This is the owner's first chat with you.");
  return lines.join("\n");
}

export type ContextSnapshot = {
  bot: ContextBot;
  turn: ThisTurn;
};

/** The whole system-role context, blocks in order: Your bot, This turn. */
export function renderContext(snapshot: ContextSnapshot): string {
  return [renderYourBot(snapshot.bot), renderThisTurn(snapshot.turn)].join("\n\n");
}

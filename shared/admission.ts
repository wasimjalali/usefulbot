/**
 * Admission (UB-009): before a turn is sent, the fixed envelope it carries is
 * compared with the bot's model window. Refused with a plain sentence when it
 * does not fit, never clipped. Pure: callers read the notes and pass their
 * sizes in. The engine measures the system prompt and the tool schemas itself
 * (SPEC 5.5.1) and passes them as `promptChars` and `toolSchemaChars`; the
 * constants below are the estimate for a caller that has no measurement.
 *
 * The envelope is the shared prompt, the rendered context block, the notes
 * block, the tool schemas and the output reserve.
 */
import { renderContext, estimateTokens, type ContextSnapshot } from "./context-blocks.ts";
import { catalogFor } from "./live-models.ts";
import { exactModelOption } from "./models.ts";
import { UNKNOWN_WINDOW_TOKENS } from "./policy.ts";
import { botSelection } from "./session-selection.ts";
import type { ProviderStore } from "./providers.ts";
import { DESCRIPTION_MAX, DEFAULT_BOT_ID, type ShellBot } from "./shell-store.ts";

/**
 * The estimate of the system prompt before the bot's own context block:
 * agent/instructions.md plus the skills list around it. A test holds it at or
 * above `wc -c` of the file.
 */
export const SHARED_PROMPT_CHARS = 9_100;
/**
 * The estimate of the tools array the model is sent, as JSON, when the caller
 * has not measured it: `measureWire` in scripts/tool-schema-size.mjs
 * serializes every tool as a function entry (name, description, JSON schema).
 */
export const TOOL_SCHEMA_CHARS = 21_000;
/** Room kept for the model's own answer. */
export const OUTPUT_RESERVE_TOKENS = 4096;

export type Envelope = {
  tokens: number;
  windowTokens: number;
  modelLabel: string;
  descriptionChars: number;
};

export type AdmissionInput = {
  bot: ShellBot;
  store: ProviderStore;
  /** Length of the rendered notes block. */
  notesChars: number;
  /**
   * Length of everything hidden the turn adds in front of the owner's message,
   * such as a routine's "nobody is watching" line. 0 when the turn carries none.
   */
  briefChars?: number;
  /**
   * Characters of tool schemas mounted on top of the declared set: the MCP
   * tools this chat already picked up on demand. 0 when none.
   */
  mountedToolChars?: number;
  /** The measured system prompt, in characters. Absent: `SHARED_PROMPT_CHARS`. */
  promptChars?: number;
  /** The measured tool schemas, in characters. Absent: `TOOL_SCHEMA_CHARS`. */
  toolSchemaChars?: number;
};

export type Admission =
  | ({ ok: true } & Envelope)
  | ({ ok: false; code: "context_too_large"; message: string } & Envelope);

/** The plain sentence a refused send shows, whatever the surface. */
export const CONTEXT_TOO_LARGE_TEXT =
  "This bot's instructions and notes don't fit its model's context window. Shorten its instructions, remove notes or pick a model with a larger window.";
export const DESCRIPTION_TOO_LONG_TEXT =
  `This bot's instructions are over ${DESCRIPTION_MAX.toLocaleString("en-US")} characters. Shorten them in its settings.`;

/** True when the stored description is over the cap and the send must be refused. */
export function descriptionTooLong(bot: Pick<ShellBot, "description">): boolean {
  return bot.description.length > DESCRIPTION_MAX;
}

/** The window of one model, from the catalog row for exactly it; unknown is 32,768. */
export function windowFor(connectionId: string, modelId: string): { windowTokens: number; modelLabel: string } {
  const option = exactModelOption(modelId, catalogFor(connectionId));
  const tokens = option?.contextTokens;
  return {
    windowTokens: Number.isInteger(tokens) && (tokens as number) > 0 ? (tokens as number) : UNKNOWN_WINDOW_TOKENS,
    modelLabel: option?.label ?? modelId,
  };
}

/**
 * The "This turn" block is rendered with the longest values its fields take
 * (80-character names, a 40-character folder), so the estimate never falls
 * short of the real block.
 */
function worstCaseTurn(label: string, modelId: string, connection: string): ContextSnapshot["turn"] {
  const long = "x".repeat(80);
  return {
    owner: long,
    first: long,
    date: new Date(0),
    tz: "America/Argentina/ComodRivadavia",
    permission: "full_access",
    folder: "x".repeat(40),
    model: { label, id: modelId, connection },
    image: { label: long, id: long },
    firstChat: true,
  };
}

/** The context block this bot's turn carries. */
export function contextText(bot: ShellBot, turn: ContextSnapshot["turn"]): string {
  return renderContext({
    bot: { name: bot.name, label: bot.label, description: bot.description },
    turn,
  });
}

export function envelopeFor(input: AdmissionInput): Envelope {
  const selection = botSelection(input.bot, input.store);
  const { windowTokens, modelLabel } = windowFor(selection.connectionId, selection.modelId);
  const context = contextText(input.bot, worstCaseTurn(modelLabel, selection.modelId, selection.connectionId));
  const tokens = estimateTokens(input.promptChars ?? SHARED_PROMPT_CHARS)
    + estimateTokens(context.length)
    + estimateTokens(input.notesChars)
    + estimateTokens((input.toolSchemaChars ?? TOOL_SCHEMA_CHARS) + (input.mountedToolChars ?? 0))
    + estimateTokens(input.briefChars ?? 0)
    + OUTPUT_RESERVE_TOKENS;
  return { tokens, windowTokens, modelLabel, descriptionChars: input.bot.description.length };
}

export function admission(input: AdmissionInput): Admission {
  const envelope = envelopeFor(input);
  if (envelope.tokens <= envelope.windowTokens) return { ok: true, ...envelope };
  return { ok: false, code: "context_too_large", message: CONTEXT_TOO_LARGE_TEXT, ...envelope };
}

/** The Generalist's shipped text against what the owner has saved. */
export function seedFor(bot: ShellBot, seedText: string): { differs: boolean; text: string } | null {
  if (bot.id !== DEFAULT_BOT_ID) return null;
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  return { differs: squash(bot.description) !== squash(seedText), text: seedText };
}

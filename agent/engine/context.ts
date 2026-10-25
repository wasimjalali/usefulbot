import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderThisTurn, renderYourBot, type ContextBot, type ThisTurn } from "../../shared/context-blocks.ts";
import { UB } from "./protocol.ts";

/**
 * Prompt and context (SPEC 5.6). The system prompt is static and cached: the
 * rules in agent/instructions.md, the skills list, then the bot block. It
 * changes only when the owner edits the bot or a skill. What changes every
 * turn (the date, the permission, the folder, the model, the notes) goes last,
 * as one hidden message, and only when its text differs from the last one this
 * chat's active branch holds, so the prompt prefix stays cacheable.
 */

export type SkillInfo = { name: string; description: string };

let instructionsCache: string | null = null;

/** agent/instructions.md, read once per process. */
export function instructionsText(): string {
  instructionsCache ??= readFileSync(fileURLToPath(new URL("../instructions.md", import.meta.url)), "utf8").trim();
  return instructionsCache;
}

export function skillsBlock(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  return [
    "# Skills",
    "",
    "Open one in full with `load_skill`.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
}

/** The prompt before "Your bot": the rules and the skills list. */
export function basePromptFor(skills: SkillInfo[]): string {
  return [instructionsText(), skillsBlock(skills)].filter((part) => part !== "").join("\n\n");
}

/** The static system prompt: instructions, then the skills list, then "Your bot". */
export function systemPromptFor(bot: ContextBot, skills: SkillInfo[]): string {
  return [basePromptFor(skills), renderYourBot(bot)].join("\n\n");
}

/** The per-turn hidden message: "This turn", then the notes block when there is one. */
export function turnContextText(turn: ThisTurn, notes: string): string {
  return [renderThisTurn(turn), notes.trim()].filter((part) => part !== "").join("\n\n");
}

/**
 * Whether the hidden context message must be sent this turn: nothing was sent
 * yet on this branch, the text changed, or a compaction came after the last
 * one (a summary drops it from the model's view). Reads newest first.
 */
export function contextNeedsSending(branch: readonly SessionEntry[], text: string): boolean {
  for (let at = branch.length - 1; at >= 0; at -= 1) {
    const entry = branch[at];
    if (entry.type === "compaction") return true;
    if (entry.type === "custom_message" && entry.customType === UB.context) {
      const content = typeof entry.content === "string" ? entry.content : entry.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return content !== text;
    }
  }
  return true;
}

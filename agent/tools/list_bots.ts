import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf } from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";
import { rosterLine, speakersFrom } from "../../shared/threads.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

const SUMMARY_CHARS = 200;

/** The first 200 characters; `descriptionChars` beside it says how much was left out. */
function summarize(text: string): string {
  // By code point, so an emoji at the cut is never split in half.
  const points = Array.from(text);
  return points.length > SUMMARY_CHARS ? `${points.slice(0, SUMMARY_CHARS).join("")}...` : text;
}

export default defineTool({
  description:
    "List every bot, section and group on this Mac with ids. Read only. Call before send_to_bot, post_to_group or rail_action to address the right id. Descriptions come summarised with their full length; pass botId for one bot's full description.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx, { readOnly: true });
    if (!who.ok) return who.result;
    if (input.botId !== undefined && !shell.bots.some((bot) => bot.id === input.botId)) {
      return { status: "not_found", error: `no bot with id ${input.botId}` };
    }
    const speakers = speakersFrom(shell.bots);
    const nameOf = (id: string) => speakers.find((bot) => bot.id === id)?.name ?? id;
    return {
      activeBotId: who.caller.id,
      bots: shell.bots
        .filter((bot) => bot.kind === "bot")
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          title: wrapUntrusted(`bot:${bot.id} title`, bot.label),
          description: wrapUntrusted(
            `bot:${bot.id} description`,
            bot.id === input.botId ? bot.description : summarize(bot.description),
          ),
          descriptionChars: bot.description.length,
          section: shell.sections.find((section) => section.id === bot.sectionId)?.name ?? null,
          pinned: bot.pinned,
          hidden: bot.hidden,
          isDefault: bot.id === "bot-useful",
        })),
      groups: shell.bots
        .filter((bot) => bot.kind === "group")
        .map((group) => ({
          id: group.id,
          name: group.name,
          members: group.memberIds.map((id) => ({ id, name: nameOf(id) })),
        })),
      sections: shell.sections.map((section) => ({ id: section.id, name: section.name })),
      roster: [
        ...shell.bots
          .filter((bot) => bot.kind === "bot")
          .map((bot) => rosterLine({
            id: bot.id,
            kind: bot.kind,
            name: bot.name,
            title: bot.label,
            sectionId: bot.sectionId,
            pinned: bot.pinned,
            hidden: bot.hidden,
            memberIds: bot.memberIds,
          })),
        ...shell.bots
          .filter((bot) => bot.kind === "group")
          .map((group) => rosterLine({
            id: group.id,
            kind: group.kind,
            name: group.name,
            title: group.label,
            sectionId: group.sectionId,
            pinned: group.pinned,
            hidden: group.hidden,
            memberIds: group.memberIds,
          })),
      ],
      note: "The default bot (bot-useful) is you, the orchestrator, not a teammate.",
    };
  },
});

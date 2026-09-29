import { defineTool } from "eve/tools";
import { z } from "zod";
import { activeBotId } from "../lib/active-bot.ts";
import { readShell } from "../../shared/shell-io.ts";
import { rosterLine, speakersFrom } from "../../shared/threads.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

export default defineTool({
  description:
    "List every bot, section and group chat on this Mac with its id. Read only, needs no approval. Call it before sendToBot or postToGroup so you address the right teammate by id.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    const shell = readShell();
    const speakers = speakersFrom(shell.bots);
    const nameOf = (id: string) => speakers.find((bot) => bot.id === id)?.name ?? id;
    return {
      activeBotId: activeBotId(shell, ctx),
      bots: shell.bots
        .filter((bot) => bot.kind === "bot")
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          title: wrapUntrusted(`bot:${bot.id} title`, bot.label),
          description: wrapUntrusted(`bot:${bot.id} description`, bot.description),
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

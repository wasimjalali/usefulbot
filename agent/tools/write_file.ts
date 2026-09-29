import { defineTool } from "eve/tools";
import { z } from "zod";
import { approvalActor } from "../lib/approvals.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { approvedWrite } from "../lib/write.ts";
import { appendAgentEvent } from "../../shared/agent-store.ts";
import { isPagePath, recordPage } from "../../shared/media-store.ts";
import { readShell } from "../../shared/shell-io.ts";

export default defineTool({
  description: "Write a UTF-8 file in the workspace this conversation works in. Gated by the conversation's permission. An .html file also goes into the owner's Library and shows in the chat as a preview they can open in their browser.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
    expectedSha256: z.string().nullable(),
  }),
  async execute(input, ctx) {
    const written = await approvedWrite({
      path: input.path,
      content: input.content,
      expectedSha256: input.expectedSha256,
      ...approvalActor(ctx),
    });
    if (!isPagePath(written.path)) return written;
    return { ...written, note: showPage(written.path, input.content, ctx) };
  },
});

/**
 * The file is written by now; this only files it. A failure here is told to
 * the bot, never thrown, so the turn does not retry a write that landed.
 */
function showPage(path: string, html: string, ctx: { session?: { id?: string } }): string {
  try {
    const shell = readShell();
    const botId = activeBotId(shell, ctx);
    const botName = shell.bots.find((bot) => bot.id === botId)?.name ?? "Useful Bot";
    const { item } = recordPage({ path, html, botId, botName });
    if (item.forgotten) return "The owner removed this page from their Library, so it is not shown again.";
    if (!botId) return "The page is in the owner's Library. It could not be added to this chat.";
    // Once per page per chat: the event id repeats, so a rewrite does not
    // post a second card, and a card a failed write never posted is posted
    // on the next one.
    appendAgentEvent(botId, { kind: "page", text: item.title, imageId: item.id, id: `page_${item.id}` });
    return "The page is in the chat as a preview the owner can open in their browser (it shows the file as it is now), and in their Library.";
  } catch (err) {
    console.error(`[media] could not file page ${path}`, err);
    return "The file was written, but it could not be added to the owner's Library or this chat.";
  }
}

import { defineTool } from "eve/tools";
import { z } from "zod";
import { lenientNullableString } from "../lib/lenient-null.ts";
import { approvalActor } from "../lib/approvals.ts";
import { authoritySessionId, awaitActiveBotId, BOT_CONTEXT_MISSING, isBotContextMissing, isSubAgent } from "../lib/active-bot.ts";
import { approvedWrite } from "../lib/write.ts";
import { appendAgentEvent } from "../../shared/agent-store.ts";
import { isPagePath, recordPage } from "../../shared/media-store.ts";
import { readShell } from "../../shared/shell-io.ts";

export default defineTool({
  description: "Write a UTF-8 file in the workspace, gated by the conversation's permission. An .html file also lands in the owner's Library with a browser preview in the chat. Leaving expectedSha256 out overwrites without the conflict check.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
    expectedSha256: lenientNullableString("SHA-256 of the file's current bytes; the write is refused if it changed. Omit to overwrite unchecked."),
  }),
  async execute(input, ctx) {
    let grantSessionId: string | undefined;
    try {
      grantSessionId = authoritySessionId(ctx);
    } catch (error) {
      if (isBotContextMissing(error)) return BOT_CONTEXT_MISSING;
      throw error;
    }
    const written = await approvedWrite({
      path: input.path,
      content: input.content,
      expectedSha256: input.expectedSha256,
      ...approvalActor(ctx),
      // A sub-agent writes under its root session's grant, never one of its own.
      grantSessionId,
    });
    if (!isPagePath(written.path)) return written;
    // A sub-agent files nothing in the owner's Library or chat: its root reports.
    if (isSubAgent(ctx)) return { ...written, note: "The page is written. A sub-agent adds nothing to the owner's Library or chat, so say where the file is in your report." };
    return { ...written, note: await showPage(written.path, input.content, ctx) };
  },
});

/**
 * The file is written by now; this only files it. A failure here is told to
 * the bot, never thrown, so the turn does not retry a write that landed.
 */
async function showPage(path: string, html: string, ctx: { session?: { id?: string; parent?: unknown } }): Promise<string> {
  try {
    const shell = readShell();
    // Waits for a just-created session's binding; an unbound one is
    // bot_context_missing, caught below and told to the bot.
    const botId = await awaitActiveBotId(shell, ctx);
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

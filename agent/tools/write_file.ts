import { defineTool, type ToolCtx } from "../lib/tool.ts";
import { z } from "zod";
import { lenientNullableString } from "../lib/lenient-null.ts";
import { approvalActor } from "../lib/approvals.ts";
import { approvedWrite } from "../lib/write.ts";
import { isPagePath, recordPage } from "../../shared/media-store.ts";

export default defineTool({
  name: "write_file",
  description: "Write a UTF-8 file in the workspace, gated by the chat's permission. An .html file also lands in the owner's Library with a browser preview in the chat. Leaving expectedSha256 out overwrites without the conflict check.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
    expectedSha256: lenientNullableString("SHA-256 of the file's current bytes; the write is refused if it changed. Omit to overwrite unchecked."),
  }),
  sequential: true,
  async execute(input, ctx) {
    const written = await approvedWrite({
      path: input.path,
      content: input.content,
      expectedSha256: input.expectedSha256,
      signal: ctx.abortSignal,
      ...approvalActor(ctx),
    });
    if (!isPagePath(written.path)) return written;
    return { ...written, note: await showPage(written.path, input.content, ctx) };
  },
});

/**
 * The file is written by now; this only files it. A failure here is told to
 * the bot, never thrown, so the turn does not retry a write that landed.
 */
async function showPage(path: string, html: string, ctx: ToolCtx): Promise<string> {
  try {
    const { item } = recordPage({ path, html, botId: ctx.botId, botName: ctx.snapshot.context.bot.name, chatId: ctx.chatId });
    if (item.forgotten) return "The owner removed this page from their Library, so it is not shown again.";
    // Once per page per chat: the row key repeats, so a rewrite does not
    // post a second card, and a card a failed write never posted is posted
    // on the next one.
    await ctx.appendRow({ key: `page:${item.id}`, kind: "page", mediaId: item.id, title: item.title, path });
    return "The page is in the chat as a preview the owner can open in their browser (it shows the file as it is now), and in their Library.";
  } catch (err) {
    console.error(`[media] could not file page ${path}`, err);
    return "The file was written, but it could not be added to the owner's Library or this chat.";
  }
}

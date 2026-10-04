import { defineTool } from "eve/tools";
import { z } from "zod";
import { lenientNumber } from "../lib/lenient-null.ts";
import { sharedMemoryStore } from "../lib/memory.ts";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { callerOf, inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";

export default defineTool({
  description: "Delete one of this bot's own memory notes. Applies at once in Auto and Full access; refused in Read only.",
  inputSchema: z.object({
    id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
    expectedRevision: lenientNumber("The note's integer revision.", z.number().int()),
  }),
  execute: async (input, ctx) => {
    // The acting bot comes from the session binding; there is no way to name
    // another bot. Ownership is checked again under the store lock.
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const botId = who.caller.id;
    // Deleting a note is the bot's own memory housekeeping, like editing one:
    // Auto runs it at once, Read only refuses.
    const permission = sessionPermission(ctx);
    const gate = inAppGate(permission);
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const actor = approvalActor(ctx);
    const hash = actionSha256({
      tool: "memory.delete",
      canonicalArgs: JSON.stringify({ ...input, botId }),
      cwd: "memory",
      targetRevision: String(input.expectedRevision),
      backend: "memory",
      toolVersion: "1",
    });
    const rec = getApprovalStore().request({
      ...actor,
      tool: "memory.delete",
      actionSha256: hash,
      preview: `delete memory note ${input.id} (${who.caller.bot.name}, revision ${input.expectedRevision})`,
    });
    await settle(getApprovalStore(), rec.id, hash, gate, ctx, permission);
    return executeIfApproved(getApprovalStore(), rec.id, hash, () => {
      if (!readShell().bots.some((item) => item.id === botId)) {
        throw new Error("memory_bot_missing");
      }
      return sharedMemoryStore().archive(input.id, botId, input.expectedRevision);
    });
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { sharedMemoryStore, tagsForBot } from "../lib/memory.ts";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";

const PREVIEW_MAX = 300;

/** Fit the body onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}...` : flat;
}

export default defineTool({
  description: "Create or update a memory note. Applies at once in Auto and Full access; refused in Read only.",
  inputSchema: z.object({
    id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/).optional(),
    expectedRevision: z.number().nullable(),
    title: z.string().max(120),
    tags: z.array(z.string().max(32)).max(8),
    body: z.string().max(8192),
    audience: z.enum(["desktop", "shared-phone"]),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    botId: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    // The same size checks the store runs, but before the card: an invalid
    // note must not burn the owner's approval on a write that can never land.
    if (Buffer.byteLength(input.body, "utf8") > 8192) {
      return {
        status: "invalid",
        error: "memory_too_large",
        hint: "Keep the body under 8192 bytes, or split it across notes.",
      };
    }
    if (input.title.length > 120 || input.tags.length > 8) {
      return {
        status: "invalid",
        error: "memory_meta",
        hint: "Keep the title under 120 characters and the tags to 8.",
      };
    }
    // A botId tags the note into that bot's namespace, so it must name a real
    // bot. The roster check runs before the card, the way create_routine.ts
    // does it, so the owner never approves a write that cannot land.
    const shell = readShell();
    const botId = input.botId ?? activeBotId(shell, ctx);
    if (botId && !shell.bots.some((item) => item.id === botId)) {
      return { status: "not_found", error: `no bot with id ${botId}`, hint: "Call listBots for exact ids." };
    }
    // A note is the bot's own memory, edited again in one call, so Auto
    // writes it at once; Read only refuses.
    const gate = inAppGate(sessionPermission(ctx));
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const actor = approvalActor(ctx);
    const hash = actionSha256({
      tool: "memory.upsert",
      canonicalArgs: JSON.stringify(input),
      cwd: "memory",
      targetRevision: input.expectedRevision === null ? null : String(input.expectedRevision),
      backend: "memory",
      toolVersion: "1",
    });
    const rec = getApprovalStore().request({
      ...actor,
      tool: "memory.upsert",
      actionSha256: hash,
      // The body is what the owner is actually authorising, so it goes on the
      // card next to the metadata the hash binds.
      preview: `memory ${input.title} (${input.audience}${input.tags.length ? ", tags: " + input.tags.join(", ") : ""}${input.expiresAt ? ", expires " + input.expiresAt : ""}): ${clipPreview(input.body)}`,
    });
    await settle(getApprovalStore(), rec.id, hash, gate);
    return executeIfApproved(getApprovalStore(), rec.id, hash, () => {
      // Resolved again after the wait: the acting bot or the roster can have
      // changed while the card was open, and the write must not land in a
      // namespace that no longer exists.
      const fresh = readShell();
      const target = input.botId ?? activeBotId(fresh, ctx);
      if (target && !fresh.bots.some((item) => item.id === target)) {
        throw new Error("memory_bot_missing");
      }
      const tags = target ? tagsForBot(input.tags, target) : input.tags;
      return sharedMemoryStore().upsert({
        id: input.id,
        expectedRevision: input.expectedRevision,
        title: input.title,
        tags,
        body: input.body,
        audience: input.audience,
        expiresAt: input.expiresAt,
        sessionId: actor.sessionId,
      });
    });
  },
});

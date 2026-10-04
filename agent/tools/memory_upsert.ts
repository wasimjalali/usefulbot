import { defineTool } from "eve/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { lenientNullableNumber, lenientNullableString } from "../lib/lenient-null.ts";
import { sharedMemoryStore } from "../lib/memory.ts";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { callerOf, inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";
import { seenOutside } from "../lib/outside-content.ts";

const PREVIEW_MAX = 300;

/**
 * Whether the bot already has a live note under exactly this id. Another bot's
 * note counts as existing (the store refuses it). A case-insensitive disk can
 * answer for an id that differs only in case, so the id read back must match.
 * Anything but "not found" and "not yours" is a real failure and is rethrown.
 */
function noteExists(botId: string, id: string): boolean {
  try {
    return sharedMemoryStore().readCard(id, botId).id === id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "memory_not_found") return false;
    if (message === "memory_forbidden") return true;
    throw err;
  }
}

/** Fit the body onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}...` : flat;
}

export default defineTool({
  description: "Create or update a memory note. Applies at once in Auto and Full access; refused in Read only.",
  inputSchema: z.object({
    id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/).optional(),
    expectedRevision: lenientNullableNumber("The note's integer revision, or null to create."),
    title: z.string().max(120),
    tags: z.array(z.string().max(32)).max(8),
    body: z.string().max(8192),
    expiresAt: lenientNullableString("ISO-8601 time with offset, or null.", z.string().datetime({ offset: true })),
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
    // A note is always the acting bot's own, taken from the session binding;
    // there is no way to name another bot. The roster check runs before the
    // card, the way create_routine.ts does it, so the owner never approves a
    // write that cannot land.
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const botId = who.caller.id;
    // A note is the bot's own memory, edited again in one call, so Auto
    // writes it at once; Read only refuses.
    const permission = sessionPermission(ctx);
    const gate = inAppGate(permission);
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const actor = approvalActor(ctx);
    const hash = actionSha256({
      tool: "memory.upsert",
      canonicalArgs: JSON.stringify({ ...input, botId }),
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
      preview: `memory ${input.title} (${who.caller.bot.name}${input.tags.length ? ", tags: " + input.tags.join(", ") : ""}${input.expiresAt ? ", expires " + input.expiresAt : ""}): ${clipPreview(input.body)}`,
    });
    await settle(getApprovalStore(), rec.id, hash, gate, ctx, permission);
    return executeIfApproved(getApprovalStore(), rec.id, hash, () => {
      // The roster is read again after the wait: the acting bot can have been
      // deleted while the card was open, and the write must not land in a
      // namespace that no longer exists.
      if (!readShell().bots.some((item) => item.id === botId)) {
        throw new Error("memory_bot_missing");
      }
      // After outside content a NEW note's id is the server's, never the
      // model's: the block prints ids, and an id is text the model chose. An
      // edit of an existing note keeps its id, and another bot's id is left
      // as given so the store refuses it as it always has.
      const outside = seenOutside(ctx);
      let id = input.id;
      if (outside && id !== undefined && !noteExists(botId, id)) {
        // An edit was meant (a revision was given) of a note that is not there:
        // archived, expired, mistyped or stale. Never turn that into a new note.
        if (input.expectedRevision !== null) throw new Error("memory_not_found");
        id = randomUUID();
      }
      return sharedMemoryStore().upsert({
        id,
        expectedRevision: input.expectedRevision,
        title: input.title,
        tags: input.tags,
        body: input.body,
        botId,
        // The tool is the model's hand. Owner writes come from the Settings API.
        // A turn that already read outside content (a page, an app result, a
        // file, a handoff) marks what it writes, so the owner can see it.
        source: outside ? "model-after-outside-content" : "model",
        expiresAt: input.expiresAt,
        sessionId: actor.sessionId,
      });
    });
  },
});

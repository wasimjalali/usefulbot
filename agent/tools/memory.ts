import { defineTool, type ToolCtx } from "../lib/tool.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { lenientNullableNumber, lenientNullableString } from "../lib/lenient-null.ts";
import { sharedMemoryStore } from "../lib/memory.ts";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { flatLine, wrapUntrusted } from "../../shared/untrusted.ts";
import { markOutside, seenOutside } from "../lib/outside-content.ts";

const PREVIEW_MAX = 300;
const NOTE_ID = /^[A-Za-z0-9-]{1,80}$/;

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
  const flat = flatLine(value).replace(/\s+/g, " ");
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}...` : flat;
}

const input = z.object({
  action: z.enum(["search", "read", "save", "delete"]),
  query: z.string().optional().describe("search: what to look for."),
  id: z.string().regex(NOTE_ID).optional().describe("read and delete: the note id. save: give it to update that note."),
  expectedRevision: lenientNullableNumber("save: the note's integer revision to update, or null to create. delete: the revision."),
  title: z.string().max(120).optional().describe("save: required."),
  tags: z.array(z.string().max(32)).max(8).optional(),
  body: z.string().max(8192).optional().describe("save: required."),
  expiresAt: lenientNullableString("save: ISO-8601 time with offset, or null.", z.string().datetime({ offset: true })),
});

type Input = z.output<typeof input>;

export default defineTool({
  name: "memory",
  description: "Your own memory notes. action search (query), read (id), save (title, body, tags; id and expectedRevision to update) or delete (id, expectedRevision). Saves and deletes apply at once in Auto and Full access, refused in Read only.",
  inputSchema: input,
  sequential: true,
  async execute(args, ctx) {
    switch (args.action) {
      case "search": return search(args, ctx);
      case "read": return read(args, ctx);
      case "save": return save(args, ctx);
      case "delete": return remove(args, ctx);
    }
  },
});

function missing(field: string, action: string) {
  return { status: "invalid", error: `${field}_required`, hint: `memory ${action} needs ${field}.` };
}

function search(args: Input, ctx: ToolCtx) {
  if (!args.query) return missing("query", "search");
  const notes = sharedMemoryStore().search(args.query, ctx.botId);
  // A returned outside-sourced note carries that content back into this turn.
  if (notes.some((note) => note.source === "model-after-outside-content")) markOutside(ctx);
  return notes.map((note) => ({
    ...note,
    title: wrapUntrusted(`memory:${note.id} title`, note.title),
    body: wrapUntrusted(`memory:${note.id}`, note.body),
  }));
}

function read(args: Input, ctx: ToolCtx) {
  if (!args.id) return missing("id", "read");
  const note = sharedMemoryStore().read(args.id, ctx.botId);
  // A note written after outside content carries that content back into this
  // turn, so reading it marks the turn: it can't be laundered into a clean note.
  if (note.source === "model-after-outside-content") markOutside(ctx);
  return {
    ...note,
    title: wrapUntrusted(`memory:${note.id} title`, note.title),
    body: wrapUntrusted(`memory:${note.id}`, note.body),
  };
}

async function save(args: Input, ctx: ToolCtx) {
  if (args.title === undefined) return missing("title", "save");
  if (args.body === undefined) return missing("body", "save");
  const note = { title: args.title, tags: args.tags ?? [], body: args.body };
  // The same size checks the store runs, but before the card: an invalid
  // note must not burn the owner's approval on a write that can never land.
  if (Buffer.byteLength(note.body, "utf8") > 8192) {
    return {
      status: "invalid",
      error: "memory_too_large",
      hint: "Keep the body under 8192 bytes, or split it across notes.",
    };
  }
  if (note.title.length > 120 || note.tags.length > 8) {
    return {
      status: "invalid",
      error: "memory_meta",
      hint: "Keep the title under 120 characters and the tags to 8.",
    };
  }
  const botId = ctx.botId;
  // A note is the bot's own memory, edited again in one call, so Auto
  // writes it at once; Read only refuses.
  const permission = sessionPermission(ctx);
  const gate = inAppGate(permission);
  if (gate === "refuse") return READ_ONLY_BLOCKED;
  const actor = approvalActor(ctx);
  const hash = actionSha256({
    tool: "memory.upsert",
    canonicalArgs: JSON.stringify({ ...note, id: args.id, expectedRevision: args.expectedRevision, expiresAt: args.expiresAt, botId }),
    cwd: "memory",
    targetRevision: args.expectedRevision === null ? null : String(args.expectedRevision),
    backend: "memory",
    toolVersion: "1",
  });
  const store = getApprovalStore();
  const rec = store.request({
    ...actor,
    tool: "memory.upsert",
    actionSha256: hash,
    // The body is what the owner is actually authorising, so it goes on the
    // card next to the metadata the hash binds.
    preview: `memory ${flatLine(note.title)} (${note.tags.length ? "tags: " + flatLine(note.tags.join(", ")) : "no tags"}${args.expiresAt ? ", expires " + args.expiresAt : ""}): ${clipPreview(note.body)}`,
  });
  await settle(store, rec.id, hash, gate, ctx, permission);
  return executeIfApproved(store, rec.id, hash, () => {
    // After outside content a NEW note's id is the server's, never the
    // model's: the block prints ids, and an id is text the model chose. An
    // edit of an existing note keeps its id, and another bot's id is left
    // as given so the store refuses it as it always has.
    const outside = seenOutside(ctx);
    let id = args.id;
    if (outside && id !== undefined && !noteExists(botId, id)) {
      // An edit was meant (a revision was given) of a note that is not there:
      // archived, expired, mistyped or stale. Never turn that into a new note.
      if (args.expectedRevision !== null) throw new Error("memory_not_found");
      id = randomUUID();
    }
    return sharedMemoryStore().upsert({
      id,
      expectedRevision: args.expectedRevision,
      title: note.title,
      tags: note.tags,
      body: note.body,
      botId,
      // The tool is the model's hand. Owner writes come from the Settings API.
      // A turn that already read outside content (a page, an app result, a
      // file) marks what it writes, so the owner can see it.
      source: outside ? "model-after-outside-content" : "model",
      expiresAt: args.expiresAt,
      sessionId: actor.chatId,
    });
  });
}

async function remove(args: Input, ctx: ToolCtx) {
  if (!args.id) return missing("id", "delete");
  const revision = args.expectedRevision;
  if (revision === null) return missing("expectedRevision", "delete");
  // Deleting a note is the bot's own memory housekeeping, like editing one:
  // Auto runs it at once, Read only refuses.
  const permission = sessionPermission(ctx);
  const gate = inAppGate(permission);
  if (gate === "refuse") return READ_ONLY_BLOCKED;
  const botId = ctx.botId;
  const hash = actionSha256({
    tool: "memory.delete",
    canonicalArgs: JSON.stringify({ id: args.id, expectedRevision: revision, botId }),
    cwd: "memory",
    targetRevision: String(revision),
    backend: "memory",
    toolVersion: "1",
  });
  const store = getApprovalStore();
  const rec = store.request({
    ...approvalActor(ctx),
    tool: "memory.delete",
    actionSha256: hash,
    preview: `delete memory note ${args.id} (revision ${revision})`,
  });
  await settle(store, rec.id, hash, gate, ctx, permission);
  return executeIfApproved(store, rec.id, hash, () => sharedMemoryStore().archive(args.id as string, botId, revision));
}

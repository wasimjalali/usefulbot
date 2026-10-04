import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf } from "../lib/permission.ts";
import { sharedMemoryStore } from "../lib/memory.ts";
import { readShell } from "../../shared/shell-io.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { markOutside } from "../lib/outside-content.ts";

export const search = defineTool({
  description: "Search this bot's own memory notes.",
  inputSchema: z.object({ query: z.string() }),
  async execute(input, ctx) {
    const who = await callerOf(readShell(), ctx, { readOnly: true });
    if (!who.ok) return who.result;
    const notes = sharedMemoryStore().search(input.query, who.caller.id);
    // See memory_read: a returned outside-sourced note marks the turn.
    if (notes.some((note) => note.source === "model-after-outside-content")) markOutside(ctx);
    return notes.map((note) => ({
      ...note,
      title: wrapUntrusted(`memory:${note.id} title`, note.title),
      body: wrapUntrusted(`memory:${note.id}`, note.body),
    }));
  },
});

export default search;

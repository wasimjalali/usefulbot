import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf } from "../lib/permission.ts";
import { sharedMemoryStore } from "../lib/memory.ts";
import { readShell } from "../../shared/shell-io.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { markOutside } from "../lib/outside-content.ts";

export default defineTool({
  description: "Read one of this bot's own memory notes by id, in full.",
  inputSchema: z.object({ id: z.string() }),
  async execute(input, ctx) {
    const who = await callerOf(readShell(), ctx, { readOnly: true });
    if (!who.ok) return who.result;
    const note = sharedMemoryStore().read(input.id, who.caller.id);
    // A note written after outside content carries that content back into this
    // turn, so reading it marks the turn: it can't be laundered into a clean note.
    if (note.source === "model-after-outside-content") markOutside(ctx);
    return {
      ...note,
      title: wrapUntrusted(`memory:${note.id} title`, note.title),
      body: wrapUntrusted(`memory:${note.id}`, note.body),
    };
  },
});

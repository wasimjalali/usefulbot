import { defineTool } from "eve/tools";
import { z } from "zod";
import { sharedMemoryStore } from "../lib/memory.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

export default defineTool({
  description: "Read one desktop memory note by id.",
  inputSchema: z.object({ id: z.string() }),
  execute(input) {
    const note = sharedMemoryStore().read(input.id, "desktop");
    return {
      ...note,
      title: wrapUntrusted(`memory:${note.id} title`, note.title),
      body: wrapUntrusted(`memory:${note.id}`, note.body),
    };
  },
});

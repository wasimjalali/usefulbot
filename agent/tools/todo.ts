import { defineTool } from "eve/tools";
import { todo } from "eve/tools/todo";
import { z } from "zod";

// eve's own todo with shorter texts (UB-009 PR C). Spreading keeps its durable
// state key and executor; the schema keeps the same fields, types and enums
// (test/tool-schema-size.test.ts pins it against eve's).
export default defineTool({
  ...todo,
  description:
    "Keep a task list for this session. Use it for work with three or more steps; skip it for simple requests. Call with `todos` to replace the whole list, without it to read the list. Mark a task in_progress when you start it (one at a time) and completed when done.",
  inputSchema: z.strictObject({
    todos: z
      .array(
        z.strictObject({
          content: z.string().describe("The task."),
          priority: z.enum(["high", "medium", "low"]),
          status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        }),
      )
      .describe("The full list. Omit to read it.")
      .optional(),
  }),
});

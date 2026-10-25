import { defineTool, toolOutput } from "../lib/tool.ts";
import { z } from "zod";

/**
 * The chat's task list. Every result carries the whole list in its `details`,
 * so the list lives in the session file beside the call that wrote it and
 * follows the branch a chat is on (Pi's pattern for tool state). The map below
 * only answers a read without a write; the engine can seed it from the
 * branch's last `todo` result with `restoreTodos` when a chat opens.
 */

type Todo = { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" | "cancelled" };

const LISTS_MAX = 64;
const lists = new Map<string, Todo[]>();

export function restoreTodos(chatId: string, todos: Todo[]): void {
  lists.delete(chatId);
  lists.set(chatId, todos);
  if (lists.size > LISTS_MAX) lists.delete(lists.keys().next().value as string);
}

export default defineTool({
  name: "todo",
  description:
    "Keep a task list for this chat. Use it for work with three or more steps; skip it for simple requests. Call with `todos` to replace the whole list, without it to read the list. Mark a task in_progress when you start it (one at a time) and completed when done.",
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
  sequential: true,
  execute(input, ctx) {
    if (input.todos) restoreTodos(ctx.chatId, input.todos);
    const todos = lists.get(ctx.chatId) ?? [];
    return toolOutput([{ type: "text", text: JSON.stringify({ todos }) }], { todos });
  },
});

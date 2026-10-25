import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, toolOutput } from "../lib/tool.ts";

/**
 * Asks the owner a question and ends the turn: their answer is their next
 * message. The engine turns the result's `question` into a card (it blocks a
 * batch that mixes `ask` with another call, so this always runs alone and
 * `terminate` always ends the turn).
 */
export default defineTool({
  name: "ask",
  description:
    "Ask the owner a question and end your turn; their answer is their next message. Only when the goal or target is unclear and a wrong guess would cost something. Call it alone, with a short prompt and, when it helps, a few options.",
  inputSchema: z.object({
    prompt: z.string().min(1).max(500),
    options: z
      .array(z.object({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(80),
        detail: z.string().max(200).optional(),
      }))
      .max(6)
      .optional(),
    allowFreeform: z.boolean().optional().describe("Let them type their own answer. Default true."),
  }),
  sequential: true,
  execute(input) {
    const question = {
      requestId: randomUUID(),
      prompt: input.prompt,
      options: input.options ?? [],
      allowFreeform: input.allowFreeform ?? true,
    };
    return toolOutput(
      [{ type: "text", text: "Asked the owner. Their answer is their next message." }],
      { question },
      { terminate: true },
    );
  },
});

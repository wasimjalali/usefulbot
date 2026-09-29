// A step that emitted a tool call and then ran out of output tokens ends with
// finish_reason "length". eve 0.54 takes "length" as "keep writing": it starts
// the next step without running the call the cut step already made, and the
// AI SDK then refuses that prompt and every later one in the session
// (MissingToolResultsError, before any model is called). The session is dead
// and Retry only replays the same refusal. Reported as a tool step instead,
// the call runs, or comes back to the model as invalid input when its
// arguments were cut, and the history stays whole.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settleChoices(payload: unknown, seen: { toolCall: boolean }, key: "delta" | "message"): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    const body = choice[key];
    if (isRecord(body) && Array.isArray(body.tool_calls) && body.tool_calls.length > 0) seen.toolCall = true;
    if (choice.finish_reason === "length" && seen.toolCall) {
      choice.finish_reason = "tool_calls";
      changed = true;
    }
  }
  return changed;
}

/**
 * One SSE block of a chat-completions stream, with a "length" finish turned
 * into "tool_calls" once the stream has carried a tool call. `seen` lives for
 * the whole stream. A block that needs no change comes back as it was.
 */
export function settleStreamBlock(block: string, seen: { toolCall: boolean }): string {
  // Most blocks are text deltas; only a block that could matter is parsed.
  if (!block.includes("tool_calls") && !block.includes("\"length\"")) return block;
  let changed = false;
  const lines = block.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }
    if (!settleChoices(payload, seen, "delta")) return line;
    changed = true;
    return `data: ${JSON.stringify(payload)}`;
  });
  return changed ? lines.join("\n") : block;
}

/** The same repair for a non-streaming chat completion, in place. */
export function settleCompletion(payload: unknown): void {
  settleChoices(payload, { toolCall: false }, "message");
}

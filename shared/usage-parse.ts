export interface ObservedUsage {
  inputTokens: number;
  outputTokens: number;
}

// A token count is an exact, non-negative integer; a fractional or absurd float
// is a malformed payload, not a spend figure worth recording.
const COUNT_MAX = 1_000_000_000;

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX
    ? value
    : null;
}

export function usageFromPayload(payload: unknown): ObservedUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const input = asCount(usage.prompt_tokens) ?? asCount(usage.input_tokens);
  const output = asCount(usage.completion_tokens) ?? asCount(usage.output_tokens);
  if (input === null || output === null) return null;
  return { inputTokens: input, outputTokens: output };
}

export function usageFromSseBlock(block: string): ObservedUsage | null {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      // A block can carry several data lines; the first one without a usage
      // field must not end the scan, or a later usage line is silently dropped.
      const found = usageFromPayload(JSON.parse(data));
      if (found) return found;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

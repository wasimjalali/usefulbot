export interface ObservedUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens the provider served from its prompt cache (a part of inputTokens). */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's cache (a part of inputTokens). */
  cacheWriteTokens?: number;
}

// A token count is an exact, non-negative integer; a fractional or absurd float
// is a malformed payload, not a spend figure worth recording.
const COUNT_MAX = 1_000_000_000;

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Three shapes carry the cache counts. Chat completions (and the router's own
 * translation of the other two): prompt_tokens includes them, details beside.
 * Responses: input_tokens includes them, details beside. Anthropic Messages:
 * input_tokens EXCLUDES them, so the cache read and write are added back, or a
 * cached prompt would look nearly free to the budgets.
 */
export function usageFromPayload(payload: unknown): ObservedUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const promptTokens = asCount(usage.prompt_tokens);
  let input = promptTokens ?? asCount(usage.input_tokens);
  const output = asCount(usage.completion_tokens) ?? asCount(usage.output_tokens);
  if (input === null || output === null) return null;
  let cached: number | null = null;
  let written: number | null = null;
  if (promptTokens !== null) {
    const details = record(usage.prompt_tokens_details);
    cached = asCount(details?.cached_tokens);
    written = asCount(details?.cache_write_tokens);
  } else {
    const anthropicRead = asCount(usage.cache_read_input_tokens);
    const anthropicWrite = asCount(usage.cache_creation_input_tokens);
    if (anthropicRead !== null || anthropicWrite !== null) {
      cached = anthropicRead;
      written = anthropicWrite;
      input += (anthropicRead ?? 0) + (anthropicWrite ?? 0);
    } else {
      const details = record(usage.input_tokens_details);
      cached = asCount(details?.cached_tokens);
      written = asCount(details?.cache_write_tokens);
    }
  }
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached !== null ? { cachedInputTokens: cached } : {}),
    ...(written !== null ? { cacheWriteTokens: written } : {}),
  };
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

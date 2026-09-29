import { randomUUID } from "node:crypto";
import { RouterError } from "./errors.ts";
import { retryAfterMs } from "./retry-after.ts";
import type { AuthedCaller } from "./auth.ts";

const FIRECRAWL = "https://api.firecrawl.dev/v2/search";
const SEARCH_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

// Smallest copy of the router's capped reader: search.ts must not import
// index.ts, and the body must stay bounded while the slot is held.
async function readCappedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RouterError({
        status: 502,
        type: "upstream_error",
        code: "upstream_protocol_error",
        message: "upstream body too large",
      });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function search(caller: AuthedCaller, body: unknown): Promise<unknown> {
  if (!caller.search) {
    throw new RouterError({
      status: 403,
      type: "permission_error",
      code: "capability_forbidden",
      message: "capability_forbidden",
    });
  }
  if (!body || typeof body !== "object") {
    throw new RouterError({
      status: 400,
      type: "invalid_request_error",
      code: "invalid_request",
      message: "invalid_request",
    });
  }
  const query = (body as { query?: unknown }).query;
  const countRaw = (body as { count?: unknown }).count;
  const queryLength = typeof query === "string" ? [...query].length : 0;
  if (typeof query !== "string" || queryLength < 1 || queryLength > 512) {
    throw new RouterError({
      status: 400,
      type: "invalid_request_error",
      code: "invalid_request",
      message: "invalid query",
    });
  }
  const count = countRaw === undefined ? 5 : countRaw;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 5) {
    throw new RouterError({
      status: 400,
      type: "invalid_request_error",
      code: "invalid_request",
      message: "invalid count",
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(FIRECRAWL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: count }),
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new RouterError({
        status: 429,
        type: "rate_limit_error",
        code: "upstream_rate_limited",
        message: "search rate limited",
        retryable: true,
        retryAfterMs: retryAfterMs(response),
      });
    }
    if (!response.ok) {
      throw new RouterError({
        status: 502,
        type: "upstream_error",
        code: "upstream_protocol_error",
        message: "search failed",
      });
    }
    // The timer stays armed through the body read and parse: headers alone
    // do not release the concurrency slot the caller holds.
    const text = await readCappedBody(response, SEARCH_BODY_LIMIT_BYTES);
    const json = JSON.parse(text) as {
      data?: { web?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const web = json.data?.web ?? [];
    return {
      results: web.slice(0, count).map((item) => ({
        title: String(item.title ?? "").slice(0, 200),
        url: String(item.url ?? "").slice(0, 2048),
        snippet: String(item.description ?? "").slice(0, 800),
      })),
      provider: "firecrawl-keyless",
      request_id: randomUUID(),
    };
  } finally {
    clearTimeout(timer);
  }
}

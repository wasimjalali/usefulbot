import { randomUUID } from "node:crypto";
import { encodeSelectionHeader, SELECTION_HEADER, type ModelSelection } from "../../shared/session-selection.ts";
import type { RouterIds } from "./router-identity.ts";

/**
 * The router's 429s that clear by themselves within seconds: all ten model
 * slots taken, or the per-minute request window full. With several bots working
 * both are routine, so the call waits instead of failing the turn. The budget
 * codes are deliberately absent: a spent day does not come back in a minute.
 */
const WAITABLE_CODES = new Set(["global_concurrency_limit", "caller_rate_limit"]);
/**
 * The provider's own rate limit, which lifts in about a minute. A long
 * agent run meets it routinely, and failing the turn on it ended runs that
 * only needed to pause. A used-up plan or credit is a different code (402)
 * and is never waited on.
 */
const PROVIDER_CODES = new Set(["upstream_rate_limited"]);

/** The most one model call will wait in total before the 429 is handed back. */
export const MAX_TOTAL_WAIT_MS = 60_000;
// A full per-minute window can take most of a minute to open again.
const MAX_SINGLE_WAIT_MS = 30_000;
/** The provider's limit gets longer: its retry-after is often a full minute. */
export const MAX_PROVIDER_TOTAL_WAIT_MS = 180_000;
const MAX_PROVIDER_SINGLE_WAIT_MS = 90_000;
const BASE_BACKOFF_MS = 1_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long the router asked for, from the body first and the header second. */
async function waitHint(response: Response): Promise<{ code: string | null; ms: number | null }> {
  let code: string | null = null;
  let ms: number | null = null;
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; retry_after_ms?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    const hinted = body.error?.retry_after_ms;
    if (typeof hinted === "number" && Number.isFinite(hinted) && hinted >= 0) ms = hinted;
  } catch {
    // Not the router's JSON error shape: no code, so the caller does not wait.
  }
  if (ms === null) {
    const seconds = Number(response.headers.get("retry-after"));
    if (response.headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  }
  return { code, ms };
}

export interface RouterFetchOptions {
  /** Read on every attempt, so a cached provider follows the session's current turn. */
  ids: () => RouterIds;
  /**
   * The selection frozen for the turn in flight, read on every attempt so a
   * retry and a 429 wait of minutes send the same one the first attempt did.
   * Null (or no option) sends no header and the router uses the last pick:
   * the reviewer, which has its own role, and a turn that froze nothing.
   */
  selection?: () => ModelSelection | null;
  authorization?: () => string;
  fetch?: FetchLike;
  sleep?: (ms: number, signal: AbortSignal | null | undefined) => Promise<void>;
  random?: () => number;
}

/**
 * The fetch every model call goes through: stamps the session, turn and a
 * fresh request id, and waits out the router's short-lived 429s.
 *
 * Each attempt carries a NEW request id. The router refuses a repeated id as
 * `duplicate_request`, and a refused attempt never reached the point where its
 * id was recorded, but a fresh one is right either way.
 */
export function routerFetch(options: RouterFetchOptions): FetchLike {
  const doFetch = options.fetch ?? fetch;
  const doSleep = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  return async (input, init) => {
    let waited = 0;
    for (let attempt = 0; ; attempt += 1) {
      const ids = options.ids();
      const headers = new Headers(init?.headers);
      if (options.authorization) headers.set("authorization", options.authorization());
      headers.set("x-useful-session-id", ids.sessionId);
      headers.set("x-useful-turn-id", ids.turnId);
      headers.set("x-useful-request-id", randomUUID());
      const selection = options.selection?.() ?? null;
      if (selection) headers.set(SELECTION_HEADER, encodeSelectionHeader(selection));
      const response = await doFetch(input, { ...init, headers });
      if (response.status !== 429) return response;
      const hint = await waitHint(response);
      const provider = hint.code !== null && PROVIDER_CODES.has(hint.code);
      if (!hint.code || (!WAITABLE_CODES.has(hint.code) && !provider)) return response;
      const singleCap = provider ? MAX_PROVIDER_SINGLE_WAIT_MS : MAX_SINGLE_WAIT_MS;
      const totalCap = provider ? MAX_PROVIDER_TOTAL_WAIT_MS : MAX_TOTAL_WAIT_MS;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, singleCap);
      let wait: number;
      if (provider) {
        const hinted = hint.ms ?? backoff;
        // A pause longer than the whole allowance cannot be waited out, so it
        // goes back now rather than after minutes of waiting for nothing.
        if (waited + hinted > totalCap) return response;
        // A pause longer than one slice is waited a slice at a time: the
        // router answers the next ask with the time still left. The jitter
        // grows with the pause, so bots released together by one pause do
        // not all hit the provider in the same half second.
        const jitter = random() * Math.min(5_000, Math.max(500, hinted * 0.1));
        wait = Math.min(Math.round(Math.min(hinted, singleCap) + jitter), totalCap - waited);
        if (wait <= 0) return response;
      } else {
        // Jitter, so ten bots refused together do not all come back together.
        wait = Math.round((hint.ms ?? backoff) + random() * 500);
        if (wait > singleCap + 500 || waited + wait > totalCap) return response;
      }
      await response.body?.cancel();
      await doSleep(wait, init?.signal);
      waited += wait;
    }
  };
}

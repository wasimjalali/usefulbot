import { RouterError } from "./errors.ts";
import { readCapped } from "./read-capped.ts";

export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** Spend and credit limits OpenAI reports as a 429 `code` (the set Codex treats as quota). */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

/**
 * Z.ai sends every limit as a 429 with a numeric `code` (docs.z.ai/api-reference/api-code).
 * 1302 (requests too fast) and 1305 (overloaded) are real rate limits and absent here.
 */
const ZAI_CODES = new Map<string, string>([
  ["1113", "upstream_quota_exhausted"], // no balance or resource package
  ["1308", "upstream_usage_limit"], // plan usage limit, resets later
  ["1309", "upstream_quota_exhausted"], // Coding Plan package expired
  ["1310", "upstream_usage_limit"], // weekly or monthly limit
  ["1311", "upstream_usage_not_included"], // plan does not include the model
  ["1313", "upstream_usage_limit"], // fair usage policy
  ["1314", "upstream_quota_exhausted"], // enterprise package expired
  ["1315", "upstream_usage_not_included"], // key limited to enterprise coding use
  ["1316", "upstream_usage_limit"],
  ["1317", "upstream_usage_limit"],
  ["1318", "upstream_usage_limit"],
  ["1319", "upstream_usage_limit"],
  ["1320", "upstream_usage_limit"],
  ["1321", "upstream_usage_limit"],
]);

/** The furthest reset worth naming; anything later is a unit mixup or junk. */
const MAX_RESET_S = 400 * 24 * 3600;

/**
 * The router's code for a provider error that says a plan or credit limit is
 * used up, or null when it is an ordinary rate limit. Read from the error's
 * `type` and `code` the way OpenAI's own Codex client reads them
 * (codex-rs/codex-api/src/api_bridge.rs), plus the documented shapes of the
 * other vendors in the catalog: Kimi (platform.kimi.ai/docs/api/errors) and Z.ai,
 * and the ChatGPT plan-sharing codes OpenAI documents for Sign in with ChatGPT.
 */
export function usedLimitCode(type: string, code: string, message = ""): string | null {
  // Sign in with ChatGPT (docs: token-sharing-open-source/errors-and-recovery).
  if (code === "subscription_sharing_usage_limit_exceeded") return "upstream_chatgpt_usage_limit";
  if (code === "subscription_sharing_user_not_eligible") return "upstream_chatgpt_not_eligible";
  if (type === "usage_limit_reached") return "upstream_usage_limit";
  if (type === "usage_not_included") return "upstream_usage_not_included";
  if (type === "insufficient_quota" || QUOTA_CODES.has(code)) return "upstream_quota_exhausted";
  if (type === "exceeded_current_quota_error") return "upstream_quota_exhausted";
  // Kimi's tokens-per-day limit shares `rate_limit_reached_error` with its
  // per-minute and concurrency ones; only the message names it, and its
  // docs say it resets the next day, which no wait inside a turn reaches.
  // Anchored on the limit's own wording ("reached organization TPD rate
  // limit", "Organization-level TPD limit reached"), not the bare token: the
  // message also carries the caller's organisation name.
  if (type === "rate_limit_reached_error" && /\borganization(?:-level)? (?:max )?TPD\b/i.test(message)) return "upstream_usage_limit";
  return ZAI_CODES.get(code) ?? null;
}

/** Epoch seconds of a reset, or undefined when the value can't be one. */
function plausibleReset(seconds: number, nowS: number): number | undefined {
  // A reset sent in milliseconds reads as seconds after the division.
  const value = seconds > 1e12 ? seconds / 1000 : seconds;
  if (!(value > nowS && value <= nowS + MAX_RESET_S)) return undefined;
  return Math.round(value);
}

/** The reset a provider error names, as epoch seconds, when it names a plausible one. */
export function resetOf(error: Record<string, unknown>): number | undefined {
  const nowS = Date.now() / 1000;
  if (typeof error.resets_at === "number" && Number.isFinite(error.resets_at)) {
    return plausibleReset(error.resets_at, nowS);
  }
  if (typeof error.resets_in_seconds === "number" && Number.isFinite(error.resets_in_seconds)) {
    return plausibleReset(nowS + error.resets_in_seconds, nowS);
  }
  return undefined;
}

/**
 * Z.ai names its reset only in words, "Your limit will reset at 2026-09-24
 * 18:00:00": a wall clock in China Standard Time with no zone on it. Read
 * for Z.ai's own codes only; another vendor's time is not in that zone.
 */
export function zaiResetOf(code: string, message: string): number | undefined {
  if (!ZAI_CODES.has(code)) return undefined;
  const said = /\bresets? at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i.exec(message);
  if (!said) return undefined;
  const at = Date.parse(`${said[1]}T${said[2]}+08:00`);
  return Number.isFinite(at) ? plausibleReset(at / 1000, Date.now() / 1000) : undefined;
}

/** A used-up limit's message: the code, and the reset when there is one. */
export function usedLimitMessage(name: string, resetsAt: number | undefined): string {
  return resetsAt !== undefined ? `${name} resets_at=${resetsAt}` : name;
}

/**
 * A 429 is either "slow down" or "the plan or the credit is used up", and
 * only the body says which. A used-up limit is not retried: it answers 402,
 * which no client retries, with the reset time when the provider gave one,
 * so the app can say what happened and until when.
 */
export async function upstreamLimitError(response: Response): Promise<RouterError> {
  const text = await readCapped(response, 16_384).catch(async () => {
    // Too large or unreadable: an ordinary rate limit, and the socket is
    // released rather than left for the collector.
    await response.body?.cancel().catch(() => {});
    return "";
  });
  let type = "";
  let code = "";
  let message = "";
  let resetsAt: number | undefined;
  try {
    const error = (JSON.parse(text) as { error?: Record<string, unknown> } | null)?.error;
    if (error && typeof error === "object") {
      type = typeof error.type === "string" ? error.type : "";
      code = typeof error.code === "string" ? error.code
        : typeof error.code === "number" ? String(error.code) : "";
      message = typeof error.message === "string" ? error.message : "";
      resetsAt = resetOf(error) ?? zaiResetOf(code, message);
    }
  } catch { /* not JSON: an ordinary rate limit */ }
  // Google names the quota that ran out (google.rpc.QuotaFailure); a per-day
  // one does not lift in a turn's time, whatever the body's outer shape.
  const name = usedLimitCode(type, code, message)
    ?? (/"quotaId"\s*:\s*"[^"]*PerDay/.test(text) ? "upstream_usage_limit" : null);
  if (name) {
    return new RouterError({
      status: 402,
      type: "rate_limit_error",
      code: name,
      // The reset rides in the message: it is what reaches the app through
      // eve's failure text.
      message: usedLimitMessage(name, resetsAt),
      retryable: false,
    });
  }
  return new RouterError({
    status: 429,
    type: "rate_limit_error",
    code: "upstream_rate_limited",
    message: "upstream_rate_limited",
    retryable: true,
    retryAfterMs: retryAfterMs(response),
  });
}

import { RouterError } from "./errors.ts";

const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 300_000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const FAILURE_OPEN_MS = 30_000;
/**
 * A model the upstream says it does not have is worse than a flaky minute: it
 * needs the owner to pick a different one. It used to set a flag with nothing
 * to clear it, so the alias stayed dead for the life of the router process and
 * the only way back was restarting the services. It is a long cool-down now,
 * not a headstone: a model reselected in the composer takes effect at the
 * latest five minutes later, and a model that is still missing simply opens
 * the alias again on the next call.
 *
 * `disable()` is not this. A reservation that overran its budget is a spend
 * guard, and a guard that lifts itself on a timer is not one.
 */
const MISSING_MODEL_OPEN_MS = 300_000;

/**
 * A 4xx the provider answered with (context overflow, invalid request,
 * unsupported tools or images). The request was refused, the upstream is fine:
 * it keeps the wire shape of a protocol error, but it never counts toward the
 * failure circuit, or one oversized prompt would pause every bot on the model.
 */
export class UpstreamRefusalError extends RouterError {}

/**
 * One circuit per upstream: alias, connection and model. A rate limit or a
 * missing model on one model must not stop another model or another bot that
 * picked a different one. The alias comes first so `disable` can find it.
 */
export function circuitKey(alias: string, connectionId: string, modelId: string): string {
  return `${alias}|${connectionId}|${modelId}`;
}

function aliasOf(key: string): string {
  const cut = key.indexOf("|");
  return cut === -1 ? key : key.slice(0, cut);
}

interface CircuitState {
  openUntil: number;
  /** Open because the provider said to slow down, not because it failed. */
  rateLimited: boolean;
  failures: number[];
}

function clampRetryAfter(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(ms)));
}

export class AliasCircuit {
  private readonly states = new Map<string, CircuitState>();
  /** Alias-wide: the spend tripwire covers every model of the alias. */
  private readonly disabled = new Set<string>();

  private state(key: string): CircuitState {
    let current = this.states.get(key);
    if (!current) {
      current = { openUntil: 0, rateLimited: false, failures: [] };
      this.states.set(key, current);
    }
    return current;
  }

  assertClosed(key: string, now = Date.now()): void {
    const alias = aliasOf(key);
    const current = this.state(key);
    // The spend tripwire, which no timer lifts. Its own code, because the app
    // tells the owner to wait out a `circuit_open` and no wait clears this:
    // the two states read alike from the outside and do not mean alike.
    if (this.disabled.has(alias)) {
      throw new RouterError({
        status: 503,
        type: "internal_error",
        code: "circuit_disabled",
        message: "circuit_disabled",
        alias: alias as "workhorse" | "reviewer",
      });
    }
    // Paused because the provider said to slow down: every bot hears that,
    // with the time left, rather than a generic cool-down. The agent's fetch
    // waits out this code; it does not wait out a circuit_open.
    if (current.openUntil > now && current.rateLimited) {
      throw new RouterError({
        status: 429,
        type: "rate_limit_error",
        code: "upstream_rate_limited",
        message: "upstream_rate_limited",
        retryable: true,
        retryAfterMs: current.openUntil - now,
      });
    }
    if (current.openUntil > now) {
      throw new RouterError({
        status: 503,
        type: "internal_error",
        code: "circuit_open",
        // The wait rides in the message too: eve keeps only the message of
        // a failed call, so the app's countdown reads it from there.
        message: `circuit_open retry_after_ms=${current.openUntil - now}`,
        alias: alias as "workhorse" | "reviewer",
        retryable: true,
        retryAfterMs: current.openUntil - now,
      });
    }
  }

  recordSuccess(key: string): void {
    const current = this.state(key);
    current.failures = [];
    current.openUntil = 0;
    current.rateLimited = false;
  }

  /**
   * Stop calling this alias (every model of it) until the router restarts. The one caller is a
   * reservation that overran its budget, which means the spend accounting and
   * the upstream disagree. That is not something a wait fixes.
   */
  disable(alias: string): void {
    this.disabled.add(alias);
  }

  recordFailure(key: string, error: RouterError, now = Date.now()): void {
    if (error instanceof UpstreamRefusalError) return;
    const current = this.state(key);
    if (error.code === "upstream_rate_limited") {
      const retryAfter = clampRetryAfter(error.retryAfterMs);
      if (now + retryAfter > current.openUntil) {
        current.openUntil = now + retryAfter;
        current.rateLimited = true;
      }
      return;
    }
    if (error.code === "model_unavailable") {
      // The later deadline decides what the pause is: a rate-limit pause that
      // outlasts this one keeps its label, so the agent still waits it out.
      if (now + MISSING_MODEL_OPEN_MS >= current.openUntil) {
        current.openUntil = now + MISSING_MODEL_OPEN_MS;
        current.rateLimited = false;
      }
      return;
    }
    // A timeout is a 5xx-class failure too: three in the window open the
    // alias the same way a protocol error does.
    if (error.code === "upstream_protocol_error" || error.code === "upstream_timeout") {
      current.failures = current.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
      current.failures.push(now);
      if (current.failures.length >= FAILURE_THRESHOLD) {
        if (now + FAILURE_OPEN_MS >= current.openUntil) {
          current.openUntil = now + FAILURE_OPEN_MS;
          current.rateLimited = false;
        }
      }
    }
  }
}

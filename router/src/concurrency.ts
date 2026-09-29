import { RouterError } from "./errors.ts";
import { MAX_ACTIVE_UPSTREAM } from "../../shared/policy.ts";

/** How long a caller refused by the ceiling is told to wait before trying again. */
export const CEILING_RETRY_AFTER_MS = 2_000;

/**
 * In-memory concurrency ceiling (SPEC.md section 4, "Concurrency"):
 * one active request per key, and at most `maxTotal` active across the gate.
 * Acquired before the step id is reserved, so a refused request never
 * consumes a step, a rate-limit hit or a token reservation.
 *
 * The key is the caller plus the session, not the caller alone. eve holds one
 * credential for every bot, so a caller-only key made the whole app one
 * session: a second bot got `session_busy` while the first was thinking. With
 * the session in the key one bot still cannot run two model calls at once,
 * and ten bots can run one each.
 *
 * The ceiling has its own code. It used to answer `global_budget_exhausted`,
 * which is also the DAILY aggregate budget, so the app told the owner the
 * day's tokens were gone when the bots were merely busy.
 */
export class ConcurrencyGate {
  private readonly active = new Set<string>();
  private readonly maxTotal: number;

  constructor(maxTotal: number = MAX_ACTIVE_UPSTREAM) {
    this.maxTotal = maxTotal;
  }

  static key(callerId: string, sessionId: string): string {
    return JSON.stringify([callerId, sessionId]);
  }

  /**
   * Takes a slot and returns the function that gives it back. The release is
   * idempotent, so a handler whose error path and `finally` both run cannot
   * free a slot that a later request now holds.
   */
  acquire(key: string): () => void {
    if (this.active.has(key)) {
      throw new RouterError({
        status: 409,
        type: "invalid_request_error",
        code: "session_busy",
        message: "session_busy",
      });
    }
    if (this.active.size >= this.maxTotal) {
      throw new RouterError({
        status: 429,
        type: "rate_limit_error",
        code: "global_concurrency_limit",
        message: "global_concurrency_limit",
        retryable: true,
        retryAfterMs: CEILING_RETRY_AFTER_MS,
      });
    }
    this.active.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(key);
    };
  }

  get activeCount(): number {
    return this.active.size;
  }
}

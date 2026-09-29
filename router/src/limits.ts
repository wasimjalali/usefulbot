import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { RouterError } from "./errors.ts";
import { SEARCH_LIMITS } from "../../shared/policy.ts";
import { currentBudget, effectiveLimits } from "../../shared/limits-store.ts";
import type { AuthedCaller } from "./auth.ts";

export interface UsageRow {
  callerId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  at: number;
}

export interface UsageBucket {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  caller_id: string;
  window_start: string;
  reserved_input_tokens: number | null;
  reserved_output_tokens: number | null;
  observed_input_tokens: number;
  observed_output_tokens: number;
  requests: number;
  provider_remaining: null;
  by_model: UsageBucket[];
}

export interface ReserveInput {
  caller: AuthedCaller;
  alias: string;
  inputUnits: number;
  outputUnits: number;
  now: number;
}

export interface Reconciliation {
  overrun: boolean;
  alias: string | null;
}

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const HIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RESERVATION_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const SCHEMA_VERSION = 2;

interface TokenTotals {
  input: number;
  output: number;
}

/**
 * Conservative input upper bound in reservation units. An exact tokenizer is
 * unavailable at the router, so SPEC.md:242 mandates UTF-8 bytes plus fixed
 * message/tool framing. These are never reported as measured tokens. The
 * slack is deliberate: a reservation is settled to the observed usage right
 * after the response, but an observation above the reservation is an overrun
 * that disables the alias for the process. An image part counts by its
 * base64 length for the same reason: a model bills a picture by its pixels,
 * not its bytes, and the encoded size is the bound that cannot be exceeded.
 */
export function estimateInputUnits(body: unknown): number {
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const messages = Buffer.byteLength(JSON.stringify(rec.messages ?? []), "utf8");
  const tools = Buffer.byteLength(JSON.stringify(rec.tools ?? []), "utf8");
  const messageCount = Array.isArray(rec.messages) ? rec.messages.length : 0;
  const toolCount = Array.isArray(rec.tools) ? rec.tools.length : 0;
  return messages + tools + messageCount * 16 + toolCount * 64 + 64;
}

export class LimitStore {
  private readonly db: DatabaseSync;
  private lastPrune = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    // Writers serialize through BEGIN IMMEDIATE; wait briefly for a held lock
    // instead of surfacing SQLITE_BUSY as a 500.
    this.db.exec("PRAGMA busy_timeout=5000");
    this.migrate();
    this.prune(Date.now());
  }

  private migrate(): void {
    // Additive, idempotent migrations. Existing 1.x databases gain the
    // reservations ledger in place without losing request, hit or usage rows.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hits (
        caller_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        reserved_input INTEGER NOT NULL,
        reserved_output INTEGER NOT NULL,
        observed_input INTEGER,
        observed_output INTEGER,
        state TEXT NOT NULL,
        usage_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservations_created_idx ON reservations(created_at);
      CREATE TABLE IF NOT EXISTS search_hits (
        caller_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_hits_ts_idx ON search_hits(ts);
    `);
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const version = Number(row?.user_version ?? 0);
    if (version < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    this.db.prepare("DELETE FROM requests WHERE created_at < ?").run(now - REQUEST_TTL_MS);
    this.db.prepare("DELETE FROM search_hits WHERE ts < ?").run(now - REQUEST_TTL_MS);
    this.db.prepare("DELETE FROM hits WHERE ts < ?").run(now - HIT_RETENTION_MS);
    this.db.prepare("DELETE FROM usage WHERE ts < ?").run(now - USAGE_RETENTION_MS);
    this.db.prepare("DELETE FROM reservations WHERE created_at < ?").run(now - RESERVATION_RETENTION_MS);
  }

  private chargedTokens(callerId: string | null, since: number): TokenTotals {
    const usage = callerId
      ? this.db.prepare(
        "SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM usage WHERE ts > ? AND caller_id = ?",
      ).get(since, callerId) as { input: number; output: number }
      : this.db.prepare(
        "SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM usage WHERE ts > ?",
      ).get(since) as { input: number; output: number };
    const reserved = callerId
      ? this.db.prepare(
        "SELECT COALESCE(SUM(reserved_input), 0) AS input, COALESCE(SUM(reserved_output), 0) AS output FROM reservations WHERE state = 'reserved' AND created_at > ? AND caller_id = ?",
      ).get(since, callerId) as { input: number; output: number }
      : this.db.prepare(
        "SELECT COALESCE(SUM(reserved_input), 0) AS input, COALESCE(SUM(reserved_output), 0) AS output FROM reservations WHERE state = 'reserved' AND created_at > ?",
      ).get(since) as { input: number; output: number };
    return { input: Number(usage.input) + Number(reserved.input), output: Number(usage.output) + Number(reserved.output) };
  }

  private reservedTokens(callerId: string | null, since: number): TokenTotals {
    const row = callerId
      ? this.db.prepare(
        "SELECT COALESCE(SUM(reserved_input), 0) AS input, COALESCE(SUM(reserved_output), 0) AS output FROM reservations WHERE state = 'reserved' AND created_at > ? AND caller_id = ?",
      ).get(since, callerId) as { input: number; output: number }
      : this.db.prepare(
        "SELECT COALESCE(SUM(reserved_input), 0) AS input, COALESCE(SUM(reserved_output), 0) AS output FROM reservations WHERE state = 'reserved' AND created_at > ?",
      ).get(since) as { input: number; output: number };
    return { input: Number(row.input), output: Number(row.output) };
  }

  private policyError(code: string, retryAfterMs?: number): RouterError {
    return new RouterError({
      status: 429,
      type: "rate_limit_error",
      code,
      message: code,
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  /**
   * Per-caller and aggregate checks plus the hit insert, all inside one
   * BEGIN IMMEDIATE transaction. When `reservation` is supplied the input
   * upper bound and requested max output are charged in the same transaction
   * before dispatch (SPEC.md:238-240).
   */
  private enforce(
    caller: AuthedCaller,
    now: number,
    reservation?: { id: string; alias: string; inputUnits: number; outputUnits: number },
  ): void {
    // Read at enforce time, not at import: the owner can move the daily budget
    // from the settings pane and the next turn must respect it without a
    // router restart.
    const effective = effectiveLimits(caller.profile, currentBudget());
    const limits = effective.caller;
    const aggregate = effective.aggregate;
    const minuteAgo = now - 60_000;
    const recent = this.db.prepare("SELECT COUNT(*) AS c FROM hits WHERE caller_id = ? AND ts > ?").get(
      caller.callerId,
      minuteAgo,
    ) as { c: number };
    if (recent.c >= limits.rpm) {
      // A slot frees when the oldest hit in the window ages out. Saying when
      // lets the agent wait that long instead of failing the turn.
      const oldest = this.db.prepare("SELECT MIN(ts) AS ts FROM hits WHERE caller_id = ? AND ts > ?").get(
        caller.callerId,
        minuteAgo,
      ) as { ts: number | null };
      throw new RouterError({
        status: 429,
        type: "rate_limit_error",
        code: "caller_rate_limit",
        message: "caller_rate_limit",
        retryable: true,
        ...(oldest.ts !== null ? { retryAfterMs: Math.max(0, oldest.ts + 60_000 - now) } : {}),
      });
    }
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const day = this.db.prepare("SELECT COUNT(*) AS c FROM hits WHERE caller_id = ? AND ts > ?").get(
      caller.callerId,
      dayAgo,
    ) as { c: number };
    if (limits.requests24h > 0 && day.c >= limits.requests24h) {
      throw this.policyError("caller_budget_exhausted");
    }
    const callerTokens = this.chargedTokens(caller.callerId, dayAgo);
    const incomingInput = reservation?.inputUnits ?? 0;
    const incomingOutput = reservation?.outputUnits ?? 0;
    if ((limits.input24h > 0
        && (callerTokens.input >= limits.input24h || callerTokens.input + incomingInput > limits.input24h))
      || (limits.output24h > 0
        && (callerTokens.output >= limits.output24h || callerTokens.output + incomingOutput > limits.output24h))) {
      throw this.policyError("caller_budget_exhausted");
    }
    const totalDay = this.db.prepare("SELECT COUNT(*) AS c FROM hits WHERE ts > ?").get(dayAgo) as { c: number };
    if (aggregate.requests24h > 0 && totalDay.c >= aggregate.requests24h) {
      throw this.policyError("global_budget_exhausted");
    }
    const totalTokens = this.chargedTokens(null, dayAgo);
    if ((aggregate.input24h > 0
        && (totalTokens.input >= aggregate.input24h || totalTokens.input + incomingInput > aggregate.input24h))
      || (aggregate.output24h > 0
        && (totalTokens.output >= aggregate.output24h || totalTokens.output + incomingOutput > aggregate.output24h))) {
      throw this.policyError("global_budget_exhausted");
    }
    this.db.prepare("INSERT INTO hits (caller_id, ts) VALUES (?, ?)").run(caller.callerId, now);
    if (reservation) {
      this.db.prepare(
        "INSERT INTO reservations (reservation_id, caller_id, alias, reserved_input, reserved_output, state, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?)",
      ).run(reservation.id, caller.callerId, reservation.alias, reservation.inputUnits, reservation.outputUnits, now);
    }
  }

  recordUsage(row: UsageRow): void {
    this.prune(row.at);
    this.db.prepare(
      "INSERT INTO usage (caller_id, provider, model, input_tokens, output_tokens, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.callerId, row.provider, row.model, row.inputTokens, row.outputTokens, row.at);
  }

  /**
   * Ops audit shape: with no callerId this aggregates every caller and labels
   * the row `caller_id: "aggregate"` so operators cannot mistake it for the
   * desktop-only view. Per-caller views keep the caller's id.
   */
  summarize(callerId?: string, now = Date.now(), windowMs = 7 * 24 * 60 * 60 * 1000): UsageSummary {
    const start = now - windowMs;
    const totals = callerId
      ? this.db.prepare(
        "SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM usage WHERE caller_id = ? AND ts > ?",
      ).get(callerId, start) as { requests: number; input: number; output: number }
      : this.db.prepare(
        "SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM usage WHERE ts > ?",
      ).get(start) as { requests: number; input: number; output: number };
    const rows = callerId
      ? this.db.prepare(
        "SELECT provider, model, COUNT(*) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage WHERE caller_id = ? AND ts > ? GROUP BY provider, model ORDER BY output DESC, input DESC",
      ).all(callerId, start) as Array<{ provider: string; model: string; requests: number; input: number; output: number }>
      : this.db.prepare(
        "SELECT provider, model, COUNT(*) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage WHERE ts > ? GROUP BY provider, model ORDER BY output DESC, input DESC",
      ).all(start) as Array<{ provider: string; model: string; requests: number; input: number; output: number }>;
    const reserved = this.reservedTokens(callerId ?? null, start);
    return {
      caller_id: callerId ?? "aggregate",
      window_start: new Date(start).toISOString(),
      reserved_input_tokens: reserved.input,
      reserved_output_tokens: reserved.output,
      observed_input_tokens: Number(totals.input),
      observed_output_tokens: Number(totals.output),
      requests: Number(totals.requests),
      provider_remaining: null,
      by_model: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        requests: Number(row.requests),
        inputTokens: Number(row.input),
        outputTokens: Number(row.output),
      })),
    };
  }

  rememberRequest(requestId: string, callerId: string, now: number): void {
    this.prune(now);
    const key = `${callerId}\u0000${requestId}`;
    const info = this.db.prepare(
      "INSERT INTO requests (request_id, caller_id, created_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING",
    ).run(key, callerId, now);
    if (Number(info.changes) === 0) {
      throw new RouterError({
        status: 409,
        type: "invalid_request_error",
        code: "duplicate_request",
        message: "duplicate_request",
      });
    }
  }

  hit(caller: AuthedCaller, now: number): void {
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.enforce(caller, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Persisted per-caller search gate from SPEC.md section 7. The counter is
   * written before dispatch, so failed and unknown requests still count, and
   * every check plus the insert runs in one transaction.
   */
  checkSearchLimit(caller: AuthedCaller, now: number): void {
    // Callers without the search capability get capability_forbidden from the
    // adapter, not a quota error, so they never consume the shared budget.
    if (!caller.search) return;
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const perCaller = (SEARCH_LIMITS as Record<string, number>)[caller.profile] ?? 0;
      // Unknown profiles default to no budget: a search flag on a profile
      // without a cap must not mean unlimited searches.
      if (perCaller <= 0) {
        throw this.policyError("search_rate_limited");
      }
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const day = this.db.prepare("SELECT COUNT(*) AS c FROM search_hits WHERE caller_id = ? AND ts > ?").get(
        caller.callerId,
        dayAgo,
      ) as { c: number };
      if (day.c >= perCaller) {
        throw this.policyError("search_rate_limited");
      }
      const total = this.db.prepare("SELECT COUNT(*) AS c FROM search_hits WHERE ts > ?").get(dayAgo) as { c: number };
      if (total.c >= SEARCH_LIMITS.aggregate) {
        throw this.policyError("search_rate_limited");
      }
      const last = this.db.prepare("SELECT MAX(ts) AS ts FROM search_hits WHERE caller_id = ?").get(
        caller.callerId,
      ) as { ts: number | null };
      if (last.ts !== null && now - last.ts < SEARCH_LIMITS.minIntervalMs) {
        // Unlike the daily caps above this one clears by itself, within a
        // second. With several bots searching it is routine, so it says when.
        throw this.policyError("search_rate_limited", Math.max(0, last.ts + SEARCH_LIMITS.minIntervalMs - now));
      }
      this.db.prepare("INSERT INTO search_hits (caller_id, ts) VALUES (?, ?)").run(caller.callerId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserve(input: ReserveInput): string {
    const reservationId = randomUUID();
    this.prune(input.now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.enforce(input.caller, input.now, {
        id: reservationId,
        alias: input.alias,
        inputUnits: input.inputUnits,
        outputUnits: input.outputUnits,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return reservationId;
  }

  /**
   * Reconcile a reservation to certified usage. Unknown usage leaves the
   * reservation charged until its rolling expiry. Observed usage above the
   * reservation is recorded as an overrun for the caller to block the alias.
   */
  reconcile(
    reservationId: string,
    observed: { inputTokens: number; outputTokens: number },
    meta: { provider: string; model: string },
    now: number,
  ): Reconciliation {
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT caller_id, alias, reserved_input, reserved_output, usage_id FROM reservations WHERE reservation_id = ?",
      ).get(reservationId) as {
        caller_id: string;
        alias: string;
        reserved_input: number;
        reserved_output: number;
        usage_id: number | null;
      } | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { overrun: false, alias: null };
      }
      const overrun = observed.inputTokens > row.reserved_input || observed.outputTokens > row.reserved_output;
      let usageId = row.usage_id;
      if (usageId === null) {
        const info = this.db.prepare(
          "INSERT INTO usage (caller_id, provider, model, input_tokens, output_tokens, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(row.caller_id, meta.provider, meta.model, observed.inputTokens, observed.outputTokens, now);
        usageId = Number(info.lastInsertRowid);
      } else {
        this.db.prepare(
          "UPDATE usage SET provider = ?, model = ?, input_tokens = ?, output_tokens = ?, ts = ? WHERE id = ?",
        ).run(meta.provider, meta.model, observed.inputTokens, observed.outputTokens, now, usageId);
      }
      this.db.prepare(
        "UPDATE reservations SET observed_input = ?, observed_output = ?, state = ?, usage_id = ? WHERE reservation_id = ?",
      ).run(observed.inputTokens, observed.outputTokens, overrun ? "overrun" : "reconciled", usageId, reservationId);
      this.db.exec("COMMIT");
      return { overrun, alias: row.alias };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

import {
  appendRoutineRun,
  claimDueRoutine,
  claimManualRun,
  claimRunNow,
  pendingRoutines,
  type Routine,
} from "../../shared/routines-store.ts";
import type { Engine } from "./engine.ts";
import { EngineError } from "./protocol.ts";
import type { TurnResult } from "./pi-host.ts";

/**
 * The routine scheduler (SPEC 5.11). A 20 second timer in the engine, at most
 * four runs at once and one per routine. A routine runs in its own chat,
 * created on its first run and reused, so a run never lands in the chat the
 * owner is typing in. The run is a turn with origin `routine`: no owner bubble,
 * a note row first, an hour of budget and ten minutes without events.
 */

type Claimed = { routine: Routine };

/**
 * The routine store calls the scheduler makes (also the seam a test uses to make
 * one fail). The real ones wait at most `LOCK_WAIT_MS` for the store's lock, so
 * a lock held for seconds by another process never stalls the engine.
 */
export type RoutineStore = {
  pending(now: Date): Routine[];
  claimManual(id: string): Claimed | null;
  claimDue(id: string, now: Date): Claimed | null;
  claimRunNow(id: string): Claimed | null;
  appendRun(id: string, run: { status: "ok" | "failed"; chatId?: string | null; error?: string }): unknown;
};

export type RoutineOptions = {
  tickMs?: number;
  maxRunning?: number;
  budgetMs?: number;
  idleMs?: number;
  checkMs?: number;
  /** Pause between tries to record a finished run while the store's lock is busy. */
  recordRetryMs?: number;
  store?: Partial<RoutineStore>;
};

const DEFAULTS = { tickMs: 20_000, maxRunning: 4, budgetMs: 60 * 60_000, idleMs: 10 * 60_000, checkMs: 5_000, recordRetryMs: 250 };
const LOCK_WAIT_MS = 50;
/** 40 tries at the default pause is ten seconds of a busy lock before a finished run is given up on. */
const RECORD_TRIES = 40;

const isLockBusy = (error: unknown): boolean => error instanceof Error && error.message === "routines_locked";

function logFailure(event: string, fields: Record<string, unknown>, error: unknown): void {
  console.error(JSON.stringify({ event, ...fields, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
}

export class RoutineScheduler {
  private readonly options: typeof DEFAULTS;
  private readonly store: RoutineStore;
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  private readonly engine: Engine;

  constructor(engine: Engine, options: RoutineOptions = {}) {
    this.engine = engine;
    const { store, ...rest } = options;
    this.options = { ...DEFAULTS, ...rest };
    this.store = {
      pending: (now) => pendingRoutines(now),
      claimManual: (id) => claimManualRun(id, undefined, LOCK_WAIT_MS),
      claimDue: (id, now) => claimDueRoutine(id, now, undefined, LOCK_WAIT_MS),
      claimRunNow: (id) => claimRunNow(id, undefined, LOCK_WAIT_MS),
      appendRun: (id, run) => appendRoutineRun(id, run, undefined, undefined, LOCK_WAIT_MS),
      ...store,
    };
  }

  start(): void {
    if (this.timer) return;
    // A store that fails must not take the engine down: the next tick tries again.
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        logFailure("routine_tick_failed", {}, error);
      }
    }, this.options.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** How many runs are in flight (tests and the status poll). */
  get inFlight(): number {
    return this.running.size;
  }

  /** Starts what is due or requested, up to the cap. Returns the routine ids it started. */
  tick(now = new Date()): string[] {
    const started: string[] = [];
    this.engine.sweepRoutineLinks();
    let candidates: Routine[];
    try {
      candidates = this.store.pending(now);
    } catch (error) {
      console.error(JSON.stringify({ event: "routines_unreadable", error: error instanceof Error ? error.message : String(error) }));
      return started;
    }
    for (const routine of candidates) {
      if (this.running.size >= this.options.maxRunning) break;
      if (this.running.has(routine.id)) continue;
      let claimed: Claimed | null;
      try {
        claimed = this.store.claimManual(routine.id) ?? this.store.claimDue(routine.id, now);
      } catch (error) {
        logFailure("routine_tick_failed", { routineId: routine.id }, error);
        // A busy lock is the same for every routine: skip the rest of this tick. Any other failure belongs to this routine alone.
        if (isLockBusy(error)) break;
        continue;
      }
      if (!claimed) continue;
      try {
        this.begin(claimed.routine);
        started.push(routine.id);
      } catch (error) {
        this.recordFailure(claimed.routine, null, error);
      }
    }
    return started;
  }

  /** The owner's Run now: claims the routine and runs it in its chat. */
  runNow(routineId: string): { chatId: string; turnId: string | null; queued: boolean } {
    if (this.running.has(routineId)) throw new EngineError(409, "routine_busy");
    let claimed: Claimed | null;
    try {
      claimed = this.store.claimRunNow(routineId);
    } catch (error) {
      if (isLockBusy(error)) throw new EngineError(503, "routines_store_busy", { retryable: true });
      throw error;
    }
    if (!claimed) throw new EngineError(404, "routine_missing");
    try {
      return this.begin(claimed.routine);
    } catch (error) {
      this.recordFailure(claimed.routine, null, error);
      throw error;
    }
  }

  private begin(routine: Routine): { chatId: string; turnId: string | null; queued: boolean } {
    const index = this.engine.host.index;
    // The index is the truth: a routine's chat is the one that names it, created on its first run.
    const known = index.all().find((meta) => meta.routineId === routine.id) ?? (routine.chatId ? index.get(routine.chatId) : undefined);
    let chatId = known?.chatId;
    if (!chatId) {
      chatId = index.create({ botId: routine.botId, title: routine.name, routineId: routine.id }).chatId;
      this.linkChat(routine.id, chatId);
    } else if (routine.chatId !== chatId) {
      this.linkChat(routine.id, chatId);
    }
    const stamp = this.engine.host.now().toISOString();
    const prompt = `Scheduled run of the routine ${routine.name}. Nobody is watching: do not ask questions or wait for cards.\n\n${routine.instruction}`;
    // The note is filed when the run's own turn starts, so a run that waits and is dropped never "ran", and the note carries that turn's id.
    const submitted = this.engine.turns.submitInternal(chatId, "routine", `routine:${routine.id}:${stamp}`, prompt, {
      key: `note:routine-run-${routine.id}-${stamp}`,
      kind: "note",
      text: `Routine ${routine.name} ran.`,
      source: "routine",
    });
    const finished = this.watch(routine, chatId, submitted.turnId, submitted.done);
    this.running.set(routine.id, finished);
    void finished.finally(() => { this.running.delete(routine.id); });
    return { chatId, turnId: submitted.turnId, queued: submitted.queued };
  }

  /** Points the routine at its chat; a busy store (short lock wait) is a retryable 503, not a bare error. */
  private linkChat(routineId: string, chatId: string): void {
    try {
      this.engine.host.deps.setRoutineChat(routineId, chatId);
    } catch (error) {
      if (isLockBusy(error)) throw new EngineError(503, "routines_store_busy", { retryable: true });
      throw error;
    }
  }

  /** Enforces the budget and records the run when it ends. */
  private async watch(routine: Routine, chatId: string, turnId: string, done: Promise<TurnResult>): Promise<void> {
    const chat = this.engine.host.chat(chatId);
    const timer = setInterval(() => {
      const turn = chat.turn;
      if (!turn || turn.turnId !== turnId) return;
      const now = Date.now();
      if (now - turn.startedAt > this.options.budgetMs) this.engine.turns.abortTurn(chat, "budget");
      else if (now - turn.lastEventAt > this.options.idleMs) this.engine.turns.abortTurn(chat, "idle");
    }, this.options.checkMs);
    timer.unref();
    try {
      const result = await done;
      if (result.outcome === "completed") {
        await this.record(routine, { status: "ok", chatId });
      } else {
        const error = result.failure?.detail ?? (result.outcome === "cancelled" ? "The run was stopped." : "The run failed.");
        await this.record(routine, { status: "failed", chatId, error });
      }
    } catch (error) {
      // The run is over either way: a store that cannot record it is logged, not thrown into nowhere.
      logFailure("routine_run_record_failed", { routineId: routine.id, chatId }, error);
    } finally {
      clearInterval(timer);
    }
  }

  private recordFailure(routine: Routine, chatId: string | null, error: unknown): void {
    const detail = error instanceof EngineError && typeof error.fields.message === "string"
      ? error.fields.message
      : error instanceof EngineError ? error.code : error instanceof Error ? error.message : String(error);
    this.record(routine, { status: "failed", ...(chatId ? { chatId } : {}), error: detail }).catch((recordError: unknown) => {
      logFailure("routine_run_record_failed", { routineId: routine.id, chatId }, recordError);
    });
  }

  /**
   * Writes a run into the routine's history. The first try is synchronous; a
   * busy lock (another process holds the store) is retried without blocking the
   * engine, because a finished run that is never recorded is a lost fact.
   */
  private async record(routine: Routine, run: { status: "ok" | "failed"; chatId?: string | null; error?: string }): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.store.appendRun(routine.id, run);
        return;
      } catch (error) {
        if (!isLockBusy(error) || attempt >= RECORD_TRIES) throw error;
        await new Promise<void>((resolve) => { setTimeout(resolve, this.options.recordRetryMs).unref(); });
      }
    }
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What is in flight, on disk (`<stateRoot>/engine/running.json`), so a boot
 * after a crash can close the turns that were cut off and turn the messages
 * that were waiting behind them into unsent rows (SPEC 5.5.3, 5.5.10). It holds
 * ids only; the messages themselves are in the session files.
 */

export type RunningTurnRecord = { chatId: string; turnId: string; startedAt: string };
export type QueuedRecord = { chatId: string; turnId: string; clientId: string };

type LedgerFile = { schemaVersion: 1; turns: RunningTurnRecord[]; queued: QueuedRecord[] };

export class RunningLedger {
  private turns: RunningTurnRecord[] = [];
  private queued: QueuedRecord[] = [];

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.turns) || !Array.isArray(parsed.queued)) {
      throw new Error("running_ledger_unreadable");
    }
    this.turns = parsed.turns;
    this.queued = parsed.queued;
  }

  /** What the previous process left behind. Read once at boot, before this process writes. */
  leftovers(): { turns: RunningTurnRecord[]; queued: QueuedRecord[] } {
    return { turns: [...this.turns], queued: [...this.queued] };
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const file: LedgerFile = { schemaVersion: 1, turns: this.turns, queued: this.queued };
    const tmp = join(dirname(this.path), `.running.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  turnStarted(record: RunningTurnRecord): void {
    this.turns = this.turns.filter((turn) => turn.chatId !== record.chatId);
    this.turns.push(record);
    this.save();
  }

  turnEnded(chatId: string, turnId: string): void {
    const before = this.turns.length;
    this.turns = this.turns.filter((turn) => !(turn.chatId === chatId && turn.turnId === turnId));
    if (this.turns.length !== before) this.save();
  }

  messageQueued(record: QueuedRecord): void {
    this.queued.push(record);
    this.save();
  }

  messageDequeued(chatId: string, clientId: string): void {
    const before = this.queued.length;
    this.queued = this.queued.filter((item) => !(item.chatId === chatId && item.clientId === clientId));
    if (this.queued.length !== before) this.save();
  }

  /** Forgets everything left by the previous process once the boot has dealt with it. */
  clear(): void {
    this.turns = [];
    this.queued = [];
    this.save();
  }
}

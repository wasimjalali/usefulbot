import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  UB,
  type FailureData,
  type OpenQuestion,
  type QueuedData,
  type QueuedDropData,
  type QuestionData,
  type Row,
  type SearchResult,
  type TurnOrigin,
  type TurnStartData,
} from "./protocol.ts";

/**
 * Rows are built from the session's active branch and nothing else (SPEC
 * 5.12): never from the compaction-aware context projection, which drops
 * summarized history. The same builder runs over a whole file and over entries
 * as they arrive, so a live row and a rebuilt one have the same id.
 *
 * The owner's bubble comes from the turn's own `ub.turn-start` entry, which the
 * host writes the moment the turn is accepted, so its place in the chat never
 * depends on when Pi gets around to writing the message. Row ids: user `<turnId>:u`, assistant `<turnId>:a<n>` (n counts the turn's
 * text-bearing assistant messages from 0), failure `<turnId>:f`, question
 * `<turnId>:q`, compaction `compaction:<entryId>`, unsent `unsent:<clientId>`,
 * and the `key` of a `ub.row` entry for everything a tool filed.
 */

export const COMPACTION_NOTE = "Conversation compacted to fit the model's window";

/** What a pushed entry did to the row list, so the host can emit events. */
export type RowChange =
  | { type: "added"; row: Row }
  | { type: "updated"; row: Row }
  /** A row Pi hid from the model's context (an attempt it retried by itself): it leaves the rows too. */
  | { type: "removed"; row: Row };

type TurnState = {
  turnId: string;
  origin: TurnOrigin;
  clientId?: string;
  assistantCount: number;
  searchResults: SearchResult[];
};

type TextBlock = { type?: unknown; text?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content as TextBlock[]) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchResultsOf(details: unknown): SearchResult[] {
  if (!isRecord(details) || !Array.isArray(details.searchResults)) return [];
  const out: SearchResult[] = [];
  for (const item of details.searchResults) {
    if (!isRecord(item)) continue;
    if (typeof item.title === "string" && typeof item.url === "string") {
      out.push({ title: item.title, url: item.url, snippet: typeof item.snippet === "string" ? item.snippet : "" });
    }
  }
  return out;
}

export class RowBuilder {
  /** Rows in the order they happened. */
  readonly rows: Row[] = [];
  private readonly index = new Map<string, number>();
  /** The session entry each assistant row came from, so a context edit that drops the entry can drop the row. */
  private readonly entryRows = new Map<string, string>();
  /** Messages waiting behind a running turn: always shown last, and moved into `rows` when their turn starts. */
  private readonly pending: Row[] = [];
  private turn: TurnState | null = null;
  /** Every client id a turn-start or a queued entry carried, for the idempotent send. */
  readonly clients = new Map<string, { turnId: string; queued: boolean }>();
  /** Keys of `ub.row` entries, for append idempotency. */
  readonly keys = new Set<string>();
  private questionRowId: string | null = null;

  static build(entries: Iterable<SessionEntry>): RowBuilder {
    const builder = new RowBuilder();
    for (const entry of entries) builder.push(entry);
    return builder;
  }

  has(rowId: string): boolean {
    return this.index.has(rowId) || this.pending.some((row) => row.rowId === rowId);
  }

  /** A message still waiting behind a running turn (no bubble in the chat yet). */
  isPending(rowId: string): boolean {
    return this.pending.some((row) => row.rowId === rowId);
  }

  get(rowId: string): Row | undefined {
    const at = this.index.get(rowId);
    return at === undefined ? this.pending.find((row) => row.rowId === rowId) : this.rows[at];
  }

  /** What the app shows: the rows, then the messages still waiting their turn. */
  view(): Row[] {
    return this.pending.length === 0 ? this.rows : [...this.rows, ...this.pending];
  }

  private takePending(rowId: string): Row | undefined {
    const at = this.pending.findIndex((row) => row.rowId === rowId);
    return at === -1 ? undefined : this.pending.splice(at, 1)[0];
  }

  /** The question still waiting for an answer, or null. */
  openQuestion(): OpenQuestion | null {
    if (!this.questionRowId) return null;
    const row = this.get(this.questionRowId);
    if (!row || row.kind !== "question" || !row.open) return null;
    return { requestId: row.requestId, prompt: row.prompt, options: row.options, allowFreeform: row.allowFreeform };
  }

  /** The turn id that rows of the current turn carry (null before any turn). */
  currentTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  private add(row: Row): RowChange | null {
    if (this.has(row.rowId)) return null;
    this.index.set(row.rowId, this.rows.length);
    this.rows.push(row);
    return { type: "added", row };
  }

  private remove(rowId: string): RowChange[] {
    const at = this.index.get(rowId);
    if (at === undefined) return [];
    const [row] = this.rows.splice(at, 1);
    this.index.delete(rowId);
    for (let next = at; next < this.rows.length; next += 1) this.index.set(this.rows[next].rowId, next);
    for (const [entryId, mapped] of this.entryRows) if (mapped === rowId) this.entryRows.delete(entryId);
    return [{ type: "removed", row }];
  }

  push(entry: SessionEntry): RowChange[] {
    switch (entry.type) {
      case "message":
        return this.pushMessage(entry);
      case "compaction": {
        const change = this.add({
          rowId: `compaction:${entry.id}`,
          kind: "note",
          turnId: null,
          at: entry.timestamp,
          text: COMPACTION_NOTE,
          source: "compaction",
        });
        return change ? [change] : [];
      }
      case "custom":
        return this.pushCustom(entry.customType, entry.data, entry.timestamp);
      case "context_edit": {
        // Only a drop (`replacement: null`) of an assistant message hides a row. The ids that follow keep counting, as the live stream does.
        const rowId = entry.replacement === null ? this.entryRows.get(entry.targetId) : undefined;
        return rowId ? this.remove(rowId) : [];
      }
      default:
        return [];
    }
  }

  private pushMessage(entry: Extract<SessionEntry, { type: "message" }>): RowChange[] {
    const message = entry.message as unknown as Record<string, unknown>;
    const turn = this.turn;
    if (message.role === "assistant") {
      if (!turn) return [];
      const text = textOf(message.content);
      if (text.trim() === "") return [];
      const row: Row = {
        rowId: `${turn.turnId}:a${turn.assistantCount}`,
        kind: "assistant",
        turnId: turn.turnId,
        at: entry.timestamp,
        text,
        ...(turn.searchResults.length > 0 ? { searchResults: turn.searchResults } : {}),
      };
      turn.assistantCount += 1;
      turn.searchResults = [];
      const change = this.add(row);
      if (change) this.entryRows.set(entry.id, row.rowId);
      return change ? [change] : [];
    }
    if (message.role === "toolResult" && turn && message.toolName === "web_search") {
      turn.searchResults.push(...searchResultsOf(message.details));
    }
    return [];
  }

  private pushCustom(customType: string, data: unknown, at: string): RowChange[] {
    if (!isRecord(data)) return [];
    switch (customType) {
      case UB.turnStart: {
        const start = data as unknown as TurnStartData;
        this.turn = {
          turnId: start.turnId,
          origin: start.origin,
          ...(start.clientId ? { clientId: start.clientId } : {}),
          assistantCount: 0,
          searchResults: [],
        };
        if (start.clientId) this.clients.set(start.clientId, { turnId: start.turnId, queued: false });
        if (start.origin !== "owner") return [];
        // The next owner message closes an open question and is the turn's bubble.
        const changes = this.closeQuestion();
        const rowId = `${start.turnId}:u`;
        const row: Row = {
          rowId,
          kind: "user",
          turnId: start.turnId,
          at,
          text: start.text ?? "",
          ...(start.clientId ? { clientId: start.clientId } : {}),
          attachments: start.attachments ?? [],
        };
        // A message that waited has its bubble now: it leaves the waiting list for its place in the chat.
        this.takePending(rowId);
        const change = this.add(row);
        if (change) changes.push(change);
        return changes;
      }
      case UB.queued: {
        const queued = data as unknown as QueuedData;
        this.clients.set(queued.clientId, { turnId: queued.turnId, queued: true });
        const rowId = `${queued.turnId}:u`;
        if (this.has(rowId)) return [];
        this.pending.push({
          rowId,
          kind: "user",
          turnId: queued.turnId,
          at,
          text: queued.text,
          clientId: queued.clientId,
          attachments: queued.attachments ?? [],
          queued: true,
        });
        return [];
      }
      case UB.queuedDrop: {
        const drop = data as unknown as QueuedDropData;
        const queuedRow = this.takePending(`${drop.turnId}:u`);
        if (!queuedRow || queuedRow.kind !== "user") return [];
        this.clients.delete(drop.clientId);
        const unsent: Row = {
          rowId: `unsent:${drop.clientId}`,
          kind: "unsent",
          turnId: null,
          at,
          clientId: drop.clientId,
          text: queuedRow.text,
          reason: drop.reason,
        };
        const change = this.add(unsent);
        return change ? [change] : [];
      }
      case UB.failure: {
        const failure = data as unknown as FailureData;
        const change = this.add({
          rowId: `${failure.turnId}:f`,
          kind: "failure",
          turnId: failure.turnId,
          at,
          code: failure.code,
          detail: failure.detail,
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
          ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
          messageKept: true,
        });
        return change ? [change] : [];
      }
      case UB.question: {
        const question = data as unknown as QuestionData;
        const rowId = `${question.turnId}:q`;
        const change = this.add({
          rowId,
          kind: "question",
          turnId: question.turnId,
          at,
          requestId: question.requestId,
          prompt: question.prompt,
          options: question.options,
          allowFreeform: question.allowFreeform,
          open: true,
        });
        if (change) this.questionRowId = rowId;
        return change ? [change] : [];
      }
      case UB.row: {
        const filed = data as { key: string; turnId: string | null } & Record<string, unknown>;
        this.keys.add(filed.key);
        const { key, turnId, ...fields } = filed;
        // A note a tool or the web service filed says where it came from; the default is "system".
        const withSource = fields.kind === "note" ? { source: "system", ...fields } : fields;
        const change = this.add({ rowId: key, turnId: turnId ?? null, at, ...withSource } as Row);
        return change ? [change] : [];
      }
      default:
        return [];
    }
  }

  private closeQuestion(): RowChange[] {
    if (!this.questionRowId) return [];
    const row = this.get(this.questionRowId);
    this.questionRowId = null;
    if (!row || row.kind !== "question" || !row.open) return [];
    const closed: Row = { ...row, open: false };
    this.rows[this.index.get(row.rowId) as number] = closed;
    return [{ type: "updated", row: closed }];
  }
}

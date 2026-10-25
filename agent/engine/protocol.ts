/**
 * Chat protocol v1 (SPEC 6): the rows the engine serves and the events it
 * streams. The shapes are pinned by test/fixtures/chat-protocol/ (README there).
 * Field names are camelCase; an absent optional field is left out, never null,
 * except where a type says `| null`.
 */

export type TurnOrigin = "owner" | "routine" | "system";

export type Attachment = { name: string; mediaType: string; size: number };

export type SearchResult = { title: string; url: string; snippet: string };

export type Activity = { kind: "thinking" | "tool" | "compacting" | "retrying"; tool?: string; detail?: string };

export type QuestionOption = { id: string; label: string; detail?: string };

type RowBase = { rowId: string; turnId: string | null; at: string };

export type Row =
  | (RowBase & { kind: "user"; text: string; clientId?: string; attachments: Attachment[]; queued?: true })
  | (RowBase & { kind: "assistant"; text: string; searchResults?: SearchResult[] })
  | (RowBase & { kind: "note"; text: string; source: "routine" | "connect" | "compaction" | "system" })
  | (RowBase & { kind: "failure"; code: string; detail: string; retryAfterMs?: number; resetsAt?: string; messageKept: true })
  | (RowBase & { kind: "question"; requestId: string; prompt: string; options: QuestionOption[]; allowFreeform: boolean; open: boolean })
  | (RowBase & { kind: "unsent"; clientId: string; text: string; reason: "cancelled" | "interrupted" })
  | (RowBase & { kind: "image"; imageId: string; prompt?: string })
  | (RowBase & { kind: "page"; mediaId: string; title: string; path: string })
  | (RowBase & { kind: "widget"; widgetId: string; callId: string; connectionId: string; toolName: string })
  | (RowBase & { kind: "card"; proposalId: string });

export type RowKind = Row["kind"];

export type EventBody = { type: string } & Record<string, unknown>;

/** Envelope `{seq, epoch, at, chatId, turnId?, type, ...}` (SPEC 6.2). */
export type EngineEvent = {
  seq: number;
  epoch: string;
  at: string;
  chatId: string;
  turnId?: string;
  type: string;
} & Record<string, unknown>;

export type OpenQuestion = { requestId: string; prompt: string; options: QuestionOption[]; allowFreeform: boolean };

export type TurnOutcome = "completed" | "cancelled" | "failed";

/** An HTTP-visible refusal: `{ok: false, error, ...fields}` with `status` (SPEC 6.4). */
export class EngineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, unknown>;
  constructor(status: number, code: string, fields: Record<string, unknown> = {}) {
    super(code);
    this.name = "EngineError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** The custom entries (`ub.*`) the engine writes into a session file (SPEC 5.5, 5.12). */
export const UB = {
  turnStart: "ub.turn-start",
  turnEnd: "ub.turn-end",
  queued: "ub.queued",
  queuedDrop: "ub.queued-drop",
  failure: "ub.failure",
  question: "ub.question",
  row: "ub.row",
  context: "ub.context",
} as const;

/** Owner turns carry the text and attachments the user row shows, so the row never waits on Pi's own message. */
export type TurnStartData = {
  turnId: string;
  origin: TurnOrigin;
  clientId?: string;
  retry?: true;
  text?: string;
  attachments?: Attachment[];
};
export type TurnEndData = { turnId: string; outcome: TurnOutcome | "interrupted" | "refused" };
export type QueuedData = { turnId: string; clientId: string; text: string; attachments: Attachment[] };
export type QueuedDropData = { turnId: string; clientId: string; reason: "cancelled" | "interrupted" };
export type FailureData = { turnId: string; code: string; detail: string; retryAfterMs?: number; resetsAt?: string };
export type QuestionData = { turnId: string; requestId: string; prompt: string; options: QuestionOption[]; allowFreeform: boolean };

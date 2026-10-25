import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { admission, descriptionTooLong, DESCRIPTION_TOO_LONG_TEXT } from "../../shared/admission.ts";
import { readProviderStore } from "../../shared/providers.ts";
import { botSelection } from "../../shared/session-selection.ts";
import { peekShell } from "../../shared/shell-io.ts";
import type { ShellBot } from "../../shared/shell-store.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { removeSessionGrant, upsertSessionGrant } from "../../shared/workspace-store.ts";
import { forgetRouterError, lastRouterError } from "../lib/router-fetch.ts";
import { routerIds } from "../lib/router-identity.ts";
import type { RowInput } from "../lib/tool.ts";
import { buildSnapshot } from "../lib/turn-snapshot.ts";
import { clip, PREVIEW_MAX, TITLE_MAX } from "./chats.ts";
import { basePromptFor, systemPromptFor, turnContextText } from "./context.ts";
import type { TurnBody } from "./deps.ts";
import { type ChatRuntime, type EngineHost, type QueuedTurn, type RunningTurn, type TurnResult, type TurnSpec } from "./pi-host.ts";
import { factsFor, turnBindings } from "./provider.ts";
import { selectionRefusal } from "./selection-refusal.ts";
import {
  EngineError,
  UB,
  type Activity,
  type Attachment,
  type FailureData,
  type QueuedDropData,
  type QueuedData,
  type TurnEndData,
  type TurnOrigin,
  type TurnStartData,
} from "./protocol.ts";
import { toolDetail } from "./tool-labels.ts";

/**
 * Turns (SPEC 5.5): admission, the host queue, the running turn, cancel,
 * retry and the settle that closes a turn. One `session.prompt()` is exactly
 * one turn because the host never uses Pi's follow-up queue.
 */

/** How long a turn start waits for the workspace store's lock. */
const GRANT_WAIT_MS = 50;

export type SubmitResult = { turnId: string; queued: boolean; done: Promise<TurnResult> };

type Prepared = {
  bot: ShellBot;
  snapshot: ReturnType<typeof buildSnapshot>;
  systemPrompt: string;
  contextText: string;
};

type Deferred = { done: Promise<TurnResult>; finish: (result: TurnResult) => void };

function deferred(): Deferred {
  let finish!: (result: TurnResult) => void;
  const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
  return { done, finish };
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** The prompt text and image parts for a request body (SPEC 5.5.4). */
export function specFromBody(body: TurnBody): TurnSpec {
  const attachments: Attachment[] = [];
  const images: TurnSpec["images"] = [];
  const parts = [body.text.trim()];
  for (const item of body.attachments) {
    attachments.push({ name: item.name, mediaType: item.mediaType, size: item.size });
    if (item.dataUrl) {
      const match = DATA_URL.exec(item.dataUrl);
      if (!match) throw new EngineError(400, "attachment_invalid");
      images.push({ type: "image", mimeType: match[1], data: match[2] });
      parts.push(`Attached image: ${item.name.replace(/[\r\n\t]+/g, " ").slice(0, 120)}`);
    } else if (item.text !== undefined) {
      parts.push(`Attached file: ${item.name.replace(/[\r\n\t]+/g, " ").slice(0, 120)}\n${wrapUntrusted(item.name, item.text)}`);
    } else {
      parts.push(`Attached file: ${item.name.replace(/[\r\n\t]+/g, " ").slice(0, 120)} (${item.size} bytes). Contents are not readable as text.`);
    }
  }
  return { text: body.text, promptText: parts.filter((part) => part !== "").join("\n\n"), images, attachments };
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

type RetryTarget = {
  turnId: string;
  clientId: string;
  /** The failed turn's `ub.turn-start`: the leaf moves to its parent, so the whole attempt is left behind. */
  startEntry: SessionEntry;
  /** The user message Pi wrote for it: the exact text and images the model saw. */
  /** Null when the attempt died before Pi wrote the message: the marker's own text is all there is. */
  userEntry: (SessionEntry & { type: "message" }) | null;
  start: TurnStartData;
  failure: FailureData;
  failedAt: number;
};

/** The chat's newest turn, when it failed and nothing came after it (SPEC 5.5.9). */
export function findRetryTarget(branch: readonly SessionEntry[]): RetryTarget | null {
  let startAt = -1;
  for (let at = branch.length - 1; at >= 0; at -= 1) {
    const entry = branch[at];
    if (entry.type === "custom" && entry.customType === UB.turnStart) {
      startAt = at;
      break;
    }
  }
  if (startAt === -1) return null;
  const startEntry = branch[startAt] as Extract<SessionEntry, { type: "custom" }>;
  const start = startEntry.data as TurnStartData;
  if (start.origin !== "owner" || !start.clientId) return null;
  let failure: FailureData | null = null;
  let failedAt = 0;
  let userEntry: RetryTarget["userEntry"] | null = null;
  for (let at = startAt + 1; at < branch.length; at += 1) {
    const entry = branch[at];
    if (entry.type === "custom" && entry.customType === UB.failure) {
      const data = entry.data as FailureData;
      if (data.turnId === start.turnId) {
        failure = data;
        failedAt = Date.parse(entry.timestamp);
      }
    } else if (entry.type === "message" && userEntry === null && (entry.message as unknown as { role?: string }).role === "user") {
      userEntry = entry;
    }
  }
  if (!failure) return null;
  return { turnId: start.turnId, clientId: start.clientId, startEntry, userEntry, start, failure, failedAt };
}

export class TurnRunner {
  private readonly host: EngineHost;
  /** How a queued message whose start finds the workspace store busy is retried: every 250 ms, 40 times. */
  busyRetry = { ms: 250, tries: 40 };
  private readonly busyTimers = new Map<string, NodeJS.Timeout>();

  constructor(host: EngineHost) {
    this.host = host;
    host.onSessionEvent = (chat, event) => this.onEvent(chat, event);
  }

  // --- admission --------------------------------------------------------------

  /**
   * Everything that can refuse a send before Pi sees it (SPEC 5.5.1). Throws a
   * typed EngineError. `stampGrant` writes the chat's workspace grant first, so
   * the snapshot shows what the tools will enforce: only a turn that is about
   * to start stamps, never a send that will wait behind a running one.
   */
  prepare(chat: ChatRuntime, spec: TurnSpec, options: { stampGrant: boolean }): Prepared {
    const store = readProviderStore();
    const shell = peekShell();
    if (!shell) throw new EngineError(503, "shell_unreadable");
    const bot = shell.bots.find((item) => item.id === chat.botId);
    if (!bot) throw new EngineError(409, "bot_missing");
    const selection = botSelection(bot, store);
    const refusal = selectionRefusal(bot, store);
    if (refusal) throw new EngineError(refusal.status, refusal.code, { message: refusal.message });
    const facts = factsFor(selection);
    if (spec.images.length > 0 && facts.vision === false) throw new EngineError(400, "model_no_vision");
    if (descriptionTooLong(bot)) throw new EngineError(409, "description_too_long", { message: DESCRIPTION_TOO_LONG_TEXT });
    if (options.stampGrant) {
      try {
        // A short wait: a lock held for seconds fails the start (retryable) instead of stalling every chat.
        upsertSessionGrant({ chatId: chat.chatId, path: bot.workspace?.path ?? null, permission: bot.permission, selection }, undefined, undefined, GRANT_WAIT_MS);
      } catch (error) {
        if (error instanceof Error && error.message === "workspace_locked") throw new EngineError(503, "workspace_store_busy", { retryable: true });
        throw error;
      }
    }
    const firstChat = !this.host.index.all().some((meta) => meta.botId === bot.id && meta.lastTurn !== null);
    const snapshot = buildSnapshot(bot.id, chat.chatId, undefined, { firstChat });
    const skills = this.host.deps.listSkills();
    const systemPrompt = systemPromptFor(snapshot.context.bot, skills);
    const notes = this.host.deps.notesBlockFor(bot.id);
    const contextText = turnContextText(snapshot.context.turn, notes);
    const declarations = [...this.host.deps.allTools(), ...this.host.deps.pickedTools(chat.chatId)]
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    // The shared admission, fed what this engine will really send: the prompt before "Your bot", the notes and the tool schemas.
    const verdict = admission({
      bot,
      store,
      notesChars: notes.length,
      promptChars: basePromptFor(skills).length,
      toolSchemaChars: JSON.stringify(declarations).length,
    });
    if (!verdict.ok) throw new EngineError(409, "context_too_large", { message: verdict.message });
    return { bot, snapshot, systemPrompt, contextText };
  }

  // --- submitting -------------------------------------------------------------

  /** Once shutdown has begun no turn starts or queues: the app retries against the next engine. */
  private assertRunning(): void {
    if (this.host.stopping) throw new EngineError(503, "engine_stopping", { retryable: true });
  }

  /** An owner message: refused, queued behind a running turn, or started. */
  submitOwner(chatId: string, body: TurnBody): SubmitResult {
    this.assertRunning();
    const chat = this.host.chat(chatId);
    chat.ensureLive();
    if (body.retry) return this.retry(chat, body);
    const existing = this.existing(chat, body.clientId);
    if (existing) return existing;
    const spec = specFromBody(body);
    this.prepare(chat, spec, { stampGrant: false });
    return this.accept(chat, { origin: "owner", clientId: body.clientId, spec, persisted: true });
  }

  /** A routine run or a system turn. Same admission; the prompt is not an owner bubble. */
  submitInternal(chatId: string, origin: Exclude<TurnOrigin, "owner">, clientId: string, text: string, startNote?: RowInput): SubmitResult {
    this.assertRunning();
    const chat = this.host.chat(chatId);
    chat.ensureLive();
    const existing = this.existing(chat, clientId);
    if (existing) return existing;
    const spec: TurnSpec = { text, promptText: text, images: [], attachments: [] };
    this.prepare(chat, spec, { stampGrant: false });
    // `startNote` is filed when this turn starts, not now: a turn that waits and is dropped never ran.
    return this.accept(chat, { origin, clientId, spec, persisted: false, ...(startNote ? { startNote } : {}) });
  }

  /** The original answer for a clientId this chat already knows (SPEC 5.5.1). */
  private existing(chat: ChatRuntime, clientId: string): SubmitResult | null {
    if (chat.turn?.clientId === clientId) return { turnId: chat.turn.turnId, queued: false, done: chat.turn.done };
    const waiting = chat.queue.find((item) => item.clientId === clientId);
    if (waiting) return { turnId: waiting.turnId, queued: true, done: waiting.done };
    chat.syncRows();
    const known = chat.live?.rows.clients.get(clientId);
    if (known) {
      return {
        turnId: known.turnId,
        queued: known.queued,
        done: Promise.resolve({ turnId: known.turnId, outcome: "completed" }),
      };
    }
    return null;
  }

  private accept(chat: ChatRuntime, input: { origin: TurnOrigin; clientId: string; spec: TurnSpec; persisted: boolean; startNote?: RowInput }): SubmitResult {
    const turnId = randomUUID();
    // A queue that is waiting for its head to start (busy store) keeps its order: a new send goes behind it.
    if (chat.turn || chat.queue.length > 0) return this.enqueue(chat, { turnId, ...input, ...deferred() });
    return this.start(chat, { turnId, ...input, ...deferred() });
  }

  private enqueue(chat: ChatRuntime, queued: QueuedTurn): SubmitResult {
    chat.queue.push(queued);
    if (queued.persisted) {
      const data: QueuedData = { turnId: queued.turnId, clientId: queued.clientId, text: queued.spec.text, attachments: queued.spec.attachments };
      chat.appendCustom(UB.queued, data);
      this.host.ledger.messageQueued({ chatId: chat.chatId, turnId: queued.turnId, clientId: queued.clientId });
      chat.bus.emit({ type: "message.queued", clientId: queued.clientId, text: queued.spec.text }, chat.turn?.turnId);
    }
    return { turnId: queued.turnId, queued: true, done: queued.done };
  }

  /**
   * Accepts the turn: everything here is synchronous, so the turn's marker is
   * in the file, and its bubble in the rows, before anything else can be
   * appended behind it. Only the model call is async (`run`).
   */
  private start(chat: ChatRuntime, input: QueuedTurn, retryTarget?: RetryTarget): SubmitResult {
    const prepared = this.prepare(chat, input.spec, { stampGrant: true });
    const turn: RunningTurn = {
      turnId: input.turnId,
      origin: input.origin,
      clientId: input.clientId,
      retry: retryTarget !== undefined,
      spec: input.spec,
      snapshot: { ...prepared.snapshot, turnId: input.turnId },
      contextText: prepared.contextText,
      systemPrompt: prepared.systemPrompt,
      abort: new AbortController(),
      cancelRequested: false,
      abortReason: null,
      startedAt: Date.now(),
      partialText: "",
      streamRowId: null,
      activity: null,
      assistantCount: 0,
      lastEventAt: Date.now(),
      thinkingEmittedAt: 0,
      agentStarted: false,
      lastAssistant: null,
      userEmitted: false,
      done: input.done,
      finish: input.finish,
    };
    chat.turn = turn;
    chat.touch();
    let marked = false;
    try {
      if (retryTarget) {
        // The failed attempt stays in the file on an abandoned branch (SPEC 5.5.9). The session is
        // dropped first so the next one is built from the branch we move to.
        chat.disposeSession();
        const live = chat.ensureLive();
        if (retryTarget.startEntry.parentId === null) live.sm.resetLeaf();
        else live.sm.branch(retryTarget.startEntry.parentId);
        chat.syncRows();
      }
      // The running record goes in before the marker, so a crash between the two still closes the turn at boot; a failure below undoes it.
      this.host.ledger.turnStarted({ chatId: chat.chatId, turnId: turn.turnId, startedAt: new Date().toISOString() });
      if (input.persisted) this.host.ledger.messageDequeued(chat.chatId, input.clientId);
      const startData: TurnStartData = {
        turnId: turn.turnId,
        origin: turn.origin,
        clientId: input.clientId,
        ...(retryTarget ? { retry: true as const } : {}),
        ...(turn.origin === "owner" ? { text: turn.spec.text, attachments: turn.spec.attachments } : {}),
      };
      const question = chat.openQuestion;
      if (turn.origin === "owner") {
        if (question) {
          chat.openQuestion = null;
          chat.bus.emit({ type: "input.resolved", requestId: question.requestId }, turn.turnId);
        }
        if (chat.meta.questionOpen) this.host.index.update(chat.chatId, { questionOpen: false }, { touch: false });
      }
      chat.appendCustom(UB.turnStart, startData);
      marked = true;
      // A new chat's file does not exist until Pi has a message: write it now, so the owner's first message survives a refusal or a crash.
      chat.flushSession();
      // The list orders by `updatedAt`: a turn that starts moves its chat to the top at once.
      this.host.index.update(chat.chatId, {});
      this.titleFrom(chat, turn);
      if (input.startNote) chat.appendRow(input.startNote);
      chat.bus.emit({
        type: "turn.started",
        origin: turn.origin,
        ...(turn.origin === "owner" ? { clientId: input.clientId } : {}),
        // A Retry leaves the failed attempt's rows on an abandoned branch: the app refetches the rows page.
        ...(retryTarget ? { retry: true, resync: true } : {}),
      }, turn.turnId);
    } catch (error) {
      chat.turn = null;
      this.undoStart(chat, turn, marked, error);
      throw error;
    }
    void this.run(chat, turn).catch((error) => {
      console.error(JSON.stringify({ event: "turn_crashed", chatId: chat.chatId, turnId: turn.turnId, error: error instanceof Error ? error.message : String(error) }));
    });
    return { turnId: turn.turnId, queued: false, done: turn.done };
  }

  /**
   * A start that threw: the running record is withdrawn (or the next boot would
   * report an interrupted turn that never ran), and a marker already in the file
   * is closed as a refused turn, so nothing is left half open.
   */
  private undoStart(chat: ChatRuntime, turn: RunningTurn, marked: boolean, error: unknown): void {
    this.settleStep(chat, turn, "undo_ledger", () => this.host.ledger.turnEnded(chat.chatId, turn.turnId));
    if (!marked) return;
    this.settleStep(chat, turn, "undo_marker", () => {
      const detail = clip(error instanceof Error ? error.message : String(error), 500) || "The turn could not start.";
      chat.appendCustom(UB.failure, { turnId: turn.turnId, code: "engine_error", detail } satisfies FailureData);
      chat.appendCustom(UB.turnEnd, { turnId: turn.turnId, outcome: "refused" } satisfies TurnEndData);
    });
  }

  // --- the run ------------------------------------------------------------------

  private async run(chat: ChatRuntime, turn: RunningTurn): Promise<void> {
    let thrown: { error: unknown; refused: boolean } | null = null;
    let prompting = false;
    try {
      const session = await chat.ensureSession(turn);
      if (turn.cancelRequested || turn.abortReason === "shutdown") return;
      const binding = { chatId: chat.chatId, turnId: turn.turnId, selection: turn.snapshot.selection };
      await turnBindings.run(binding, async () => {
        prompting = true;
        await session.prompt(turn.spec.promptText, { images: turn.spec.images, expandPromptTemplates: false });
        await session.waitForIdle();
      });
    } catch (error) {
      // Pi turned the prompt away before it ran anything: a refusal. Anything else is an engine error.
      thrown = { error, refused: prompting && !turn.agentStarted };
    } finally {
      this.settle(chat, turn, thrown);
    }
  }

  private titleFrom(chat: ChatRuntime, turn: RunningTurn): void {
    const meta = chat.meta;
    if (turn.origin !== "owner" || meta.titleSetByOwner || meta.routineId !== null) return;
    if (meta.title !== "New chat") return;
    const title = clip(turn.spec.text, TITLE_MAX);
    if (title !== "") this.host.index.update(chat.chatId, { title }, { touch: false });
  }

  // --- settle -------------------------------------------------------------------

  private settle(chat: ChatRuntime, turn: RunningTurn, thrown: { error: unknown; refused: boolean } | null): void {
    const ids = routerIds(chat.chatId, turn.turnId);
    if (turn.abortReason === "shutdown") {
      // The engine is stopping: write nothing. The running record stays, so the next boot closes this turn as
      // interrupted (with Retry) and turns what waited behind it into unsent rows (SPEC D15, 5.5.10).
      forgetRouterError(ids.turnId);
      chat.turn = null;
      turn.finish({ turnId: turn.turnId, outcome: "failed", failure: { code: "interrupted", detail: "The app stopped while this was running." } });
      return;
    }
    let result: TurnResult;
    let failure: FailureData | null = null;
    const last = turn.lastAssistant;
    if (turn.cancelRequested) {
      result = { turnId: turn.turnId, outcome: "cancelled" };
    } else if (turn.abortReason === "budget" || turn.abortReason === "idle") {
      const detail = turn.abortReason === "budget" ? "This run took longer than an hour and was stopped." : "This run stopped answering for ten minutes and was stopped.";
      failure = { turnId: turn.turnId, code: "routine_timeout", detail };
      result = { turnId: turn.turnId, outcome: "failed", failure: { code: failure.code, detail } };
    } else if (thrown || last?.stopReason === "error" || last?.stopReason === "aborted") {
      const record = lastRouterError(ids.turnId);
      const piMessage = thrown
        ? (thrown.error instanceof Error ? thrown.error.message : String(thrown.error))
        : last?.errorMessage ?? "The turn failed.";
      const code = thrown && thrown.error instanceof EngineError
        ? thrown.error.code
        : record?.code ?? (thrown?.refused ? "refused" : "engine_error");
      const detail = clip(record?.message ?? piMessage, 500) || "The turn failed.";
      failure = {
        turnId: turn.turnId,
        code,
        detail,
        ...(record?.retryAfterMs != null ? { retryAfterMs: record.retryAfterMs } : {}),
        ...(record?.resetsAt != null ? { resetsAt: record.resetsAt } : {}),
      };
      result = { turnId: turn.turnId, outcome: "failed", failure: { code, detail } };
    } else {
      result = { turnId: turn.turnId, outcome: "completed" };
    }
    forgetRouterError(ids.turnId);

    // Every step is its own try: a bookkeeping write that throws is logged and must never leave the chat busy.
    this.settleStep(chat, turn, "write", () => {
      chat.syncRows();
      if (failure) chat.appendCustom(UB.failure, failure);
      const outcome: TurnEndData["outcome"] = result.outcome === "failed" && thrown?.refused ? "refused" : result.outcome;
      chat.appendCustom(UB.turnEnd, { turnId: turn.turnId, outcome } satisfies TurnEndData);
    });
    this.settleStep(chat, turn, "ledger", () => this.host.ledger.turnEnded(chat.chatId, turn.turnId));
    chat.turn = null;
    chat.touch();
    this.settleStep(chat, turn, "last_turn", () => this.recordLastTurn(chat, turn.turnId, result.outcome));
    this.updateShellPreview(chat);
    if (result.outcome !== "cancelled" && this.host.openChatId !== chat.chatId) {
      chat.replyReadySince = this.host.now().toISOString();
    }
    this.settleStep(chat, turn, "emit", () => {
      if (result.outcome === "completed") chat.bus.emit({ type: "turn.completed" }, turn.turnId);
      else if (result.outcome === "cancelled") chat.bus.emit({ type: "turn.cancelled" }, turn.turnId);
      else if (failure) {
        chat.bus.emit({
          type: "turn.failed",
          code: failure.code,
          detail: failure.detail,
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
          ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
          messageKept: true,
          rowId: `${turn.turnId}:f`,
        }, turn.turnId);
      }
    });
    turn.finish(result);
    this.settleStep(chat, turn, "sweep", () => this.host.sweep());
    this.settleStep(chat, turn, "next", () => this.startNext(chat));
  }

  private settleStep(chat: ChatRuntime, turn: RunningTurn, step: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(JSON.stringify({ event: `settle_${step}_failed`, chatId: chat.chatId, turnId: turn.turnId, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private recordLastTurn(chat: ChatRuntime, turnId: string, outcome: "completed" | "cancelled" | "failed"): void {
    this.host.index.update(chat.chatId, { lastTurn: { turnId, outcome, endedAt: this.host.now().toISOString() } });
  }

  /** Keeps the bot's preview line fresh when the chat is its current one (SPEC 5.4). */
  private updateShellPreview(chat: ChatRuntime): void {
    const meta = chat.meta;
    try {
      if (this.host.current.get(meta.botId) !== chat.chatId) return;
      this.host.current.set(meta.botId, chat.chatId, meta.preview);
    } catch (error) {
      console.error(JSON.stringify({ event: "shell_preview_failed", chatId: chat.chatId, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Starts the next queued message, in order, once the running turn has settled. */
  private startNext(chat: ChatRuntime): void {
    if (chat.turn || this.host.stopping) return;
    const next = chat.queue.shift();
    if (!next) return;
    try {
      this.start(chat, next);
    } catch (error) {
      // A busy workspace store is momentary: the message keeps its place at the head of the queue and the start is tried again.
      if (error instanceof EngineError && error.code === "workspace_store_busy" && (next.busyTries ?? 0) < this.busyRetry.tries) {
        next.busyTries = (next.busyTries ?? 0) + 1;
        chat.queue.unshift(next);
        const timer = setTimeout(() => {
          this.busyTimers.delete(chat.chatId);
          try {
            this.startNext(chat);
          } catch (retryError) {
            console.error(JSON.stringify({ event: "start_next_failed", chatId: chat.chatId, error: retryError instanceof Error ? retryError.message : String(retryError) }));
          }
        }, this.busyRetry.ms);
        timer.unref();
        this.busyTimers.set(chat.chatId, timer);
        return;
      }
      // A message that waited and can no longer run (its model went away, say)
      // comes back as an unsent bubble with Send again.
      const message = error instanceof EngineError && typeof error.fields.message === "string" ? error.fields.message : error instanceof Error ? error.message : String(error);
      this.dropQueued(chat, next, "cancelled", { code: error instanceof EngineError ? error.code : "refused", detail: message });
      this.startNext(chat);
    }
  }

  // --- cancel and retry -----------------------------------------------------------

  /** Stop: drop the queue, expire the cards, abort. The `turn.cancelled` event comes on settle. */
  cancel(chatId: string): void {
    const chat = this.host.chat(chatId);
    clearTimeout(this.busyTimers.get(chatId));
    this.busyTimers.delete(chatId);
    for (const queued of chat.queue.splice(0)) this.dropQueued(chat, queued, "cancelled");
    const turn = chat.turn;
    if (!turn) return;
    turn.cancelRequested = true;
    turn.abortReason = "cancelled";
    // Cards first: a pending card must not hold the cancel.
    this.host.approvals.expireSession(chatId);
    turn.abort.abort();
    const session = chat.live?.session;
    if (session) {
      void session.abort().catch((error: unknown) => {
        console.error(JSON.stringify({ event: "abort_failed", chatId, error: error instanceof Error ? error.message : String(error) }));
      });
    }
  }

  private dropQueued(chat: ChatRuntime, queued: QueuedTurn, reason: QueuedDropData["reason"], failure?: { code: string; detail: string }): void {
    try {
      // A message whose turn was already written (its start failed afterwards) is no longer waiting: nothing to drop.
      if (queued.persisted && chat.ensureLive().rows.isPending(`${queued.turnId}:u`)) {
        const data: QueuedDropData = { turnId: queued.turnId, clientId: queued.clientId, reason };
        chat.appendCustom(UB.queuedDrop, data);
        this.host.ledger.messageDequeued(chat.chatId, queued.clientId);
        chat.bus.emit({ type: "message.dropped", clientId: queued.clientId });
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "drop_queued_failed", chatId: chat.chatId, turnId: queued.turnId, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      // Whatever the writes did, the sender's promise resolves and the queue behind it moves on.
      queued.finish(failure ? { turnId: queued.turnId, outcome: "failed", failure } : { turnId: queued.turnId, outcome: "cancelled" });
    }
  }

  /**
   * The engine is stopping (SIGTERM, an update relaunch): abort the running turn
   * but record nothing. Unlike Stop it leaves the queue and the running record
   * alone, so the next boot closes the turn as interrupted and turns what
   * waited into unsent rows.
   */
  shutdown(chatId: string): void {
    const chat = this.host.chat(chatId);
    clearTimeout(this.busyTimers.get(chatId));
    this.busyTimers.delete(chatId);
    // Routine and system turns that waited live in memory only and will not come back at boot: their senders learn it was lost.
    // Queued owner messages stay: they are in the session and the ledger, and boot turns them into unsent rows.
    chat.queue = chat.queue.filter((queued) => {
      if (queued.persisted) return true;
      queued.finish({ turnId: queued.turnId, outcome: "failed", failure: { code: "interrupted", detail: "The app stopped while this was running." } });
      return false;
    });
    const turn = chat.turn;
    if (!turn || turn.abortReason) return;
    turn.abortReason = "shutdown";
    this.host.approvals.expireSession(chatId);
    turn.abort.abort();
    void chat.live?.session?.abort().catch((error: unknown) => {
      console.error(JSON.stringify({ event: "abort_failed", chatId, error: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** Stops a routine run that overran its budget (SPEC 5.11). */
  abortTurn(chat: ChatRuntime, reason: "budget" | "idle"): void {
    const turn = chat.turn;
    if (!turn || turn.abortReason) return;
    turn.abortReason = reason;
    this.host.approvals.expireSession(chat.chatId);
    turn.abort.abort();
    void chat.live?.session?.abort().catch((error: unknown) => {
      console.error(JSON.stringify({ event: "abort_failed", chatId: chat.chatId, error: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** The retry turn this clientId already got on the active branch, when there is one. */
  private finishedRetry(live: ReturnType<ChatRuntime["ensureLive"]>, clientId: string): SubmitResult | null {
    const known = live.rows.clients.get(clientId);
    if (!known || known.queued) return null;
    let retried = false;
    for (const entry of live.sm.getBranch()) {
      if (entry.type === "custom" && entry.customType === UB.turnStart && (entry.data as TurnStartData).turnId === known.turnId) {
        retried = (entry.data as TurnStartData).retry === true;
      }
    }
    if (!retried) return null;
    return { turnId: known.turnId, queued: false, done: Promise.resolve({ turnId: known.turnId, outcome: "completed" }) };
  }

  private retry(chat: ChatRuntime, body: TurnBody): SubmitResult {
    // The same Retry posted again (a lost response, a double tap) gets the retry's turn back, as a duplicate send does.
    if (chat.turn?.retry && chat.turn.clientId === body.clientId) return { turnId: chat.turn.turnId, queued: false, done: chat.turn.done };
    if (chat.turn || chat.queue.length > 0) throw new EngineError(409, "chat_busy");
    const live = chat.ensureCurrent();
    const target = findRetryTarget(live.sm.getBranch());
    if (!target || target.clientId !== body.clientId) {
      const done = this.finishedRetry(live, body.clientId);
      if (done) return done;
      throw new EngineError(409, "retry_not_available");
    }
    const remaining = (target.failure.retryAfterMs ?? 0) - (this.host.now().getTime() - target.failedAt);
    if (remaining > 0) throw new EngineError(429, "retry_too_soon", { retryAfterMs: Math.ceil(remaining) });
    // The exact message again: text and images as the model saw them, the owner text as the row shows it.
    if (!target.userEntry) {
      // The attempt died before Pi wrote the message. The marker keeps the owner's words but only the
      // names of the attachments, so a message with attachments cannot be sent again.
      if ((target.start.attachments ?? []).length > 0) throw new EngineError(409, "retry_attachments_lost");
      const text = target.start.text ?? "";
      if (text.trim() === "") throw new EngineError(409, "retry_not_available");
      const fromMarker: TurnSpec = { text, promptText: text, images: [], attachments: [] };
      this.prepare(chat, fromMarker, { stampGrant: false });
      return this.start(chat, { turnId: randomUUID(), origin: "owner", clientId: target.clientId, spec: fromMarker, persisted: false, ...deferred() }, target);
    }
    const content = (target.userEntry.message as unknown as { content: unknown }).content;
    const images = Array.isArray(content)
      ? (content as { type?: string; data?: string; mimeType?: string }[])
        .filter((block) => block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
        .map((block) => ({ type: "image" as const, data: block.data as string, mimeType: block.mimeType as string }))
      : [];
    const spec: TurnSpec = {
      text: target.start.text ?? textOfBlocks(content),
      promptText: textOfBlocks(content),
      images,
      attachments: target.start.attachments ?? [],
    };
    this.prepare(chat, spec, { stampGrant: false });
    return this.start(chat, { turnId: randomUUID(), origin: "owner", clientId: target.clientId, spec, persisted: false, ...deferred() }, target);
  }

  // --- Pi events -------------------------------------------------------------------

  private onEvent(chat: ChatRuntime, event: AgentSessionEvent): void {
    const turn = chat.turn;
    if (!turn) return;
    turn.lastEventAt = Date.now();
    switch (event.type) {
      case "agent_start":
        turn.agentStarted = true;
        return;
      case "turn_start":
        this.activity(chat, turn, { kind: "thinking" }, true);
        return;
      case "turn_end":
      case "entry_appended":
        // `entry_appended` is how Pi announces entries it adds outside a message, such as the context edit that hides a retried attempt.
        chat.syncRows();
        return;
      case "message_start": {
        const message = event.message as unknown as { role?: string };
        if (message.role === "user" && turn.origin === "owner" && !turn.userEmitted) {
          turn.userEmitted = true;
          chat.bus.emit({
            type: "message.user",
            rowId: `${turn.turnId}:u`,
            ...(turn.clientId ? { clientId: turn.clientId } : {}),
            text: turn.spec.text,
            attachments: turn.spec.attachments,
          }, turn.turnId);
        }
        return;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string };
        if (inner.type === "text_delta" && typeof inner.delta === "string" && inner.delta !== "") {
          turn.partialText += inner.delta;
          let delta = inner.delta;
          if (!turn.streamRowId) {
            // Whitespace alone makes no row: it is held back and goes out with the first real text.
            if (turn.partialText.trim() === "") return;
            turn.streamRowId = `${turn.turnId}:a${turn.assistantCount}`;
            delta = turn.partialText;
          }
          chat.bus.emit({ type: "message.delta", rowId: turn.streamRowId, delta }, turn.turnId);
        } else if (inner.type === "thinking_delta") {
          this.activity(chat, turn, { kind: "thinking" }, true);
        }
        return;
      }
      case "message_end": {
        const message = event.message as unknown as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
        if (message.role === "assistant") {
          turn.lastAssistant = { stopReason: message.stopReason, errorMessage: message.errorMessage };
          const text = textOfBlocks(message.content);
          const counted = text.trim() !== "";
          const rowId = turn.streamRowId ?? `${turn.turnId}:a${turn.assistantCount}`;
          // The streaming state resets first: whatever fails below, the next message gets its own row id.
          if (counted) turn.assistantCount += 1;
          turn.streamRowId = null;
          turn.partialText = "";
          try {
            if (counted) {
              chat.bus.emit({ type: "message.final", rowId, text }, turn.turnId);
              this.host.index.update(chat.chatId, { preview: clip(text, PREVIEW_MAX) });
            }
          } finally {
            chat.syncRows();
          }
          return;
        }
        chat.syncRows();
        return;
      }
      case "tool_execution_start": {
        // The assistant message that made this call is in the session by now: rows fetched during the tool must have it.
        chat.syncRows();
        const widget = this.host.deps.widgetForCall(event.toolName, (event.args ?? {}) as Record<string, unknown>);
        chat.calls.set(event.toolCallId, { turnId: turn.turnId, widget: widget ? { connectionId: widget.connectionId, toolName: widget.toolName } : null });
        if (chat.calls.size > 200) chat.calls.delete(chat.calls.keys().next().value as string);
        this.activity(chat, turn, { kind: "tool", tool: event.toolName, detail: toolDetail(event.toolName) }, false);
        chat.bus.emit({ type: "tool.call", callId: event.toolCallId, name: event.toolName, ...(widget ? { widget } : {}) }, turn.turnId);
        return;
      }
      case "tool_execution_end": {
        this.toolEnded(chat, turn, event);
        return;
      }
      case "compaction_start":
        this.activity(chat, turn, { kind: "compacting", detail: "Compacting the conversation" }, false);
        return;
      case "compaction_end": {
        const changes = chat.syncRows();
        const note = changes.find((change) => change.row.kind === "note" && change.row.rowId.startsWith("compaction:"));
        if (note) chat.bus.emit({ type: "compaction.done", rowId: note.row.rowId }, turn.turnId);
        return;
      }
      case "auto_retry_start":
        this.activity(chat, turn, { kind: "retrying", detail: "Retrying" }, false);
        return;
      default:
        return;
    }
  }

  private activity(chat: ChatRuntime, turn: RunningTurn, activity: Activity, quiet: boolean): void {
    turn.activity = activity;
    if (quiet && Date.now() - turn.thinkingEmittedAt < 500 && turn.thinkingEmittedAt !== 0) return;
    if (activity.kind === "thinking") turn.thinkingEmittedAt = Date.now();
    chat.bus.emit({ type: "activity", ...activity }, turn.turnId);
  }

  private toolEnded(chat: ChatRuntime, turn: RunningTurn, event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    const details = (event.result as { details?: unknown } | undefined)?.details as Record<string, unknown> | undefined;
    const searchResults = Array.isArray(details?.searchResults) ? details?.searchResults : undefined;
    chat.syncRows();
    chat.bus.emit({
      type: "tool.result",
      callId: event.toolCallId,
      name: event.toolName,
      isError: event.isError === true,
      ...(searchResults ? { searchResults } : {}),
    }, turn.turnId);
    if (event.toolName === "find_tools") chat.registerPicked();
    const question = details?.question as { requestId?: string; prompt?: string; options?: unknown; allowFreeform?: boolean } | undefined;
    if (event.toolName === "ask" && !event.isError && question && typeof question.requestId === "string" && typeof question.prompt === "string") {
      const data = {
        turnId: turn.turnId,
        requestId: question.requestId,
        prompt: question.prompt,
        options: Array.isArray(question.options) ? question.options : [],
        allowFreeform: question.allowFreeform === true,
      };
      chat.appendCustom(UB.question, data);
      this.host.index.update(chat.chatId, { questionOpen: true }, { touch: false });
      chat.openQuestion = { requestId: data.requestId, prompt: data.prompt, options: data.options as never, allowFreeform: data.allowFreeform };
      chat.bus.emit({ type: "input.requested", requestId: data.requestId, kind: "question", prompt: data.prompt, options: data.options, allowFreeform: data.allowFreeform }, turn.turnId);
    }
  }

  // --- boot --------------------------------------------------------------------------

  /**
   * Closes what the previous process left (SPEC 5.5.10): a turn that was cut
   * off gets an `interrupted` failure and, when it died in a tool, the tool
   * results the model's next request needs; a message that was waiting behind
   * it becomes an unsent row. Nothing here throws on one bad chat.
   */
  recoverInterrupted(): void {
    const left = this.host.ledger.leftovers();
    for (const record of left.turns) {
      try {
        if (!this.host.index.get(record.chatId)) continue;
        const chat = this.host.chat(record.chatId);
        const live = chat.ensureLive();
        this.repairDanglingToolCalls(live.sm);
        chat.appendCustom(UB.failure, { turnId: record.turnId, code: "interrupted", detail: "The app stopped while this was running." } satisfies FailureData);
        chat.appendCustom(UB.turnEnd, { turnId: record.turnId, outcome: "interrupted" } satisfies TurnEndData);
        this.recordLastTurn(chat, record.turnId, "failed");
        removeSessionGrant(record.chatId);
      } catch (error) {
        console.error(JSON.stringify({ event: "recover_failed", chatId: record.chatId, turnId: record.turnId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    for (const record of left.queued) {
      try {
        if (!this.host.index.get(record.chatId)) continue;
        const chat = this.host.chat(record.chatId);
        chat.appendCustom(UB.queuedDrop, { turnId: record.turnId, clientId: record.clientId, reason: "interrupted" } satisfies QueuedDropData);
      } catch (error) {
        console.error(JSON.stringify({ event: "recover_failed", chatId: record.chatId, clientId: record.clientId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    this.host.ledger.clear();
    for (const chat of this.host.runtimes()) chat.evict();
  }

  /** A tool call with no result would make the router refuse the next request. */
  private repairDanglingToolCalls(sm: { getBranch(): SessionEntry[]; appendMessage(message: never): string }): void {
    const branch = sm.getBranch();
    let assistantAt = -1;
    for (let at = branch.length - 1; at >= 0; at -= 1) {
      const entry = branch[at];
      if (entry.type === "message" && (entry.message as unknown as { role?: string }).role === "assistant") {
        assistantAt = at;
        break;
      }
    }
    if (assistantAt === -1) return;
    const assistant = (branch[assistantAt] as Extract<SessionEntry, { type: "message" }>).message as unknown as { content?: unknown };
    if (!Array.isArray(assistant.content)) return;
    const calls = (assistant.content as { type?: string; id?: string; name?: string }[]).filter((block) => block.type === "toolCall" && block.id);
    if (calls.length === 0) return;
    const answered = new Set<string>();
    for (const entry of branch.slice(assistantAt + 1)) {
      if (entry.type === "message") {
        const message = entry.message as unknown as { role?: string; toolCallId?: string };
        if (message.role === "toolResult" && message.toolCallId) answered.add(message.toolCallId);
      }
    }
    for (const call of calls) {
      if (answered.has(call.id as string)) continue;
      sm.appendMessage({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name ?? "tool",
        content: [{ type: "text", text: "The app stopped before this finished. Check what happened before you continue." }],
        isError: true,
        timestamp: Date.now(),
      } as never);
    }
  }
}

export type { AgentSession };

import { readProviderStore } from "../../shared/providers.ts";
import { peekShell } from "../../shared/shell-io.ts";
import { removeSessionGrant } from "../../shared/workspace-store.ts";
import type { RowInput } from "../lib/tool.ts";
import { installEngineApi } from "./api.ts";
import { clip, PREVIEW_MAX, type ChatMeta } from "./chats.ts";
import { admission } from "../../shared/admission.ts";
import { TurnBodyError } from "../../shared/turn-input.ts";
import { tryReadRoutinesStore } from "../../shared/routines-store.ts";
import { estimateTokens } from "../../shared/context-blocks.ts";
import { basePromptFor } from "./context.ts";
import type { Subscription } from "./events.ts";
import type { Deps } from "./deps.ts";
import { EngineHost, PI_VERSION_STRING, type HostOptions } from "./pi-host.ts";
import { EngineError, type Activity, type EngineEvent, type Row } from "./protocol.ts";
import { RoutineScheduler, type RoutineOptions } from "./routines.ts";
import { TurnRunner } from "./turns.ts";

/**
 * The engine: one host, the turn runner, the routine scheduler, and the
 * operations the HTTP routes call (SPEC 6). http.ts only translates requests
 * into these methods.
 */

export type EngineOptions = HostOptions & { routines?: RoutineOptions };

export type ChatListItem = { chatId: string; title: string; preview: string; routineId: string | null; updatedAt: string };

export type RowsPage = {
  rows: Row[];
  nextBefore: string | null;
  tailSeq?: number;
  epoch?: string;
  running?: { turnId: string; startedAt: string; rowId?: string; partialText: string; activity: Activity } | null;
  queued?: { clientId: string; text: string }[];
  openQuestion?: { requestId: string; prompt: string; options: unknown[]; allowFreeform: boolean } | null;
};

export type StatusChat = {
  chatId: string;
  running: { turnId: string; activity: Activity } | null;
  waitingOnOwner: "question" | "approval" | null;
  replyReadySince: string | null;
  lastTurn: { turnId: string; outcome: string; endedAt: string } | null;
};

const DAY_MS = 86_400_000;
/** How long a delete waits for the workspace store's lock. */
const GRANT_WAIT_MS = 50;
const SEARCH_BUDGET_MS = 2_000;

export class Engine {
  readonly host: EngineHost;
  readonly turns: TurnRunner;
  readonly routines: RoutineScheduler;
  private routinesUnreadable = false;

  private constructor(host: EngineHost, options: EngineOptions) {
    this.host = host;
    this.turns = new TurnRunner(host);
    this.routines = new RoutineScheduler(this, options.routines);
  }

  /**
   * Boots (SPEC 5.1): stale approval cards expire, turns the last process
   * left running are closed, old trash is purged, the routine timer starts.
   */
  static async boot(options: EngineOptions): Promise<Engine> {
    const host = await EngineHost.create(options);
    const engine = new Engine(host, options);
    host.approvals.invalidateOnRestart();
    host.index.purgeTrash();
    engine.turns.recoverInterrupted();
    installEngineApi({
      appendRow: async (botId, chatId, row) => engine.fileRow(botId, chatId, row),
      systemTurn: async (botId, key, text, note) => engine.systemTurn(botId, key, text, note),
      runRoutine: async (routineId) => engine.routines.runNow(routineId),
      botContext: async (botId) => engine.botContext(botId),
    });
    engine.sweepRoutineLinks();
    host.startSweeper();
    engine.routines.start();
    return engine;
  }

  get epoch(): string {
    return this.host.epoch;
  }

  health(): { epoch: string; pi: string } {
    return { epoch: this.host.epoch, pi: PI_VERSION_STRING };
  }

  async close(): Promise<void> {
    this.host.stopping = true;
    this.routines.stop();
    // Not Stop: a shutdown is an interruption, recorded as one by the next boot.
    for (const chat of this.host.runtimes()) this.turns.shutdown(chat.chatId);
    // Give the aborted turns a moment to write their last entries.
    const deadline = Date.now() + 5_000;
    while (this.host.runtimes().some((chat) => chat.turn) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.host.close();
  }

  // --- bots and the current chat -------------------------------------------------

  private requireBot(botId: string) {
    const bot = peekShell()?.bots.find((item) => item.id === botId);
    if (!bot) throw new EngineError(404, "bot_not_found");
    return bot;
  }

  private currentChatId(botId: string): string | null {
    return this.host.current.get(botId);
  }

  private makeCurrent(botId: string, chatId: string | null, preview: string): void {
    this.host.current.set(botId, chatId, preview);
  }

  /** The chat a row or a system turn without a chat id belongs to: the bot's current one, else a fresh one. */
  currentOrNewChat(botId: string): string {
    this.requireBot(botId);
    const current = this.currentChatId(botId);
    if (current && this.host.index.get(current)) return current;
    const meta = this.host.index.create({ botId });
    this.makeCurrent(botId, meta.chatId, "");
    return meta.chatId;
  }

  // --- chats -----------------------------------------------------------------------

  /**
   * A chat that belonged to a routine which is gone is an ordinary chat again:
   * nothing else clears the link when the owner deletes the routine.
   */
  sweepRoutineLinks(): void {
    const linked = this.host.index.all().filter((meta) => meta.routineId !== null);
    if (linked.length === 0) return;
    // A store that cannot be read says nothing about which routines exist: unlink nothing.
    const store = tryReadRoutinesStore();
    if (!store) {
      if (!this.routinesUnreadable) console.error(JSON.stringify({ event: "routines_unreadable_sweep_skipped" }));
      this.routinesUnreadable = true;
      return;
    }
    this.routinesUnreadable = false;
    const alive = new Set(store.routines.map((routine) => routine.id));
    for (const meta of linked) {
      if (!alive.has(meta.routineId as string)) this.host.index.update(meta.chatId, { routineId: null }, { touch: false });
    }
  }

  listChats(query: { botId?: string; before?: string; limit?: number; includeFixtures?: boolean }): { current: string | null; chats: ChatListItem[]; nextBefore: string | null } {
    this.sweepRoutineLinks();
    const page = this.host.index.list(query);
    return {
      current: query.botId ? this.currentChatId(query.botId) : null,
      chats: page.chats.map((meta) => ({ chatId: meta.chatId, title: meta.title, preview: meta.preview, routineId: meta.routineId, updatedAt: meta.updatedAt })),
      nextBefore: page.nextBefore,
    };
  }

  createChat(botId: string): { chatId: string } {
    this.requireBot(botId);
    const meta = this.host.index.create({ botId });
    this.makeCurrent(botId, meta.chatId, "");
    return { chatId: meta.chatId };
  }

  renameChat(chatId: string, title: string): void {
    this.host.index.rename(chatId, title);
  }

  deleteChat(chatId: string): { current: string | null } {
    const meta = this.host.index.require(chatId);
    const chat = this.host.chat(chatId);
    if (chat.turn || chat.queue.length > 0) throw new EngineError(409, "chat_busy");
    // The grant goes first, with a short wait: a busy store refuses the delete (retryable) before anything is removed.
    try {
      removeSessionGrant(chatId, undefined, GRANT_WAIT_MS);
    } catch (error) {
      if (error instanceof Error && error.message === "workspace_locked") throw new EngineError(503, "workspace_store_busy", { retryable: true });
      throw error;
    }
    this.host.approvals.expireSession(chatId);
    this.host.forget(chatId);
    this.host.index.remove(chatId);
    if (meta.routineId) {
      try {
        this.host.deps.setRoutineChat(meta.routineId, null);
      } catch (error) {
        // The routine's stale chat id heals on the next sweep or run; the delete must finish.
        console.error(JSON.stringify({ event: "routine_unlink_failed", routineId: meta.routineId, chatId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (this.host.openChatId === chatId) this.host.openChatId = null;
    let current = this.currentChatId(meta.botId);
    if (current === chatId) {
      const next = this.host.index.newest(meta.botId);
      current = next?.chatId ?? null;
      this.makeCurrent(meta.botId, current, next?.preview ?? "");
    }
    return { current };
  }

  openChat(chatId: string): void {
    const meta = this.host.index.require(chatId);
    this.host.openChatId = chatId;
    this.host.chat(chatId).replyReadySince = null;
    if (this.currentChatId(meta.botId) !== chatId) this.makeCurrent(meta.botId, chatId, meta.preview);
  }

  /**
   * Titles and previews first, then the text of each chat's rows, newest chats
   * first, within a time budget. Every hit names a row: the matching one, or the
   * chat's last row when only the title or preview matched.
   */
  searchChats(query: string, limit = 50, budgetMs = SEARCH_BUDGET_MS): { hits: { chatId: string; rowId: string; title: string; snippet: string; at: string }[] } {
    const needle = query.trim().toLowerCase();
    if (needle === "") return { hits: [] };
    const cap = Math.min(Math.max(limit, 1), 200);
    const hits: { chatId: string; rowId: string; title: string; snippet: string; at: string }[] = [];
    const chats = this.host.index.all().filter((meta) => !meta.fixture).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const deadline = Date.now() + budgetMs;
    const seen = new Set<string>();
    for (const meta of chats) {
      if (hits.length >= cap || Date.now() >= deadline) break;
      const inTitle = meta.title.toLowerCase().includes(needle);
      if (!inTitle && !meta.preview.toLowerCase().includes(needle)) continue;
      try {
        const last = this.peekRows(meta.chatId, (rows) => rows[rows.length - 1]);
        if (!last) continue;
        hits.push({ chatId: meta.chatId, rowId: last.rowId, title: meta.title, snippet: clip(inTitle ? meta.title : meta.preview, PREVIEW_MAX), at: meta.updatedAt });
        seen.add(meta.chatId);
      } catch {
        // A chat that cannot be read has nothing to search; it shows as unreadable when opened.
      }
    }
    for (const meta of chats) {
      if (hits.length >= cap || Date.now() >= deadline) break;
      if (seen.has(meta.chatId)) continue;
      try {
        const row = this.peekRows(meta.chatId, (rows) => {
          for (let at = rows.length - 1; at >= 0; at -= 1) {
            const candidate = rows[at];
            if ((candidate.kind === "user" || candidate.kind === "assistant") && candidate.text.toLowerCase().includes(needle)) return candidate;
          }
          return undefined;
        });
        if (row && (row.kind === "user" || row.kind === "assistant")) {
          const at = row.text.toLowerCase().indexOf(needle);
          const start = Math.max(0, at - 40);
          hits.push({ chatId: meta.chatId, rowId: row.rowId, title: meta.title, snippet: clip(row.text.slice(start, start + PREVIEW_MAX), PREVIEW_MAX), at: row.at });
        }
      } catch {
        // As above.
      }
    }
    return { hits };
  }

  /**
   * Reads a chat's rows and leaves the engine as it found it: a chat that was
   * not loaded is evicted again, and one that had no runtime at all loses the
   * runtime it got for the read.
   */
  private peekRows<T>(chatId: string, read: (rows: Row[]) => T): T {
    const hadRuntime = this.host.hasRuntime(chatId);
    const chat = this.host.chat(chatId);
    const wasLive = chat.live !== null;
    try {
      return read(chat.ensureCurrent().rows.rows);
    } finally {
      if (!wasLive && !chat.turn) chat.evict();
      if (!hadRuntime && !chat.turn && chat.queue.length === 0 && chat.bus.subscriberCount === 0) this.host.forget(chatId);
    }
  }

  // --- rows and events ---------------------------------------------------------------

  rows(chatId: string, query: { before?: string; limit?: number }): RowsPage {
    const chat = this.host.chat(chatId);
    const limit = Math.min(Math.max(query.limit ?? 60, 1), 200);
    let all: Row[];
    try {
      all = chat.ensureCurrent().rows.view();
    } catch (error) {
      if (!(error instanceof EngineError) || error.code !== "chat_unreadable") throw error;
      all = [{
        rowId: `unreadable:${chatId}`,
        kind: "failure",
        turnId: null,
        at: chat.meta.updatedAt,
        code: "unreadable",
        detail: "This chat's file can't be read.",
        messageKept: true,
      }];
    }
    let end = all.length;
    if (query.before) {
      const at = all.findIndex((row) => row.rowId === query.before);
      if (at === -1) throw new EngineError(400, "before_unknown");
      end = at;
    }
    const start = Math.max(0, end - limit);
    const rows = all.slice(start, end);
    const nextBefore = start > 0 ? rows[0].rowId : null;
    if (query.before) return { rows, nextBefore };
    const turn = chat.turn;
    return {
      rows,
      tailSeq: chat.bus.tailSeq,
      epoch: this.host.epoch,
      running: turn
        ? {
            turnId: turn.turnId,
            startedAt: new Date(turn.startedAt).toISOString(),
            // The streaming message's row, so a reload mid-turn puts the partial text on the right row.
            ...(turn.streamRowId ? { rowId: turn.streamRowId } : {}),
            partialText: turn.streamRowId ? turn.partialText : "",
            activity: turn.activity ?? { kind: "thinking" },
          }
        : null,
      queued: chat.queue.filter((item) => item.persisted).map((item) => ({ clientId: item.clientId, text: item.spec.text })),
      openQuestion: chat.openQuestion,
      nextBefore,
    };
  }

  subscribe(chatId: string, send: (event: EngineEvent) => void, options: { after?: number; epoch?: string }): Subscription {
    const chat = this.host.chat(chatId);
    chat.touch();
    // Open (not just known): a stream means the app has this chat on screen, so its rows stay cached.
    try { chat.ensureLive(); } catch { /* an unreadable chat still streams its (empty) events */ }
    return chat.bus.subscribe(send, { ...options, running: chat.turn ? { turnId: chat.turn.turnId } : null });
  }

  // --- status --------------------------------------------------------------------------

  status(): { epoch: string; chats: StatusChat[] } {
    const pending = new Map<string, number>();
    for (const card of this.host.approvals.listPending()) pending.set(card.chatId, (pending.get(card.chatId) ?? 0) + 1);
    const now = this.host.now().getTime();
    const chats: StatusChat[] = [];
    const runtimes = new Map(this.host.runtimes().map((item) => [item.chatId, item]));
    for (const meta of this.host.index.all()) {
      if (meta.fixture) continue;
      const runtime = runtimes.get(meta.chatId);
      const running = runtime?.turn ? { turnId: runtime.turn.turnId, activity: runtime.turn.activity ?? { kind: "thinking" as const } } : null;
      const waitingOnOwner = meta.questionOpen ? "question" : pending.has(meta.chatId) ? "approval" : null;
      const replyReadySince = runtime?.replyReadySince ?? null;
      const lastTurn = meta.lastTurn;
      const recent = lastTurn !== null && now - Date.parse(lastTurn.endedAt) <= DAY_MS;
      if (running || waitingOnOwner || replyReadySince || lastTurn?.outcome === "failed" || recent) {
        chats.push({ chatId: meta.chatId, running, waitingOnOwner, replyReadySince, lastTurn });
      }
    }
    return { epoch: this.host.epoch, chats };
  }

  // --- turns -----------------------------------------------------------------------------

  submitTurn(chatId: string, raw: unknown): { turnId?: string; queued?: true } {
    let body: ReturnType<Deps["parseTurnBody"]>;
    try {
      body = this.host.deps.parseTurnBody(raw);
    } catch (error) {
      if (error instanceof TurnBodyError) throw new EngineError(400, error.code);
      throw error;
    }
    const result = this.turns.submitOwner(chatId, body);
    return result.queued ? { queued: true } : { turnId: result.turnId };
  }

  cancel(chatId: string): void {
    this.host.index.require(chatId);
    this.turns.cancel(chatId);
  }

  // --- the internal routes (SPEC 6.5) ------------------------------------------------------------

  /** Files a row in a chat (default: the bot's current one), idempotent by `row.key`. */
  fileRow(botId: string, chatId: string | null, row: RowInput & { source?: string }): { chatId: string; rowId: string } {
    const target = chatId ?? this.currentOrNewChat(botId);
    const meta = this.host.index.require(target);
    if (meta.botId !== botId) throw new EngineError(404, "chat_not_found");
    this.host.chat(target).appendRow(row);
    return { chatId: target, rowId: row.key };
  }

  /** Connect-card resume and the like: a turn the app did not type (D19). Idempotent by `key`. */
  systemTurn(botId: string, key: string, text: string, note?: string): { chatId: string; turnId: string | null; queued: boolean } {
    const chatId = this.currentOrNewChat(botId);
    if (note) this.host.chat(chatId).appendRow({ key: `note:system-turn-${key}`, kind: "note", text: note, source: "connect" });
    const result = this.turns.submitInternal(chatId, "system", `system:${key}`, text);
    return { chatId, turnId: result.turnId, queued: result.queued };
  }

  /** What `/api/bots/context` shows: the bot's instructions against its model's window. */
  botContext(botId: string): { windowTokens: number; instructionTokens: number; envelopeTokens: number } {
    const bot = this.requireBot(botId);
    const notes = this.host.deps.notesBlockFor(botId);
    const declarations = this.host.deps.allTools().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const verdict = admission({
      bot,
      store: readProviderStore(),
      notesChars: notes.length,
      promptChars: basePromptFor(this.host.deps.listSkills()).length,
      toolSchemaChars: JSON.stringify(declarations).length,
    });
    return { windowTokens: verdict.windowTokens, instructionTokens: estimateTokens(bot.description.length), envelopeTokens: verdict.tokens };
  }

  /** The index entry for a chat, for the routine scheduler. */
  meta(chatId: string): ChatMeta | undefined {
    return this.host.index.get(chatId);
  }
}

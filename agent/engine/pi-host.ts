import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalStore } from "../lib/approvals.ts";
import type { CtxResolver, RowInput, ToolCtx } from "../lib/tool.ts";
import type { OkSnapshot } from "../lib/turn-snapshot.ts";
import type { ModelSelection } from "../../shared/session-selection.ts";
import { ChatIndex, clip, PREVIEW_MAX, type ChatMeta } from "./chats.ts";
import { contextNeedsSending } from "./context.ts";
import { CurrentChat } from "./current-chat.ts";
import type { Deps } from "./deps.ts";
import { ChatBus } from "./events.ts";
import { overrideKey, RouterProvider, PROVIDER_ID } from "./provider.ts";
import { EngineError, UB, type Activity, type Attachment, type OpenQuestion, type Row, type TurnOrigin } from "./protocol.ts";
import { RunningLedger } from "./queue.ts";
import { RowBuilder, type RowChange } from "./rows.ts";

/**
 * The only file that talks to Pi (SPEC D1). It owns the model runtime, the
 * router provider, the session pool and, for each chat that has been touched
 * since boot, a ChatRuntime: the state that outlives an AgentSession (event
 * bus, host queue, running turn, open question, row cache).
 */

export const PI_VERSION_STRING: string = PI_VERSION;

/** Rows the app learns about from a dedicated event, so they get no `row` event. */
const NO_ROW_EVENT = new Set<Row["kind"]>(["user", "assistant", "question"]);

export type TurnSpec = {
  /** What the owner typed: the row text. */
  text: string;
  /** What goes to the model: the text with text attachments inlined in their fence. */
  promptText: string;
  images: { type: "image"; data: string; mimeType: string }[];
  attachments: Attachment[];
};

export type RunningTurn = {
  turnId: string;
  origin: TurnOrigin;
  clientId?: string;
  retry: boolean;
  spec: TurnSpec;
  snapshot: OkSnapshot;
  /** The hidden "This turn" message this turn would send. */
  contextText: string;
  systemPrompt: string;
  /** The turn's own abort, for the routine budget; Stop goes through `session.abort()`. */
  abort: AbortController;
  cancelRequested: boolean;
  abortReason: "cancelled" | "budget" | "idle" | "shutdown" | null;
  startedAt: number;
  partialText: string;
  streamRowId: string | null;
  activity: Activity | null;
  assistantCount: number;
  lastEventAt: number;
  thinkingEmittedAt: number;
  /** Pi started the run (its `agent_start`): a rejection before this is a refusal, after it an engine error. */
  agentStarted: boolean;
  lastAssistant: { stopReason?: string; errorMessage?: string } | null;
  userEmitted: boolean;
  done: Promise<TurnResult>;
  finish: (result: TurnResult) => void;
};

export type TurnResult = {
  turnId: string;
  outcome: "completed" | "cancelled" | "failed";
  failure?: { code: string; detail: string };
};

export type QueuedTurn = {
  turnId: string;
  origin: TurnOrigin;
  clientId: string;
  spec: TurnSpec;
  /** Owner messages are persisted as `ub.queued`; routine and system ones live in memory only. */
  persisted: boolean;
  /** A row filed when this turn starts (a routine run's "ran" note). */
  startNote?: RowInput;
  /** Starts that found the workspace store busy (see TurnRunner.startNext). */
  busyTries?: number;
  done: Promise<TurnResult>;
  finish: (result: TurnResult) => void;
};

type Live = {
  sm: SessionManager;
  rows: RowBuilder;
  syncedLeaf: string | null;
  session: AgentSession | null;
  /** What the session was created for, so a changed prompt or model recreates it. */
  systemPrompt: string | null;
  model: unknown;
  pi: ExtensionAPI | null;
  declared: Set<string>;
  unsubscribe: (() => void) | null;
  /** The picked MCP tools' listings are refreshed once per time a chat is opened. */
  pickedRefreshed: boolean;
};

export type HostOptions = {
  /** `<stateRoot>/engine` */
  engineDir: string;
  routerBaseUrl: string;
  routerToken: () => string;
  deps: Deps;
  approvals: Pick<ApprovalStore, "expireSession" | "invalidateOnRestart" | "listPending">;
  now?: () => Date;
  /** Test seams under the router fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal | null | undefined) => Promise<void>;
  /** Pi's agent-level retry back-off, 2 s unless a test shortens it. */
  retryBaseDelayMs?: number;
  /** At most this many idle sessions stay alive. */
  idleSessionLimit?: number;
  /** An idle chat nobody has open is dropped after this long. */
  idleMs?: number;
};

export type SessionEventHandler = (chat: ChatRuntime, event: AgentSessionEvent) => void;

function lastAssistantToolNames(sm: { getLeafEntry(): SessionEntry | undefined; getEntry(id: string): SessionEntry | undefined }): string[] {
  let entry = sm.getLeafEntry();
  while (entry) {
    if (entry.type === "message") {
      const message = entry.message as unknown as { role?: string; content?: unknown };
      if (message.role === "assistant") {
        if (!Array.isArray(message.content)) return [];
        return (message.content as { type?: string; name?: string }[])
          .filter((block) => block.type === "toolCall" && typeof block.name === "string")
          .map((block) => block.name as string);
      }
    }
    entry = entry.parentId ? sm.getEntry(entry.parentId) : undefined;
  }
  return [];
}

export class ChatRuntime {
  readonly bus: ChatBus;
  turn: RunningTurn | null = null;
  queue: QueuedTurn[] = [];
  live: Live | null = null;
  replyReadySince: string | null = null;
  lastActive: number;
  /** What a tool call was, for the widget row the app files after the turn is over. */
  readonly calls = new Map<string, { turnId: string; widget: { connectionId: string; toolName: string } | null }>();
  /** The question waiting for the owner's next message, from the rows or `ask`. */
  openQuestion: OpenQuestion | null = null;

  readonly host: EngineHost;
  readonly chatId: string;

  constructor(host: EngineHost, chatId: string) {
    this.host = host;
    this.chatId = chatId;
    this.bus = new ChatBus(chatId, host.epoch, host.now);
    this.lastActive = host.now().getTime();
  }

  get meta(): ChatMeta {
    return this.host.index.require(this.chatId);
  }

  get botId(): string {
    return this.meta.botId;
  }

  touch(): void {
    this.lastActive = this.host.now().getTime();
  }

  // --- the session file and the row cache -----------------------------------

  /** Opens the session file (or starts a new one) and builds the rows. No AgentSession yet. */
  ensureLive(): Live {
    if (this.live) return this.live;
    const meta = this.meta;
    const dir = this.host.index.sessionDir(meta.botId);
    mkdirSync(dir, { recursive: true });
    let sm: SessionManager;
    if (meta.sessionFile && existsSync(meta.sessionFile)) {
      try {
        sm = SessionManager.open(meta.sessionFile, dir, this.host.piCwd);
      } catch (error) {
        throw new EngineError(409, "chat_unreadable", { detail: error instanceof Error ? error.message : String(error) });
      }
    } else {
      // A new chat, or one whose recorded file was never written (a crash before the first message): empty.
      sm = SessionManager.create(this.host.piCwd, dir, { id: meta.chatId });
    }
    // The index names the file from the start, though Pi writes it only with the first message: a crash
    // during the first response must find it again at boot.
    const file = sm.getSessionFile();
    if (file && meta.sessionFile !== file) this.host.index.update(this.chatId, { sessionFile: file }, { touch: false });
    const rows = RowBuilder.build(sm.getBranch());
    this.live = {
      sm,
      rows,
      syncedLeaf: sm.getLeafId(),
      session: null,
      systemPrompt: null,
      model: null,
      pi: null,
      declared: new Set(),
      unsubscribe: null,
      pickedRefreshed: false,
    };
    this.openQuestion = rows.openQuestion();
    this.restoreTodos();
    return this.live;
  }

  /**
   * `ensureLive` plus a sync. Pi emits `message_end` before it appends the message to the
   * session, so the cache can lag the file while a tool runs: anything that reads the rows
   * (a page, a duplicate-send check, search) goes through here.
   */
  ensureCurrent(): Live {
    const live = this.ensureLive();
    this.syncRows();
    return live;
  }

  /** Pulls entries the session added since the last look into the row cache and emits what changed. */
  syncRows(): RowChange[] {
    const live = this.live;
    if (!live) return [];
    const sm = live.sm;
    const leaf = sm.getLeafId();
    if (leaf === live.syncedLeaf) return [];
    const fresh: SessionEntry[] = [];
    let found = live.syncedLeaf === null;
    for (let id = leaf; id !== null;) {
      if (id === live.syncedLeaf) {
        found = true;
        break;
      }
      const entry = sm.getEntry(id);
      if (!entry) break;
      fresh.push(entry);
      id = entry.parentId;
    }
    if (!found) {
      // The leaf moved to another branch (Retry): the cache is rebuilt, nothing is emitted.
      live.rows = RowBuilder.build(sm.getBranch());
      live.syncedLeaf = leaf;
      this.openQuestion = live.rows.openQuestion();
      this.restoreTodos();
      return [];
    }
    const changes: RowChange[] = [];
    for (let at = fresh.length - 1; at >= 0; at -= 1) changes.push(...live.rows.push(fresh[at]));
    live.syncedLeaf = leaf;
    for (const change of changes) {
      // The app already streamed this row (message.delta, message.final): it is told to drop it.
      if (change.type === "removed") this.bus.emit({ type: "row.removed", rowId: change.row.rowId }, change.row.turnId ?? undefined);
      else if (!NO_ROW_EVENT.has(change.row.kind) && change.type !== "updated") {
        this.bus.emit({ type: "row", row: change.row }, change.row.turnId ?? undefined);
      }
    }
    return changes;
  }

  /**
   * The tool call with this id: from the calls seen since boot, else read off
   * the branch (a widget row can be filed after a restart).
   */
  private callOf(callId: string): { turnId: string; widget: { connectionId: string; toolName: string } | null } | undefined {
    const known = this.calls.get(callId);
    if (known) return known;
    const live = this.live;
    if (!live) return undefined;
    const branch = live.sm.getBranch();
    for (let at = branch.length - 1; at >= 0; at -= 1) {
      const entry = branch[at];
      if (entry.type !== "message") continue;
      const message = entry.message as unknown as { role?: string; content?: unknown };
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const block = (message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[])
        .find((item) => item.type === "toolCall" && item.id === callId);
      if (!block || typeof block.name !== "string") continue;
      let turnId = "";
      for (let back = at; back >= 0; back -= 1) {
        const earlier = branch[back];
        if (earlier.type === "custom" && earlier.customType === UB.turnStart) {
          turnId = (earlier.data as { turnId: string }).turnId;
          break;
        }
      }
      const widget = this.host.deps.widgetForCall(block.name, block.arguments ?? {});
      return { turnId, widget: widget ? { connectionId: widget.connectionId, toolName: widget.toolName } : null };
    }
    return undefined;
  }

  /** The todo list follows the branch: it is the last `todo` result on it, or empty (Pi's pattern for tool state). */
  restoreTodos(): void {
    const live = this.live;
    if (!live) return;
    const branch = live.sm.getBranch();
    let todos: unknown[] = [];
    for (let at = branch.length - 1; at >= 0; at -= 1) {
      const entry = branch[at];
      if (entry.type !== "message") continue;
      const message = entry.message as unknown as { role?: string; toolName?: string; details?: { todos?: unknown } };
      if (message.role === "toolResult" && message.toolName === "todo" && Array.isArray(message.details?.todos)) {
        todos = message.details.todos;
        break;
      }
    }
    this.host.deps.restoreTodos(this.chatId, todos);
  }

  /**
   * Writes the session file now. Pi creates it only once a user or assistant
   * message exists, so a new chat's first turn marker (and the owner's words in
   * it) would be lost to a refusal or a crash before then. Pi 1.4.0 has no public
   * call for this; the guard fails loudly if an upgrade moves what it relies on
   * (the first-message test in contract-turns.test.ts then fails too).
   */
  flushSession(): void {
    const sm = this.ensureLive().sm as unknown as { flushed?: boolean; persist?: boolean; _rewriteFile?: () => void };
    if (sm.flushed || sm.persist === false) return;
    if (typeof sm._rewriteFile !== "function") throw new Error("pi_session_flush_unavailable");
    sm._rewriteFile();
    sm.flushed = true;
  }

  /** Appends a custom entry to the session and syncs the rows. Returns the entry id. */
  appendCustom(customType: string, data: unknown): string {
    const live = this.ensureLive();
    const id = live.sm.appendCustomEntry(customType, data);
    this.syncRows();
    return id;
  }

  /** Files a tool's row: a `ub.row` entry plus a `row` event, idempotent by key. */
  appendRow(row: RowInput): boolean {
    const live = this.ensureLive();
    if (live.rows.keys.has(row.key)) return false;
    const call = row.kind === "widget" ? this.callOf(row.callId) : undefined;
    if (row.kind === "widget" && !call?.widget && !("connectionId" in row)) throw new EngineError(404, "widget_call_unknown");
    // A widget is filed after its turn, usually while the next one runs: it belongs to the turn that made the call.
    const filedIn = row.kind === "widget" ? (call?.turnId || this.turn?.turnId || null) : (this.turn?.turnId ?? call?.turnId ?? null);
    // The app names the widget by its call; the row also says which connection and tool drew it.
    const filed = row.kind === "widget" && call?.widget ? { ...call.widget, ...row } : row;
    this.appendCustom(UB.row, { ...filed, turnId: filedIn });
    this.host.index.update(this.chatId, {});
    return true;
  }

  // --- the AgentSession -------------------------------------------------------

  /** The context one tool call runs with (agent/lib/tool.ts). */
  readonly resolveCtx: CtxResolver = (callId, signal) => {
    const turn = this.turn;
    if (!turn) throw new Error("tool_call_without_turn");
    const ctx: ToolCtx = {
      chatId: this.chatId,
      botId: this.botId,
      turnId: turn.turnId,
      callId,
      origin: turn.origin,
      abortSignal: signal ?? turn.abort.signal,
      snapshot: turn.snapshot,
      session: { id: this.chatId, turn: { id: turn.turnId } },
      appendRow: async (row) => { this.appendRow(row); },
    };
    return ctx;
  };

  /**
   * The session for this turn: created on first use, recreated when the system
   * prompt or the model changed (the prompt cache breaks either way, which the
   * spec accepts), reused otherwise.
   */
  async ensureSession(turn: RunningTurn): Promise<AgentSession> {
    const live = this.ensureLive();
    const model = this.host.provider.modelFor(turn.snapshot.selection);
    if (live.session && (live.systemPrompt !== turn.systemPrompt || live.model !== model)) this.disposeSession();
    if (live.session) return live.session;

    const settings = this.host.settingsFor(turn.snapshot.selection);
    const loader = new DefaultResourceLoader({
      cwd: this.host.piCwd,
      agentDir: this.host.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: turn.systemPrompt,
      extensionFactories: [(pi) => this.installExtension(pi, live)],
    });
    await loader.reload();
    if (!live.pickedRefreshed) {
      live.pickedRefreshed = true;
      // Optional: the picks work from whatever the index holds, so a refresh that fails is logged and the chat goes on.
      await this.host.deps.refreshPickedTools(this.chatId).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "picked_refresh_failed", chatId: this.chatId, error: error instanceof Error ? error.message : String(error) }));
      });
    }
    const tools = [...this.host.deps.allTools(), ...this.host.deps.pickedTools(this.chatId)];
    live.declared = new Set(tools.map((tool) => tool.name));
    const { session } = await createAgentSession({
      cwd: this.host.piCwd,
      agentDir: this.host.agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime: this.host.modelRuntime,
      resourceLoader: loader,
      // Never `tools`: an allowlist, even an empty one, filters out our custom tools.
      noTools: "builtin",
      customTools: tools.map((tool) => tool.toPiTool(this.resolveCtx)),
      sessionManager: live.sm,
      settingsManager: settings,
    });
    live.session = session;
    live.systemPrompt = turn.systemPrompt;
    live.model = model;
    live.unsubscribe = session.subscribe((event) => {
      // A fault in our own bookkeeping must not break Pi's loop in the middle of a turn: it is logged, loudly.
      try {
        this.host.onSessionEvent?.(this, event);
      } catch (error) {
        console.error(JSON.stringify({ event: "session_event_failed", chatId: this.chatId, type: event.type, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
      }
    });
    return session;
  }

  disposeSession(): void {
    const live = this.live;
    if (!live?.session) return;
    live.unsubscribe?.();
    live.session.dispose();
    live.session = null;
    live.pi = null;
    live.unsubscribe = null;
    live.systemPrompt = null;
    live.model = null;
    live.declared.clear();
  }

  /** Drops the session, the row cache and the file handle state. The chat reloads from its file next time. */
  evict(): void {
    this.disposeSession();
    this.live = null;
    // The event ring lives as long as someone can use it: nobody attached, nothing to replay.
    if (this.bus.subscriberCount === 0) this.bus.dropRing();
  }

  /** Registers the MCP tools `find_tools` picked since the session started. */
  registerPicked(): void {
    const live = this.live;
    if (!live?.pi) return;
    for (const tool of this.host.deps.pickedTools(this.chatId)) {
      if (live.declared.has(tool.name)) continue;
      live.pi.registerTool(tool.toPiTool(this.resolveCtx) as ToolDefinition);
      live.declared.add(tool.name);
    }
  }

  private installExtension(pi: ExtensionAPI, live: Live): void {
    live.pi = pi;
    // Fail closed (SPEC 5.8, 12): a name nobody registered is refused, and a
    // batch that mixes `ask` with another call is refused whole.
    pi.on("tool_call", (event, ctx) => {
      if (!live.declared.has(event.toolName)) {
        return { block: true, reason: `${event.toolName} is not a tool in this chat.` };
      }
      const batch = lastAssistantToolNames(ctx.sessionManager);
      if (batch.includes("ask") && batch.length > 1) {
        return { block: true, reason: "ask must be the only call in a message. Finish the other work, then ask again." };
      }
      return undefined;
    });
    // "This turn" and the notes ride at the end, as one hidden message, only when they changed.
    pi.on("before_agent_start", (_event, ctx) => {
      const turn = this.turn;
      if (!turn) return undefined;
      if (!contextNeedsSending(ctx.sessionManager.getBranch(), turn.contextText)) return undefined;
      return { message: { customType: UB.context, content: turn.contextText, display: false } };
    });
    pi.on("session_before_compact", (event) => {
      const info = event as { reason?: string; preparation?: { tokensBefore?: number } };
      console.error(JSON.stringify({ event: "compaction", chatId: this.chatId, reason: info.reason ?? null, tokensBefore: info.preparation?.tokensBefore ?? null }));
      return undefined;
    });
  }
}

export class EngineHost {
  readonly epoch = randomUUID();
  readonly index: ChatIndex;
  readonly ledger: RunningLedger;
  readonly deps: Deps;
  /** Each bot's open chat in `shell.json`: written off the request and settle paths. */
  readonly current: CurrentChat;
  readonly approvals: HostOptions["approvals"];
  readonly now: () => Date;
  readonly provider: RouterProvider;
  readonly engineDir: string;
  /** Pi's working directory and its own state folder (SPEC 5.1): both ours, both empty. */
  readonly piCwd: string;
  readonly agentDir: string;
  /** The chat the app named in its newest `POST /open` since boot. */
  openChatId: string | null = null;
  onSessionEvent: SessionEventHandler | null = null;
  /** Set when shutdown begins: no turn starts, and nothing waiting is started in place of a running one. */
  stopping = false;
  private readonly chats = new Map<string, ChatRuntime>();
  private sweepTimer: NodeJS.Timeout | null = null;

  private readonly options: HostOptions;
  readonly modelRuntime: ModelRuntime;

  private constructor(options: HostOptions, modelRuntime: ModelRuntime) {
    this.options = options;
    this.modelRuntime = modelRuntime;
    this.engineDir = options.engineDir;
    this.piCwd = options.engineDir;
    this.agentDir = join(options.engineDir, "pi");
    this.now = options.now ?? (() => new Date());
    this.deps = options.deps;
    this.current = new CurrentChat(options.deps);
    this.approvals = options.approvals;
    this.index = new ChatIndex(options.engineDir, this.now);
    this.ledger = new RunningLedger(join(options.engineDir, "running.json"));
    this.provider = new RouterProvider({
      baseUrl: options.routerBaseUrl,
      token: options.routerToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    modelRuntime.registerNativeProvider(this.provider.provider());
  }

  static async create(options: HostOptions): Promise<EngineHost> {
    const agentDir = join(options.engineDir, "pi");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    // No credentials are stored (the router token comes from the process env at call time),
    // so both files stay absent. Nothing is read from ~/.pi.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "credentials.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    return new EngineHost(options, modelRuntime);
  }

  /** In-memory Pi settings for one session (SPEC 5.2, 5.7). */
  settingsFor(selection: ModelSelection): SettingsManager {
    const model = this.provider.modelFor(selection);
    const window = model.contextWindow;
    return SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 8_192,
        keepRecentTokens: 8_192,
        // Compact at 75% of the model's own window, as before.
        modelOverrides: {
          [overrideKey(selection)]: {
            reserveTokens: Math.max(4_096, Math.floor(0.25 * window)),
            keepRecentTokens: Math.min(20_000, Math.floor(0.25 * window)),
          },
        },
      },
      // Provider-level retries stay 0: routerFetch waits out 429s itself and the router refuses a repeated request id.
      retry: { enabled: true, maxRetries: 2, baseDelayMs: this.options.retryBaseDelayMs ?? 2_000, provider: { maxRetries: 0 } },
      cacheWarming: "off",
      enableInstallTelemetry: false,
      // Nothing project-local is ever trusted: no extension, skill or setting is loaded from a folder.
    }, { projectTrusted: false });
  }

  /** The runtime of a chat in the index. Throws `chat_not_found` otherwise. */
  chat(chatId: string): ChatRuntime {
    this.index.require(chatId);
    let runtime = this.chats.get(chatId);
    if (!runtime) {
      runtime = new ChatRuntime(this, chatId);
      this.chats.set(chatId, runtime);
    }
    return runtime;
  }

  hasRuntime(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  /** The runtimes touched since boot (the status poll walks these). */
  runtimes(): ChatRuntime[] {
    return [...this.chats.values()];
  }

  forget(chatId: string): void {
    const runtime = this.chats.get(chatId);
    runtime?.evict();
    this.chats.delete(chatId);
  }

  // --- the pool ---------------------------------------------------------------

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  /**
   * At most `idleSessionLimit` idle sessions stay alive (oldest first go), and
   * an idle chat nobody has open for `idleMs` is dropped whole. A chat with a
   * running turn, queued messages or entries not yet on disk is never touched.
   */
  sweep(): void {
    const limit = this.options.idleSessionLimit ?? 4;
    const idleMs = this.options.idleMs ?? 15 * 60_000;
    const now = this.now().getTime();
    const idle = this.runtimes()
      .filter((chat) => chat.live && !chat.turn && chat.queue.length === 0)
      .filter((chat) => {
        const file = chat.live?.sm.getSessionFile();
        return !file || existsSync(file);
      })
      .sort((left, right) => left.lastActive - right.lastActive);
    const withSession = idle.filter((chat) => chat.live?.session);
    for (const chat of withSession.slice(0, Math.max(0, withSession.length - limit))) chat.disposeSession();
    for (const chat of idle) {
      if (chat.bus.subscriberCount === 0 && now - chat.lastActive >= idleMs) chat.evict();
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.current.stop();
    for (const chat of this.chats.values()) chat.disposeSession();
  }
}

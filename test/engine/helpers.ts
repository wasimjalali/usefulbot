import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApprovalStore } from "../../agent/lib/approvals.ts";
import { defineTool, toolOutput, type RowInput, type UsefulTool } from "../../agent/lib/tool.ts";
import type { Deps, TurnBody } from "../../agent/engine/deps.ts";
import { parseTurnBody } from "../../shared/turn-input.ts";
import { Engine, type EngineOptions } from "../../agent/engine/engine.ts";
import type { EngineEvent } from "../../agent/engine/protocol.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { currentChatInShell, setCurrentChatInShell } from "../../agent/engine/deps.ts";
import { startFakeRouter, type FakeRouter } from "./fake-router.ts";

/**
 * A whole engine against a fake router: temp state root, one provider
 * connection, the default bot, real stores, the real Pi underneath. Every
 * engine test builds one of these, so what it proves is what the app runs.
 */

export const CONNECTION = "opencode-go:plan";
export const MODEL = "glm-5.3-flash";

const ENV_KEYS = [
  "UB_STATE_ROOT", "UB_ROUTER_DESKTOP_TOKEN", "UB_SHELL_PATH", "UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH",
  "UB_WORKSPACE_STORE_PATH", "UB_ROUTINES_PATH", "UB_APPROVALS_PATH", "UB_SESSION_ID", "UB_TURN_ID", "HOME",
] as const;

export type FakeToolState = {
  picked: UsefulTool[];
  searchCalls: number;
  approvals: ApprovalStore;
};

/** Tools the tests drive. None is named like a Pi built-in. */
export function fakeTools(state: FakeToolState): UsefulTool[] {
  return [
    defineTool({
      name: "echo",
      description: "Echo text back.",
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => `echo:${text}`,
    }),
    defineTool({
      name: "web_search",
      description: "Search the web.",
      inputSchema: z.object({ query: z.string() }),
      execute: () => {
        state.searchCalls += 1;
        return toolOutput(
          [{ type: "text", text: "2 results" }],
          { searchResults: [{ title: "Pi agent harness", url: "https://example.com/pi", snippet: "An embeddable agent loop." }] },
        );
      },
    }),
    defineTool({
      name: "ask",
      description: "Ask the owner a question and stop.",
      inputSchema: z.object({
        prompt: z.string(),
        options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })).optional(),
      }),
      sequential: true,
      execute: ({ prompt, options }, ctx) => toolOutput(
        [{ type: "text", text: "Question shown." }],
        { question: { requestId: `q-${ctx.callId}`, prompt, options: options ?? [{ id: "a", label: "A" }], allowFreeform: true } },
        { terminate: true },
      ),
    }),
    defineTool({
      name: "slow",
      description: "Wait until stopped.",
      inputSchema: z.object({}),
      sequential: true,
      execute: (_input, ctx) => new Promise<string>((_resolve, reject) => {
        const timer = setTimeout(() => _resolve("slow done"), 30_000);
        ctx.abortSignal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      }),
    }),
    defineTool({
      name: "gated",
      description: "Needs an approval card.",
      inputSchema: z.object({}),
      sequential: true,
      execute: async (_input, ctx) => {
        const { id } = state.approvals.request({
          chatId: ctx.chatId,
          botId: ctx.botId,
          turnId: ctx.turnId,
          toolCallId: ctx.callId,
          tool: "bash",
          actionSha256: "0".repeat(64),
          preview: "ls",
        });
        // Races the tool's abort signal, as the real approval wait does.
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            if (state.approvals.get(id)?.status !== "pending") { clearInterval(poll); resolve(); }
          }, 20);
          ctx.abortSignal.addEventListener("abort", () => { clearInterval(poll); reject(new Error("aborted")); }, { once: true });
        });
        return "gated done";
      },
    }),
    defineTool({
      name: "file_row",
      description: "File a row beside the reply.",
      inputSchema: z.object({ row: z.record(z.string(), z.unknown()) }),
      execute: async ({ row }, ctx) => {
        await ctx.appendRow(row as unknown as RowInput);
        return "filed";
      },
    }),
    defineTool({
      name: "find_tools",
      description: "Pick MCP tools.",
      inputSchema: z.object({ query: z.string() }),
      sequential: true,
      execute: () => {
        state.picked.push(defineTool({
          name: "demo__ping",
          description: "Ping the demo server.",
          inputSchema: z.object({}),
          sequential: true,
          execute: () => "pong",
        }));
        return "picked demo__ping";
      },
    }),
  ];
}

export type World = {
  root: string;
  router: FakeRouter;
  engine: Engine;
  state: FakeToolState;
  chats: Map<string, string>;
  /** A new chat for the default bot. */
  newChat(): string;
  /** Sends an owner message and returns the HTTP-shaped result. */
  send(chatId: string, text: string, extra?: Partial<TurnBody>): { turnId?: string; queued?: true };
  /** Resolves once the chat has no running or queued turn. */
  idle(chatId: string, timeoutMs?: number): Promise<void>;
  /** Records a chat's events from now on. */
  record(chatId: string, options?: { after?: number; epoch?: string }): { events: EngineEvent[]; stop(): void };
  close(): Promise<void>;
};

export type WorldOptions = {
  /** The model's context window in tokens (the compaction tests use a small one). */
  window?: number;
  deps?: Partial<Deps>;
  engine?: Partial<EngineOptions>;
  /** Boot over an existing root (a restart). */
  root?: string;
  router?: FakeRouter;
};

function modelRow(window: number) {
  return { id: MODEL, label: MODEL, efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens: window, inputs: ["text", "image"] };
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const root = options.root ?? mkdtempSync(join(tmpdir(), "ub-engine-"));
  process.env.UB_STATE_ROOT = root;
  process.env.UB_ROUTER_DESKTOP_TOKEN = "test-router-token";
  process.env.HOME = join(root, "home");
  const router = options.router ?? await startFakeRouter();

  if (!options.root) {
    writeFileSync(join(root, "providers.json"), JSON.stringify({
      schemaVersion: 2,
      connections: {
        [CONNECTION]: {
          id: CONNECTION,
          providerId: "opencode-go",
          mode: "plan",
          credential: { kind: "key", key: "go-key-12345678" },
          fields: {},
          updatedAt: new Date().toISOString(),
          lastError: null,
        },
      },
      activeConnectionId: CONNECTION,
      selectedModel: MODEL,
      effort: null,
      speed: "standard",
      roles: {},
    }));
    writeFileSync(join(root, "models-cache.json"), JSON.stringify({
      schemaVersion: 3,
      providers: { [CONNECTION]: { fetchedAt: Date.now(), models: [modelRow(options.window ?? 200_000)] } },
    }));
    readShell();
  }

  const approvals = new ApprovalStore(Date.now, join(root, "approvals.json"));
  const state: FakeToolState = { picked: [], searchCalls: 0, approvals };
  const tools = fakeTools(state);
  const restoredTodos: { chatId: string; todos: unknown[] }[] = [];
  const deps: Deps = {
    allTools: () => tools,
    pickedTools: () => state.picked,
    refreshPickedTools: async () => undefined,
    restoreTodos: (chatId, todos) => { restoredTodos.push({ chatId, todos }); },
    widgetForCall: (name, args) => (name === "demo__ping" ? { connectionId: "demo", toolName: "ping", arguments: args } : null),
    listSkills: () => [{ name: "about-useful-bot", description: "Questions about the app." }],
    notesBlockFor: () => "",
    setRoutineChat: () => undefined,
    parseTurnBody: parseTurnBody,
    currentChat: currentChatInShell,
    setCurrentChat: setCurrentChatInShell,
    ...options.deps,
  };
  const engine = await Engine.boot({
    engineDir: join(root, "engine"),
    routerBaseUrl: router.baseUrl,
    routerToken: () => "test-router-token",
    deps,
    approvals,
    retryBaseDelayMs: 20,
    ...options.engine,
  });

  const recorders: { stop(): void }[] = [];
  const world: World = {
    root,
    router,
    engine,
    state,
    chats: new Map(),
    newChat: () => engine.createChat(DEFAULT_BOT_ID).chatId,
    send: (chatId, text, extra = {}) => engine.submitTurn(chatId, { clientId: crypto.randomUUID(), text, attachments: [], ...extra }),
    idle: async (chatId, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      const chat = engine.host.chat(chatId);
      while (chat.turn || chat.queue.length > 0) {
        if (Date.now() > deadline) throw new Error(`chat ${chatId} still busy after ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Let the settle's last writes land.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    record: (chatId, recordOptions = {}) => {
      const events: EngineEvent[] = [];
      const subscription = engine.subscribe(chatId, (event) => events.push(event), recordOptions);
      events.push(...subscription.initial);
      const recorder = { events, stop: () => subscription.unsubscribe() };
      recorders.push(recorder);
      return recorder;
    },
    close: async () => {
      for (const recorder of recorders) recorder.stop();
      await engine.close();
      if (!options.router) await router.close();
      if (!options.root) rmSync(root, { recursive: true, force: true });
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
  };
  return world;
}

/** Resolves once the router has received `count` requests. */
export async function waitForRequests(world: World, count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (world.router.requests.length < count) {
    if (Date.now() > deadline) throw new Error(`router saw ${world.router.requests.length} of ${count} requests`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The event types of a recorded stream, in order, without `ping`. */
export function types(events: EngineEvent[]): string[] {
  return events.filter((event) => event.type !== "ping").map((event) => event.type);
}

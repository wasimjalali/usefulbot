import { peekShell, tryUpdateShell } from "../../shared/shell-io.ts";
import { setBotChat } from "../../shared/shell-store.ts";
import type { UsefulTool } from "../lib/tool.ts";
import type { TurnBody } from "../../shared/turn-input.ts";
import type { SkillInfo } from "./context.ts";

/**
 * What the engine calls in other workers' files (seams.md). Everything the
 * engine needs from the tools, the notes and the web-side stores goes through
 * this one type, so a test can hand the host fakes and the real wiring is one
 * function.
 */

export type WidgetRef = { connectionId: string; toolName: string; arguments: Record<string, unknown> };

export type { TurnAttachment, TurnBody } from "../../shared/turn-input.ts";

export type Deps = {
  /** The 16 declared tools, in their fixed order (agent/tools/index.ts). */
  allTools(): UsefulTool[];
  /** The MCP tools `find_tools` picked for this chat (agent/tools/picked.ts). */
  pickedTools(chatId: string): UsefulTool[];
  /** The widget a picked tool's call opens, or null (shared/mcp-apps.ts). */
  widgetForCall(name: string, args: Record<string, unknown>): WidgetRef | null;
  /** Before a reopened chat's picked tools are registered: checks each connection's listing is current (agent/tools/picked.ts). */
  refreshPickedTools(chatId: string): Promise<void>;
  /** Seeds the todo list from the branch's last `todo` result when a chat opens (agent/tools/todo.ts). */
  restoreTodos(chatId: string, todos: unknown[]): void;
  /** Name and one line for each skill (agent/lib/skills.ts). */
  listSkills(): SkillInfo[];
  /** The rendered notes block for "This turn" (shared/notes-block.ts). */
  notesBlockFor(botId: string): string;
  /** Points a routine at its own chat, or clears it (shared/routines-store.ts). */
  setRoutineChat(routineId: string, chatId: string | null): void;
  /** Validates `POST /chats/:id/turns` (shared/turn-input.ts). */
  parseTurnBody(raw: unknown): TurnBody;
  /** The chat a bot has open (`shell.json` v2 keeps only this per bot). */
  currentChat(botId: string): string | null;
  /** Makes a chat the bot's current one, or none, and updates its preview line. Throws when the shell store is busy: the engine retries (current-chat.ts). */
  setCurrentChat(botId: string, chatId: string | null, preview: string): void;
};

/** The chat a bot has open, from `shell.json`. */
export function currentChatInShell(botId: string): string | null {
  return peekShell()?.bots.find((item) => item.id === botId)?.chatId ?? null;
}

/** How long the engine waits for a store lock (the shell file, the routines file) before failing or parking the write. */
const LOCK_WAIT_MS = 50;

/** Makes a chat the bot's current one (or none) under the shell lock. Throws `shell_store_busy` when the lock stays held. */
export function setCurrentChatInShell(botId: string, chatId: string | null, preview: string): void {
  const written = tryUpdateShell((store) => setBotChat(store, botId, chatId, preview, new Date().toISOString()), LOCK_WAIT_MS);
  if (!written) throw new Error("shell_store_busy");
}

/**
 * The real wiring. Every seam loads once, up front, so a seam that is not
 * there is reported by name at boot and not as a bare import error in the
 * middle of a turn.
 */
export async function loadDeps(): Promise<Deps> {
  const failures: string[] = [];
  async function seam<T>(name: string, load: () => Promise<T | undefined>): Promise<T> {
    try {
      const found = await load();
      if (found !== undefined) return found;
      failures.push(`${name}: not exported`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined as unknown as T;
  }
  const deps: Deps = {
    allTools: await seam("allTools", async () => (await import("../tools/index.ts")).allTools),
    pickedTools: await seam("pickedTools", async () => (await import("../tools/picked.ts")).pickedTools),
    refreshPickedTools: await seam("refreshPickedTools", async () => (await import("../tools/picked.ts")).refreshPickedTools),
    restoreTodos: await seam("restoreTodos", async () => (await import("../tools/todo.ts")).restoreTodos as Deps["restoreTodos"]),
    widgetForCall: await seam("widgetForCall", async () => (await import("../../shared/mcp-apps.ts")).widgetForCall),
    listSkills: await seam("listSkills", async () => (await import("../lib/skills.ts")).listSkills),
    notesBlockFor: await seam("notesBlockFor", async () => (await import("../../shared/notes-block.ts")).notesBlockFor),
    // The same short lock wait as the scheduler's own store calls: a busy store throws `routines_locked` instead of stalling the engine.
    setRoutineChat: await seam("setRoutineChat", async () => {
      const set = (await import("../../shared/routines-store.ts")).setRoutineChat;
      return set && ((routineId: string, chatId: string | null) => { set(routineId, chatId, undefined, LOCK_WAIT_MS); });
    }),
    parseTurnBody: await seam("parseTurnBody", async () => (await import("../../shared/turn-input.ts")).parseTurnBody),
    currentChat: currentChatInShell,
    setCurrentChat: setCurrentChatInShell,
  };
  if (failures.length > 0) throw new Error(`seams_missing: ${failures.join("; ")}`);
  return deps;
}

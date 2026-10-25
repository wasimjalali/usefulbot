import type { RowInput } from "../lib/tool.ts";

/**
 * What the rest of the engine process (tools, routines, migration) and the
 * engine's internal HTTP routes (SPEC 6.5) call on the host. W1 implements it
 * in agent/engine/; until then every call fails loud.
 */
export type EngineApi = {
  /**
   * Appends a row to a chat (SPEC 5.12): a `ub.row` custom entry plus a `row`
   * event. `chatId` null means the bot's current chat. Idempotent by `row.key`.
   */
  appendRow(botId: string, chatId: string | null, row: RowInput): Promise<{ chatId: string; rowId: string }>;
  /**
   * Starts a turn with origin `system` (connect-card resume, D19). Idempotent
   * by `key`; queued behind a running turn like any prompt.
   */
  systemTurn(botId: string, key: string, text: string, note?: string): Promise<{ chatId: string; turnId: string | null; queued: boolean }>;
  /** Claims and runs a routine now in its own chat (SPEC 5.11). */
  runRoutine(routineId: string): Promise<{ chatId: string; turnId: string | null; queued: boolean }>;
  /** Instruction cost against the window, for `/api/bots/context`. */
  botContext(botId: string): Promise<{ windowTokens: number; instructionTokens: number; envelopeTokens: number }>;
};

let installed: EngineApi | null = null;

/** The host calls this once at boot. */
export function installEngineApi(api: EngineApi): void {
  installed = api;
}

export function engineApi(): EngineApi {
  if (!installed) throw new Error("engine_api_not_installed");
  return installed;
}

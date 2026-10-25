import { randomUUID } from "node:crypto";
import type { RowInput, ToolCtx } from "../../agent/lib/tool.ts";
import type { OkSnapshot } from "../../agent/lib/turn-snapshot.ts";
import { upsertSessionGrant } from "../../shared/workspace-store.ts";
import type { WorkspacePermission } from "../../shared/workspace-store.ts";

export type TestCtx = ToolCtx & { rows: RowInput[]; abort: () => void };

/**
 * A tool context for a test: the fields a tool reads, rows collected in
 * `rows` (idempotent by key, as the engine's appendRow is) and a signal the
 * test can fire with `abort()`.
 */
export function fakeCtx(over: Partial<Pick<ToolCtx, "chatId" | "botId" | "turnId" | "callId" | "origin">> = {}): TestCtx {
  const chatId = over.chatId ?? "chat-test";
  // A fresh turn per context unless a test names one: the outside-content mark
  // is kept per chat and turn, and a shared id would leak it between tests.
  const turnId = over.turnId ?? `turn-${randomUUID()}`;
  const controller = new AbortController();
  const rows: RowInput[] = [];
  const snapshot = {
    status: "ok",
    sessionId: chatId,
    turnId,
    botId: over.botId ?? "bot-useful",
    context: { bot: { name: "Useful Bot", label: "", description: "" } },
  } as unknown as OkSnapshot;
  return {
    chatId,
    botId: over.botId ?? "bot-useful",
    turnId,
    callId: over.callId ?? "call-test",
    origin: over.origin ?? "owner",
    abortSignal: controller.signal,
    snapshot,
    session: { id: chatId, turn: { id: turnId } },
    async appendRow(row) {
      if (!rows.some((item) => item.key === row.key)) rows.push(row);
    },
    rows,
    abort: () => controller.abort(),
  };
}

/**
 * Stamps the grant the engine writes before a turn: this chat works in `path`
 * (null: no folder, the owner's home) under `permission`. A chat the engine
 * never stamped fails closed to Read only, so tests that want Auto or Full
 * access stamp it here. Reads the store path from UB_WORKSPACE_STORE_PATH.
 */
export function stampGrant(chatId: string, path: string | null, permission: WorkspacePermission): void {
  // The record is keyed by the chat id; `sessionId` rides along until the
  // store's input field is renamed everywhere.
  upsertSessionGrant({ chatId, sessionId: chatId, path, permission } as never, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
}

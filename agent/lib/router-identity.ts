import { createHash, randomUUID } from "node:crypto";

/**
 * How a model call tells the router which chat it belongs to.
 *
 * The router gates one model call per SESSION and hashes the session into the
 * upstream's own session header, so the id has to be per chat. The router
 * validates these headers as uuids, and a chat id is only one by luck, so it is
 * hashed into that shape. The hash is stable: the same chat keeps the same id
 * across steps, turns and an engine restart.
 */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  // Version nibble 8 (RFC 9562 "custom") and the 10xx variant, so the value is
  // an honest uuid rather than a v4 that was never random.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RouterIds {
  sessionId: string;
  turnId: string;
}

/**
 * UB_SESSION_ID and UB_TURN_ID pin the ids for the probes and evals that set
 * them. Otherwise both derive from the chat and the turn. A caller with no turn
 * in hand (a tool calling the router directly) gets a random turn id: the
 * router only requires that it is a uuid.
 */
export function routerIds(
  chatId: string,
  turnId?: string,
  env: Record<string, string | undefined> = process.env,
): RouterIds {
  return {
    sessionId: env.UB_SESSION_ID ?? stableUuid(`session:${chatId}`),
    turnId: env.UB_TURN_ID ?? (turnId ? stableUuid(`turn:${chatId}:${turnId}`) : randomUUID()),
  };
}

/** The subset of a tool context the router ids need (`ToolCtx` has it). */
export interface ToolIdContext {
  session?: { id?: string; turn?: { id?: string } };
}

/**
 * Router ids for a tool that calls the router itself. The engine always
 * supplies the session at runtime; a test or a direct call may pass no context
 * at all. That case gets `null`, never a shared constant: one fixed id would
 * make every context-less call one session, which is the bug this file exists
 * to remove. The caller decides what no session means for its route.
 */
export function toolRouterIds(ctx: ToolIdContext | undefined): RouterIds | null {
  const sessionId = ctx?.session?.id;
  if (!sessionId) return null;
  return routerIds(sessionId, ctx?.session?.turn?.id);
}

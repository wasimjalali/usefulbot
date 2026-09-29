import { createHash, randomUUID } from "node:crypto";

/**
 * How a model call tells the router which bot it belongs to.
 *
 * The router gates one model call per SESSION and hashes the session into the
 * upstream's own session header, so the id has to be per bot. It used to be one
 * random uuid per process, which made every bot one session: one model call at
 * a time across the app, and one shared provider-side session and cache.
 *
 * The router validates these headers as uuids, and an eve session id is not
 * one, so it is hashed into that shape. The hash is stable: the same chat keeps
 * the same id across steps, turns and an eve restart.
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
 * them, exactly as before. Otherwise both derive from eve. A caller with no
 * turn in hand (a tool calling the router directly) gets a random turn id: the
 * router only requires that it is a uuid.
 */
export function routerIds(
  eveSessionId: string,
  eveTurnId?: string,
  env: Record<string, string | undefined> = process.env,
): RouterIds {
  return {
    sessionId: env.UB_SESSION_ID ?? stableUuid(`session:${eveSessionId}`),
    turnId: env.UB_TURN_ID ?? (eveTurnId ? stableUuid(`turn:${eveSessionId}:${eveTurnId}`) : randomUUID()),
  };
}

/**
 * The turn id off eve's `step.started` event. `defineDynamic` types the event
 * as `unknown`, so this reads the one documented field and nothing else. A
 * missing id is not an error: `routerIds` falls back to a random turn id.
 */
export function turnIdOf(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const turnId = (data as { turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

/** The subset of an eve ToolContext the router ids need. */
export interface ToolIdContext {
  session?: { id?: string; turn?: { id?: string } };
}

/**
 * Router ids for a tool that calls the router itself. eve always supplies the
 * session at runtime; a test or a direct call may pass no context at all, the
 * way the other tools here allow. That case gets `null`, never a shared
 * constant: one fixed id would make every context-less call one session again,
 * which is the bug this file exists to remove. The caller decides what no
 * session means for its route.
 */
export function toolRouterIds(ctx: ToolIdContext | undefined): RouterIds | null {
  const sessionId = ctx?.session?.id;
  if (!sessionId) return null;
  return routerIds(sessionId, ctx?.session?.turn?.id);
}

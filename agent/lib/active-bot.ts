import { bindChildSession, readSessionBot, readSessionParent, resolveSessionBot } from "../../shared/session-bindings.ts";
import { peekShell } from "../../shared/shell-io.ts";
import type { ShellStore } from "../../shared/shell-store.ts";

/** The subset of an eve ToolContext the active-bot resolution needs. */
export interface ActiveBotContext {
  session?: {
    id?: string;
    parent?: unknown;
    auth?: { current?: { attributes?: Readonly<Record<string, unknown>> } | null } | null;
  };
}

/** Thrown when no bot can be named for the acting session. */
export class BotContextMissingError extends Error {
  constructor() {
    super("bot_context_missing");
    this.name = "BotContextMissingError";
  }
}

/** What a tool that returns results hands back when no bot is bound. */
export const BOT_CONTEXT_MISSING = { status: "blocked", error: "bot_context_missing" } as const;

export function isBotContextMissing(err: unknown): boolean {
  return err instanceof BotContextMissingError;
}

/** How long a tool of a brand new session waits for the proxy to bind it. */
export const BINDING_WAIT_MS = 5_000;
const BINDING_POLL_MS = 50;

/** Same alphabet as the session store's ids: no dots, no slashes. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Whether eve says this session was delegated from another (`ctx.session.parent`, set by eve alone). */
export function isSubAgent(ctx?: ActiveBotContext): boolean {
  return Boolean(ctx?.session?.parent);
}

/**
 * The root session and bot a sub-agent's child session acts for, or null for a
 * session that is not a child. A child holds exactly its root's bot and grants
 * and nothing of its own, so anything that cannot be proven refuses with
 * `bot_context_missing`: a root that is unbound, is itself a child or is not a
 * session id; a nested child (eve's built-in `agent` is root-only, so an
 * immediate parent other than the root is unexpected); a bot claim, or a row
 * for the child, that names another bot or another parent. It never falls
 * back to the pin, the test override or the child's own id. A verified child
 * is recorded under its parent (never as a root) so the proxy and later
 * lookups agree.
 */
export function subAgentRoot(
  ctx?: ActiveBotContext,
  shell: ShellStore | null = peekShell(),
): { rootSessionId: string; botId: string } | null {
  const parent = ctx?.session?.parent;
  if (!parent) return null;
  const childId = ctx?.session?.id;
  if (typeof parent !== "object" || Array.isArray(parent) || typeof childId !== "string" || !SESSION_ID.test(childId)) {
    throw new BotContextMissingError();
  }
  const { rootSessionId, sessionId } = parent as { rootSessionId?: unknown; sessionId?: unknown };
  if (typeof rootSessionId !== "string" || !SESSION_ID.test(rootSessionId) || rootSessionId === childId) {
    throw new BotContextMissingError();
  }
  if (sessionId !== rootSessionId) throw new BotContextMissingError();
  const botId = resolveSessionBot(rootSessionId, shell);
  if (!botId || readSessionParent(rootSessionId) !== null) throw new BotContextMissingError();
  const claim = ctx?.session?.auth?.current?.attributes?.botId;
  if (typeof claim === "string" && claim.length > 0 && claim !== botId) throw new BotContextMissingError();
  const own = readSessionBot(childId);
  if (own !== null) {
    if (own !== botId || readSessionParent(childId) !== rootSessionId) throw new BotContextMissingError();
  } else {
    try {
      bindChildSession(childId, rootSessionId, botId);
    } catch (err) {
      // Another writer bound it differently between the read and the write.
      if (err instanceof Error && err.message === "session_owner_conflict") throw new BotContextMissingError();
      throw err;
    }
  }
  return { rootSessionId, botId };
}

/**
 * The session whose grant (permission, folder) and binding count for this
 * call: the session itself, or for a sub-agent's child its verified root.
 * Throws `bot_context_missing` for a child that cannot be verified.
 */
export function authoritySessionId(ctx?: ActiveBotContext): string | undefined {
  const root = subAgentRoot(ctx);
  return root ? root.rootSessionId : ctx?.session?.id;
}

/**
 * Which bot is acting, read from the durable session binding
 * (shared/session-bindings.ts), never from `shell.selectedBotId`: the selected
 * bot is only where the owner last looked. An unbound session throws
 * `bot_context_missing`. A sub-agent's child session (eve `ctx.session.parent`)
 * acts as its root session's bot (`subAgentRoot`), and refuses when that
 * cannot be shown, whatever the pin says.
 * UB_ACTIVE_BOT_ID stays as the explicit test and probe override, ahead of
 * the binding, for a call that has no session; under the test runner it also
 * covers an unbound session (never a child).
 */
function resolveNow(shell: ShellStore | null, ctx?: ActiveBotContext): string | null {
  const root = subAgentRoot(ctx, shell);
  if (root) return root.botId;
  const sessionId = ctx?.session?.id ?? null;
  if (!sessionId) return process.env.UB_ACTIVE_BOT_ID || null;
  const bound = resolveSessionBot(sessionId, shell);
  if (bound) return bound;
  // A real session with no binding is refused. The pin stands in for a missing
  // binding only under the test runner, never in a running app.
  return process.env.NODE_TEST_CONTEXT ? process.env.UB_ACTIVE_BOT_ID || null : null;
}

/** Synchronous, no wait: for callers that cannot await. Throws `bot_context_missing`. */
export function activeBotId(shell: ShellStore, ctx?: ActiveBotContext): string {
  const id = resolveNow(shell, ctx);
  if (!id) throw new BotContextMissingError();
  return id;
}

/**
 * The same, after a bounded wait for a just-created session. A new session's
 * first turn starts inside eve's create call and the proxy can only bind the
 * session once that call answers with its id, so the first tool call can run
 * a moment before the binding lands.
 */
export async function awaitActiveBotId(
  shell: ShellStore,
  ctx?: ActiveBotContext,
  timeoutMs = Number(process.env.UB_BINDING_WAIT_MS ?? BINDING_WAIT_MS),
): Promise<string> {
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : BINDING_WAIT_MS);
  let roster: ShellStore | null = shell;
  for (;;) {
    const id = resolveNow(roster, ctx);
    if (id) return id;
    // No session id at all (a bare test call) will never gain one.
    if (!ctx?.session?.id || Date.now() >= deadline) throw new BotContextMissingError();
    await new Promise((resolve) => setTimeout(resolve, BINDING_POLL_MS));
    // The pointer a backfill reads may have landed while this waited.
    roster = peekShell();
  }
}

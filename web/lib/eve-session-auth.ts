import { CHILD_AT_MAX, bindTurnBody, childCancelQuery, isEveSessionPost } from "../../shared/eve-proxy.ts";
import { eveStreamPayload } from "../../shared/eve-stream.ts";
import { bindChildSession, readSessionParent, resolveSessionBot } from "../../shared/session-bindings.ts";
import { eveOrigin } from "../../shared/stack.ts";
import { channelJwt, channelJwtNoBot } from "./agent-exec.ts";
import { readShell } from "../../shared/shell-io.ts";

export type EveCallAuth =
  | {
    ok: true;
    /** The token for this call. Null only for a session create: the route mints it once the bot is validated. */
    jwt: string | null;
    /** The bot the session path is bound to, or null for a create, health, info or an unbound cancel. */
    bound: string | null;
    /** The turn body to forward: the original, with `botId` pinned to the bound bot, for a continuation. */
    body: string | null;
  }
  | { ok: false; status: number; error: string };

/**
 * Which bot an eve call is made as. For every `session/<id>` path (continue,
 * stream, cancel) the bot comes from the durable binding for that path id,
 * never from the request body, and the token carries that bot's claim, so eve
 * can hold the call to the same binding. A session nobody bound is refused
 * before eve sees it, except a cancel (stopping a session is always safe). A
 * body that names another bot is refused. Throws when the binding cannot be
 * read or the channel secret is missing; the caller maps that to a 503.
 */
export function authorizeEveCall(
  method: string,
  suffix: string,
  rawBody: string | null,
  resolveBot: (sessionId: string) => string | null,
  /** Whether a session is a recorded sub-agent child, which is never written to. */
  isChild: (sessionId: string) => boolean = (sessionId) => readSessionParent(sessionId) !== null,
): EveCallAuth {
  const match = /^session\/([^/]+)(\/|$)/.exec(suffix);
  if (!match) {
    // A create is minted after the route validates its bot. Health and info
    // need a verified token and no claim.
    return { ok: true, jwt: suffix === "session" ? null : channelJwtNoBot(), bound: null, body: rawBody };
  }
  const readOnly = childWriteRefusal(method, suffix, isChild);
  if (readOnly) return { ok: false, ...readOnly };
  const bound = resolveBot(match[1]);
  const cancel = method === "POST" && suffix === `session/${match[1]}/cancel`;
  if (bound === null) {
    if (!cancel) return { ok: false, status: 400, error: "session_unbound" };
    return { ok: true, jwt: channelJwtNoBot(), bound: null, body: rawBody };
  }
  if (method === "POST" && isEveSessionPost(suffix) && rawBody !== null) {
    const turn = bindTurnBody(rawBody, bound);
    if (!turn.ok) return { ok: false, status: 400, error: turn.error };
    return { ok: true, jwt: channelJwt(bound), bound, body: turn.body };
  }
  return { ok: true, jwt: channelJwt(bound), bound, body: rawBody };
}

/**
 * The token a carry-over reads the old session with. The old session must be
 * bound to the bot whose chat is continuing: no owner, or another bot's
 * session, is refused and no token is minted for it.
 */
export function carryOverReader(
  carriedFrom: string,
  ownerId: string | null,
  resolveBot: (sessionId: string) => string | null,
): { ok: true; jwt: string } | { ok: false; status: number; error: string } {
  if (!ownerId || resolveBot(carriedFrom) !== ownerId) {
    return { ok: false, status: 400, error: "continue_from_refused" };
  }
  return { ok: true, jwt: channelJwt(ownerId) };
}

export type ChildStreamDeps = {
  resolveBot: (sessionId: string) => string | null;
  /** The root a session was recorded as a child of, or null. */
  readParent: (sessionId: string) => string | null;
  /** The first event of `parent`'s stream at the absolute index `at` (see readStreamEventAt). */
  readEventAt: (parent: string, at: number, jwt: string, signal?: AbortSignal) => Promise<string | null>;
  bind: (child: string, parent: string, botId: string) => void;
};

export function childStreamDeps(): ChildStreamDeps {
  return {
    resolveBot: (id) => resolveSessionBot(id, readShell()),
    readParent: (id) => readSessionParent(id),
    readEventAt: (parent, at, jwt, signal) => readStreamEventAt(parent, at, jwt, { signal }),
    bind: (child, parent, botId) => { bindChildSession(child, parent, botId); },
  };
}

/** How long, and how many bytes, the read of one parent event may take. */
const EVENT_READ_MS = 5_000;
const EVENT_READ_MAX_BYTES = 1024 * 1024;

/**
 * The text of the first event on `parent`'s eve stream read from the absolute
 * index `at`, which is event `at` itself: eve's non-negative `startIndex` is an
 * absolute event count, and its stream route writes one blank line and then
 * each event as one JSON line (no index on the line). The read stops at that
 * first whole line, so events appended later are never read. Null when the
 * stream ends, or passes `maxBytes`, before one whole line (a short read).
 * Throws on an eve error status, a failed fetch, the time cap (a parent with
 * nothing at `at` yet is followed live by eve) or the caller going away.
 */
export async function readStreamEventAt(
  parent: string,
  at: number,
  jwt: string,
  options: { fetch?: typeof fetch; origin?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("eve_stream_index");
  const maxBytes = options.maxBytes ?? EVENT_READ_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? EVENT_READ_MS);
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (err: unknown): never => {
    if (timedOut) throw new Error("eve_stream_timeout");
    if (options.signal?.aborted) throw new Error("aborted");
    throw err;
  };
  try {
    const url = `${options.origin ?? eveOrigin()}/eve/v1/session/${encodeURIComponent(parent)}/stream?startIndex=${at}`;
    const res = await (options.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${jwt}` }, signal: controller.signal }).catch(fail);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`eve_stream_${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // A body that does not end on the abort still loses the race to it.
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(new Error("aborted"));
      if (controller.signal.aborted) stop();
      else controller.signal.addEventListener("abort", stop, { once: true });
    });
    stopped.catch(() => undefined);
    const encoder = new TextEncoder();
    let buf = "";
    let bytes = 0;
    // Bytes of the lines already read through, so the cap holds for the line
    // that is returned even when its newline arrives in the chunk that
    // crosses the cap.
    let used = 0;
    try {
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), stopped]).catch(fail);
        if (done) return null;
        bytes += value.byteLength;
        buf += decoder.decode(value, { stream: true });
        // Only a line eve finished with its newline is a whole event.
        let newline = buf.indexOf("\n");
        while (newline !== -1) {
          const line = buf.slice(0, newline);
          used += encoder.encode(line).byteLength + 1;
          if (used > maxBytes) return null;
          const payload = eveStreamPayload(line);
          if (payload !== null) return payload;
          buf = buf.slice(newline + 1);
          newline = buf.indexOf("\n");
        }
        if (bytes > maxBytes) return null;
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The refusal for a write into a sub-agent's child session, or null. A send, a
 * cancel or a reset into a recorded child is never allowed: the child's work
 * is read only. Called by the authorisation itself and again right before the
 * call is forwarded, because a child can be recorded while a request is in
 * flight. Throws when the binding store cannot be read.
 */
export function childWriteRefusal(
  method: string,
  suffix: string,
  isChild: (sessionId: string) => boolean,
): { status: 403; error: "child_session_readonly" } | null {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return null;
  // Any path under the session, not only the shapes the POST allowlist admits
  // today, so a later route cannot write past this.
  const match = /^session\/([^/]+)(?:\/|$)/.exec(suffix);
  if (!match || !isChild(match[1])) return null;
  return { status: 403, error: "child_session_readonly" };
}

/**
 * May a read of `child`'s stream go through, as a sub-agent of `parent`?
 * `parent` must be bound to a bot and not itself a child, and `child` must not
 * be the parent, a root session or recorded under another parent or bot. A
 * child already recorded under this parent and bot is served with no eve read.
 * Otherwise `at`, the absolute index of the parent's `subagent.called` event
 * for it, is checked: the one event at `at` on the parent's own stream must be
 * exactly that event, raised by the parent and naming this child. Then the
 * child is bound to the parent's bot with the parent recorded (eve holds every
 * session call to a binding; the proxy refuses any write into a recorded
 * child). Anything else is `child_session_unverified`. Nothing is cached: an
 * eve or store failure throws, and the route answers 503. GET streams only.
 */
export async function authorizeChildStream(
  parent: string,
  child: string,
  at: number | null,
  deps: ChildStreamDeps,
  signal?: AbortSignal,
): Promise<EveCallAuth> {
  const bot = deps.resolveBot(parent);
  if (bot === null) return { ok: false, status: 400, error: "session_unbound" };
  const refused: EveCallAuth = { ok: false, status: 403, error: "child_session_unverified" };
  if (child === parent || deps.readParent(parent) !== null) return refused;
  const childParent = deps.readParent(child);
  const childBot = deps.resolveBot(child);
  const allowed = (): EveCallAuth => ({ ok: true, jwt: channelJwt(bot), bound: bot, body: null });
  if (childParent !== null) return childParent === parent && childBot === bot ? allowed() : refused;
  // A session bound to a bot with no parent is a root, never a child.
  if (childBot !== null) return refused;
  if (at === null || !Number.isSafeInteger(at) || at < 0 || at > CHILD_AT_MAX) return refused;
  const payload = await deps.readEventAt(parent, at, channelJwt(bot), signal);
  if (payload === null || !isSubagentCall(payload, parent, child)) return refused;
  deps.bind(child, parent, bot);
  return allowed();
}

export type ChildCancel =
  | { kind: "none" }
  | { kind: "refused"; status: number; error: string }
  | { kind: "verified"; jwt: string; search: string; parent: string; child: string; agentId: string | null };

/**
 * A cancel into a sub-agent's child, as one decision. `none`: not a POST to
 * exactly `session/<id>/cancel` carrying a `parent` query, so the normal
 * authorisation (which refuses every write into a recorded child) applies.
 * Otherwise `parent` and `at` are required and checked against the parent's
 * `subagent.called` event (authorizeChildStream), and only `verified` may skip
 * the normal write refusal. Throws like authorizeChildStream.
 */
export async function authorizeChildCancel(
  method: string,
  suffix: string,
  search: string,
  deps: ChildStreamDeps,
  signal?: AbortSignal,
): Promise<ChildCancel> {
  const query = childCancelQuery(method, suffix, search);
  if (!query.present) return { kind: "none" };
  const child = /^session\/([^/]+)\/cancel$/.exec(suffix)?.[1];
  if (!child || query.parent === null || query.at === null || query.agentIdBad) {
    return { kind: "refused", status: 403, error: "child_session_unverified" };
  }
  const auth = await authorizeChildStream(query.parent, child, query.at, deps, signal);
  if (!auth.ok) return { kind: "refused", status: auth.status, error: auth.error };
  if (auth.jwt === null) return { kind: "refused", status: 403, error: "child_session_unverified" };
  return { kind: "verified", jwt: auth.jwt, search: query.search, parent: query.parent, child, agentId: query.agentId };
}

/** Whether a stream line is exactly `parent`'s `subagent.called` for `child`. */
function isSubagentCall(payload: string, parent: string, child: string): boolean {
  try {
    const event = JSON.parse(payload) as { type?: unknown; data?: { sessionId?: unknown; childSessionId?: unknown } } | null;
    return event !== null && typeof event === "object" && event.type === "subagent.called"
      && event.data?.sessionId === parent && event.data?.childSessionId === child;
  } catch {
    return false;
  }
}

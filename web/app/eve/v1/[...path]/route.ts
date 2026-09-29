import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { ApprovalStore, defaultApprovalsPath } from "../../../../../agent/lib/approvals.ts";
import {
  eveGetAllowed,
  evePostAllowed,
  eveSessionRoute,
  isEveSessionPost,
  parseTurnExtras,
  parseTurnMessage,
  relayedEveCode,
  rewriteEveTurnBody,
  sessionRouteHeader,
  turnHasImages,
  type SessionRoute,
} from "../../../../../shared/eve-proxy.ts";
import { catalogFor } from "../../../../../shared/live-models.ts";
import { modelOption, modelSeesImages } from "../../../../../shared/models.ts";
import { composerState, readProviderStore } from "../../../../../shared/providers.ts";
import { cancelEveTurn, channelJwt, continuationBriefFor, sessionHasCompletedTurn, syncSessionWorkspace } from "../../../../lib/agent-exec";
import { RETRY_NOTE } from "../../../../../shared/continuation-brief.ts";
import { EVE_BODY_MAX, apiError, rateLimited, readBody } from "../../../../lib/api-guard";
import { readShell, updateShell } from "../../../../../shared/shell-io.ts";
import { carryOverLineage, continueFromVerdict, settleContinuation, type ShellBot } from "../../../../../shared/shell-store.ts";
import { removeSessionGrant } from "../../../../../shared/workspace-store.ts";
import { groupMembers, speakersFrom } from "../../../../../shared/threads.ts";

const EVE = "http://127.0.0.1:4321";

/** True only when the catalog says the active model is text-only. */
function rejectsImages(): boolean {
  const composer = composerState(readProviderStore());
  const catalog = catalogFor(composer.connectionId || composer.providerId);
  const model = modelOption(composer.providerId, composer.modelId, catalog);
  return modelSeesImages(model) === false;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, await context.params, "GET");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, await context.params, "POST");
}

/**
 * A stopped turn can't act on an approval card any more. After a cancel, its
 * session's cards are retired instead of staying up over the chat until they
 * expire.
 */
function retireCards(method: string, suffix: string): void {
  const cancelled = method === "POST" ? /^session\/([^/]+)\/cancel$/.exec(suffix) : null;
  if (!cancelled) return;
  try {
    new ApprovalStore(Date.now, defaultApprovalsPath()).expireSession(cancelled[1]);
  } catch (err) {
    console.error("approval cards of a stopped session were left pending", err);
  }
}

async function proxy(request: Request, params: { path: string[] }, method: string): Promise<Response> {
  // Owner sessions only (S5): the desktop auto-session and the phone's
  // credential-bound session both pass requireOwner; a bare device/router
  // credential never becomes a session, so eve only ever answers behind one.
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const session = gate.session;
  const suffix = params.path.join("/");
  const allowed = method === "GET" ? eveGetAllowed(suffix) : evePostAllowed(suffix);
  if (!allowed) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (method !== "GET") {
    const csrf = request.headers.get("x-ub-csrf");
    if (!csrf || csrf !== session.csrf) {
      return Response.json({ ok: false, error: "csrf" }, { status: 403 });
    }
    if (rateLimited(`eve:${session.callerId}`, 60)) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
  }
  const url = new URL(request.url);
  const target = `${EVE}/eve/v1/${suffix}${url.search}`;
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Same credential path as the handoff pump: env token if present, otherwise
  // sign one from the channel secret.
  const jwt = channelJwt();
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);
  let body: Uint8Array | undefined;
  let route: SessionRoute | null = null;
  // The session a replacement carries over from, once verified.
  let carriedFrom: string | null = null;
  if (method !== "GET") {
    try {
      body = await readBody(request, EVE_BODY_MAX);
    } catch (err) {
      const guarded = apiError(err);
      if (guarded) return guarded;
      throw err;
    }
    if (isEveSessionPost(suffix)) {
      let bot: ShellBot | null = null;
      // Outside the rewrite's catch on purpose: that one forwards the original
      // body when anything throws, and a carry-over that failed its check must
      // be refused, never relayed. Only a new session carries over, and only
      // from the bot's own live session or one it already carried over from.
      const extras = parseTurnExtras(new TextDecoder().decode(body));
      const notes: string[] = [];
      if (extras.continueFrom !== undefined) {
        let owner: ShellBot | null = null;
        try {
          const botId = (JSON.parse(new TextDecoder().decode(body)) as { botId?: unknown }).botId;
          owner = readShell().bots.find((item) => item.id === botId) ?? null;
        } catch {
          owner = null;
        }
        const verdict = suffix === "session" && owner && extras.continueFrom
          ? continueFromVerdict(owner, extras.continueFrom)
          : "refused";
        if (verdict === "moved") {
          // Another client (or the handoff pump) already carried this session
          // over. A second carry-over would fork the chat, so the caller
          // catches up with the live session instead.
          return Response.json({ ok: false, error: "eve_error", status: 409, code: "session_moved" }, { status: 409 });
        }
        if (verdict !== "allowed" || !extras.continueFrom) {
          return Response.json({ ok: false, error: "continue_from_refused" }, { status: 400 });
        }
        carriedFrom = extras.continueFrom;
      }
      // The cheap refusals come before any read of an old session. A
      // carry-over reads one back for its brief, thousands of events on a
      // long chat, and a turn refused here needed none of it.
      // A picture for a model that cannot look at it is refused before the
      // turn exists: eve would stage the bytes, the upstream would reject
      // the call, and the session would retire on the failed turn. A model
      // the catalog does not know goes through, and the upstream decides.
      try {
        const parsed = parseTurnMessage((JSON.parse(new TextDecoder().decode(body)) as { message?: unknown }).message);
        if (parsed !== null && turnHasImages(parsed) && rejectsImages()) {
          return Response.json({ ok: false, error: "model_no_vision" }, { status: 400 });
        }
      } catch {
        /* a malformed body is judged by the rewrite below, as before */
      }
      if (carriedFrom) notes.push(await continuationBriefFor(carriedFrom, jwt ?? "", undefined, request.signal));
      if (suffix !== "session") {
        // A send into the session a carry-over opened, before that session
        // has finished a turn: a step-zero failure (a rate limit, say) drops
        // the opening message and the brief with it, so it rides again.
        const target = suffix.split("/")[1] ?? "";
        let owner: ShellBot | null = null;
        try {
          const botId = (JSON.parse(new TextDecoder().decode(body)) as { botId?: unknown }).botId;
          owner = readShell().bots.find((item) => item.id === botId) ?? null;
        } catch {
          owner = null;
        }
        const previous = owner?.previousSessionIds?.[0];
        if (owner && previous && owner.continuedSessionId === target && owner.continuationSettled !== true) {
          let settled = false;
          try {
            settled = await sessionHasCompletedTurn(target, jwt ?? "", request.signal);
          } catch (err) {
            console.error("carry-over settle check failed", err instanceof Error ? err.message : err);
          }
          if (settled) {
            const botId = owner.id;
            try {
              updateShell((current) => settleContinuation(current, botId, target));
            } catch (err) {
              console.error("carry-over settle not recorded", err instanceof Error ? err.message : err);
            }
          } else {
            notes.push(await continuationBriefFor(previous, jwt ?? "", undefined, request.signal));
          }
        }
      }
      if (extras.retry) notes.push(RETRY_NOTE);
      try {
        const raw = new TextDecoder().decode(body);
        const shell = readShell();
        route = eveSessionRoute(raw, shell);
        if (!route) {
          return Response.json({ ok: false, error: "eve_bot_missing" }, { status: 400 });
        }
        bot = shell.bots.find((item) => item.id === route?.threadId) ?? null;
        const members = bot && bot.kind === "group"
          ? groupMembers(speakersFrom(shell.bots), bot.memberIds)
          : [];
        body = new TextEncoder().encode(rewriteEveTurnBody(raw, bot, route, members, notes));
        headers.set("content-type", "application/json");
      } catch {
        // A carry-over or a retry note that could not be folded in is refused
        // here: forwarding the original body would relay those fields to eve
        // and record a carry-over the new session does not hold.
        if (notes.length > 0) {
          return Response.json({ ok: false, error: "eve_message_invalid" }, { status: 400 });
        }
        /* keep the original body: a malformed turn must fail at eve, not here */
      }
      // Outside the body-rewrite try on purpose. The tools that run during
      // this turn read the workspace grant for the session, so it has to be
      // current — stamped or revoked — before the turn reaches eve. Sharing
      // the catch above would turn a grants-store failure into a silent "keep
      // going with whatever the file still says", which is the stale
      // capability this stamp exists to prevent. A bot we could not resolve
      // revokes rather than leaves the old grant standing: no grant falls
      // back to the legacy root with approval cards, which is a narrowing.
      // Continuation posts carry the session id in the path; a create is
      // stamped from the response below.
      if (suffix !== "session") {
        const sessionId = suffix.split("/")[1] ?? "";
        if (sessionId) {
          try {
            if (bot) syncSessionWorkspace(sessionId, bot);
            else removeSessionGrant(sessionId);
          } catch {
            return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
          }
        }
      }
    }
  }
  try {
    const signal = method === "GET"
      ? request.signal
      : AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
    // readBody allocates an exact-length Uint8Array, so its backing buffer is
    // the payload; the cast narrows ArrayBufferLike to the BodyInit type.
    const upstream = await fetch(target, { method, headers, body: body?.buffer as ArrayBuffer | undefined, signal });
    if (!upstream.ok) {
      // Keep the upstream status but never relay eve's internal error body to
      // the caller; it can carry runtime and prompt detail. The one exception
      // is the code that says the session is gone for good, which the client
      // needs to start a fresh one instead of dead-ending the chat.
      // Only a 409 body is read, and eve's is a few dozen bytes; every
      // other failure body is dropped unread as before.
      const text = upstream.status === 409
        ? await upstream.text().catch(() => "")
        : (await upstream.body?.cancel().catch(() => undefined), "");
      const code = relayedEveCode(upstream.status, text);
      // A session eve already retired can't act on its cards either.
      if (code === "session_not_active") retireCards(method, suffix);
      return Response.json(
        { ok: false, error: "eve_error", status: upstream.status, ...(code ? { code } : {}) },
        { status: upstream.status },
      );
    }
    retireCards(method, suffix);
    const out = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) out.set("content-type", ct);
    out.set("cache-control", "no-store");
    // A catch-up read (`includeTailIndex=1`) is told where the durable stream
    // ends, so it can stop there instead of waiting for the stream to go quiet.
    const tailIndex = upstream.headers.get("x-eve-stream-tail-index");
    if (tailIndex) out.set("x-eve-stream-tail-index", tailIndex);
    // A session create answers with the fresh session id. Capture the small
    // JSON body to stamp the grant before returning it: a tolerant parse that
    // fails still passes the body through untouched. The shell is re-read so
    // the stamp cannot come from a pre-request snapshot.
    if (method === "POST" && suffix === "session" && route) {
      const text = await upstream.text();
      let created = "";
      try {
        created = (JSON.parse(text) as { sessionId?: string }).sessionId ?? "";
      } catch {
        /* a body this build cannot parse still belongs to the caller */
      }
      if (created && carriedFrom) {
        // Recorded here, not by the client: this is the one place that knows
        // the carry-over was verified and the new session exists. The client
        // moves the live pointer with its usual touchChat.
        const previous = carriedFrom;
        const botId = route.threadId;
        let lost = false;
        try {
          updateShell((current) => {
            // Only over the session this carry-over came from: if another
            // client moved the pointer meanwhile, its session is the chat.
            const outcome = carryOverLineage(current, botId, previous, created);
            lost = outcome.lost;
            return outcome.store;
          });
          if (!lost) removeSessionGrant(previous);
        } catch (err) {
          // The new session already holds the brief; only a second carry-over
          // from this old session would be refused. Not worth failing the send,
          // but it is said.
          console.error("session lineage not recorded", err instanceof Error ? err.message : err);
        }
        if (lost) {
          // Two clients carried the same session over at once and the other
          // one's session is the chat now. This one's would fork it, so its
          // turn is stopped and the client told to catch up, the same answer
          // a carry-over from an already-moved session gets.
          console.error("carry-over lost the race; its session is cancelled");
          await cancelEveTurn(created, jwt ?? "");
          return Response.json({ ok: false, error: "eve_error", status: 409, code: "session_moved" }, { status: 409 });
        }
      }
      if (created) {
        try {
          const bot = readShell().bots.find((item) => item.id === route?.threadId) ?? null;
          if (bot) syncSessionWorkspace(created, bot);
          else removeSessionGrant(created);
        } catch {
          // The session exists upstream either way, so the body goes back. What
          // must not survive is a grant row this build could not make current:
          // without one the tools fall back to the legacy root with approval
          // cards, which is the narrower posture.
          try { removeSessionGrant(created); } catch { /* the next turn's stamp settles it */ }
        }
      }
      return new Response(text, { status: upstream.status, headers: out });
    }
    const encoded = sessionRouteHeader(route);
    // Tells the caller which bot or group answered, and which member an
    // @mention directed the turn at.
    if (encoded) out.set("x-ub-route", encoded);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return Response.json({ ok: false, error: "eve_unavailable" }, { status: 503 });
  }
}

import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { ApprovalStore, defaultApprovalsPath } from "../../../../../agent/lib/approvals.ts";
import {
  bodyHasInputResponses,
  childStreamQuery,
  turnRewriteFailure,
  eveGetAllowed,
  evePostAllowed,
  eveSessionRoute,
  hiddenPrefixChars,
  isEveSessionPost,
  parseInputResponses,
  parseTurnExtras,
  parseTurnMessage,
  relayedEveCode,
  rewriteEveTurnBody,
  sessionRouteHeader,
  turnHasImages,
  type SessionRoute,
} from "../../../../../shared/eve-proxy.ts";
import { catalogFor } from "../../../../../shared/live-models.ts";
import { exactModelOption, modelSeesImages } from "../../../../../shared/models.ts";
import { readProviderStore, type ProviderStore } from "../../../../../shared/providers.ts";
import { botSelection, lastPick } from "../../../../../shared/session-selection.ts";
import {
  admissionRefusal,
  briefMaxCharsFor,
  cancelEveTurn,
  channelJwt,
  continuationBriefFor,
  modelSelectionRefusal,
  sessionHasCompletedTurn,
  syncSessionWorkspace,
} from "../../../../lib/agent-exec";
import { authorizeChildCancel, authorizeChildStream, authorizeEveCall, carryOverReader, childStreamDeps, childWriteRefusal, type ChildCancel, type EveCallAuth } from "../../../../lib/eve-session-auth";
import { RETRY_NOTE } from "../../../../../shared/continuation-brief.ts";
import { EVE_BODY_MAX, apiError, rateLimited, readBody } from "../../../../lib/api-guard";
import { readShell, updateShell } from "../../../../../shared/shell-io.ts";
import { carryOverLineage, continueFromVerdict, settleContinuation, type ShellBot } from "../../../../../shared/shell-store.ts";
import { removeSessionGrant } from "../../../../../shared/workspace-store.ts";
import { bindSession, readSessionParent, resolveSessionBot, sessionCarriesOverFor } from "../../../../../shared/session-bindings.ts";
import { recordSubagentStop } from "../../../../../shared/subagent-stops.ts";
import { eveOrigin } from "../../../../../shared/stack.ts";

const EVE = eveOrigin();

/**
 * True only when the catalog says the bot's own model is text-only. The model
 * is the one the turn will run on (the bot's selection), looked up exactly: a
 * model the catalog does not list is unknown, not the list's first model.
 */
function rejectsImages(bot: ShellBot | null): boolean {
  const store = readProviderStore();
  const selection = bot ? botSelection(bot, store) : lastPick(store);
  const model = exactModelOption(selection.modelId, catalogFor(selection.connectionId));
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
function retireCards(method: string, suffix: string, search: string): void {
  const cancelled = method === "POST" ? /^session\/([^/]+)\/cancel$/.exec(suffix) : null;
  if (!cancelled) return;
  // The app's automatic cancel of a stopped-report turn says so with
  // scope=report: it retires only that session's own cards. Every other cancel
  // (the owner's Stop) also retires its sub-agents' cards, failing closed.
  const children = new URLSearchParams(search).get("scope") !== "report";
  try {
    new ApprovalStore(Date.now, defaultApprovalsPath()).expireSession(cancelled[1], { children });
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
  let target = `${EVE}/eve/v1/${suffix}${url.search}`;
  const sessionPath = /^session\/([^/]+)(?:\/(?:stream|cancel))?$/.exec(suffix);
  // A cancel into a sub-agent's child is verified as one decision (see
  // authorizeChildCancel), before anything else. eve's background tasks outlive
  // a parent's cancel, so this is the owner's way to stop one. Only a verified
  // result skips the write refusals below.
  let childCancel: Extract<ChildCancel, { kind: "verified" }> | null = null;
  if (sessionPath) {
    let decision: ChildCancel;
    try {
      decision = await authorizeChildCancel(method, suffix, url.search, childStreamDeps(), request.signal);
    } catch (err) {
      console.error("child cancel could not be verified", err instanceof Error ? err.message : err);
      const missing = err instanceof Error && err.message === "channel_credential_missing";
      return Response.json({ ok: false, error: missing ? "channel_credential_missing" : "child_session_unverifiable" }, { status: 503 });
    }
    if (decision.kind === "refused") return Response.json({ ok: false, error: decision.error }, { status: decision.status });
    if (decision.kind === "verified") childCancel = decision;
  }
  // A sub-agent's child session is otherwise read only. A send, a cancel or a
  // reset into one is refused here, whatever binding eve holds for it.
  if (method !== "GET" && sessionPath && !childCancel) {
    try {
      if (readSessionParent(sessionPath[1]) !== null) {
        return Response.json({ ok: false, error: "child_session_readonly" }, { status: 403 });
      }
    } catch (err) {
      console.error("child session check failed", err instanceof Error ? err.message : err);
      return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
    }
  }
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // The token names the bot the session path is bound to (see
  // authorizeEveCall). A create has none yet: it is minted below, once the
  // route has validated the bot.
  let jwt: string | null = null;
  const authorize = (raw: string | null): EveCallAuth | Response => {
    try {
      return authorizeEveCall(method, suffix, raw, (sessionId) => resolveSessionBot(sessionId, readShell()));
    } catch (err) {
      console.error("eve call could not be authorised", err instanceof Error ? err.message : err);
      const missing = err instanceof Error && err.message === "channel_credential_missing";
      return Response.json({ ok: false, error: missing ? "channel_credential_missing" : "workspace_unavailable" }, { status: 503 });
    }
  };
  if (method === "GET") {
    // A read of a sub-agent's child stream names the session it was delegated
    // from (`parent`) and the index of that session's `subagent.called` event
    // for it (`at`), which is checked against that one event on the parent's
    // own stream (see authorizeChildStream). A session recorded as a child is
    // never read without its parent.
    const child = sessionPath && suffix.endsWith("/stream") ? childStreamQuery(url.search) : null;
    let auth: EveCallAuth | Response;
    if (sessionPath && child?.present) {
      if (child.parent === null) return Response.json({ ok: false, error: "child_session_unverified" }, { status: 403 });
      try {
        auth = await authorizeChildStream(child.parent, sessionPath[1], child.at, childStreamDeps(), request.signal);
      } catch (err) {
        console.error("child stream could not be verified", err instanceof Error ? err.message : err);
        const missing = err instanceof Error && err.message === "channel_credential_missing";
        return Response.json({ ok: false, error: missing ? "channel_credential_missing" : "child_session_unverifiable" }, { status: 503 });
      }
      target = `${EVE}/eve/v1/${suffix}${child.search}`;
    } else {
      try {
        if (sessionPath && readSessionParent(sessionPath[1]) !== null) {
          return Response.json({ ok: false, error: "child_session_unverified" }, { status: 403 });
        }
      } catch (err) {
        console.error("child session check failed", err instanceof Error ? err.message : err);
        return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
      }
      auth = authorize(null);
    }
    if (auth instanceof Response) return auth;
    if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
    jwt = auth.jwt;
    if (jwt) headers.set("authorization", `Bearer ${jwt}`);
  }
  if (childCancel) {
    headers.set("authorization", `Bearer ${childCancel.jwt}`);
    target = `${EVE}/eve/v1/${suffix}${childCancel.search}`;
  }
  let body: Uint8Array | undefined;
  let route: SessionRoute | null = null;
  // The session a replacement carries over from, once verified.
  let carriedFrom: string | null = null;
  let carriedOwner: string | null = null;
  // An answer to an eve input request (a session limit, an approval): forwarded
  // as validated, never rewritten into a turn.
  let inputAnswer = false;
  if (method !== "GET") {
    try {
      body = await readBody(request, EVE_BODY_MAX);
    } catch (err) {
      const guarded = apiError(err);
      if (guarded) return guarded;
      throw err;
    }
    // Every session path, a cancel included, is authorised against the binding
    // for its path id before anything else; a create has no session yet.
    if (suffix !== "session" && !childCancel) {
      const auth = authorize(new TextDecoder().decode(body));
      if (auth instanceof Response) return auth;
      if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
      jwt = auth.jwt;
      if (jwt) headers.set("authorization", `Bearer ${jwt}`);
      if (isEveSessionPost(suffix) && auth.body !== null) body = new TextEncoder().encode(auth.body);
      if (isEveSessionPost(suffix) && bodyHasInputResponses(new TextDecoder().decode(body))) {
        // Same binding as a turn into this session (authorize above pinned the
        // bound bot); the body is rebuilt from the validated fields alone.
        const answer = parseInputResponses(new TextDecoder().decode(body));
        if (!answer.ok) return Response.json({ ok: false, error: "input_responses_invalid" }, { status: 400 });
        body = new TextEncoder().encode(JSON.stringify({ inputResponses: answer.inputResponses }));
        headers.set("content-type", "application/json");
        inputAnswer = true;
      }
    } else if (bodyHasInputResponses(new TextDecoder().decode(body))) {
      // A create opens a conversation with a message; there is nothing to answer yet.
      return Response.json({ ok: false, error: "input_responses_invalid" }, { status: 400 });
    }
    if (isEveSessionPost(suffix) && !inputAnswer) {
      // Identity first. A turn into an existing session belongs to the bot the
      // durable binding names for that session id, never to the bot the body
      // says: nothing else ties a session to a bot, and the body is the one
      // field a client chooses. A body that names another bot is refused, and
      // a session nobody bound is refused before eve sees it (a turn eve
      // accepts and then fails retires the session).
      let bot: ShellBot | null = null;
      // The session this turn goes into, whose mounted tools count against the
      // window; a create holds none.
      const intoSession = suffix === "session" ? null : suffix.split("/")[1] ?? null;
      // Set once the body is rewritten; see the check right after it.
      let finalRefusal: Response | null = null;
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
        // A session another bot owns, or that two bots both point at, is never
        // carried over into this bot (the ambiguity-aware resolver decides).
        let ownsPrior = false;
        try {
          ownsPrior = Boolean(owner && extras.continueFrom && sessionCarriesOverFor(extras.continueFrom, owner.id, readShell()));
        } catch {
          ownsPrior = false;
        }
        const verdict = suffix === "session" && owner && extras.continueFrom && ownsPrior
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
        carriedOwner = owner?.id ?? null;
      }
      // The cheap refusals come before any read of an old session. A
      // carry-over reads one back for its brief, thousands of events on a
      // long chat, and a turn refused here needed none of it.
      // A picture for a model that cannot look at it is refused before the
      // turn exists: eve would stage the bytes, the upstream would reject
      // the call, and the session would retire on the failed turn. A model
      // the catalog does not know goes through, and the upstream decides.
      let sender: ShellBot | null = null;
      // Providers store before the roster the sender comes from, the order the
      // freeze and the stamps use.
      let senderStore: ProviderStore;
      try {
        senderStore = readProviderStore();
      } catch (err) {
        console.error("bot selection could not be checked", err instanceof Error ? err.message : err);
        return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
      }
      try {
        const sent = JSON.parse(new TextDecoder().decode(body)) as { message?: unknown; botId?: unknown };
        const parsed = parseTurnMessage(sent.message);
        sender = typeof sent.botId === "string"
          ? readShell().bots.find((item) => item.id === sent.botId) ?? null
          : null;
        if (parsed !== null && turnHasImages(parsed) && rejectsImages(sender)) {
          return Response.json({ ok: false, error: "model_no_vision" }, { status: 400 });
        }
      } catch {
        /* a malformed body is judged by the rewrite below, as before */
      }
      // The bot's own model has to be servable before the turn reaches eve:
      // its connection signed in and its model still in the live list. The
      // router would refuse it too, but a turn eve has accepted and failed
      // retires the session, so the owner is told here and picks again. Never
      // a quiet switch to another model. A cheap refusal too, so it sits above
      // the carry-over read.
      try {
        const refusal = sender === null
          ? null
          : modelSelectionRefusal(sender, senderStore) ?? admissionRefusal(sender, readShell(), senderStore, 0, intoSession);
        if (refusal) return refusal;
      } catch (err) {
        console.error("bot selection could not be checked", err instanceof Error ? err.message : err);
        return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
      }
      // The carried session is read as the bot that owns it, the same claim the
      // new session will carry.
      if (carriedFrom) {
        let reader: ReturnType<typeof carryOverReader>;
        try {
          reader = carryOverReader(carriedFrom, carriedOwner, (id) => resolveSessionBot(id, readShell()));
        } catch (err) {
          console.error("carry-over could not be authorised", err instanceof Error ? err.message : err);
          const missing = err instanceof Error && err.message === "channel_credential_missing";
          return Response.json({ ok: false, error: missing ? "channel_credential_missing" : "workspace_unavailable" }, { status: 503 });
        }
        if (!reader.ok) return Response.json({ ok: false, error: reader.error }, { status: reader.status });
        notes.push(await continuationBriefFor(
          carriedFrom,
          reader.jwt,
          undefined,
          request.signal,
          sender ? briefMaxCharsFor(sender, readShell(), senderStore, null) : undefined,
        ));
      }
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
            // The earlier session is read only as the bot that owns it.
            let reader: ReturnType<typeof carryOverReader> | null = null;
            try {
              reader = carryOverReader(previous, owner.id, (id) => resolveSessionBot(id, readShell()));
            } catch (err) {
              console.error("earlier session could not be authorised", err instanceof Error ? err.message : err);
            }
            if (reader?.ok) {
              notes.push(await continuationBriefFor(
                previous,
                reader.jwt,
                undefined,
                request.signal,
                sender ? briefMaxCharsFor(sender, readShell(), senderStore, target) : undefined,
              ));
            }
            else console.error("earlier session is not this bot's; its brief was not read");
          }
        }
      }
      if (extras.retry) notes.push(RETRY_NOTE);
      let stampStore: ProviderStore | null = null;
      try {
        const raw = new TextDecoder().decode(body);
        // Store before roster, as the agent freezes (see syncSessionWorkspaceFresh).
        stampStore = readProviderStore();
        const shell = readShell();
        route = eveSessionRoute(raw, shell);
        if (!route) {
          return Response.json({ ok: false, error: "eve_bot_missing" }, { status: 400 });
        }
        bot = shell.bots.find((item) => item.id === route?.threadId) ?? null;
        body = new TextEncoder().encode(rewriteEveTurnBody(raw, route, notes));
        // The definitive check, on the very bot, roster and providers store
        // this turn is dispatched with, and the whole hidden prefix it carries
        // (the brief, a retry note, the mention line and their framing). The
        // earlier checks only spared a long carry-over read; the owner may have
        // changed the model, the instructions or the notes during it.
        if (bot) {
          finalRefusal = modelSelectionRefusal(bot, stampStore)
            ?? admissionRefusal(bot, shell, stampStore, hiddenPrefixChars(route, notes), intoSession);
        }
        headers.set("content-type", "application/json");
      } catch (err) {
        // Routing and rewriting fail closed. Forwarding the original body
        // would open a session this proxy never resolved a route for, which
        // would stay unbound, and would relay carry-over fields eve must not
        // see. A bad message is the caller's 400; a store failure is a 503.
        console.error("turn could not be routed", err instanceof Error ? err.message : err);
        const failure = turnRewriteFailure(err);
        return Response.json({ ok: false, error: failure.error }, { status: failure.status });
      }
      if (!route) {
        return Response.json({ ok: false, error: "session_route_failed" }, { status: 503 });
      }
      if (finalRefusal) return finalRefusal;
      if (suffix === "session") {
        // A create is made as the validated route bot, never as a bot the body
        // names but the roster does not hold (eveSessionRoute returned null for it).
        try {
          jwt = channelJwt(route.threadId);
        } catch (err) {
          console.error("new session could not be authorised", err instanceof Error ? err.message : err);
          return Response.json({ ok: false, error: "channel_credential_missing" }, { status: 503 });
        }
        headers.set("authorization", `Bearer ${jwt}`);
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
            if (bot) syncSessionWorkspace(sessionId, bot, stampStore ?? undefined);
            else removeSessionGrant(sessionId);
          } catch {
            return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
          }
        }
      }
    }
  }
  // A child can be recorded while this request was being read and prepared:
  // one last look, right before anything reaches eve.
  try {
    const readOnly = childCancel ? null : childWriteRefusal(method, suffix, (id) => readSessionParent(id) !== null);
    if (readOnly) return Response.json({ ok: false, error: readOnly.error }, { status: readOnly.status });
  } catch (err) {
    console.error("child session check failed", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: "workspace_unavailable" }, { status: 503 });
  }
  // Before the cancel reaches eve, so the marker exists when eve's cancelled
  // report reaches the parent. A marker that cannot be written is said, not hidden.
  if (childCancel) {
    try {
      recordSubagentStop({ rootSessionId: childCancel.parent, childSessionId: childCancel.child, agentId: childCancel.agentId });
    } catch (err) {
      console.error("owner stop of a sub-agent was not recorded", err instanceof Error ? err.message : err);
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
      if (code === "session_not_active") retireCards(method, suffix, url.search);
      return Response.json(
        { ok: false, error: "eve_error", status: upstream.status, ...(code ? { code } : {}) },
        { status: upstream.status },
      );
    }
    retireCards(method, suffix, url.search);
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
      if (created && route) {
        // The new session is bound to the bot before anything else happens to
        // it, so every tool the first turn runs finds its owner. eve minted
        // the id inside this call, so this is the earliest point it exists.
        // A session that cannot be bound is stopped: it would run unowned.
        try {
          bindSession(created, route.threadId);
        } catch (err) {
          console.error("new session could not be bound", err instanceof Error ? err.message : err);
          await cancelEveTurn(created, jwt ?? "");
          return Response.json({ ok: false, error: "session_bind_failed" }, { status: 503 });
        }
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
          // Store before roster, as the agent freezes.
          const store = readProviderStore();
          const bot = readShell().bots.find((item) => item.id === route?.threadId) ?? null;
          if (bot) syncSessionWorkspace(created, bot, store);
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

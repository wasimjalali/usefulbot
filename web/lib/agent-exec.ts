import { createHmac } from "node:crypto";
import {
  appendAgentEvent,
  referencedWidgetIds,
  sweepOrphanThreads,
  type ThreadKind,
} from "../../shared/agent-store.ts";
import { sweepOrphanWidgets } from "../../shared/widgets-store.ts";
import { libraryDrawingIds } from "../../shared/media-store.ts";
import { parseEveStreamLine, takeStreamLines, type EveEvent as StreamEvent } from "../../shared/eve-stream.ts";
import { BRIEF_MAX_CHARS, buildContinuationBrief, settledByBriefTurn, withSessionNotes } from "../../shared/continuation-brief.ts";
import { relayedEveCode } from "../../shared/eve-proxy.ts";
import { sendHandoff, writeHandoffReply } from "../../shared/agents-send.ts";
import {
  claimHandoff,
  listDeliverable,
  markDelivered,
  markFailed,
  ownsHandoffClaim,
  readHandoff,
  releaseHandoffClaim,
  HANDOFF_ATTEMPTS_MAX,
  HANDOFF_DEPTH_MAX,
  type HandoffRecord,
} from "../../shared/handoffs.ts";
import {
  appendRoutineRun,
  claimDueRoutine,
  readRoutine,
  claimManualRun,
  claimRunNow,
  pendingRoutines,
  sweepOrphanRoutines,
  type Routine,
  type RoutineRunStatus,
} from "../../shared/routines-store.ts";
import { peekShell, readShell, shellWasReseeded, updateShell } from "../../shared/shell-io.ts";
import { removeSessionGrant, upsertSessionGrant } from "../../shared/workspace-store.ts";
import { bindSession, resolveSessionBot } from "../../shared/session-bindings.ts";
import { DESCRIPTION_MAX, freezeNullSelections, GENERALIST_SEED_V2, recordSessionLineage, type ShellBot } from "../../shared/shell-store.ts";
import { botSelection, type ModelSelection } from "../../shared/session-selection.ts";
import { retiredRouteMessage } from "../../shared/provider-catalog.ts";
import { effectiveDefault, ProviderRouteRetiredError, readProviderStore, selectionAvailability, type ProviderStore } from "../../shared/providers.ts";
import { eveOrigin } from "../../shared/stack.ts";
import {
  admission,
  briefBudgetChars,
  CONTEXT_TOO_LARGE_TEXT,
  DESCRIPTION_TOO_LONG_TEXT,
  descriptionTooLong,
  envelopeFor,
  seedFor,
  type Admission,
} from "../../shared/admission.ts";
import { flat } from "../../shared/context-blocks.ts";
import { NOTES_BLOCK_CAP } from "../../shared/notes-block.ts";
import { renderNotesFor } from "../../agent/memory/notes.ts";
import { eagerConnections, mountedToolBytes, selectMountedTools } from "../../shared/connection-tools.ts";
import { connectionIndex, sessionTools } from "../../shared/connection-tools-store.ts";
import { readConnectionsStore } from "../../shared/connections-store.ts";
import { sharedMemoryStore } from "../../agent/lib/memory.ts";

/**
 * Handoff delivery. The sending agent tool only writes a queue record, so a
 * bot-to-bot message never blocks the sender's turn. The web server drains that
 * queue: it opens (or reuses) the receiving bot's eve session, waits for the
 * reply, and appends the result to the receiving transcript.
 */

const EVE = eveOrigin();
/**
 * A handoff is a bot waiting on another bot inside its own turn, so the wait
 * has to stay short: two minutes, then the sender is told it got nothing.
 */
const DELIVER_TIMEOUT_MS = 120_000;
/**
 * A routine is not a wait, it is the work. The same two minutes were applied
 * to it, and a scheduled job that scans a folder or files documents runs far
 * longer than that: at 120 seconds the reader gave up, the run was written to
 * history as `failed: This operation was aborted`, and the turn it had started
 * carried on inside eve for hours. The owner saw a routine cut off mid-sentence
 * with a bot that never stopped working. A routine gets an hour, bounded by an
 * idle cap so a genuinely stuck turn is still let go of.
 */
const ROUTINE_TIMEOUT_MS = 60 * 60_000;
/**
 * No event at all from the session for this long ends the run. Sized off the
 * longest gap a healthy turn can leave: a model call the router caps at 180
 * seconds, a shell line the bash tool caps at 60, or a `send_to_bot` waiting
 * out a teammate's whole turn on the handoff's two-minute budget. Ten minutes
 * clears all three with room to spare, so silence this long is a turn that is
 * not coming back rather than one taking its time.
 */
const ROUTINE_IDLE_MS = 10 * 60_000;

/**
 * Length of the notes block this bot's turn carries, read from the memory
 * store without writing. A store that will not read counts as a full block:
 * admission stays conservative and the failure is logged, so a notes outage
 * never fails a chat and never makes a send look smaller than it is.
 */
export function notesCharsFor(botId: string): number {
  try {
    return renderNotesFor(botId, sharedMemoryStore).length;
  } catch (err) {
    console.error("notes could not be read for admission; counted as a full block", err instanceof Error ? err.message : err);
    return NOTES_BLOCK_CAP;
  }
}

/**
 * Characters of tool schemas mounted on top of the built-in set: the OpenAPI
 * connections mounted every turn (already clamped to their budget) and the
 * MCP tools this session picked up on demand, each weighed the way it is
 * mounted. A new session holds none.
 */
export function mountedToolChars(sessionId: string | null): number {
  let chars = 0;
  for (const entry of eagerConnections()) chars += mountedToolBytes(entry) ?? 0;
  if (sessionId) {
    const connections = readConnectionsStore().connections;
    // The same selection the resolver mounts with (agent/tools/connection_tools.ts).
    for (const pick of selectMountedTools(sessionTools(sessionId), {
      connection: (id) => connections.find((item) => item.id === id),
      indexed: (id, tool) => connectionIndex(id)?.tools.find((item) => item.name === tool),
    })) {
      chars += pick.weight;
    }
  }
  return chars;
}

/**
 * What the Settings counter shows for one bot (GET /api/bots/context): its
 * instructions' length, the fixed envelope of a turn against the model's
 * window, and for the Generalist the shipped text with whether the saved one
 * differs. Null when the bot is not on the roster. Providers first, then the
 * roster, the order the freeze reads them in.
 */
export function botContextReport(botId: string) {
  const store = readProviderStore();
  const shell = readShell();
  const bot = shell.bots.find((item) => item.id === botId);
  if (!bot) return null;
  const envelope = envelopeFor({
    bot,
    shell,
    store,
    notesChars: notesCharsFor(bot.id),
    mountedToolChars: mountedToolChars(bot.sessionId ?? null),
  });
  return {
    descriptionChars: envelope.descriptionChars,
    max: DESCRIPTION_MAX,
    envelopeTokens: envelope.tokens,
    windowTokens: envelope.windowTokens,
    modelLabel: envelope.modelLabel,
    fits: envelope.tokens <= envelope.windowTokens && envelope.descriptionChars <= DESCRIPTION_MAX,
    seed: seedFor(bot, GENERALIST_SEED_V2),
  };
}

/**
 * Admission for one bot's turn, reading the notes it would carry and the tool
 * schemas mounted for its session. `hiddenChars` is the whole hidden prefix the
 * turn adds (see `hiddenPrefixChars`). `sessionId` is the session the turn goes
 * into, or null for a new one.
 */
export function admitTurn(
  bot: ShellBot,
  shell: { bots: ShellBot[] },
  store: ProviderStore,
  hiddenChars = 0,
  sessionId: string | null = bot.sessionId ?? null,
): Admission {
  return admission({
    bot,
    shell,
    store,
    notesChars: notesCharsFor(bot.id),
    briefChars: hiddenChars,
    mountedToolChars: mountedToolChars(sessionId),
  });
}

/** The most a carry-over brief may take for this bot's model. */
export function briefMaxCharsFor(
  bot: ShellBot,
  shell: { bots: ShellBot[] },
  store: ProviderStore,
  sessionId: string | null = bot.sessionId ?? null,
): number {
  return briefBudgetChars(
    { bot, shell, store, notesChars: notesCharsFor(bot.id), mountedToolChars: mountedToolChars(sessionId) },
    BRIEF_MAX_CHARS,
  );
}

/**
 * The 409 a proxy send gets back when the bot's stored instructions are over
 * the cap, or the fixed envelope does not fit its model. Null when it fits.
 */
export function admissionRefusal(
  bot: ShellBot,
  shell: { bots: ShellBot[] },
  store: ProviderStore,
  hiddenChars = 0,
  sessionId: string | null = bot.sessionId ?? null,
): Response | null {
  if (descriptionTooLong(bot)) {
    return Response.json(
      { ok: false, error: "description_too_long", message: DESCRIPTION_TOO_LONG_TEXT },
      { status: 409 },
    );
  }
  const verdict = admitTurn(bot, shell, store, hiddenChars, sessionId);
  if (verdict.ok) return null;
  return Response.json({ ok: false, error: verdict.code, message: verdict.message }, { status: 409 });
}

/**
 * Stamp — or revoke — the workspace grant a turn's tools will read. Called
 * from the eve proxy and from server-driven turns: the agent process
 * resolves the grant per session, so it must be current before the turn
 * reaches eve. A bot whose folder was detached revokes the grant here, so
 * capability never outlives the owner's decision.
 */
export function syncSessionWorkspace(
  sessionId: string,
  bot: ShellBot,
  // A caller that read the roster passes a store read taken BEFORE that roster
  // read (see syncSessionWorkspaceFresh): the same order the agent freezes in.
  store: ProviderStore = readProviderStore(),
  // A permission or folder change mid-turn re-stamps the grant but must not
  // move the turn's model: the no-turn-id freeze path reads the grant every
  // step. Such callers pass the selection the turn start stamped, read
  // before anything revoked the grant (a detach revokes it first).
  options: { keptSelection?: ModelSelection } = {},
): void {
  if (!sessionId) return;
  const kept = options.keptSelection;
  // Always stamped: the permission is the bot's whether or not a folder is
  // attached. No folder means the bot works under the owner's home.
  // The model rides in the same write, so the agent reads one grant for both:
  // the bot's own selection, or the current effective default for a bot that
  // inherits it (model null).
  upsertSessionGrant({
    sessionId,
    path: bot.workspace?.path ?? null,
    permission: bot.permission,
    selection: kept ?? botSelection(bot, store),
  });
}

/**
 * Pin every bot that has no model of its own to the effective default as it
 * stands now, so the per-bot pick that follows moves one bot only.
 *
 * A null bot inherits the default (the last pick, as the old global chip
 * resolved it), which is right until a pick would move it. This runs ONLY at
 * the start of a PUT /api/providers that carries a botId and any per-bot pick
 * (model, effort or speed), inside the providers lock, with the store that
 * call holds. Connect, sign-out, a
 * default-model change and the turn start leave null bots alone: they keep
 * inheriting, exactly as before. The pin is the effective default (the model
 * `composerState` resolves, with its snapped effort and speed), not the raw
 * stored model, so it is what the owner's chip showed. When that default is
 * not usable (nothing connected yet) nothing is pinned and the bots stay null,
 * by design: they had no running selection, so they follow the next usable pick.
 * Idempotent: bots that already chose are untouched.
 */
export function ensureBotSelections(providerStore: ProviderStore = readProviderStore()): void {
  if (!readShell().bots.some((bot) => bot.model === null)) return;
  const pick = effectiveDefault(providerStore);
  if (!pick) return;
  updateShell((current) => freezeNullSelections(current, pick));
}

/**
 * The eve proxy's refusal for a send to a bot whose selection cannot carry a
 * turn, or null when it can. The same envelope as the proxy's other errors.
 * Pure of eve: the caller answers with it before any fetch to eve.
 */
export function modelSelectionRefusal(bot: ShellBot, store: ProviderStore): Response | null {
  const retired = retiredRouteMessage(botSelection(bot, store).connectionId);
  if (retired) {
    return Response.json({ ok: false, error: "provider_route_retired", message: retired }, { status: 409 });
  }
  if (botSelectionUsable(bot, store)) return null;
  return Response.json(
    {
      ok: false,
      error: "model_selection_unavailable",
      message: "This bot's model or its connection is no longer available. Pick a model for it again.",
    },
    { status: 409 },
  );
}

/**
 * Whether the bot's selection can carry a turn: its connection is live and its
 * model is still listed. The caller reads `store` BEFORE the roster the bot
 * came from (the order the freeze and the stamps use), so a fresh store never
 * pairs with an older roster.
 */
export function botSelectionUsable(bot: ShellBot, store: ProviderStore): boolean {
  return selectionAvailability(store, botSelection(bot, store)).available;
}

/**
 * Stamp from the roster as it is right now, not from a snapshot taken before
 * an await. `runEveTurn` reads the shell, then spends up to twenty seconds
 * replaying the session stream; stamping the pre-await bot in that window
 * resurrects a grant the owner detached while it ran. A bot that has since
 * disappeared revokes rather than keeps its old capability.
 */
function syncSessionWorkspaceFresh(sessionId: string, botId: string): void {
  if (!sessionId) return;
  try {
    // Providers store first, roster second: the web write order moves a pin in
    // the shell before the default in the store, so a fresh store implies a
    // roster at least as fresh (the same order the turn snapshot reads in).
    const store = readProviderStore();
    let bot: ShellBot | undefined;
    try {
      bot = readShell().bots.find((item) => item.id === botId);
    } catch {
      // An unreadable roster is not permission to keep the grant.
      removeSessionGrant(sessionId);
      return;
    }
    if (!bot) {
      removeSessionGrant(sessionId);
      return;
    }
    syncSessionWorkspace(sessionId, bot, store);
  } catch (err) {
    // A contended grants store must not surface as a raw lock code in a
    // routine's transcript note. The turn does not start: running it against a
    // grant this process could not make current is the thing to avoid.
    throw new Error("workspace_unavailable", { cause: err });
  }
}

/**
 * Pump state, one copy per PROCESS rather than per module instance. The Next
 * dev server gives each API route its own copy of this module, so plain
 * module-level sets were not shared: a Test run (the run route) marked a
 * routine in flight in a set the tick route never saw. The rail showed that bot
 * as idle, and the in-memory mutex between a manual run and the scheduler did
 * not hold across the two routes (the durable store claim was the only guard).
 * Found live on 2026-09-17: five routines running, tick reported none.
 */
interface PumpState {
  inflight: Set<string>;
  routinesInflight: Set<string>;
  pumpQueue: Promise<unknown>;
  routineQueue: Promise<unknown>;
}
const PUMP_STATE_KEY = Symbol.for("useful-bot.agent-exec.pump-state");
const pumpState: PumpState = ((globalThis as Record<symbol, unknown>)[PUMP_STATE_KEY] ??= {
  inflight: new Set<string>(),
  routinesInflight: new Set<string>(),
  pumpQueue: Promise.resolve(),
  routineQueue: Promise.resolve(),
}) as PumpState;

const inflight = pumpState.inflight;

type EveEvent = { type?: string; data?: Record<string, unknown>; meta?: { id?: string; at?: string } };

/** Who is calling eve: the owner's app, a handoff pump delivery or a routine run. */
export type ChannelDelivery = "owner" | "handoff" | "routine";

/**
 * The bot claim is a string on purpose: eve projects only string claims into
 * the session's auth attributes and drops the rest. A null bot is a token with
 * no claim, which eve's channel accepts for nothing but a cancel.
 */
function signChannelJwt(secret: string, sub: string, botId: string | null, delivery?: ChannelDelivery): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iss: "useful-bot",
    aud: "useful-bot",
    ...(botId === null ? {} : { botId }),
    ...(delivery ? { delivery } : {}),
    iat: now,
    exp: now + 12 * 60 * 60,
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function agentsEnabled(): boolean {
  return Boolean(process.env.UB_CHANNEL_JWT || process.env.UB_CHANNEL_JWT_SECRET);
}

// A token per bot and delivery kind, signed from the channel secret and cached
// until it nears expiry. The web process is long-lived, so a cached token has
// to be re-signed before its 12 hours run out. There is no fallback to the
// UB_CHANNEL_JWT env token for eve: it carries no bot claim, and eve refuses
// a token without one. That env value stays only as the tick route's key.
const signedChannelJwts = new Map<string, { secret: string; token: string; exp: number }>();

/** A token for one bot. A call is never made as no bot: an empty id throws. */
export function channelJwt(botId: string, delivery: ChannelDelivery = "owner"): string {
  if (typeof botId !== "string" || botId.length === 0) throw new Error("channel_bot_missing");
  return cachedChannelJwt(botId, delivery);
}

/**
 * A token with no bot claim, for the calls eve accepts without one: health,
 * info and the cancel of a session nobody bound. Never for a turn or a read.
 */
export function channelJwtNoBot(): string {
  return cachedChannelJwt(null, "owner");
}

function cachedChannelJwt(botId: string | null, delivery: ChannelDelivery): string {
  const secret = process.env.UB_CHANNEL_JWT_SECRET;
  if (!secret) throw new Error("channel_credential_missing");
  const now = Math.floor(Date.now() / 1000);
  const key = `${botId ?? ""}\u0000${delivery}`;
  const cached = signedChannelJwts.get(key);
  // Re-sign once the cached token is within an hour of its exp, or when the
  // secret itself changed; signing is cheap but there is no reason to do it
  // on every proxy request.
  if (cached && cached.secret === secret && now < cached.exp - 60 * 60) return cached.token;
  const token = signChannelJwt(secret, "desktop-app", botId, delivery);
  signedChannelJwts.set(key, { secret, token, exp: now + 12 * 60 * 60 });
  return token;
}

function textField(data: Record<string, unknown> | undefined, key: string): string {
  const value = data?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Follow an eve session stream to the end of the turn in progress.
 * `message.appended` deltas accumulate; `message.completed` is authoritative
 * when it carries text. Resolves with an empty string if the turn ends with no
 * assistant text, which is recorded as an empty reply rather than a failure.
 */
export async function readHandoffStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  historyIds: Set<string> = new Set(),
  expectedMessage = "",
  /** Called for every event parsed, so a caller can keep an idle timer fed. */
  onEvent?: () => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let done = false;
  // Events replayed from before this delivery are ignored; then the reader only
  // starts collecting once eve echoes the exact envelope for this handoff, so a
  // gap in the id skip set can never resolve with an older turn's reply.
  let armed = expectedMessage.length === 0;
  let seenNew = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) {
    onAbort();
    return "";
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!payload || payload === "[DONE]") continue;
        let event: EveEvent | null = null;
        try {
          event = JSON.parse(payload) as EveEvent;
        } catch {
          continue;
        }
        if (!event || typeof event.type !== "string") continue;
        // Before the history skip: a replay of a long session is progress too,
        // and an idle timer that only counted new events would fire part way
        // through one.
        onEvent?.();
        const eventId = event.meta?.id;
        if (eventId && historyIds.has(eventId)) continue;
        if (!armed) {
          if (event.type === "message.received" && textField(event.data, "message") === expectedMessage) {
            armed = true;
          }
          continue;
        }
        if (event.type === "message.received" || event.type === "message.appended" || event.type === "step.started") {
          seenNew = true;
        }
        if (event.type === "message.appended") {
          text += textField(event.data, "messageDelta");
        } else if (event.type === "message.completed") {
          seenNew = true;
          const full = textField(event.data, "message");
          if (full) text = full;
        } else if (
          event.type === "turn.completed"
          || event.type === "turn.cancelled"
          || event.type === "turn.failed"
          || event.type === "session.failed"
          || event.type === "session.waiting"
        ) {
          if (seenNew) done = true;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  if (expectedMessage && !armed) {
    // Our envelope never came back: marking this delivered with an empty reply
    // would silently drop the handoff from the receiver transcript.
    throw new Error("envelope_mismatch");
  }
  return text.trim();
}

/**
 * Every event id a session already holds. The post-send read uses this to skip
 * the replayed history, so a second handoff into the same chat does not resolve
 * with the previous turn's reply.
 */
async function sessionEventIds(sessionId: string, jwt: string): Promise<Set<string>> {
  const ids = new Set<string>();
  // The stream pauses after every turn with session.waiting but stays open, so
  // "done" is a short quiet period after the last replayed event, not the first
  // waiting marker. Stopping at the first marker misses later turns and makes
  // the next delivery resolve with an older reply.
  const controller = new AbortController();
  const idleMs = 2_000;
  let idle = setTimeout(() => controller.abort(), idleMs);
  const hard = setTimeout(() => controller.abort(), 20_000);
  const reset = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleMs);
  };
  try {
    const res = await fetch(`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0`, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return ids;
    reset();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      reset();
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseEveStreamLine(line);
        if (event?.meta?.id) ids.add(event.meta.id);
      }
    }
  } catch {
    /* idle timeout: whatever history was collected is enough */
  } finally {
    clearTimeout(idle);
    clearTimeout(hard);
  }
  return ids;
}

/** How much of an old session the carry-over reads before it stops. */
const CARRY_READ = { headEvents: 400, tailEvents: 20_000, idleMs: 3_000, hardMs: 15_000, maxBytes: 48 * 1024 * 1024 };

/**
 * Up to `count` events from absolute index `start`, plus the stream's tail
 * index from eve's catch-up header. The stream stays open after its last
 * event, so the read stops at the count; the quiet period only guards a
 * stream that stalls, and is armed once the headers are in.
 */
async function readStreamRange(
  sessionId: string,
  jwt: string,
  start: number,
  count: number,
  outer?: AbortSignal,
): Promise<{ events: StreamEvent[]; tail: number | null; cut: boolean; next: number }> {
  const events: StreamEvent[] = [];
  // Stream positions taken, counted per event line whether or not it parsed:
  // `start + consumed` is where the next read begins, with no line skipped or
  // read twice at the seam.
  let consumed = 0;
  const controller = new AbortController();
  // The caller gave up (the owner's request went away): stop reading too.
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", () => controller.abort(), { once: true });
  const hard = setTimeout(() => controller.abort(), CARRY_READ.hardMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), CARRY_READ.idleMs);
  };
  let tail: number | null = null;
  let cut = false;
  let bytes = 0;
  try {
    const url = `${EVE}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${start}&includeTailIndex=1`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`eve_stream_${res.status}`);
    const header = Number(res.headers.get("x-eve-stream-tail-index"));
    tail = res.headers.has("x-eve-stream-tail-index") && Number.isInteger(header) ? header : null;
    // Nothing recorded past `start`: no need to wait on a live stream.
    const wanted = tail === null ? count : Math.min(count, tail + 1 - start);
    if (wanted <= 0) {
      await res.body.cancel().catch(() => undefined);
      return { events, tail, cut, next: start };
    }
    reset();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (consumed < wanted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      reset();
      bytes += chunk.value.byteLength;
      if (bytes > CARRY_READ.maxBytes) {
        cut = true;
        break;
      }
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      const taken = takeStreamLines(lines, wanted - consumed);
      consumed += taken.consumed;
      events.push(...taken.events);
    }
    await reader.cancel().catch(() => undefined);
  } catch (err) {
    // The deadline or a stalled stream ended the read. What came in is kept
    // and marked cut; anything else is a real failure.
    if (!controller.signal.aborted) throw err;
    cut = true;
  } finally {
    if (idle) clearTimeout(idle);
    clearTimeout(hard);
  }
  return { events, tail, cut, next: start + consumed };
}

/**
 * A session's recorded events for the carry-over brief: its opening (the
 * original request, any brief it inherited) and its newest stretch (the
 * latest work, the todo list and the failure that ended it). On a long
 * session the middle is skipped and counted, never the end. An empty read
 * throws, so the brief says the context was lost instead of pretending
 * there was none.
 */
export async function readSessionEvents(
  sessionId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<{ events: StreamEvent[]; skipped: number; cut: boolean }> {
  const head = await readStreamRange(sessionId, jwt, 0, CARRY_READ.headEvents, signal);
  if (head.events.length === 0) throw new Error("eve_stream_empty");
  if (head.tail === null) {
    // No tail index: only the opening is certain, and the end may be missing.
    return { events: head.events, skipped: 0, cut: true };
  }
  const total = head.tail + 1;
  if (total <= head.next) return { events: head.events, skipped: 0, cut: head.cut };
  const start = Math.max(head.next, total - CARRY_READ.tailEvents);
  const rest = await readStreamRange(sessionId, jwt, start, total - start, signal);
  return {
    events: [...head.events, ...rest.events],
    skipped: start - head.next,
    // A live session can grow between the two reads; what came after the
    // first tail index was not read, so the brief says its end may be missing.
    cut: head.cut || rest.cut || rest.next < total || (rest.tail !== null && rest.tail > head.tail),
  };
}

/**
 * Whether a session has finished a turn yet. Until it has, the message that
 * opened it (and the brief that rode on it) may have been dropped by a
 * step-zero failure. Reads the opening and the newest stretch of the stream.
 */
export async function sessionHasCompletedTurn(sessionId: string, jwt: string, signal?: AbortSignal): Promise<boolean> {
  // A completed step commits the prompt, opening message included, to eve's
  // history; a cancelled turn keeps its accepted input too. Only a turn that
  // carried the brief counts: a handoff completing in the unsettled window
  // left the dropped brief dropped.
  const head = await readStreamRange(sessionId, jwt, 0, CARRY_READ.headEvents, signal);
  if (settledByBriefTurn(head.events)) return true;
  if (head.tail === null || head.tail + 1 <= head.next) return false;
  // The rest is read from where the head stopped, as far back as the brief
  // read goes, so a head cut short cannot leave a gap the settling step sat
  // in. The brief turn's message may be in the head, so both are judged.
  const start = Math.max(head.next, head.tail + 1 - CARRY_READ.tailEvents);
  const tail = await readStreamRange(sessionId, jwt, start, head.tail + 1 - start, signal);
  return settledByBriefTurn([...head.events, ...tail.events]);
}

/**
 * The brief a replacement session opens with. A stream that cannot be read
 * still yields a brief that says so, so the bot tells the owner it lost the
 * thread instead of acting as if there never was one.
 */
export async function continuationBriefFor(
  sessionId: string,
  jwt: string,
  reason?: string,
  signal?: AbortSignal,
  /** The most the brief may take, sized from the bot's window (see briefMaxCharsFor). */
  maxChars?: number,
): Promise<string> {
  try {
    const read = await readSessionEvents(sessionId, jwt, signal);
    return buildContinuationBrief(read.events, { reason, skipped: read.skipped, cut: read.cut, maxChars });
  } catch {
    return buildContinuationBrief([], {
      reason: `${reason ?? "the previous session stopped"}; its conversation could not be read back, so tell the owner you lost the earlier context and ask what to pick up`,
    });
  }
}

function handoffEnvelope(handoff: HandoffRecord): string {
  // Names are flattened to one line: the transcript and the brief recognise a
  // handoff by lines 1 and 2, and a newline in a name would break both.
  const source = flat(handoff.sourceName) || "a bot";
  const group = handoff.groupName ? flat(handoff.groupName) || "this group" : "";
  const lines = [
    `Handoff from ${source}.`,
    group ? `This belongs to the group chat ${group}.` : "This arrives in your own chat.",
    // Lines 1 and 2 above are parsed by the transcript (Swift isHandoffEnvelope,
    // continuation-brief.ts): keep them exactly.
    `This is another bot on this Mac, not the owner. Do the part that fits your role and permission, and say what you declined. Your reply goes back to ${source} and the owner reads both chats.`,
    ...(handoff.depth > 0 ? [`Relay hop ${handoff.depth} of ${HANDOFF_DEPTH_MAX}.`] : []),
    "",
    handoff.message,
  ];
  return lines.join("\n");
}

function receiverOf(handoff: HandoffRecord, bots: ShellBot[]): { bot: ShellBot; kind: ThreadKind } | null {
  if (handoff.groupId) {
    const group = bots.find((bot) => bot.id === handoff.groupId && bot.kind === "group");
    if (group) return { bot: group, kind: "group" };
  }
  const target = bots.find((bot) => bot.id === handoff.targetBotId);
  return target ? { bot: target, kind: "bot" } : null;
}

/**
 * Open (or reuse) a bot's eve session, send one message and wait for the reply.
 * Shared by handoff delivery and by routine runs so both reach eve the same
 * way: the same envelope-matched stream read, the same timeout, the same
 * history skip that keeps a second send from resolving with an older turn.
 */
/**
 * Tag a failure with the session its turn ran in, so the run history can point
 * at it. The first writer wins: an inner frame knows the session better than
 * an outer one that only has the pointer it started with.
 */
function withSession(err: unknown, sessionId: string): unknown {
  if (sessionId && err instanceof Error && !(err as Error & { sessionId?: string }).sessionId) {
    (err as Error & { sessionId?: string }).sessionId = sessionId;
  }
  return err;
}

/**
 * Stop a turn this process gave up on. Best effort: the run is already over as
 * far as the caller is concerned, and a cancel that fails must not replace the
 * timeout it is cleaning up with an error of its own.
 */
export async function cancelEveTurn(sessionId: string, jwt: string): Promise<void> {
  try {
    await fetch(`${EVE}/eve/v1/session/${sessionId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* the turn outlives us either way */ }
}

/**
 * Bind a session eve just opened (or answered on) to its bot before the
 * grant stamp and before any tool of the turn can ask whose it is. A session
 * that cannot be bound would run unowned, so its turn is stopped.
 */
async function bindCreatedSession(sessionId: string, botId: string, jwt: string): Promise<void> {
  try {
    bindSession(sessionId, botId);
  } catch (err) {
    await cancelEveTurn(sessionId, jwt);
    throw err;
  }
}

async function runEveTurn(
  bot: ShellBot,
  message: string,
  budget: { totalMs: number; idleMs?: number } = { totalMs: DELIVER_TIMEOUT_MS },
  delivery: ChannelDelivery = "owner",
  /** App notes for the turn's hidden lines (a routine's "nobody is watching"); the transcript hides them. */
  notes: string[] = [],
): Promise<{ sessionId: string; reply: string }> {
  // Every eve call of this turn, the history read, the send, the stream and the
  // cancel, carries this bot's claim and this delivery kind.
  const jwt = channelJwt(bot.id, delivery);
  // The bot's own model has to be servable before the turn exists. The code is
  // the message, so a routine's failure note and a handoff's failure record
  // carry it as they do the other codes here. Never a substitute model.
  // Checked against the stores as they are at the moment of each send, since
  // every await between a check and its fetch lets the owner change the model,
  // the instructions or the notes. Providers store first, then the roster, as
  // the freeze reads them. Refused before any eve call, never clipped: the
  // stored instructions are over the cap, or the fixed envelope (with the
  // hidden prefix this very send carries) does not fit the bot's model window.
  const admitFresh = (hiddenChars: number, intoSession: string | null): ShellBot => {
    const freshStore = readProviderStore();
    const freshShell = readShell();
    const live = freshShell.bots.find((item) => item.id === bot.id) ?? bot;
    // A retired route's own sentence is the failure the owner reads.
    const retired = retiredRouteMessage(botSelection(live, freshStore).connectionId);
    if (retired) throw new ProviderRouteRetiredError(retired);
    if (!botSelectionUsable(live, freshStore)) throw new Error("model_selection_unavailable");
    if (descriptionTooLong(live)) throw new Error("description_too_long");
    if (!admitTurn(live, freshShell, freshStore, hiddenChars, intoSession).ok) throw new Error("context_too_large");
    return live;
  };
  const hidden = withSessionNotes("", notes).length;
  admitFresh(hidden, bot.sessionId ?? null);
  const path = bot.sessionId ? `session/${bot.sessionId}` : "session";
  // The body the proxy would have built for this bot: app notes first, then
  // the caller's text. readHandoffStream arms on this exact string,
  // because eve echoes the turn as it was stored.
  const sent = `${withSessionNotes("", notes)}${message}`;
  const controller = new AbortController();
  // Which of the two clocks ran out, for the error the caller reports. A bare
  // "This operation was aborted" was the whole explanation a cut-off routine
  // ever gave.
  // The first clock to fire is the one that stopped the run, and it keeps the
  // name: the other can still go off while this one is cancelling the turn.
  let expiry = "";
  const expire = (reason: string) => {
    if (expiry) return;
    expiry = reason;
    controller.abort();
  };
  const timer = setTimeout(() => expire("turn_budget_exhausted"), budget.totalMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const feedIdle = budget.idleMs === undefined ? undefined : () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("turn_went_silent"), budget.idleMs);
  };
  feedIdle?.();
  const follow = (stream: ReadableStream<Uint8Array>, ids: Set<string>, armed = sent) =>
    readHandoffStream(stream, controller.signal, ids, armed, feedIdle);
  let sessionId = bot.sessionId ?? "";
  let reply = "";
  try {
    // The session this turn continues must belong to this bot. A pointer that
    // names another bot's session is refused before eve sees the turn.
    // Through the ambiguity-aware resolve: a session two bots point at, or one
    // another bot owns, is refused. Only sessions eve creates below are bound
    // unconditionally.
    if (sessionId) {
      const owner = resolveSessionBot(sessionId, readShell());
      if (owner !== bot.id) throw new Error(owner ? "session_owner_conflict" : "session_binding_ambiguous");
    }
    let historyIds = sessionId ? await sessionEventIds(sessionId, jwt) : new Set<string>();
    // Again after the history read: that await is where a pick or an edit lands.
    admitFresh(hidden, sessionId || null);
    if (sessionId) syncSessionWorkspaceFresh(sessionId, bot.id);
    const res = await fetch(`${EVE}/eve/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ message: sent, botId: bot.id }),
      signal: controller.signal,
    });
    if (!res.ok && res.status === 409 && sessionId) {
      // eve retired the stored session (a failed turn ends it for good), so
      // drop the pointer and start a fresh one with this same message, the
      // way the UI clients recover.
      const text = await res.text().catch(() => "");
      if (relayedEveCode(409, text) === "session_not_active") {
        // The fresh session opens with a brief of the retired one, so the
        // bot keeps the thread instead of starting over empty.
        const retired = sessionId;
        // The owner's app may have carried this session over already. Then
        // the live session holds the thread, and a second carry-over would
        // fork the chat: this delivery joins the live one instead.
        const live = readShell().bots.find((item) => item.id === bot.id) ?? null;
        if (live?.sessionId && live.sessionId !== retired) {
          clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          return await runEveTurn(live, message, budget, delivery, notes);
        }
        const sizing = admitFresh(hidden, null);
        const brief = await continuationBriefFor(
          retired,
          jwt,
          undefined,
          undefined,
          briefMaxCharsFor(sizing, readShell(), readProviderStore(), null),
        );
        // The whole hidden prefix of the carried send, and the stores as they
        // are after the brief read, not the ones the first send was sized on.
        const carried = `${withSessionNotes("", [brief, ...notes])}${message}`;
        admitFresh(carried.length - message.length, null);
        const retry = await fetch(`${EVE}/eve/v1/session`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ message: carried, botId: bot.id }),
          signal: controller.signal,
        });
        if (!retry.ok) throw new Error(`eve_send_${retry.status}`);
        const retryBody = await retry.json() as { sessionId?: string };
        sessionId = retryBody.sessionId ?? "";
        if (!sessionId) throw new Error("eve_session_missing");
        await bindCreatedSession(sessionId, bot.id, jwt);
        // Persist the fresh pointer now, so a crash before the reply still
        // leaves later handoffs and routines on the live session.
        // Only over the retired pointer: if the owner's app replaced it in
        // the meantime, its session is the chat and this one stays a side
        // conversation holding this single delivery.
        const stamp = new Date().toISOString();
        const created = sessionId;
        updateShell((current) => {
          const now = current.bots.find((item) => item.id === bot.id);
          if (now && now.sessionId && now.sessionId !== retired) {
            console.error("pump carry-over lost the race; pointer left on the owner's session");
            return current;
          }
          return recordSessionLineage({
            ...current,
            bots: current.bots.map((item) => (
              item.id === bot.id
                ? { ...item, sessionId: created, lastAt: stamp, updatedAt: stamp }
                : item
            )),
          }, bot.id, retired, created);
        });
        historyIds = new Set<string>();
        // The retired session's workspace grant goes with it.
        try {
          removeSessionGrant(retired);
        } catch (err) {
          console.error("retired session grant not removed", err instanceof Error ? err.message : err);
        }
        syncSessionWorkspaceFresh(sessionId, bot.id);
        const stream = await fetch(`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0`, {
          headers: { authorization: `Bearer ${jwt}` },
          signal: controller.signal,
        });
        if (!stream.ok || !stream.body) throw new Error(`eve_stream_${stream.status}`);
        reply = await follow(stream.body, historyIds, carried);
        return { sessionId, reply };
      }
      throw new Error(`eve_send_${res.status}`);
    }
    if (!res.ok) throw new Error(`eve_send_${res.status}`);
    const body = await res.json() as { sessionId?: string };
    sessionId = body.sessionId ?? sessionId;
    if (!sessionId) throw new Error("eve_session_missing");
    await bindCreatedSession(sessionId, bot.id, jwt);
    syncSessionWorkspaceFresh(sessionId, bot.id);
    const stream = await fetch(`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0`, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    if (!stream.ok || !stream.body) throw new Error(`eve_stream_${stream.status}`);
    reply = await follow(stream.body, historyIds);
  } catch (err) {
    // Our clock ran out, not eve's. The turn is still running in there, and
    // walking away from it leaves the bot working on a job nobody is waiting
    // for any more: it holds the session, so the owner's next message to that
    // bot is refused as busy. Stop it, and say which clock it was.
    if (expiry) {
      if (sessionId) await cancelEveTurn(sessionId, jwt);
      throw withSession(new Error(expiry), sessionId);
    }
    // The session this turn actually ran in, which is not the one the caller
    // handed us when eve opened a new one or the 409 retry above rotated it.
    // The caller writes it to the run history, and a stale or empty id there
    // is a part-finished turn the owner cannot open.
    throw withSession(err, sessionId);
  } finally {
    clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
  }
  return { sessionId, reply };
}

async function deliverOne(handoff: HandoffRecord, claimToken: string): Promise<string> {
  if (handoff.depth > HANDOFF_DEPTH_MAX) throw new Error("handoff_depth_exceeded");
  const shell = readShell();
  const receiver = receiverOf(handoff, shell.bots);
  if (!receiver) throw new Error("receiver_missing");
  const { bot, kind } = receiver;
  if (bot.hidden) throw new Error("receiver_hidden");

  const { sessionId, reply } = await runEveTurn(bot, handoffEnvelope(handoff), undefined, "handoff");

  // A stale takeover may have handed this record to another process; only the
  // token holder may write the transcript, or both would append a reply.
  if (!ownsHandoffClaim(handoff.id, claimToken)) throw new Error("claim_lost");
  // Transcript and shell row first, delivery marker last: a crash in between
  // leaves the record claimed/pending so the next pump retries, and the event
  // dedupe keeps the retry from appending a second copy.
  const sender = shell.bots.find((item) => item.id === handoff.sourceBotId);
  writeHandoffReply({
    handoff,
    reply,
    sessionId,
    receiverId: bot.id,
    threadKind: kind,
    sourceThreadKind: sender?.kind === "group" ? "group" : "bot",
  });
  const stamp = new Date().toISOString();
  const preview = reply ? reply.slice(0, 160) : "";
  updateShell((current) => ({
    ...current,
    bots: current.bots.map((item) => {
      if (item.id === bot.id) {
        return {
          ...item,
          sessionId,
          lastPreview: preview || item.lastPreview,
          lastAt: stamp,
          updatedAt: stamp,
        };
      }
      if (preview && item.id === handoff.sourceBotId) {
        return { ...item, lastPreview: preview, lastAt: stamp, updatedAt: stamp };
      }
      return item;
    }),
  }));
  markDelivered(handoff.id, reply, undefined, claimToken);
  return reply;
}

export function handoffsInFlight(): string[] {
  return [...inflight];
}

/** Bot ids currently receiving a handoff, for the rail working pulse. */
export function handoffWorkingBotIds(): string[] {
  const ids = new Set<string>();
  for (const id of inflight) {
    const record = readHandoff(id);
    if (!record) continue;
    // A group handoff runs on the room, not on the member it names. Same
    // fallback as the delivery: a room that is gone means the member runs it.
    const bots = peekShell()?.bots ?? [];
    ids.add(receiverOf(record, bots)?.bot.id ?? record.targetBotId);
  }
  return [...ids];
}

// Pumps are single-flight: the UI poll, wakePump and fan-out confirmations can
// all call this within the same second, and overlapping pumps would hold many
// eve deliveries open at once. Callers queue behind the pump in progress.
// Inside one pump the batch runs together, one delivery per receiving bot: the
// router takes ten model calls at once now, and a two minute turn on one bot
// must not hold up a handoff to another. The batch size is the bound on how
// many eve deliveries this pump holds open (the tick caps it at four).

export function pumpHandoffs(limit = 2): Promise<{
  delivered: Array<{ id: string; to: string }>;
  failed: Array<{ id: string; error: string }>;
  queued: number;
}> {
  const run = pumpState.pumpQueue.then(() => pumpOnce(limit), () => pumpOnce(limit));
  pumpState.pumpQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Deliver queued handoffs, oldest first, at most one per receiving bot at a
 * time: eve runs one turn per session, so a second handoff to a bot that is
 * already receiving one waits for the next pump. Concurrent calls are deduped
 * per handoff id and serialized by pumpHandoffs.
 */
async function pumpOnce(limit: number): Promise<{
  delivered: Array<{ id: string; to: string }>;
  failed: Array<{ id: string; error: string }>;
  queued: number;
}> {
  const delivered: Array<{ id: string; to: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  const candidates = listDeliverable().filter((record) => !inflight.has(record.id));
  const bots = peekShell()?.bots ?? [];
  const receivers = new Set<string>();
  const batch: HandoffRecord[] = [];
  for (const record of candidates) {
    if (batch.length >= limit) break;
    const receiver = receiverOf(record, bots)?.bot.id ?? record.targetBotId;
    if (receivers.has(receiver)) continue;
    receivers.add(receiver);
    batch.push(record);
  }
  await Promise.all(batch.map(async (record) => {
    // Cross-process claim: without it two web servers can both deliver the
    // same record and append two replies to the receiver transcript.
    const claimToken = claimHandoff(record.id);
    if (!claimToken) return;
    inflight.add(record.id);
    try {
      await deliverOne(record, claimToken);
      delivered.push({ id: record.id, to: record.targetName });
    } catch (err) {
      const message = err instanceof Error ? err.message : "handoff_failed";
      if (message === "claim_lost") return;
      // Neither a gone model nor a refused size is fixed by trying again.
      const modelGone = message === "model_selection_unavailable"
        || err instanceof ProviderRouteRetiredError
        || message === "context_too_large"
        || message === "description_too_long";
      const shown = message === "model_selection_unavailable"
        ? MODEL_UNAVAILABLE_TEXT
        : message === "context_too_large"
          ? CONTEXT_TOO_LARGE_TEXT
          : message === "description_too_long" ? DESCRIPTION_TOO_LONG_TEXT : message;
      const next = markFailed(record.id, message, undefined, claimToken, modelGone);
      const terminal = next && next.status === "failed" && (modelGone || next.attempts >= HANDOFF_ATTEMPTS_MAX);
      if (terminal) {
        // The sender card still reads as a normal outgoing handoff, so say
        // here that delivery gave up, the way a failed routine run does.
        try {
          let threadKind: ThreadKind = "bot";
          try {
            const sender = readShell().bots.find((item) => item.id === record.sourceBotId);
            if (sender?.kind === "group") threadKind = "group";
          } catch {
            /* unreadable roster keeps the default kind */
          }
          appendAgentEvent(record.sourceBotId, {
            kind: "note",
            threadKind,
            text: `Handoff to ${record.targetName} failed: ${shown}`.slice(0, 300),
          });
        } catch {
          /* the failed status still records the outcome */
        }
      }
      failed.push({
        id: record.id,
        error: modelGone
          ? shown
          : terminal
            ? `gave up after ${next?.attempts} tries: ${message}`
            : message,
      });
    } finally {
      inflight.delete(record.id);
      releaseHandoffClaim(record.id, claimToken);
    }
  }));
  return { delivered, failed, queued: Math.max(0, candidates.length - batch.length) };
}

/**
 * Confirm a fan-out: one handoff per target. Every target gets a copy in its own
 * thread and the room gets one card showing the same message. Replies land back
 * in the group. A single-bot send is the same path with one target and no group.
 */
/**
 * Hand a newly created bot the first brief its proposal card carried, as a
 * message from the bot that proposed it.
 *
 * Without this the brief was only ever shown on the card: the owner approved
 * it, the bot was created idle, and the work stayed in the proposer's chat.
 * Returns the number of handoffs queued, so a card with no brief and a
 * creation that did not happen both read as zero.
 */
export function deliverFirstBrief(input: {
  brief: string;
  createdBotId: string | undefined;
  sourceBotId: string | null;
  bots: ShellBot[];
}): number {
  const brief = input.brief.trim();
  if (!brief || !input.createdBotId) return 0;
  const target = input.bots.find((bot) => bot.id === input.createdBotId);
  // A group is never created by a createBot card, and a bot that is already
  // gone cannot be briefed.
  if (!target || target.kind === "group") return 0;
  const source = input.sourceBotId
    ? input.bots.find((bot) => bot.id === input.sourceBotId) ?? null
    : null;
  return fanOut({
    source: source ? { id: source.id, name: source.name } : null,
    targets: [{ id: target.id, name: target.name }],
    message: brief,
  });
}

export function fanOut(input: {
  source: { id: string; name: string } | null;
  targets: Array<{ id: string; name: string }>;
  message: string;
  group?: { id: string; name: string } | null;
}): number {
  if (input.targets.length === 0) throw new Error("fanout_empty");
  const sourceBotId = input.source?.id ?? null;
  const sourceName = input.source?.name ?? "Useful Bot";
  let count = 0;
  for (const target of input.targets) {
    sendHandoff({
      source: input.source,
      target,
      message: input.message,
      group: input.group ?? null,
      // Explicit receiver: with a group set, the default would put every copy
      // in the room instead of in each member's own thread.
      receiver: target,
    });
    count += 1;
  }
  if (input.group) {
    appendAgentEvent(input.group.id, {
      kind: "post",
      threadKind: "group",
      text: input.message,
      authorBotId: sourceBotId,
      authorName: sourceName,
      targetBotIds: input.targets.map((target) => target.id),
    });
  }
  return count;
}

/**
 * Routine runs. A routine is owner-initiated work on a schedule, so it enters
 * the bot's own 1:1 chat as a turn at depth 0: a note saying which routine
 * fired, the instruction as the owner's message, and the bot's reply. Delivery
 * uses the same eve path as a handoff.
 */

const routinesInflight = pumpState.routinesInflight;

export type RoutineRunResult = { routineId: string; sessionId: string; reply: string };

function runFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : "routine_failed";
  return message.slice(0, 300);
}

/**
 * One line per routine lifecycle event, on the web service's own stdout.
 *
 * A routine runs with nobody watching, and until now the only trace it left
 * was a run-history row holding whatever string the failure carried. Working
 * out that a run had been cut off by this process, while its turn carried on
 * inside eve, meant reading the eve session stream event by event. The line
 * is short and it names the routine, the elapsed time and the session, so the
 * next incident is answered from the log.
 */
function routineLog(routine: Routine, event: string, fields: Record<string, string | number>): void {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`)
    .join(" ");
  console.log(`[useful-bot] routine ${event} id=${routine.id} name=${JSON.stringify(routine.name)} ${detail}`);
}

/** The session a failed run left its part-finished turn in, when it had one. */
function failedSession(err: unknown): string | null {
  const carried = (err as { sessionId?: unknown } | null)?.sessionId;
  return typeof carried === "string" && carried ? carried : null;
}

/** What the owner reads when a routine or handoff could not run on the bot's own model. */
const MODEL_UNAVAILABLE_TEXT = "This bot's model isn't available any more. Pick another model in its chat.";

/** The failure note the owner reads in the chat, not the code the log holds. */
function routineFailureText(err: unknown): string {
  const code = err instanceof Error ? err.message : "routine_failed";
  if (code === "turn_budget_exhausted") {
    return "it was still running after an hour, so it was stopped. Narrow the instruction or split it in two.";
  }
  if (code === "turn_went_silent") {
    return "the bot went quiet part way through and the run was stopped.";
  }
  if (code === "model_selection_unavailable") return MODEL_UNAVAILABLE_TEXT;
  if (code === "context_too_large") return CONTEXT_TOO_LARGE_TEXT;
  if (code === "description_too_long") return DESCRIPTION_TOO_LONG_TEXT;
  return code;
}

/** The note a scheduled run carries: nobody is there to answer a question or a card. */
function routineLine(routine: Routine): string {
  return `Scheduled run of the routine ${routine.name.replace(/\s+/g, " ").trim()}. Nobody is watching: don't ask questions or wait for a card. Do what is safe and report what needs the owner.`;
}

async function executeRoutine(
  routine: Routine,
  trigger: "schedule" | "manual",
): Promise<RoutineRunResult> {
  const shell = readShell();
  const bot = shell.bots.find((item) => item.id === routine.botId);
  if (!bot) throw new Error("routine_bot_missing");
  if (bot.hidden) throw new Error("routine_bot_hidden");
  const threadKind: ThreadKind = bot.kind === "group" ? "group" : "bot";
  // These two go in before the turn so the live stream echo pairs with the
  // durable row rather than rendering a second bubble. If the agent store
  // itself will not open, there is no transcript to leave hanging and no point
  // spending an eve turn nobody will see, so that fails the run outright.
  try {
    // The note keeps the transcript honest: without it a scheduled turn reads
    // as something the owner typed.
    appendAgentEvent(bot.id, {
      kind: "note",
      threadKind,
      text: trigger === "manual"
        ? `Test run of routine "${routine.name}".`
        : `Routine "${routine.name}" ran.`,
    });
    // The instruction is stored verbatim; the bot's identity prefix is added
    // on the way to eve (see runEveTurn).
    appendAgentEvent(bot.id, {
      kind: "user",
      threadKind,
      sessionId: bot.sessionId ?? "",
      text: routine.instruction,
    });
  } catch (err) {
    // The note can land and the instruction fail, which leaves the same
    // dangling row this whole path exists to avoid. Say so where it shows.
    try {
      appendAgentEvent(bot.id, {
        kind: "note",
        threadKind,
        text: `Routine "${routine.name}" could not start: the transcript was unavailable.`,
      });
    } catch {
      /* the store is what failed; the run history still records it */
    }
    throw new Error(`routine_transcript_unavailable: ${err instanceof Error ? err.message : "unknown"}`);
  }
  // Every path out of the turn leaves an outcome row. The claim has already
  // moved the anchor, so there is no retry: a turn that throws must say so in
  // the transcript instead of leaving the note and the instruction hanging
  // with nothing after them.
  let sessionId: string;
  let reply: string;
  const startedAt = Date.now();
  routineLog(routine, "started", { trigger, bot: bot.name, session: bot.sessionId ?? "new" });
  try {
    ({ sessionId, reply } = await runEveTurn(bot, routine.instruction, {
      totalMs: ROUTINE_TIMEOUT_MS,
      idleMs: ROUTINE_IDLE_MS,
    }, "routine", [routineLine(routine)]));
    routineLog(routine, "finished", { ms: Date.now() - startedAt, session: sessionId, replyChars: reply.length });
  } catch (err) {
    // The session the turn really ran in, which runEveTurn tagged onto the
    // error; the bot's own pointer only stands in when it never got that far.
    const ranIn = failedSession(err) ?? bot.sessionId ?? "";
    routineLog(routine, "failed", {
      ms: Date.now() - startedAt,
      session: ranIn,
      error: err instanceof Error ? err.message : "unknown",
    });
    // Best effort, like the pre-append note: a locked store must not become
    // the error the caller sees in place of whatever eve actually did.
    try {
      appendAgentEvent(bot.id, {
        kind: "note",
        threadKind,
        text: `Routine "${routine.name}" failed: ${routineFailureText(err)}`.slice(0, 300),
      });
    } catch { /* the run history still records the failure */ }
    // The history row is the only place the pane can send the owner from, and
    // a failed run used to land there with no session at all. The turn that
    // failed is in this one, part-finished, and it is what they want to read.
    throw withSession(err, ranIn);
  }
  if (reply) {
    appendAgentEvent(bot.id, {
      kind: "assistant",
      threadKind,
      sessionId,
      text: reply,
    });
  }
  const stamp = new Date().toISOString();
  updateShell((current) => ({
    ...current,
    bots: current.bots.map((item) => (
      item.id === bot.id
        ? {
          ...item,
          sessionId,
          lastPreview: reply ? reply.slice(0, 160) : item.lastPreview,
          lastAt: stamp,
          updatedAt: stamp,
        }
        : item
    )),
  }));
  return { routineId: routine.id, sessionId, reply };
}

/**
 * Claim a manual run synchronously, then start the turn. The Test run route
 * needs the claim settled before it answers, so it calls this and maps a sync
 * throw (routine_busy, routine_missing, routines_locked) to a status; a run
 * told "started" but whose claim failed would leave no history row anywhere.
 * The scheduler shares the in-flight set, so a manual run cannot overlap a
 * scheduled one.
 */
export function startRoutineNow(routineId: string): Promise<RoutineRunResult> {
  if (routinesInflight.has(routineId)) throw new Error("routine_busy");
  // Claimed before anything can yield. The pump re-reads this set immediately
  // before its own claim, and both paths run to their `add` without an await,
  // so the single-threaded runtime makes this an actual mutex: a Test run and
  // a tick can no longer hold two eve turns open on one routine.
  routinesInflight.add(routineId);
  let routine: Routine;
  try {
    // Take the durable ticket too: a request an agent tool raised has to be
    // consumed here, or the next tick claims it and runs this a second time.
    const claim = claimRunNow(routineId);
    if (!claim) throw new Error("routine_missing");
    routine = claim.routine;
  } catch (err) {
    routinesInflight.delete(routineId);
    throw err;
  }
  return runClaimedRoutine(routine);
}

/**
 * Run a routine whose in-flight and store claims are already taken, and leave
 * an outcome row whatever the turn does. Shared by both manual-run entries.
 */
async function runClaimedRoutine(routine: Routine): Promise<RoutineRunResult> {
  try {
    const result = await executeRoutine(routine, "manual");
    recordRun(routine.id, { status: "ok", sessionId: result.sessionId });
    return result;
  } catch (err) {
    recordRun(routine.id, { status: "failed", error: runFailure(err), sessionId: failedSession(err) });
    throw err;
  } finally {
    routinesInflight.delete(routine.id);
  }
}

/**
 * Run one routine now, the way the pane's Test run button does. Kept for any
 * caller that wants the old rejected-promise shape for a failed claim.
 */
export async function runRoutineNow(routineId: string): Promise<RoutineRunResult> {
  return startRoutineNow(routineId);
}

/**
 * Write one run-history row. The store can be locked, and that must not become
 * the error the caller sees: losing the history line is a smaller loss than
 * replacing a real eve failure with `routines_locked`, or than aborting a pump
 * batch that still has candidates to get through.
 */
function recordRun(
  id: string,
  run: { status: RoutineRunStatus; sessionId?: string | null; error?: string },
): void {
  try {
    appendRoutineRun(id, run);
  } catch (err) {
    // The pane polls run history, so a lost row is invisible there. Say it
    // here rather than nowhere.
    console.warn(`[useful-bot] routine ${id} ran but its history row was lost:`, err);
  }
}

// Like the handoff pump: single-flight across calls, and inside one pump the
// batch runs together, one routine per bot, so two bots' routines due in the
// same minute no longer run back to back.

export type RoutinePumpResult = {
  /**
   * Runs this pump claimed and set going, not runs that finished. The pump
   * used to await them, which was survivable while a run was capped at two
   * minutes and is not now one may take an hour: the single-flight chain would
   * have held every other bot's routine behind the slowest one. The claim is
   * what has to be serialised, and the claim is all this waits for.
   */
  started: Array<{ id: string; name: string }>;
  /** Candidates whose claim itself failed. A run that fails does so later. */
  failed: Array<{ id: string; error: string }>;
  /** Candidates a contended store lock made someone else's turn this tick. */
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Runs allowed at once across every routine. One per bot per pump already
 * holds, but a pump no longer waits for the last one to finish, so without a
 * ceiling a morning's worth of due routines could all be in flight together.
 */
const MAX_ACTIVE_ROUTINES = 4;

export function pumpRoutines(limit = 2): Promise<RoutinePumpResult> {
  const run = pumpState.routineQueue.then(
    () => pumpRoutinesOnce(limit),
    () => pumpRoutinesOnce(limit),
  );
  pumpState.routineQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * The bots whose routine is running right now. Read from the in-flight set
 * rather than kept beside it, so the two can never drift; a routine deleted
 * mid-run has no row to read and its bot frees up, which is the same caveat
 * `backgroundWorkingBotIds` carries.
 */
function botsRunningRoutines(): string[] {
  const ids: string[] = [];
  for (const routineId of routinesInflight) {
    const routine = readRoutine(routineId);
    if (routine) ids.push(routine.botId);
  }
  return ids;
}

function pumpRoutinesOnce(limit: number): RoutinePumpResult {
  const started: Array<{ id: string; name: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const now = new Date();
  const free = Math.max(0, MAX_ACTIVE_ROUTINES - routinesInflight.size);
  const room = Math.min(limit, free);
  const candidates = room === 0
    ? []
    : pendingRoutines(now).filter((routine) => !routinesInflight.has(routine.id));
  // One per bot: a routine is a turn in the bot's own chat, and eve runs one
  // turn per session. A bot's second due routine waits.
  //
  // Seeded from the runs already going, not empty. While the pump awaited its
  // batch, the next tick could not start anything until every run was done, so
  // a per-pump set was enough. Now that runs are detached, the next tick comes
  // round in seconds and would claim the same bot's other routine straight
  // into a session eve still has a turn on.
  const owners = new Set<string>(botsRunningRoutines());
  const batch: Routine[] = [];
  for (const candidate of candidates) {
    if (batch.length >= room) break;
    if (owners.has(candidate.botId)) continue;
    owners.add(candidate.botId);
    batch.push(candidate);
  }
  // This loop never awaits, so every claim lands before anything else can run:
  // the mutex with startRoutineNow holds exactly as it did before.
  for (const candidate of batch) {
    // Re-checked here, not only when the list was built: a Test run can have
    // started on this routine since, and it marks the set before it yields.
    if (routinesInflight.has(candidate.id)) continue;
    // Both claims flip their marker inside the store lock, so a tick that raced
    // this one finds the request already taken or nothing due. A contended
    // lock is that race, not a fault in this routine: skip the candidate and
    // leave the rest of the batch alone. It is not a failed run either, so it
    // does not go in `failed`, where it would read as the routine misbehaving.
    let manual: { routine: Routine } | null = null;
    let claim: { routine: Routine } | null = null;
    try {
      manual = claimManualRun(candidate.id);
      claim = manual ?? claimDueRoutine(candidate.id, now);
    } catch (err) {
      const error = runFailure(err);
      if (error === "routines_locked") {
        skipped.push({ id: candidate.id, reason: error });
      } else {
        failed.push({ id: candidate.id, error });
      }
      continue;
    }
    if (!claim) continue;
    routinesInflight.add(candidate.id);
    started.push({ id: candidate.id, name: claim.routine.name });
    // Detached on purpose: see RoutinePumpResult. The in-flight set is what
    // keeps a second run off this routine until this one is done, and it is
    // released in every branch below.
    void executeRoutine(claim.routine, manual ? "manual" : "schedule")
      .then((result) => {
        recordRun(candidate.id, { status: "ok", sessionId: result.sessionId });
      })
      .catch((err) => {
        recordRun(candidate.id, { status: "failed", error: runFailure(err), sessionId: failedSession(err) });
      })
      .finally(() => {
        routinesInflight.delete(candidate.id);
      });
  }
  return { started, failed, skipped };
}

/**
 * Drop routines and transcripts belonging to bots the roster no longer has.
 * Deleting a bot sweeps its own, but the roster, the routines and the agent
 * store have three separate locks: a delete that failed between them, or a
 * routine created for a bot deleted in the same moment, leaves work nothing
 * can ever complete. The tick calls this, which makes that state temporary.
 *
 * Returns the routine ids it dropped.
 */
export function sweepOrphanState(): string[] {
  // Under the test runner the sweep only runs against a temp widgets folder.
  // A test that isolated the agent store but not the media folders once
  // deleted every real image and drawing on each run, so a miss fails the
  // test instead. Images are no longer swept at all (shared/media-store.ts).
  if (process.env.NODE_TEST_CONTEXT && (!process.env.UB_WIDGETS_DIR || !process.env.UB_MEDIA_INDEX_PATH)) {
    throw new Error("sweep under test needs UB_WIDGETS_DIR and UB_MEDIA_INDEX_PATH");
  }
  try {
    // `peekShell`, never `readShell`. A roster this process could not parse is
    // reseeded by `readShell` to a single default bot, and sweeping against
    // that would read every other bot's routines and transcripts as orphans
    // and delete all of them. No roster means no sweep, and neither does a
    // roster another process already replaced with that stub: a reseed leaves
    // valid JSON, so only the marker can tell the two apart.
    if (shellWasReseeded()) return [];
    const shell = peekShell();
    if (!shell) return [];
    const live = shell.bots.map((bot) => bot.id);
    const routines = sweepOrphanRoutines(live);
    sweepOrphanThreads(live);
    // After the threads, so what is left naming a widget is all of it. A
    // cleared chat used to take its events and leave the drawings behind, and
    // nothing else ever removed one: the directory only grew.
    //
    // A null keep set means the store would not parse. Sweeping on that would
    // read every drawing on the machine as an orphan, so this tick does not
    // sweep at all.
    // A drawing in the Library keeps its record too: the Library shows it
    // live (Edit, Open in Excalidraw) after its chat is cleared.
    const referenced = referencedWidgetIds();
    const inLibrary = libraryDrawingIds();
    if (referenced && inLibrary) sweepOrphanWidgets([...referenced, ...inLibrary]);
    return routines;
  } catch {
    // A locked or unreadable store is the next tick's problem, never this
    // tick's failure: the sweep is maintenance, not the work.
    return [];
  }
}

/**
 * The sweep the tick runs, at most once a minute. It is maintenance, not the
 * work, and at 6 ms of file reads per call it cost the event loop 145 ms a
 * minute at the tick's 2.5 s cadence. Direct deletion still cleans up at its
 * own call sites; this only decides how long a leftover can linger, which is
 * now a minute rather than a tick. The first tick after a start sweeps.
 */
export const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt: number | null = null;

export function sweepOrphanStateIfDue(now = Date.now()): string[] {
  if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) return [];
  lastSweepAt = now;
  return sweepOrphanState();
}

/** Test hook: the next tick sweeps again. */
export function resetSweepClock(): void {
  lastSweepAt = null;
}

export function routinesInFlight(): string[] {
  return [...routinesInflight];
}

/**
 * Every bot doing background work, for the rail's working row: the receivers
 * of in-flight handoffs plus the bots whose routine is running. The routine
 * half was missing, so a bot working through a routine looked idle in the rail
 * until its reply landed. With several bots running at once that is the state
 * the owner most needs to see.
 */
export function backgroundWorkingBotIds(): string[] {
  const ids = new Set(handoffWorkingBotIds());
  for (const routineId of routinesInflight) {
    // A routine deleted mid-run has no row to read; its turn still ends on its
    // own and the set clears then.
    const routine = readRoutine(routineId);
    if (routine) ids.add(routine.botId);
  }
  return [...ids];
}

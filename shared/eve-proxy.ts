import { DEFAULT_BOT_ID, orchestratorId } from "./shell-store.ts";
import type { ShellBot, ShellStore } from "./shell-store.ts";
import {
  IMAGE_DATA_URL,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGE_PARTS,
  safeAttachName,
  type TurnFilePart,
  type TurnMessage,
  type TurnTextPart,
} from "./attachments.ts";

import { resolveRoute, speakersFrom, type Route } from "./threads.ts";
import { withSessionNotes } from "./continuation-brief.ts";
import type { ThreadKind } from "./agent-store.ts";

/**
 * Session ids are opaque eve identifiers (uuid-shaped). The charset is pinned
 * and dots are excluded so a suffix like `session/..` cannot be interpolated
 * into the upstream URL and normalised into a different path.
 */
const SESSION_ID = "[A-Za-z0-9_-]+";
const SESSION_STREAM = new RegExp(`^session/${SESSION_ID}/stream$`);
const SESSION_ONE = new RegExp(`^session/${SESSION_ID}$`);
const SESSION_CANCEL = new RegExp(`^session/${SESSION_ID}/cancel$`);

export function eveGetAllowed(suffix: string): boolean {
  if (suffix === "health" || suffix === "info") return true;
  return SESSION_STREAM.test(suffix);
}

export function evePostAllowed(suffix: string): boolean {
  if (suffix === "session") return true;
  return SESSION_ONE.test(suffix) || SESSION_CANCEL.test(suffix);
}

export function isEveSessionPost(suffix: string): boolean {
  return suffix === "session" || SESSION_ONE.test(suffix);
}

/**
 * The one upstream error code a client is allowed to see. eve answers 409
 * `session_not_active` for a session that failed or was retired, and the
 * only way forward is a fresh session, so the client has to be told which
 * 409 it got. Every other error body stays behind the proxy: it can carry
 * runtime and prompt detail.
 */
export function relayedEveCode(status: number, body: string): string | null {
  if (status !== 409 || !body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return parsed.code === "session_not_active" ? "session_not_active" : null;
  } catch {
    return null;
  }
}

export type SessionRoute = Route & { mentionNames: string[] };

/** How a failure while routing or rewriting a turn is answered: never by forwarding it. */
export function turnRewriteFailure(err: unknown): { status: 400 | 503; error: "eve_message_invalid" | "session_route_failed" } {
  return err instanceof Error && err.message === "eve_message"
    ? { status: 400, error: "eve_message_invalid" }
    : { status: 503, error: "session_route_failed" };
}

export type BoundTurn =
  | { ok: true; body: string }
  | { ok: false; error: "session_unbound" | "eve_message_invalid" | "session_bot_mismatch" };

/**
 * The turn body for a send into an EXISTING session. The bot comes from the
 * durable session binding (`bound`, the owner of the session id in the path),
 * never from the body: a session nobody bound is refused, and so is a body
 * that names a different bot. On success the body carries the bound bot id,
 * which is what every later step of the proxy reads.
 */
export function bindTurnBody(raw: string, bound: string | null): BoundTurn {
  if (!bound) return { ok: false, error: "session_unbound" };
  let sent: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    sent = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "eve_message_invalid" };
  }
  if (sent.botId !== undefined && sent.botId !== bound) return { ok: false, error: "session_bot_mismatch" };
  return { ok: true, body: JSON.stringify({ ...sent, botId: bound }) };
}

/**
 * A file part's name goes verbatim into eve's `[file: name (type)]` transcript
 * line and into the model's context, so it takes the same alphabet
 * `/api/attachments` hands out: nothing that can split a line, and no
 * credential-looking names. First-party clients already send such names;
 * this is the check for anyone posting to the proxy directly.
 */
function safeTurnFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return safeAttachName(value) === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * The `message` field of a turn as this proxy accepts it: a string, or text
 * parts with image file parts. Anything else is refused here rather than
 * relayed, so eve only ever sees the shapes this build has reasoned about.
 * Returns null for a shape it does not accept.
 */
export function parseTurnMessage(value: unknown): TurnMessage | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: Array<TurnTextPart | TurnFilePart> = [];
  let images = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    if (rec.type === "text") {
      if (typeof rec.text !== "string" || rec.text.length === 0) return null;
      parts.push({ type: "text", text: rec.text });
      continue;
    }
    if (rec.type === "file") {
      if (typeof rec.data !== "string" || rec.data.length > MAX_IMAGE_DATA_URL_CHARS) return null;
      if (!IMAGE_DATA_URL.test(rec.data)) return null;
      const mediaType = rec.data.slice("data:".length, rec.data.indexOf(";"));
      if (rec.mediaType !== mediaType) return null;
      const filename = safeTurnFilename(rec.filename);
      if (filename === null) return null;
      if (++images > MAX_IMAGE_PARTS) return null;
      parts.push({ type: "file", data: rec.data, mediaType, filename });
      continue;
    }
    return null;
  }
  return parts;
}

const INPUT_REQUEST_ID_MAX = 300;
const INPUT_OPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_RESPONSES_MAX = 8;

export type InputResponse = { requestId: string; optionId: string };

/**
 * The structured answer to an eve input request (a session limit, an
 * approval): `{"inputResponses":[{"requestId","optionId"}]}`, the body eve
 * takes in place of a message. Strict on purpose: 1 to 8 items of exactly
 * those two string fields, and nothing else on the body but the bot tag the
 * app sends with every turn (checked against the binding, never relayed).
 * Text, files, extra keys and a message beside it are refused, not stripped.
 */
export function parseInputResponses(raw: string): { ok: true; inputResponses: InputResponse[] } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false };
  const body = json as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "inputResponses" && key !== "botId") return { ok: false };
  }
  if (body.botId !== undefined && typeof body.botId !== "string") return { ok: false };
  const items = body.inputResponses;
  if (!Array.isArray(items) || items.length < 1 || items.length > INPUT_RESPONSES_MAX) return { ok: false };
  const out: InputResponse[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false };
    const rec = item as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length !== 2 || !keys.includes("requestId") || !keys.includes("optionId")) return { ok: false };
    const { requestId, optionId } = rec;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > INPUT_REQUEST_ID_MAX) return { ok: false };
    if (typeof optionId !== "string" || !INPUT_OPTION_ID.test(optionId)) return { ok: false };
    out.push({ requestId, optionId });
  }
  return { ok: true, inputResponses: out };
}

/** True when the body is a JSON object that carries an `inputResponses` key at all, valid or not. */
export function bodyHasInputResponses(raw: string): boolean {
  try {
    const json = JSON.parse(raw) as unknown;
    return Boolean(json) && typeof json === "object" && !Array.isArray(json) && Object.hasOwn(json as object, "inputResponses");
  } catch {
    return false;
  }
}

/** eve's agent ids, as the app sends them on a child cancel. */
const CHILD_AGENT_ID = /^ag_agent:[a-z0-9]+$/;

const CHILD_PARENT = new RegExp(`^${SESSION_ID}$`);

/** The largest `at` a child stream read may name: far past any real session, small enough to stay exact. */
export const CHILD_AT_MAX = 100_000_000;

/**
 * The `parent` and `at` queries of a sub-agent's stream read. The app names
 * the parent session the child was delegated from and `at`, the absolute
 * index of the parent's `subagent.called` event for it; the proxy never relays
 * either to eve. `parent` is null when it is present but not exactly one
 * session id; `at` is null when it is missing or not exactly one plain
 * non-negative integer up to `CHILD_AT_MAX`.
 */
export function childStreamQuery(search: string): { present: false } | { present: true; parent: string | null; at: number | null; search: string } {
  const params = new URLSearchParams(search);
  if (!params.has("parent")) return { present: false };
  const all = params.getAll("parent");
  const parent = all.length === 1 && CHILD_PARENT.test(all[0]) ? all[0] : null;
  const ats = params.getAll("at");
  const at = ats.length === 1 && /^\d{1,9}$/.test(ats[0]) && Number(ats[0]) <= CHILD_AT_MAX ? Number(ats[0]) : null;
  params.delete("parent");
  params.delete("at");
  const rest = params.toString();
  return { present: true, parent, at, search: rest ? `?${rest}` : "" };
}

/**
 * The `parent` and `at` queries of a cancel into a sub-agent's child, read
 * exactly like a child stream read (see `childStreamQuery`). Not present for
 * any other request, a plain cancel included.
 */
export function childCancelQuery(method: string, suffix: string, search: string): { present: false } | (Extract<ReturnType<typeof childStreamQuery>, { present: true }> & { agentId: string | null; agentIdBad: boolean }) {
  if (method.toUpperCase() !== "POST" || !SESSION_CANCEL.test(suffix)) return { present: false };
  // The app may name the sub-agent being stopped; it is recorded, never relayed to eve.
  const params = new URLSearchParams(search);
  const agents = params.getAll("agentId");
  const agentIdBad = agents.length > 1 || (agents.length === 1 && !CHILD_AGENT_ID.test(agents[0]));
  params.delete("agentId");
  const rest = params.toString();
  const query = childStreamQuery(rest ? `?${rest}` : "");
  if (!query.present) return { present: false };
  return { ...query, agentId: agents.length === 1 && !agentIdBad ? agents[0] : null, agentIdBad };
}

/** The text of a turn: the string itself, or its text parts joined. */
export function turnText(message: TurnMessage): string {
  if (typeof message === "string") return message;
  return message.filter((part): part is TurnTextPart => part.type === "text").map((part) => part.text).join("\n");
}

export function turnHasImages(message: TurnMessage): boolean {
  return typeof message !== "string" && message.some((part) => part.type === "file");
}

/**
 * Resolve the bot or group an eve turn belongs to, plus its @mentions, from the
 * stored shell. The caller hands the route back to the UI so the transcript can
 * attribute the reply to the bot that actually answered.
 */
export function eveSessionRoute(raw: string, store: ShellStore): SessionRoute | null {
  let botId = "";
  let message = "";
  try {
    const json = JSON.parse(raw) as { botId?: unknown; message?: unknown };
    botId = typeof json.botId === "string" ? json.botId : "";
    const parsed = parseTurnMessage(json.message);
    message = parsed === null ? "" : turnText(parsed);
  } catch {
    return null;
  }
  const bot = store.bots.find((item) => item.id === botId) ?? null;
  const speakers = speakersFrom(store.bots);
  // An unknown botId is an error, never a silent remap to whichever bot is
  // selected: rewriting the turn as another bot would misattribute the reply.
  if (!bot) return null;
  const route = resolveRoute({
    botId: bot.id,
    text: message,
    bots: speakers,
    memberIds: bot.memberIds,
    orchestrator: orchestratorId(store),
  });
  const mentionNames = route.mentionIds
    .map((id) => speakers.find((speaker) => speaker.id === id)?.name ?? "")
    .filter((name) => name.length > 0);
  return { ...route, mentionNames };
}

/** The note a group turn carries when the owner @mentioned members. */
export function mentionLine(names: string[]): string {
  const who = names.join(", ");
  return `The owner addressed ${who}. Answer for that member's part as the orchestrator; don't claim to be ${who}.`;
}

/**
 * The turn rewrite: the message validated, and the app notes folded in as
 * hidden lines the transcript strips (a carry-over brief, a retry note, and
 * the mention line when the owner @mentioned members of a group). The bot's
 * identity is not part of the turn: it is a system block built from the bot.
 */
/** Every app note a turn carries: the caller's notes, then the mention line for a group turn. */
function turnNotes(route: SessionRoute | null, notes: string[]): string[] {
  const mentioned = (route?.mentionNames ?? []).map((name) => name.replace(/\s+/g, " ").trim()).filter((name) => name.length > 0);
  return mentioned.length > 0 ? [...notes, mentionLine(mentioned)] : notes;
}

/**
 * Characters of the whole hidden prefix `rewriteEveTurnBody` puts in front of
 * the owner's message for these notes and this route, session-note framing
 * included. Admission sizes exactly this.
 */
export function hiddenPrefixChars(route: SessionRoute | null, notes: string[]): number {
  return withSessionNotes("", turnNotes(route, notes)).length;
}

export function rewriteEveTurnBody(
  raw: string,
  route: SessionRoute | null,
  /** App notes for the hidden prefix: a carry-over brief, a retry note. */
  notes: string[] = [],
): string {
  const json = JSON.parse(raw) as { message?: unknown };
  const message = parseTurnMessage(json.message);
  if (message === null) throw new Error("eve_message");
  const allNotes = turnNotes(route, notes);
  if (allNotes.length === 0) return JSON.stringify({ message });
  const prefix = withSessionNotes("", allNotes);
  if (typeof message === "string") {
    return JSON.stringify({ message: `${prefix}${message}` });
  }
  // The prefix has to be the first thing eve summarizes: the transcript
  // strips it only from index 0, and the stream arms on what follows it. So
  // it goes onto the text part at index 0 when there is one, and otherwise
  // into a text part of its own ahead of everything, ending in the newline
  // that, joined by eve's own, makes the blank line the strip cuts at.
  const head = message[0];
  const prefixed = head?.type === "text"
    ? [{ ...head, text: `${prefix}${head.text}` }, ...message.slice(1)]
    : [{ type: "text" as const, text: `${prefix.trimEnd()}\n` }, ...message];
  return JSON.stringify({ message: prefixed });
}

const CONTINUE_FROM = new RegExp(`^${SESSION_ID}$`);

/**
 * The turn fields only this proxy reads: `continueFrom` names the session a
 * replacement carries over from, `retry` marks the owner's Retry. Neither is
 * relayed to eve. `continueFrom` is null when present but not an id.
 */
export function parseTurnExtras(raw: string): { continueFrom?: string | null; retry: boolean } {
  try {
    const json = JSON.parse(raw) as { continueFrom?: unknown; retry?: unknown };
    const out: { continueFrom?: string | null; retry: boolean } = { retry: json.retry === true };
    if (json.continueFrom !== undefined) {
      out.continueFrom = typeof json.continueFrom === "string" && CONTINUE_FROM.test(json.continueFrom)
        ? json.continueFrom
        : null;
    }
    return out;
  } catch {
    return { retry: false };
  }
}

export function sessionRouteHeader(route: SessionRoute | null): string | null {
  if (!route) return null;
  try {
    return Buffer.from(JSON.stringify(route), "utf8").toString("base64url");
  } catch {
    return null;
  }
}

export function parseSessionRouteHeader(value: string | null): SessionRoute | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SessionRoute;
    if (!parsed || (parsed.kind !== "bot" && parsed.kind !== "group")) return null;
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : "",
      kind: parsed.kind as ThreadKind,
      mentionIds: Array.isArray(parsed.mentionIds)
        ? parsed.mentionIds.filter((id): id is string => typeof id === "string")
        : [],
      mentionNames: Array.isArray(parsed.mentionNames)
        ? parsed.mentionNames.filter((name): name is string => typeof name === "string")
        : [],
      untargeted: parsed.untargeted === true,
    };
  } catch {
    return null;
  }
}

import { engineFetch, EngineUnavailableError } from "../../shared/engine-client.ts";
import { ApiError, apiError, JSON_BODY_MAX, rateLimited, readBody, TURN_BODY_MAX } from "./api-guard.ts";
import { parseTurnBody, TurnBodyError } from "../../shared/turn-input.ts";

/**
 * The web service's relay to the engine for the chat routes (SPEC 6.1, 7).
 * The routes behind it have already passed the owner gate (`requireOwner`);
 * this adds what every one of them needs: CSRF and a rate limit on writes, a
 * bounded body, the engine bearer, the engine's own status and body on the way
 * back, and a 503 `engine_unavailable` when the engine does not answer. The
 * path and query are built here from validated pieces, never from the raw URL.
 */

type Session = { csrf: string; callerId: string };

/** Writes against the engine, per caller. The route replaced had the same 60 a minute. */
const WRITES_PER_MINUTE = 60;
/** Stop and open: generous, so holding ⌘↑ through the chat list never blocks a Stop. */
const CONTROL_PER_MINUTE = 600;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
// A row id is the cursor, and a widget row id carries the provider's call id: any
// printable ASCII without spaces, as long as the engine's row keys can be.
const CURSOR = /^[\x21-\x7e]{1,260}$/;

/** A chat or bot id for a path segment or a query value, or null. */
export function safeId(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

/** The query values a route lets through, each held to a plain shape. Anything else is dropped. */
export function engineQuery(request: Request, allowed: Record<string, "id" | "cursor" | "int" | "text" | "flag">): string {
  const incoming = new URL(request.url).searchParams;
  const out = new URLSearchParams();
  for (const [name, kind] of Object.entries(allowed)) {
    const value = incoming.get(name);
    if (value === null) continue;
    const ok = kind === "id" ? ID.test(value)
      : kind === "cursor" ? CURSOR.test(value)
      : kind === "int" ? /^\d{1,9}$/.test(value)
      : kind === "flag" ? value === "1"
      : value.length > 0 && value.length <= 200;
    if (ok) out.set(name, value);
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

function engineDown(err: unknown): Response | null {
  if (err instanceof EngineUnavailableError) return fail(503, "engine_unavailable");
  if (err instanceof Error && err.message === "engine_credential_missing") return fail(503, "engine_credential_missing");
  return null;
}

/** The engine's answer as JSON: its status and body, or `engine_error` when the body is not JSON. */
async function answer(res: Response): Promise<Response> {
  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    return fail(res.ok ? 502 : res.status, "engine_error");
  }
  return new Response(text, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export type RelaySpec = {
  /** The engine path, with a query already built by `engineQuery`. */
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Posts a JSON body (default: none). `turn` validates a turn body and relays it rebuilt. */
  body?: "json" | "turn";
  /** For a `json` body: checks the parsed object and returns what to relay, or throws an `ApiError`. */
  checkBody?: (body: Record<string, unknown>) => Record<string, unknown>;
  /**
   * `control` writes (Stop, open a chat) get their own, larger bucket: a burst
   * of chat switches must never leave Stop answering 429 (default: `writes`).
   */
  bucket?: "writes" | "control";
};

/**
 * Relay one JSON request. A write needs the session's CSRF token and a free
 * slot in its rate bucket; a body is bounded before it is parsed (8 MB for a
 * turn, which can carry images; 256 KB otherwise).
 */
export async function relayJson(request: Request, session: Session, spec: RelaySpec): Promise<Response> {
  const write = spec.method !== "GET";
  if (write) {
    const csrf = request.headers.get("x-ub-csrf");
    if (!csrf || csrf !== session.csrf) return fail(403, "csrf");
    const control = spec.bucket === "control";
    if (rateLimited(`chats${control ? "-control" : ""}:${session.callerId}`, control ? CONTROL_PER_MINUTE : WRITES_PER_MINUTE)) {
      return fail(429, "rate_limited");
    }
  }
  let body: string | undefined;
  if (spec.body) {
    const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return fail(415, "unsupported_media_type");
    try {
      const bytes = await readBody(request, spec.body === "turn" ? TURN_BODY_MAX : JSON_BODY_MAX);
      const text = new TextDecoder().decode(bytes);
      if (spec.body === "turn") {
        body = JSON.stringify(parseTurnBody(text));
      } else {
        let parsed: unknown = {};
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new ApiError(400, "invalid_json");
          }
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid");
        body = JSON.stringify(spec.checkBody ? spec.checkBody(parsed as Record<string, unknown>) : parsed);
      }
    } catch (err) {
      if (err instanceof TurnBodyError) return fail(400, err.code);
      const guarded = apiError(err);
      if (guarded) return guarded;
      throw err;
    }
  }
  try {
    const res = await engineFetch(spec.path, {
      method: spec.method,
      body,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      signal: request.signal,
    });
    return await answer(res);
  } catch (err) {
    const down = engineDown(err);
    if (down) return down;
    throw err;
  }
}

/**
 * Relay the NDJSON event stream. It streams without buffering and has no
 * deadline of its own: it ends when the engine closes it or the client goes,
 * and the client going aborts the engine request too (`request.signal`).
 */
export async function relayStream(request: Request, path: string): Promise<Response> {
  try {
    const res = await engineFetch(path, { signal: request.signal, timeoutMs: null });
    if (!res.ok || !res.body) return await answer(res);
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    const down = engineDown(err);
    if (down) return down;
    throw err;
  }
}

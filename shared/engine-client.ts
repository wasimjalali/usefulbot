import { engineOrigin } from "./stack.ts";

/**
 * The web service's way to the engine (SPEC 6.5, seams.md): the engine's
 * loopback origin, the bearer token both processes read from the same Keychain
 * item, no `Origin` header (Node's fetch sends none) and a Host of
 * `127.0.0.1:<port>`. Every request is one the engine's own guards would accept
 * from a trusted caller; the owner-facing guards (session, CSRF, rate limits)
 * stay in the web routes.
 */

/** Control calls answer fast; a rows page of a very long chat is the slowest. */
export const ENGINE_TIMEOUT_MS = 30_000;

export class EngineUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("engine_unavailable", { cause });
    this.name = "EngineUnavailableError";
  }
}

export type EngineJson = { status: number; ok: boolean; body: Record<string, unknown> };

function token(): string {
  const value = process.env.UB_ENGINE_TOKEN;
  if (!value) throw new Error("engine_credential_missing");
  return value;
}

/**
 * One request to the engine. `timeoutMs: null` is for a stream, which has no
 * deadline of its own and ends when either side closes it. A connection that
 * cannot be made throws `EngineUnavailableError`.
 */
export async function engineFetch(
  path: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token()}`);
  const timeoutMs = init.timeoutMs === undefined ? ENGINE_TIMEOUT_MS : init.timeoutMs;
  const signals = [init.signal, timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)]
    .filter((item): item is AbortSignal => item !== undefined);
  try {
    return await fetch(`${engineOrigin()}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
      redirect: "error",
    });
  } catch (err) {
    // A client that went away is not the engine being down.
    if (init.signal?.aborted) throw err;
    throw new EngineUnavailableError(err);
  }
}

/** A JSON call. The engine answers `{ok, ...}` or `{ok: false, error, ...}`; a body that is not JSON reads as `engine_error`. */
export async function engineJson(
  path: string,
  init: { method?: string; json?: unknown; signal?: AbortSignal; timeoutMs?: number | null } = {},
): Promise<EngineJson> {
  const res = await engineFetch(path, {
    method: init.method,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    headers: init.json === undefined ? undefined : { "content-type": "application/json" },
    signal: init.signal,
    timeoutMs: init.timeoutMs,
  });
  let body: Record<string, unknown> = { ok: res.ok, ...(res.ok ? {} : { error: "engine_error" }) };
  try {
    const parsed = await res.json() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    /* an empty or non-JSON body keeps the default above */
  }
  return { status: res.status, ok: res.ok, body };
}

/** Whether `GET /health` answers 200. No bearer is needed, so it is the status probe. */
export async function engineHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${engineOrigin()}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

function internalBot(botId: string): string {
  return `/internal/bots/${encodeURIComponent(botId)}`;
}

/**
 * Appends a note row to a bot's current chat (a connect note, a proposal
 * answer). Idempotent by `key`, so a retry never writes it twice. Throws when
 * the engine is down or refuses.
 */
export async function engineNoteRow(botId: string, key: string, text: string, source: "connect" | "system" = "connect"): Promise<void> {
  const res = await engineJson(`${internalBot(botId)}/rows`, { method: "POST", json: { key, kind: "note", text, source } });
  if (!res.ok) throw new Error(`engine_rows_${res.status}`);
}

/** Appends a widget row to the chat that drew it, idempotent by key. */
export async function engineWidgetRow(botId: string, chatId: string, widgetId: string, callId: string): Promise<void> {
  const res = await engineJson(`${internalBot(botId)}/rows`, {
    method: "POST",
    json: { chatId, key: `widget:${callId}`, kind: "widget", widgetId, callId },
  });
  if (!res.ok) throw new Error(`engine_rows_${res.status}`);
}

/**
 * Starts a system turn in the bot's current chat (the resume after a connect
 * card, D19). Idempotent by `key`: the same key twice is one turn. Returns
 * whether the engine accepted it.
 */
export async function engineSystemTurn(botId: string, key: string, text: string, note?: string): Promise<boolean> {
  const res = await engineJson(`${internalBot(botId)}/system-turn`, {
    method: "POST",
    json: { key, text, ...(note ? { note } : {}) },
  });
  return res.ok;
}

/** Claims and runs a routine now in its own chat. */
export function engineRunRoutine(routineId: string): Promise<EngineJson> {
  return engineJson(`/internal/routines/${encodeURIComponent(routineId)}/run`, { method: "POST" });
}

/** The instruction cost against the window, for `/api/bots/context`. */
export function engineBotContext(botId: string): Promise<EngineJson> {
  return engineJson(`${internalBot(botId)}/context`);
}

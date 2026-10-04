import { createHash } from "node:crypto";
import { RouterError } from "../errors.ts";
import type { RegistryEntry } from "../registry.ts";
import { applyReasoning, modelOption, modelSeesImages } from "../../../shared/models.ts";
import { rewrapThinkHistory, stripEarlierReasoning, usesInlineThink } from "../inline-think.ts";
import { UpstreamRefusalError } from "../circuit.ts";
import type { ModelSelection } from "../../../shared/session-selection.ts";
import { catalogFor } from "../../../shared/live-models.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../../../shared/policy.ts";
import {
  readProviderStore,
  recordConnectionError,
  resolveUpstream,
  setOAuthCredential,
  updateProviderStore,
  type Credential,
} from "../../../shared/providers.ts";
import { accessTokenFor, refreshCredential } from "../../../shared/provider-oauth.ts";
import { postChatCompletions } from "./openai-chat.ts";
import { postMessages } from "./anthropic-messages.ts";
import { postResponses } from "./openai-responses.ts";
import { upstreamLimitError } from "../retry-after.ts";
import { readPrefix } from "../read-capped.ts";

/**
 * `scope` ties the key to the connection and model the call goes to, so a
 * switch starts a fresh provider-side cache and routing key instead of reusing
 * one that holds another model's prefix. Ids only, never a credential.
 */
export function sessionHeader(callerId: string, sessionId: string, role: string, scope = ""): string {
  return createHash("sha256").update(`${callerId}:${sessionId}:${role}${scope ? `:${scope}` : ""}`).digest("hex");
}

/** The prompt_cache_key OpenAI documents: a stable string per conversation and model. */
export function promptCacheKey(callerId: string, sessionId: string, connectionId: string, modelId: string): string {
  return createHash("sha256").update(`${callerId}:${sessionId}:${connectionId}:${modelId}`).digest("hex").slice(0, 32);
}

export function upstreamConfigError(error: unknown): RouterError {
  const raw = error instanceof Error ? error.message : "";
  // The bot's own pick is gone or disconnected. A refusal the owner can fix by
  // choosing again: 4xx, so it never counts toward a circuit, and never a
  // quiet switch to another model.
  const thrownCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (raw === "model_selection_unavailable" || thrownCode === "model_selection_unavailable") {
    return new RouterError({
      status: 422,
      type: "invalid_request_error",
      code: "model_selection_unavailable",
      message: "model_selection_unavailable",
    });
  }
  const known = raw === "upstream_credential_missing"
    || raw === "provider_unknown"
    || raw === "provider_incompatible"
    || raw === "provider_disconnected";
  const code = known ? raw : "configuration_unverified";
  return new RouterError({
    status: 503,
    type: "internal_error",
    code,
    message: code,
  });
}

const CLIENT_CONTROLLED_KEYS = new Set(["reasoning_effort", "service_tier"]);

/**
 * Local servers (LM Studio, Custom) only put usage in a stream's last chunk
 * when asked. A Custom endpoint may reject the field, so a refusal is
 * remembered per connection and model (memory only) and later calls skip it.
 */
const USAGE_OPTION_PROVIDERS = new Set(["lmstudio", "custom"]);
const refusesStreamUsage = new Set<string>();

const IMAGE_OMITTED = "[Attached image omitted: the selected model cannot see images.]";

/**
 * A history with pictures in it outlives the model it was made with. When
 * the owner switches to a model the catalog says is text-only, the image
 * parts become a note in their place so the turn still runs; a model the
 * catalog does not know keeps them, and the upstream decides.
 */
export function withoutImagesForTextModel(messages: unknown, sees: boolean | null): unknown {
  if (sees !== false || !Array.isArray(messages)) return messages;
  return messages.map((message) => {
    const entry = message as { content?: unknown };
    if (!entry || !Array.isArray(entry.content)) return message;
    return {
      ...entry,
      content: entry.content.map((part) => {
        const p = part as { type?: unknown };
        return p?.type === "image_url" ? { type: "text", text: IMAGE_OMITTED } : part;
      }),
    };
  });
}

export function authFailed(): RouterError {
  return new RouterError({
    status: 502,
    type: "upstream_error",
    code: "upstream_auth_failed",
    message: "upstream auth failed",
  });
}

/** The token and the auth-derived headers (ChatGPT-Account-Id) for one call. */
export function tokenFor(providerId: string, credential: Credential): { token: string; headers: Record<string, string> } {
  if (credential.kind === "key") return { token: credential.key, headers: {} };
  if (credential.kind === "oauth") {
    const info = accessTokenFor(providerId, credential);
    return { token: info.token, headers: info.headers };
  }
  return { token: "", headers: {} };
}

function persistOAuthCredential(providerId: string, credential: Credential): void {
  updateProviderStore((store) => setOAuthCredential(store, providerId, credential));
}

/**
 * Status notes are bookkeeping: a lock that cannot be taken in time must
 * not turn the model call itself into a failure, so both writers swallow
 * their own errors.
 */
export function noteConnectionError(connectionId: string, code: string): void {
  try {
    updateProviderStore((store) => (
      store.connections[connectionId] ? recordConnectionError(store, connectionId, code) : store
    ));
  } catch { /* best effort */ }
}

/**
 * A success clears the last failure the router recorded on the connection.
 * The check runs inside the lock, so a failure recorded a moment ago by
 * another call is not wiped by this stale success.
 */
export function clearConnectionError(connectionId: string): void {
  try {
    updateProviderStore((store) => {
      const conn = store.connections[connectionId];
      if (!conn || !conn.lastError) return store;
      return { ...store, connections: { ...store.connections, [connectionId]: { ...conn, lastError: null } } };
    });
  } catch { /* best effort */ }
}

export type ResolvedUpstream = ReturnType<typeof resolveUpstream>;

/**
 * Which upstream a call goes to, resolved on its own so the router can key its
 * circuit by it before dispatching. A selection (the bot's own pick, from
 * `x-useful-selection`) wins over the stored last pick; none means last pick.
 */
export function resolveFor(alias: RegistryEntry["alias"], selection?: ModelSelection | null): ResolvedUpstream {
  try {
    return resolveUpstream(readProviderStore(), alias, process.env, selection ?? undefined);
  } catch (error) {
    throw upstreamConfigError(error);
  }
}

/**
 * Wraps fetch so the first byte of the upstream body is timed, whatever the
 * adapter does with the body afterwards. Headers arrive earlier than the first
 * byte on a stream; the byte is what the eval wants.
 */
function timedFetch(timing: { firstByteAt: number | null }, onSend?: () => void): typeof fetch {
  return async (url, init) => {
    timing.firstByteAt = null;
    // The adapters build and validate their bodies before they call fetch, so
    // this is the one point where a request really goes out.
    onSend?.();
    const res = await fetch(url, init);
    if (!res.body) return res;
    const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (timing.firstByteAt === null) timing.firstByteAt = Date.now();
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export async function completeUpstream(input: {
  entry: RegistryEntry;
  body: unknown;
  sessionId: string;
  callerId: string;
  signal: AbortSignal;
  resolved: ResolvedUpstream;
  /**
   * Called once for an attempt the upstream refused with a 401 that is about
   * to be refreshed and retried, so the caller can log that call too: one
   * upstream_usage line per dispatched call, the retry being the second.
   */
  /** Called just before each HTTP request is sent, never when a refresh fails first. */
  onDispatch?: () => void;
  onRefusedAttempt?: (attempt: { startedAt: number; firstByteAt: number | null; endedAt: number }) => void;
}): Promise<{
  response: Response;
  providerId: string;
  connectionId: string;
  model: string;
  fallback: boolean;
  /** Wall-clock marks for the usage log line; the first byte is null until one arrives. */
  timing: { startedAt: number; firstByteAt: number | null };
}> {
  const resolved = input.resolved;
  const timing: { startedAt: number; firstByteAt: number | null } = { startedAt: Date.now(), firstByteAt: null };
  const fetchImpl = timedFetch(timing, () => input.onDispatch?.());
  let credential = resolved.credential;
  if (credential.kind === "oauth") {
    if (accessTokenFor(resolved.providerId, credential).expired) {
      try {
        credential = await refreshCredential(resolved.providerId, credential);
        persistOAuthCredential(resolved.providerId, credential);
      } catch {
        noteConnectionError(resolved.connection.id, "upstream_auth_failed");
        throw authFailed();
      }
    }
  }
  const payload = input.body as Record<string, unknown>;
  const forwardedBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!CLIENT_CONTROLLED_KEYS.has(key)) forwardedBody[key] = value;
  }
  // The model the owner picked in the composer, resolved from the providers
  // store the same way the provider and key are. Pinning the registry id here
  // (audit round 1) made the model menu a placebo: every workhorse call went
  // to glm-5.3-flash whatever the chip said. The registry still names the
  // alias, its window policy and the fallback; the selection names the model.
  const model = resolved.model;
  const option = modelOption(resolved.connection.id, model, catalogFor(resolved.connection.id));
  const sees = modelSeesImages(option);
  // eve compacts at 75% of the model's window (agent/lib/model-window.ts reads
  // the same catalog), so the output cap keeps to the last tenth: a prompt at
  // the threshold plus a full answer still fits a small model's window.
  // `modelOption` falls back to the list's first model; only the picked
  // model's own window may size its cap. A model with no catalog window is
  // sized from the same unknown window the agent compacts at.
  const sized = option?.id === model && option.contextTokens && option.contextTokens > 0 ? option.contextTokens : null;
  const outputCap = Math.min(input.entry.maxOutputTokens, Math.floor((sized ?? UNKNOWN_WINDOW_TOKENS) / 10));
  // Reasoning from earlier turns may belong to another model: only the
  // current turn keeps it (see stripEarlierReasoning).
  const history = withoutImagesForTextModel(stripEarlierReasoning(forwardedBody.messages), sees);
  const forwarded = applyReasoning(resolved.providerId, resolved.effort, resolved.speed, {
    ...forwardedBody,
    // A model that writes its thinking inline gets it back the same way.
    messages: resolved.protocol === "openai-chat" && usesInlineThink(resolved.providerId, model)
      ? rewrapThinkHistory(history)
      : history,
    model,
    // OpenAI documents prompt_cache_key; other vendors may refuse the field.
    ...(resolved.providerId === "openai"
      ? { prompt_cache_key: promptCacheKey(input.callerId, input.sessionId, resolved.connection.id, model) }
      : {}),
    max_tokens: typeof payload.max_tokens === "number" ? Math.min(payload.max_tokens, outputCap) : outputCap,
  });
  const usageKey = `${resolved.connection.id}:${model}`;
  let askUsage = resolved.protocol === "openai-chat"
    && USAGE_OPTION_PROVIDERS.has(resolved.providerId)
    && payload.stream === true
    && !refusesStreamUsage.has(usageKey);
  let dropUsage = refusesStreamUsage.has(usageKey);
  const bodyToSend = (): Record<string, unknown> => {
    if (askUsage) {
      const existing = forwarded.stream_options;
      return { ...forwarded, stream_options: { ...(existing && typeof existing === "object" ? existing : {}), include_usage: true } };
    }
    if (!dropUsage) return forwarded;
    const { stream_options: _dropped, ...rest } = forwarded;
    return rest;
  };
  const dispatch = (): Promise<Response> => {
    const sendBody = bodyToSend();
    const auth = tokenFor(resolved.providerId, credential);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "useful-bot/1.0",
      ...(resolved.mode.headers ?? {}),
      ...auth.headers,
    };
    if (auth.token) {
      if (resolved.keyHeader === "x-api-key") headers["x-api-key"] = auth.token;
      else if (resolved.keyHeader === "api-key") headers["api-key"] = auth.token;
      else headers.authorization = `Bearer ${auth.token}`;
    }
    if (resolved.opencodeSession) {
      headers["x-opencode-session"] = sessionHeader(input.callerId, input.sessionId, "root", `${resolved.connection.id}:${model}`);
    }
    timing.startedAt = Date.now();
    if (resolved.protocol === "openai-responses") {
      return postResponses({
        fetchImpl,
        baseUrl: resolved.baseUrl,
        model,
        chatgpt: resolved.providerId === "openai",
        body: sendBody,
        headers,
        signal: input.signal,
      });
    }
    if (resolved.protocol === "anthropic-messages") {
      return postMessages({
        baseUrl: resolved.baseUrl,
        model,
        body: sendBody,
        headers,
        signal: input.signal,
        // Top-level cache_control is Anthropic's own documented feature.
        cache: resolved.providerId === "anthropic",
        fetchImpl,
      });
    }
    return postChatCompletions({ baseUrl: resolved.baseUrl, body: sendBody, headers, signal: input.signal, fetchImpl });
  };
  let response = await dispatch();
  const answeredAt = Date.now();
  // One refresh and one retry on an oauth 401, then the auth failure below.
  if (response.status === 401 && credential.kind === "oauth") {
    // The refused attempt's own timing, taken before the retry resets it. A
    // 401 body is never read, so its first byte falls back to the headers.
    input.onRefusedAttempt?.({ startedAt: timing.startedAt, firstByteAt: timing.firstByteAt ?? answeredAt, endedAt: answeredAt });
    try {
      await response.body?.cancel();
    } catch { /* the retry carries on regardless */ }
    try {
      credential = await refreshCredential(resolved.providerId, credential);
      persistOAuthCredential(resolved.providerId, credential);
    } catch {
      noteConnectionError(resolved.connection.id, "upstream_auth_failed");
      throw authFailed();
    }
    response = await dispatch();
  }
  // A server that rejects stream_options (400, or 422 from strict schema
  // servers): log that attempt, ask without it once. It is remembered only
  // when the retry works, so an unrelated 400 that echoes the field can't
  // switch usage off for the rest of the process.
  if (askUsage && (response.status === 400 || response.status === 422)) {
    const text = await readPrefix(response.clone(), REFUSAL_BODY_BYTES);
    if (text.includes("stream_options")) {
      const refusedAt = Date.now();
      input.onRefusedAttempt?.({ startedAt: timing.startedAt, firstByteAt: timing.firstByteAt ?? refusedAt, endedAt: refusedAt });
      askUsage = false;
      dropUsage = true;
      try {
        await response.body?.cancel();
      } catch { /* the retry carries on regardless */ }
      response = await dispatch();
      if (response.status >= 200 && response.status < 300) refusesStreamUsage.add(usageKey);
    }
  }
  if (response.status >= 200 && response.status < 300) {
    clearConnectionError(resolved.connection.id);
    return { response, providerId: resolved.providerId, connectionId: resolved.connection.id, model, fallback: resolved.fallback, timing };
  }
  if (response.status >= 300 && response.status < 400) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "upstream_protocol_error",
      message: "upstream redirect rejected",
    });
  }
  if (response.status === 401 || response.status === 403) {
    noteConnectionError(resolved.connection.id, "upstream_auth_failed");
    throw authFailed();
  }
  if (response.status === 429) {
    throw await upstreamLimitError(response);
  }
  if (response.status === 402) {
    // Marked on the connection too, so the providers pane flags the account
    // rather than leaving the owner to find it from a failed turn.
    noteConnectionError(resolved.connection.id, "upstream_quota_exhausted");
    throw await upstreamOutOfCredit(response, `${resolved.providerId}/${model}`);
  }
  if (response.status === 404) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "model_unavailable",
      message: "model_unavailable",
    });
  }
  const refusal = await upstreamRefusal(response);
  // A 4xx is the provider refusing this request (context overflow, invalid
  // request, tools or images it does not take), not the upstream failing: it
  // keeps the code the app reads, but the circuit never counts it.
  const Failure = response.status < 500 ? UpstreamRefusalError : RouterError;
  throw new Failure({
    status: 502,
    type: "upstream_error",
    code: "upstream_protocol_error",
    // eve folds this message into the failed turn's text. Only the status and
    // the provider's error type and code travel: its free-text message can
    // quote a masked key or the request, so that stays in the local log.
    message: `upstream_protocol_error (${refusal.kind})`,
    upstream: `${resolved.providerId}/${model} ${refusal.kind}${refusal.message ? `: ${refusal.message}` : ""}`,
  });
}

const REFUSAL_BODY_BYTES = 4096;
const REFUSAL_MESSAGE_CHARS = 200;

/** One line of printable text, capped. */
function oneLineCapped(value: unknown, cap: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, cap);
}

/**
 * 402 Payment Required is how DeepSeek and OpenRouter say the account is out
 * of credit. A top-up is the only fix and it works at once, so it is answered
 * as the used-up credit it is: 402, never retried, and no circuit, where it
 * used to read as a protocol error that also counted toward one. The body is
 * read only for the local log.
 */
export async function upstreamOutOfCredit(response: Response, target: string): Promise<RouterError> {
  const refusal = await upstreamRefusal(response);
  return new RouterError({
    status: 402,
    type: "rate_limit_error",
    code: "upstream_quota_exhausted",
    message: "upstream_quota_exhausted",
    retryable: false,
    upstream: `${target} ${refusal.kind}${refusal.message ? `: ${refusal.message}` : ""}`,
  });
}

/** Anything shaped like a credential, masked or not, never reaches the log. */
const KEY_LIKE = /\b(?:sk|pk|rk|ak|key|token|bearer)[-_][\w*.-]{6,}|\b[A-Za-z0-9_-]{32,}\b/gi;

/**
 * The provider's own words for a refusal, from at most 4 KiB of the body:
 * `kind` is the status plus its error type and code, `message` its capped
 * free text with key-like runs masked. Every model on every protocol lands
 * here on a non-2xx, and until now the body was dropped unread, so a model
 * that refused every call for a day (MiMo V2.6 Pro, 2026-09-23) looked the
 * same as one that was down.
 */
export async function upstreamRefusal(response: Response): Promise<{ kind: string; message: string }> {
  let raw = "";
  try {
    raw = await readPrefix(response, REFUSAL_BODY_BYTES);
  } catch {
    return { kind: String(response.status), message: "" };
  }
  let type = "";
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; type?: unknown; code?: unknown };
    const inner = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    // Type and code are the provider's enums; anything else in those fields
    // is dropped rather than relayed.
    type = /^[\w.-]{1,60}$/.test(String(inner?.type ?? parsed.type ?? "")) ? String(inner?.type ?? parsed.type) : "";
    code = /^[\w.-]{1,60}$/.test(String(inner?.code ?? parsed.code ?? "")) ? String(inner?.code ?? parsed.code) : "";
    message = oneLineCapped(inner?.message ?? (typeof parsed.error === "string" ? parsed.error : parsed.message), REFUSAL_MESSAGE_CHARS)
      .replace(KEY_LIKE, "[redacted]");
  } catch {
    // Not JSON (a proxy's HTML page, a truncated body): the status says enough.
  }
  const detail = [type, code].filter((part) => part.length > 0).join("/");
  return { kind: `${response.status}${detail ? ` ${detail}` : ""}`, message };
}

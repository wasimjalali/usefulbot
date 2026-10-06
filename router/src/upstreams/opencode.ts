import { createHash } from "node:crypto";
import { RouterError } from "../errors.ts";
import type { RegistryEntry } from "../registry.ts";
import { applyReasoning, modelOption, modelSeesImages } from "../../../shared/models.ts";
import { rewrapThinkHistory, stripEarlierReasoning, usesInlineThink } from "../inline-think.ts";
import { UpstreamRefusalError } from "../circuit.ts";
import type { ModelSelection } from "../../../shared/session-selection.ts";
import { catalogFor, listedForAccount } from "../../../shared/live-models.ts";
import { providerMode } from "../../../shared/provider-catalog.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../../../shared/policy.ts";
import {
  readProviderStore,
  recordConnectionError,
  recordUnavailableModelFor,
  accountKey,
  isLegacyChatGptCredential,
  resolveUpstream,
  setOAuthCredential,
  updateProviderStore,
  type Credential,
} from "../../../shared/providers.ts";
import { revokeChatGptCredential } from "../../../shared/chatgpt-signin.ts";
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
  // The route was turned off by its vendor's terms (UB-015). The message is the
  // sentence the owner reads, so it travels with the code. 4xx like the pick
  // refusal above: nothing to retry, nothing for a circuit to count.
  if (thrownCode === "provider_route_retired") {
    return new RouterError({
      status: 422,
      type: "invalid_request_error",
      code: "provider_route_retired",
      message: `provider_route_retired: ${raw}`,
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

/** The token and the auth-derived headers for one call. */
export function tokenFor(providerId: string, credential: Credential): { token: string; headers: Record<string, string> } {
  if (credential.kind === "key") return { token: credential.key, headers: {} };
  if (credential.kind === "oauth") {
    const info = accessTokenFor(providerId, credential);
    return { token: info.token, headers: info.headers };
  }
  return { token: "", headers: {} };
}

/**
 * Refreshes in flight, one per connection. Refresh tokens rotate, so two
 * parallel refreshes with the same token would burn the session: the second
 * caller joins the first's promise instead.
 */
const refreshing = new Map<string, Promise<Credential>>();

/** The auth server could not be reached or answered 5xx: nothing is wrong with the sign-in, try again. */
function refreshUnavailable(): RouterError {
  return new UpstreamRefusalError({
    status: 503,
    type: "upstream_error",
    code: "upstream_unavailable",
    message: "upstream_unavailable",
    retryable: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rotated credentials the store would not take, per connection, keyed by the
 * refresh token the store still holds (the spent one). Memory only: the rotated
 * refresh token exists nowhere else, and spending the spent one again would
 * burn the session.
 */
const unstored = new Map<string, { spent: string | null; credential: Credential }>();

/**
 * Store a refreshed credential only while the stored one still carries the
 * `guard` refresh token; a connection removed meanwhile stays gone. A failed
 * write is tried 3 times; when all fail the credential is kept in `unstored`.
 */
async function storeRefreshed(connectionId: string, providerId: string, guard: string | null, next: Credential): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      let gone = false;
      updateProviderStore((store) => {
        const current = store.connections[connectionId]?.credential;
        if (!current || current.kind !== "oauth") {
          gone = true;
          return store;
        }
        // Another registration took the slot meanwhile: the new session has no owner either.
        if (next.kind === "oauth" && next.clientId && current.clientId !== next.clientId) {
          gone = true;
          return store;
        }
        if (current.refreshToken !== guard) return store;
        return setOAuthCredential(store, providerId, next);
      });
      // Disconnected (or switched to another registration) while the refresh ran: the new session has no owner, end it.
      if (gone && providerId === "openai") {
        revokeChatGptCredential(next).then((confirmed) => {
          if (!confirmed) console.error("[useful-bot] chatgpt refresh: revoke_unconfirmed");
        }, () => console.error("[useful-bot] chatgpt refresh: revoke_unconfirmed"));
      }
      return true;
    } catch (error) {
      if (attempt < 3) {
        await sleep(200);
        continue;
      }
      const code = error instanceof Error && /^[\w.-]{1,60}$/.test(error.message) ? error.message : "store_write_failed";
      console.error(`[useful-bot] refreshed credential for ${connectionId} was not stored: ${code}`);
    }
  }
  unstored.set(connectionId, { spent: guard, credential: next });
  return false;
}

/** A refresh token the auth server refused for good: clear it (docs: clear unusable tokens), under the same guard. */
function clearUnusable(connectionId: string, providerId: string, guard: string | null): void {
  try {
    updateProviderStore((store) => {
      const current = store.connections[connectionId]?.credential;
      if (!current || current.kind !== "oauth") return store;
      if (current.refreshToken !== guard) return store;
      return setOAuthCredential(store, providerId, { ...current, refreshToken: null, expiresAt: 0 });
    });
  } catch { /* best effort: the next call fails the same way */ }
}

/**
 * A fresh credential for a connection whose token is expired or was refused.
 * Re-reads the store first: another call (or process) may have refreshed it
 * already, and then its token is used as is; so is a rotated token the store
 * would not take earlier (its write is retried). Otherwise one refresh runs for
 * the connection. A refresh the auth server refuses for good clears the
 * ChatGPT sign-in's tokens and fails as an auth failure; a rejected client
 * fails the same way but keeps the tokens; a transient failure is a retryable
 * 503 and records nothing against the connection.
 */
async function renewedCredential(connectionId: string, providerId: string, held: Credential): Promise<Credential> {
  const stored = readProviderStore().connections[connectionId]?.credential;
  if (stored && stored.kind === "oauth" && held.kind === "oauth" && stored.accessToken !== held.accessToken
    && !accessTokenFor(providerId, stored).expired) {
    return stored;
  }
  const kept = unstored.get(connectionId);
  let keptBase: Credential | null = null;
  if (kept) {
    if (stored && stored.kind === "oauth" && stored.refreshToken === kept.spent) {
      if (await storeRefreshed(connectionId, providerId, kept.spent, kept.credential)) unstored.delete(connectionId);
      if (!accessTokenFor(providerId, kept.credential).expired) return kept.credential;
      keptBase = kept.credential;
    } else {
      unstored.delete(connectionId);
    }
  }
  const running = refreshing.get(connectionId);
  if (running) return running;
  // The guard is the refresh token the store holds right now: after a kept
  // credential was written back that is its rotated token, not the spent one.
  const now = readProviderStore().connections[connectionId]?.credential;
  const base = keptBase ?? (now && now.kind === "oauth" ? now : held);
  const guard = now && now.kind === "oauth" ? now.refreshToken : base.kind === "oauth" ? base.refreshToken : null;
  const run = (async () => {
    let next: Credential;
    try {
      next = await refreshCredential(providerId, base);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "oauth_refresh_transient") throw refreshUnavailable();
      if (code === "oauth_refresh_client") {
        console.error("[useful-bot] chatgpt refresh: oauth_refresh_client");
        noteConnectionError(connectionId, "upstream_auth_failed");
        throw authFailed();
      }
      if (providerId === "openai") clearUnusable(connectionId, providerId, guard);
      noteConnectionError(connectionId, "upstream_auth_failed");
      throw authFailed();
    }
    await storeRefreshed(connectionId, providerId, guard, next);
    return next;
  })().finally(() => refreshing.delete(connectionId));
  refreshing.set(connectionId, run);
  return run;
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
    // A ChatGPT sign-in from the old Codex route is not sent anywhere.
    if (isLegacyChatGptCredential(resolved.providerId, "oauth", credential)) {
      noteConnectionError(resolved.connection.id, "upstream_auth_failed");
      throw authFailed();
    }
    if (accessTokenFor(resolved.providerId, credential).expired) {
      credential = await renewedCredential(resolved.connection.id, resolved.providerId, credential);
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
  // Whether the vendor's own list names this model, read now: the cache can
  // change before a refusal comes back (see dropUnlistedModel).
  // Only a list fetched for the account that sends counts: the cache is per
  // connection and can still hold another saved account's list after a switch.
  // Without a match the model reads as unlisted, so a refusal drops it for the
  // sending account (and only the merged GPT-6 ids are ever dropped).
  let listedAtDispatch = listedForAccount(resolved.connection.id, model, accountKey(credential));
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
        onRefusal: resolved.providerId === "openai"
          ? ({ code, param }) => (refusalAboutModel(code, param) && dropUnlistedModel(resolved.connection.id, model, credential, listedAtDispatch)
            ? CHATGPT_MODEL_NOT_IN_PLAN
            : null)
          : undefined,
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
    const before = credential;
    credential = await renewedCredential(resolved.connection.id, resolved.providerId, credential);
    // The renewed credential can belong to another saved account (the owner
    // switched meanwhile). The listed snapshot belongs to the account that
    // sends, so it is taken again for that one; the same account keeps it.
    if (accountKey(credential) !== accountKey(before)) {
      listedAtDispatch = listedForAccount(resolved.connection.id, model, accountKey(credential));
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
  const chatGptRoute = resolved.providerId === "openai" && resolved.protocol === "openai-responses";
  if (response.status === 403 && chatGptRoute) {
    // Every 403 on this route is a policy refusal (account not eligible, region,
    // plan sharing off), never an expired sign-in: that is a 401. The body only
    // tells which kind it is.
    const refused = await chatGptError(response);
    if (refused.code === "subscription_sharing_user_not_eligible" && dropUnlistedModel(resolved.connection.id, model, credential, listedAtDispatch)) {
      throw new UpstreamRefusalError({
        status: 403,
        type: "permission_error",
        code: CHATGPT_MODEL_NOT_IN_PLAN,
        message: CHATGPT_MODEL_NOT_IN_PLAN,
        retryable: false,
      });
    }
    const code = refused.code === "subscription_sharing_user_not_eligible"
      ? "upstream_chatgpt_not_eligible"
      : "upstream_chatgpt_not_permitted";
    throw new UpstreamRefusalError({
      status: 403,
      type: "permission_error",
      code,
      message: code,
      retryable: false,
    });
  }
  if (response.status === 400 && chatGptRoute) {
    // The documented model refusal. Any other 400 (a tool or input type the
    // plan route lacks, a bad request) keeps the generic path below.
    const refused = await chatGptError(response.clone());
    if (refused.code === "subscription_sharing_unsupported_capability" && refusalAboutModel(refused.code, refused.param) && dropUnlistedModel(resolved.connection.id, model, credential, listedAtDispatch)) {
      throw new UpstreamRefusalError({
        status: 400,
        type: "invalid_request_error",
        code: CHATGPT_MODEL_NOT_IN_PLAN,
        message: CHATGPT_MODEL_NOT_IN_PLAN,
        retryable: false,
      });
    }
  }
  if (response.status === 503 && chatGptRoute) {
    // Plan sharing could not check usage or the user: temporary, not the
    // model failing, so no circuit count and no auth note.
    const named = await chatGptErrorCode(response.clone());
    if (named === "subscription_sharing_usage_unavailable" || named === "subscription_sharing_user_unavailable") {
      throw refreshUnavailable();
    }
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

/** `error.code` and `error.param` of a JSON error body; the code falls back to a top-level `detail` string. Null when absent. */
async function chatGptError(response: Response): Promise<{ code: string | null; param: string | null }> {
  try {
    const parsed = JSON.parse(await readPrefix(response, REFUSAL_BODY_BYTES)) as unknown;
    if (!parsed || typeof parsed !== "object") return { code: null, param: null };
    const body = parsed as { error?: unknown; detail?: unknown };
    const error = body.error && typeof body.error === "object" ? body.error as { code?: unknown; param?: unknown } : null;
    const param = typeof error?.param === "string" ? error.param : null;
    if (typeof error?.code === "string") return { code: error.code, param };
    return { code: typeof body.detail === "string" ? body.detail : null, param };
  } catch {
    return { code: null, param: null };
  }
}

async function chatGptErrorCode(response: Response): Promise<string | null> {
  return (await chatGptError(response)).code;
}

/** The code the app maps to "Your ChatGPT plan can't use <model>" (EveStream.swift). */
export const CHATGPT_MODEL_NOT_IN_PLAN = "upstream_chatgpt_model_not_in_plan";

/**
 * Whether a plan-sharing refusal is about the model itself: the documented
 * unsupported capability (model, tool or input type) names the model or says
 * nothing, and an ineligible account is refused on every model it tries
 * (docs: token-sharing-open-source/errors-and-recovery).
 */
export function refusalAboutModel(code: string | null, param: string | null): boolean {
  if (code === "subscription_sharing_user_not_eligible") return true;
  return code === "subscription_sharing_unsupported_capability" && (param === null || param === "model");
}

/**
 * UB-016. A ChatGPT plan can run a model the vendor list omits, and only a
 * real turn says whether this account may. When this refused model is one the
 * app merged in (not a row the vendor listed), drop it from the menu of the
 * account that sent the request, and say so (true). A listed model, another
 * connection or a credential with no account id is never touched. The drop is
 * keyed by the held credential, so an account switch while the call ran still
 * records it for the account that was refused and leaves the one now stored
 * alone. Whether the vendor listed the model is the answer at dispatch
 * (listedAtDispatch), not the cache at refusal time: another account's refresh
 * can rewrite the cache while the call runs. It is skipped when no ChatGPT sign-in is stored any more, and when
 * the held account signed out (signedOutAccounts) even if another account has
 * signed in since.
 * The store is written under its lock.
 */
function dropUnlistedModel(connectionId: string, model: string, held: Credential, listedAtDispatch: boolean): boolean {
  if (connectionId !== "openai:oauth") return false;
  if (!providerMode("openai", "oauth").unlistedModels?.some((extra) => extra.id === model)) return false;
  if (listedAtDispatch) return false;
  const account = accountKey(held);
  if (!account) return false;
  try {
    updateProviderStore((store) => {
      // An account that signed out (and has not signed in since) is not saved:
      // its sign-out cleared this list, so a late refusal must not restore it.
      if (store.signedOutAccounts?.includes(account)) return store;
      const current = store.connections[connectionId]?.credential;
      if (!current || current.kind !== "oauth") return store;
      return recordUnavailableModelFor(store, account, model);
    });
  } catch (error) {
    // The turn still fails with the plan message; the next one asks again.
    console.error(`[useful-bot] chatgpt model drop was not stored: ${error instanceof Error && /^[\w.-]{1,60}$/.test(error.message) ? error.message : "store_write_failed"}`);
  }
  return true;
}
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

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readProviderStore, type Credential } from "./providers.ts";
import { statePath, webPort } from "./stack.ts";

/**
 * Sign in with ChatGPT, OpenAI's official route for open-source apps. A
 * browser authorization code flow with PKCE on a loopback callback, then the
 * public Responses API. The spec is the docs at
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * and its profiles-and-sessions, token-reference and errors-and-recovery pages.
 *
 * This file holds the whole flow: the pending attempt, the host id and the
 * issued-client registration (a 0600 file, atomic like the providers store),
 * the code exchange, ID token validation, refresh and revoke. The web routes
 * only carry the browser callback and write the credential to the providers
 * store. Tokens, the authorize URL (it can carry id_token_hint) and the
 * callback query are never logged.
 */

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const AGENT_NAME = "Useful Bot";

/** An attempt lives ten minutes. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const SIGNIN_POLL_INTERVAL_MS = 1000;
const CLOCK_SKEW_MS = 60_000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

/** OAuth errors that mean the refresh token is unusable (docs: errors-and-recovery, Refresh errors). invalid_client is separate: the client, not the token. */
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

type FetchFn = typeof fetch;

export type SignInErrorCode =
  | "chatgpt_plan_not_enabled"
  | "chatgpt_account_mismatch"
  | "chatgpt_registration_incomplete"
  | "chatgpt_client_mismatch"
  | "chatgpt_id_token_invalid"
  | "chatgpt_token_exchange"
  | "chatgpt_signin_refused";

interface Registration {
  clientId: string;
  /** The validated ID token subject; null while the client id is provisional (issued, no token validated yet). */
  subject: string | null;
  email: string | null;
  needsConsent: boolean;
}

interface Settled {
  status: "complete" | "denied" | "error";
  error?: string;
  /** The issued client id the failed attempt held, so the app can offer "Try again" with it. */
  retryClientId?: string;
}

interface Pending {
  pollId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** The saved issued client id, or null when this attempt registers a new one. */
  clientId: string | null;
  isNew: boolean;
  createdAt: number;
  expiresAt: number;
  outcome: Settled | null;
}

interface SignInState {
  hostId: string | null;
  /** One entry per issued client id, kept across Disconnect (docs: keep the account/client mapping). */
  registrations: Registration[];
  /** The last client whose identity was validated. A provisional client never becomes it. */
  lastClientId: string | null;
  /** The issued client id of a new registration that failed before its identity was validated: the next new-account attempt reuses it. */
  retryClientId: string | null;
  pending: Pending | null;
  /** The last completed attempt, so a reloaded callback tab can show success without exchanging again. */
  lastDone: { stateHash: string; at: number } | null;
}

export type SignInOutcome =
  | { status: "complete"; credential: Credential }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: SignInErrorCode }
  /** A reload of a callback that completed within the last ten minutes: show success, exchange nothing. */
  | { status: "repeat" }
  /** The callback was not for the live attempt: nothing was touched. */
  | { status: "refused"; error: "chatgpt_state_mismatch" };

export interface SignInPoll {
  status: "pending" | "complete" | "denied" | "expired" | "error";
  error?: string;
  retryClientId?: string;
}

export type SignInAccount = { clientId: string; label: string };

export function chatGptSignInPath(): string {
  return process.env.UB_CHATGPT_SIGNIN_PATH || statePath("chatgpt-signin.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseRegistration(raw: unknown): Registration | null {
  if (!isRecord(raw) || !str(raw.clientId)) return null;
  return {
    clientId: raw.clientId as string,
    subject: str(raw.subject),
    email: str(raw.email),
    needsConsent: raw.needsConsent === true,
  };
}

function readState(path = chatGptSignInPath()): SignInState {
  const empty: SignInState = { hostId: null, registrations: [], lastClientId: null, retryClientId: null, pending: null, lastDone: null };
  // Only a file that does not exist is a first run. Anything else unreadable
  // must fail loud: an empty state would be written over saved registrations.
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    logFailure("chatgpt_state_unreadable", "read");
    throw new Error("chatgpt_state_unreadable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    logFailure("chatgpt_state_unreadable", "parse");
    throw new Error("chatgpt_state_unreadable");
  }
  if (!isRecord(raw)) {
    logFailure("chatgpt_state_unreadable", "shape");
    throw new Error("chatgpt_state_unreadable");
  }
  const out: SignInState = { hostId: str(raw.hostId), registrations: [], lastClientId: str(raw.lastClientId), retryClientId: str(raw.retryClientId), pending: null, lastDone: null };
  // The first release kept one `registration`; it becomes the first entry.
  const listed = Array.isArray(raw.registrations) ? raw.registrations : raw.registration ? [raw.registration] : [];
  for (const item of listed) {
    const reg = parseRegistration(item);
    if (reg && !out.registrations.some((r) => r.clientId === reg.clientId)) out.registrations.push(reg);
  }
  if (isRecord(raw.lastDone) && str(raw.lastDone.stateHash) && typeof raw.lastDone.at === "number") {
    out.lastDone = { stateHash: raw.lastDone.stateHash as string, at: raw.lastDone.at };
  }
  const p = raw.pending;
  if (
    isRecord(p) && str(p.pollId) && str(p.state) && str(p.nonce) && str(p.codeVerifier) && str(p.redirectUri)
    && typeof p.createdAt === "number" && typeof p.expiresAt === "number"
  ) {
    const outcome = isRecord(p.outcome) && (p.outcome.status === "complete" || p.outcome.status === "denied" || p.outcome.status === "error")
      ? {
        status: p.outcome.status,
        ...(str(p.outcome.error) ? { error: p.outcome.error as string } : {}),
        ...(str(p.outcome.retryClientId) ? { retryClientId: p.outcome.retryClientId as string } : {}),
      } as Settled
      : null;
    out.pending = {
      pollId: p.pollId as string,
      state: p.state as string,
      nonce: p.nonce as string,
      codeVerifier: p.codeVerifier as string,
      redirectUri: p.redirectUri as string,
      clientId: str(p.clientId),
      isNew: p.isNew === true,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      outcome,
    };
  }
  return out;
}

function writeState(state: SignInState, path = chatGptSignInPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Read, change and write the state in one step. */
function update(change: (state: SignInState) => void): SignInState {
  const state = readState();
  change(state);
  writeState(state);
  return state;
}

/** One line per failure: the code and a detail that is never a body, a description or a token. */
function logFailure(code: string, detail = ""): void {
  console.error(`[useful-bot] chatgpt sign-in: ${code}${detail ? ` ${detail}` : ""}`);
}

/** Our own internal reasons only; anything else (a fetch error's text) is not relayed. */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return /^(jwt_\w+|kid_unknown|jwks_unavailable|id_token_missing)$/.test(message) ? message : "unknown";
}

/** The OAuth `error` enum of a failed token answer, or "none". Never error_description. */
async function oauthErrorOf(res: Response): Promise<string> {
  try {
    const body = await res.json() as unknown;
    const code = isRecord(body) ? body.error : null;
    return typeof code === "string" && /^[\w.-]{1,60}$/.test(code) ? code : "none";
  } catch {
    return "none";
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The callback URI is always the numeric loopback, never localhost and never the configured base URL. */
function redirectUri(): string {
  return `http://127.0.0.1:${webPort()}/auth/callback`;
}

function storedChatGptCredential(): Credential | null {
  return readProviderStore().connections["openai:oauth"]?.credential ?? null;
}

/** Validated registrations only: a provisional client has no identity yet. */
function validated(state: SignInState): Registration[] {
  return state.registrations.filter((r) => r.subject !== null);
}

/**
 * The registration a default sign-in uses, never a provisional one: the one
 * whose client id the stored credential carries, else the last validated
 * client, else the most recently added validated one.
 */
function pickRegistration(state: SignInState, held: Credential | null): Registration | null {
  const saved = validated(state);
  if (saved.length === 0) return null;
  const byCredential = held && held.kind === "oauth" && held.clientId
    ? saved.find((r) => r.clientId === held.clientId)
    : undefined;
  return byCredential
    ?? saved.find((r) => r.clientId === state.lastClientId)
    ?? saved[saved.length - 1]!;
}

/** The saved accounts to choose from: the email, or a short stand-in; labels that collide get the client id's last 4. */
function accountList(state: SignInState): SignInAccount[] {
  const rows = validated(state).map((r) => ({
    clientId: r.clientId,
    label: r.email ?? `ChatGPT account ${r.clientId.slice(-4)}`,
  }));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  return rows.map((row) => (counts.get(row.label)! > 1 ? { ...row, label: `${row.label} (${row.clientId.slice(-4)})` } : row));
}

/**
 * Begin a sign-in. A new start replaces any attempt still pending, so the old
 * callback is refused. Which client it uses:
 * - `clientId`: that saved, validated registration (else `chatgpt_account_unknown`);
 * - `retryClientId`: the issued client a failed attempt reported, a validated
 *   registration or the provisional one left by a failed registration (else
 *   `chatgpt_account_unknown`);
 * - `newAccount`: always a fresh dynamic registration;
 * - otherwise the saved, validated account of the stored credential, or a
 *   fresh registration when none is validated yet. A provisional client is
 *   never reused implicitly.
 * `storedCredential` is the openai:oauth credential the store holds now (read
 * from the store when left out); its ID token becomes id_token_hint only when
 * it belongs to the registration used. `account` is that registration's email,
 * `accounts` lists every validated one, `reusesSaved` says the attempt uses an
 * issued client rather than registering a new one.
 */
export function startChatGptSignIn(
  opts: { storedCredential?: Credential | null; now?: number; newAccount?: boolean; clientId?: string; retryClientId?: string } = {},
): {
  pollId: string; authorizeUrl: string; expiresAt: number; intervalMs: number;
  account: string | null; accounts: SignInAccount[]; reusesSaved: boolean; clientId: string | null;
} {
  const now = opts.now ?? Date.now();
  flushDeferredIdentities();
  const state = readState();
  const hostId = state.hostId ?? `urn:uuid:${randomUUID()}`;
  const held = opts.storedCredential === undefined ? storedChatGptCredential() : opts.storedCredential;
  let registration: Registration | null = null;
  let provisionalClient: string | null = null;
  if (opts.clientId !== undefined) {
    registration = validated(state).find((r) => r.clientId === opts.clientId) ?? null;
    if (!registration) throw new Error("chatgpt_account_unknown");
  } else if (opts.retryClientId !== undefined) {
    registration = validated(state).find((r) => r.clientId === opts.retryClientId) ?? null;
    if (!registration) {
      if (state.retryClientId !== opts.retryClientId) throw new Error("chatgpt_account_unknown");
      provisionalClient = opts.retryClientId;
    }
  } else {
    registration = opts.newAccount ? null : pickRegistration(state, held);
  }
  const clientId = registration?.clientId ?? provisionalClient;
  const verifier = randomToken();
  const attempt: Pending = {
    pollId: randomBytes(16).toString("hex"),
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: verifier,
    redirectUri: redirectUri(),
    clientId,
    isNew: !clientId,
    createdAt: now,
    expiresAt: now + ATTEMPT_TTL_MS,
    outcome: null,
  };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId ?? DYNAMIC_CLIENT,
  });
  if (!clientId) params.set("agent_name_hint", AGENT_NAME);
  params.set("ext_agent_host_id", hostId);
  if (registration) {
    if (registration.email) params.set("login_hint", registration.email);
    if (held && held.kind === "oauth" && held.idToken && held.clientId === registration.clientId) {
      params.set("id_token_hint", held.idToken);
    }
    if (registration.needsConsent) params.set("prompt", "consent");
  }
  params.set("redirect_uri", attempt.redirectUri);
  params.set("scope", SCOPE);
  params.set("resource", RESOURCE);
  params.set("state", attempt.state);
  params.set("nonce", attempt.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  writeState({ ...state, hostId, pending: attempt });
  return {
    pollId: attempt.pollId,
    authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}`,
    expiresAt: attempt.expiresAt,
    intervalMs: SIGNIN_POLL_INTERVAL_MS,
    account: registration?.email ?? null,
    accounts: accountList(state),
    reusesSaved: clientId !== null,
    clientId,
  };
}

const REFUSED: SignInOutcome = { status: "refused", error: "chatgpt_state_mismatch" };

/**
 * The settled outcome of an attempt, kept in memory as well as in the file: a
 * failed file write must not turn a finished sign-in into a poll that hangs.
 * Small, and each entry is removed when its poll reads it.
 */
interface SharedState {
  settled: Map<string, Settled>;
  /** sha256 of the state of each remembered attempt, for tombstones. */
  hashes: Map<string, string>;
  done: { stateHash: string; at: number } | null;
  /** Attempts cancelled here: a callback for one stays refused even if a later file write succeeds. */
  cancelled: Set<string>;
  /** Validated identities whose file write failed after the credential was stored; written first on the next start, poll or complete. */
  deferred: Array<{ clientId: string; identity: { sub: string; email: string | null }; needsConsent: boolean }>;
  /** State hashes of attempts whose outcome was polled from memory while the disk row stayed unsettled. */
  tombstones: Set<string>;
  inFlight: Set<string>;
  jwks: { fetchedAt: number; keys: JsonWebKey[] } | null;
}
// On globalThis, like web/lib/sync-models.ts: the dev server gives each API
// route its own copy of this module, and recovery only works if the callback
// route, the poll route and the start route share one set of memory.
const SHARED_KEY = Symbol.for("useful-bot.chatgpt-signin.state");
const shared: SharedState = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] ??= {
  settled: new Map(),
  hashes: new Map(),
  done: null,
  cancelled: new Set(),
  deferred: [],
  tombstones: new Set(),
  inFlight: new Set(),
  jwks: null,
}) as SharedState;
const settledInMemory = shared.settled;
const cancelledPolls = shared.cancelled;
const deferredIdentities = shared.deferred;
/** Attempts whose code exchange is running, so a replayed callback cannot start a second one. */
const inFlight = shared.inFlight;

function flushDeferredIdentities(): void {
  while (deferredIdentities.length > 0) {
    const next = deferredIdentities[0]!;
    try {
      recordIdentity(next.clientId, next.identity, next.needsConsent);
    } catch {
      return; // still unwritable; it stays queued
    }
    deferredIdentities.shift();
  }
}

function rememberCancelled(pollId: string): void {
  cancelledPolls.add(pollId);
  while (cancelledPolls.size > 16) cancelledPolls.delete(cancelledPolls.values().next().value as string);
}

function remember(pollId: string, outcome: Settled, attemptState?: string): void {
  settledInMemory.set(pollId, outcome);
  if (attemptState) shared.hashes.set(pollId, stateHash(attemptState));
  while (shared.hashes.size > 16) shared.hashes.delete(shared.hashes.keys().next().value as string);
  while (settledInMemory.size > 8) settledInMemory.delete(settledInMemory.keys().next().value as string);
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** True while `pollId` is still the live, unsettled attempt. */
function stillLive(pollId: string): boolean {
  const { pending } = readState();
  return Boolean(pending && pending.pollId === pollId && !pending.outcome && !cancelledPolls.has(pollId));
}

/** Settle the attempt `pollId`, unless it was replaced or cancelled meanwhile. */
function settle(pollId: string, outcome: Settled, change?: (state: SignInState) => void): boolean {
  const state = readState();
  if (!state.pending || state.pending.pollId !== pollId || state.pending.outcome) return false;
  remember(pollId, outcome, state.pending.state);
  state.pending = { ...state.pending, outcome };
  change?.(state);
  writeState(state);
  return true;
}

function failed(pollId: string, error: SignInErrorCode, detail = "", retryClientId: string | null = null): SignInOutcome {
  logFailure(error, detail);
  if (!settle(pollId, { status: "error", error, ...(retryClientId ? { retryClientId } : {}) })) return REFUSED;
  return { status: "error", error };
}

/**
 * Record the validated identity of `clientId` (the only place `lastClientId`
 * is set). Entries are keyed by issued client id alone: another client with the
 * same subject or email is another workspace and stays.
 */
function recordIdentity(clientId: string, identity: { sub: string; email: string | null }, needsConsent: boolean): void {
  update((state) => {
    const entry = state.registrations.find((r) => r.clientId === clientId);
    if (!entry) state.registrations.push({ clientId, subject: identity.sub, email: identity.email, needsConsent });
    else Object.assign(entry, { subject: identity.sub, email: identity.email, needsConsent });
    state.lastClientId = clientId;
    if (state.retryClientId === clientId) state.retryClientId = null;
  });
}

/**
 * The browser callback. A callback that is not for the live attempt is refused
 * before anything else and leaves the attempt untouched; one that repeats a
 * completion from the last ten minutes (a reloaded tab) answers `repeat`.
 * `persist` stores the new credential; the attempt settles complete only after
 * it returned, and a throw settles `chatgpt_signin_refused` instead.
 */
export async function completeChatGptSignIn(
  params: { state: string | null; code: string | null; error: string | null; clientId: string | null },
  fetchImpl: FetchFn = fetch,
  persist?: (credential: Credential) => void,
): Promise<SignInOutcome> {
  flushDeferredIdentities();
  const state = readState();
  const { pending } = state;
  // A completion from the last ten minutes (file or memory) is a reloaded tab,
  // whatever the disk row says: it never exchanges again.
  if (params.state) {
    for (const done of [state.lastDone, shared.done]) {
      if (done && Date.now() - done.at < REPEAT_WINDOW_MS && sameSecret(done.stateHash, stateHash(params.state))) {
        return { status: "repeat" };
      }
    }
  }
  if (params.state && shared.tombstones.has(stateHash(params.state))) return REFUSED;
  if (
    !pending || pending.outcome || !params.state || !sameSecret(pending.state, params.state) || inFlight.has(pending.pollId)
    || settledInMemory.has(pending.pollId) || cancelledPolls.has(pending.pollId)
  ) {
    return REFUSED;
  }
  if (pending.expiresAt <= Date.now()) return { status: "expired" };
  inFlight.add(pending.pollId);
  try {
    return await finishAttempt(pending, params, fetchImpl, persist);
  } finally {
    inFlight.delete(pending.pollId);
  }
}

interface AttemptContext {
  /** The issued client id this attempt holds, once known. */
  clientId: string | null;
  /** Set once `persist` succeeded: from then on the sign-in is real and settles complete whatever else fails. */
  stored: Credential | null;
  /** Revokes the tokens this attempt received (fire and forget). */
  discard: (() => void) | null;
}

async function finishAttempt(
  pending: Pending,
  params: { code: string | null; error: string | null; clientId: string | null },
  fetchImpl: FetchFn,
  persist: ((credential: Credential) => void) | undefined,
): Promise<SignInOutcome> {
  const ctx: AttemptContext = { clientId: pending.clientId, stored: null, discard: null };
  try {
    return await runAttempt(pending, params, fetchImpl, persist, ctx);
  } catch {
    // Bookkeeping (the sign-in file) failed. The attempt must not stay live:
    // it settles complete when the credential is already stored, else as a refusal.
    logFailure("bookkeeping_failed");
    return rescue(pending.pollId, pending.state, ctx);
  }
}

function rescue(pollId: string, state: string, ctx: AttemptContext): SignInOutcome {
  // The real outcome was already settled in memory and only the file write failed: keep it.
  const known = settledInMemory.get(pollId);
  if (known && !ctx.stored) {
    ctx.discard?.();
    if (known.status === "denied") return { status: "denied" };
    if (known.status === "error" && known.error) return { status: "error", error: known.error as SignInErrorCode };
  }
  try {
    if (ctx.stored) {
      settle(pollId, { status: "complete" }, (next) => {
        next.lastDone = { stateHash: stateHash(state), at: Date.now() };
      });
      return { status: "complete", credential: ctx.stored };
    }
    const out = failed(pollId, "chatgpt_signin_refused", "bookkeeping", ctx.clientId);
    ctx.discard?.();
    return out;
  } catch {
    try { cancelPendingChatGptSignIn(); } catch { /* the file cannot be written at all */ }
    // After the cancel, which forgets remembered outcomes: memory is what answers the poll now.
    remember(pollId, ctx.stored
      ? { status: "complete" }
      : { status: "error", error: "chatgpt_signin_refused", ...(ctx.clientId ? { retryClientId: ctx.clientId } : {}) }, state);
    if (ctx.stored) return { status: "complete", credential: ctx.stored };
    ctx.discard?.();
    return { status: "error", error: "chatgpt_signin_refused" };
  }
}

async function runAttempt(
  pending: Pending,
  params: { code: string | null; error: string | null; clientId: string | null },
  fetchImpl: FetchFn,
  persist: ((credential: Credential) => void) | undefined,
  ctx: AttemptContext,
): Promise<SignInOutcome> {
  const { pollId } = pending;
  if (params.error) {
    if (params.error === "access_denied") {
      return settle(pollId, { status: "denied" }) ? { status: "denied" } : REFUSED;
    }
    return failed(pollId, "chatgpt_signin_refused", /^[\w.-]{1,60}$/.test(params.error) ? `error=${params.error}` : "", pending.clientId);
  }
  // The issued client id: the saved one on reauth, the callback's on a new registration.
  let clientId: string;
  if (pending.clientId === null) {
    if (!params.clientId || params.clientId === DYNAMIC_CLIENT) return failed(pollId, "chatgpt_registration_incomplete");
    clientId = params.clientId;
    ctx.clientId = clientId;
    // Keep the issued id at once: a later failure must not strand it, the next
    // new-account attempt reuses it instead of registering a duplicate client.
    update((state) => {
      if (!state.registrations.some((r) => r.clientId === clientId)) {
        state.registrations.push({ clientId, subject: null, email: null, needsConsent: false });
      }
      if (state.registrations.find((r) => r.clientId === clientId)?.subject === null) state.retryClientId = clientId;
    });
  } else {
    if (params.clientId && params.clientId !== pending.clientId) return failed(pollId, "chatgpt_client_mismatch", "", pending.clientId);
    clientId = pending.clientId;
  }
  if (!params.code) return failed(pollId, "chatgpt_signin_refused", "code=missing", clientId);

  let tokens: Record<string, unknown>;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "useful-bot/1.0" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: params.code,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) return failed(pollId, "chatgpt_token_exchange", `status=${res.status} error=${await oauthErrorOf(res)}`, clientId);
    const body = await res.json() as unknown;
    if (!isRecord(body) || !str(body.access_token)) return failed(pollId, "chatgpt_token_exchange", "status=200 body=incomplete", clientId);
    tokens = body;
  } catch {
    return failed(pollId, "chatgpt_token_exchange", "network", clientId);
  }

  // Tokens that are thrown away are revoked after the outcome is settled,
  // best effort, with code-only logging (docs: sign out).
  const discard = (): void => {
    revokeChatGptCredential({
      kind: "oauth",
      accessToken: tokens.access_token as string,
      refreshToken: str(tokens.refresh_token),
      expiresAt: null,
      accountId: null,
      clientId,
    }, fetchImpl).then((confirmed) => {
      if (!confirmed) logFailure("revoke_unconfirmed");
    }, () => logFailure("revoke_unconfirmed"));
  };
  ctx.discard = discard;
  /** Settle the failure first so the page and the poll show the real reason, then revoke. */
  const fail = (error: SignInErrorCode, detail = ""): SignInOutcome => {
    const out = failed(pollId, error, detail, clientId);
    discard();
    return out;
  };
  /** A cancelled or replaced attempt changes nothing; its tokens are revoked. */
  const stale = (): boolean => {
    if (stillLive(pollId)) return false;
    discard();
    return true;
  };

  if (stale()) return REFUSED;
  let identity: { sub: string; email: string | null };
  try {
    const idToken = str(tokens.id_token);
    if (!idToken) throw new Error("id_token_missing");
    identity = await validateIdToken(idToken, { clientId, nonce: pending.nonce }, fetchImpl);
  } catch (err) {
    if (stale()) return REFUSED;
    return fail("chatgpt_id_token_invalid", reasonOf(err));
  }
  if (stale()) return REFUSED;

  // A returning account must be the same account. Every registration stays as
  // it is; the user switches accounts with a new registration on purpose.
  const known = readState().registrations.find((r) => r.clientId === clientId);
  if (known?.subject && known.subject !== identity.sub) return fail("chatgpt_account_mismatch");

  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes(DIRECT_SCOPE)) {
    recordIdentity(clientId, identity, true);
    return fail("chatgpt_plan_not_enabled");
  }

  const expiresIn = typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
    ? tokens.expires_in
    : null;
  const credential: Credential = {
    kind: "oauth",
    accessToken: tokens.access_token as string,
    refreshToken: str(tokens.refresh_token),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    accountId: null,
    clientId,
    idToken: str(tokens.id_token),
    scopes,
    subject: identity.sub,
    email: identity.email,
  };
  try {
    persist?.(credential);
  } catch (err) {
    return fail("chatgpt_signin_refused", `persist=${err instanceof Error && /^[\w.-]{1,60}$/.test(err.message) ? err.message : "failed"}`);
  }
  ctx.stored = credential;
  ctx.discard = null; // the tokens are in use now
  // From here the sign-in is real: memory answers the poll and a reloaded tab even if the file cannot be written.
  remember(pollId, { status: "complete" }, pending.state);
  shared.done = { stateHash: stateHash(pending.state), at: Date.now() };
  try {
    recordIdentity(clientId, identity, false);
  } catch {
    // The credential is stored; the identity is written first on the next start, poll or callback.
    deferredIdentities.push({ clientId, identity, needsConsent: false });
    logFailure("identity_write_deferred");
  }
  if (!settle(pollId, { status: "complete" }, (next) => {
    next.lastDone = { stateHash: stateHash(pending.state), at: Date.now() };
  })) return REFUSED;
  return { status: "complete", credential };
}

/** Poll an attempt. A terminal status is reported once, then the pending row is dropped. */
export function pollChatGptSignIn(pollId: string): SignInPoll {
  const answer = (outcome: Settled): SignInPoll => ({
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.retryClientId ? { retryClientId: outcome.retryClientId } : {}),
  });
  // Memory first: it holds the outcome even when the file could not be written.
  flushDeferredIdentities();
  const remembered = settledInMemory.get(pollId);
  if (remembered) {
    settledInMemory.delete(pollId);
    const hash = shared.hashes.get(pollId);
    shared.hashes.delete(pollId);
    let rowGone = false;
    try {
      const state = readState();
      if (state.pending?.pollId === pollId) writeState({ ...state, pending: null });
      rowGone = true;
    } catch { /* the outcome is answered either way */ }
    // The disk row may still be unsettled: a tombstone keeps a later callback for it from exchanging again.
    if (!rowGone && hash) {
      shared.tombstones.add(hash);
      while (shared.tombstones.size > 16) shared.tombstones.delete(shared.tombstones.values().next().value as string);
    }
    return answer(remembered);
  }
  const state = readState();
  const pending = state.pending;
  if (!pending || pending.pollId !== pollId) throw new Error("oauth_poll_unknown");
  const drop = () => writeState({ ...state, pending: null });
  if (pending.outcome) {
    drop();
    return answer(pending.outcome);
  }
  if (pending.expiresAt <= Date.now()) {
    drop();
    // An attempt on an issued client names it, so Try again can reuse it.
    return { status: "expired", ...(pending.clientId ? { retryClientId: pending.clientId } : {}) };
  }
  return { status: "pending" };
}

/** Forget an attempt: a callback that arrives later is refused. */
export function cancelChatGptSignIn(pollId: string): void {
  settledInMemory.delete(pollId);
  rememberCancelled(pollId);
  const state = readState();
  if (!state.pending || state.pending.pollId !== pollId) return;
  writeState({ ...state, pending: null });
}

/** Forget whatever attempt is pending (Disconnect), so a callback mid-exchange is refused. */
export function cancelPendingChatGptSignIn(): void {
  let state: SignInState;
  try {
    state = readState();
  } catch (err) {
    // An unreadable file tracks no attempt we could cancel; Disconnect goes on.
    if (err instanceof Error && err.message === "chatgpt_state_unreadable") return;
    throw err;
  }
  if (!state.pending) return;
  // Remembered first: the attempt stays cancelled even if the write below fails
  // or a later one succeeds. A write failure still propagates, so Disconnect
  // reports it instead of deleting with an attempt that may be live.
  rememberCancelled(state.pending.pollId);
  settledInMemory.delete(state.pending.pollId);
  writeState({ ...state, pending: null });
}

/**
 * True when the pollId belongs to a ChatGPT attempt, so the poll route can
 * route it. A remembered outcome counts first; an unreadable file is "no", so a
 * corrupt ChatGPT file never breaks another provider's device-flow polls.
 */
export function isChatGptPollId(pollId: string): boolean {
  if (settledInMemory.has(pollId)) return true;
  try {
    return readState().pending?.pollId === pollId;
  } catch {
    return false;
  }
}


async function fetchJwks(fetchImpl: FetchFn): Promise<JsonWebKey[]> {
  const res = await fetchImpl(JWKS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error("jwks_unavailable");
  const body = await res.json() as unknown;
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("jwks_unavailable");
  const keys = body.keys.filter(isRecord) as JsonWebKey[];
  shared.jwks = { fetchedAt: Date.now(), keys };
  return keys;
}

/** The signing key for `kid`: from the one-hour cache, refetched once when the kid is unknown. */
async function signingKey(kid: string, fetchImpl: FetchFn) {
  const find = (keys: JsonWebKey[]) => keys.find((key) => (key as { kid?: string }).kid === kid && key.kty === "RSA");
  const cached = shared.jwks && Date.now() - shared.jwks.fetchedAt < JWKS_TTL_MS ? shared.jwks.keys : null;
  let jwk = cached ? find(cached) : undefined;
  if (!jwk) jwk = find(await fetchJwks(fetchImpl));
  if (!jwk) throw new Error("kid_unknown");
  return createPublicKey({ key: jwk, format: "jwk" });
}

function decodePart(part: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("jwt_malformed");
  return value;
}

/**
 * Validate an ID token against OpenAI's published keys: RS256 signature, then
 * issuer, audience (the issued client id), expiry, not-before, issued-at, the
 * nonce of this attempt and a non-empty subject. Throws on any failure.
 */
async function validateIdToken(
  token: string,
  expect: { clientId: string; nonce: string },
  fetchImpl: FetchFn,
): Promise<{ sub: string; email: string | null }> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("jwt_malformed");
  const header = decodePart(parts[0]!);
  const claims = decodePart(parts[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("jwt_header");
  const key = await signingKey(header.kid, fetchImpl);
  const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw new Error("jwt_signature");
  const now = Date.now();
  if (claims.iss !== ISSUER) throw new Error("jwt_iss");
  const aud = claims.aud;
  if (!(aud === expect.clientId || (Array.isArray(aud) && aud.includes(expect.clientId)))) throw new Error("jwt_aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS <= now) throw new Error("jwt_exp");
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat * 1000 - CLOCK_SKEW_MS > now)) throw new Error("jwt_iat");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 - CLOCK_SKEW_MS > now)) throw new Error("jwt_nbf");
  if (typeof claims.nonce !== "string" || !sameSecret(claims.nonce, expect.nonce)) throw new Error("jwt_nonce");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("jwt_sub");
  return { sub: claims.sub, email: str(claims.email) };
}

/**
 * Refresh grant. Access token, rotating refresh token, expiry, scopes and
 * ID token are replaced together. Callers serialize this per connection, or
 * two parallel refreshes spend the same refresh token.
 */
export async function refreshChatGptCredential(credential: Credential, fetchImpl: FetchFn = fetch): Promise<Credential> {
  // Nothing to refresh with: the sign-in is unusable.
  if (credential.kind !== "oauth" || !credential.clientId || !credential.refreshToken) throw new Error("oauth_refresh_terminal");
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "useful-bot/1.0" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credential.clientId,
        refresh_token: credential.refreshToken,
        resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    logFailure("oauth_refresh", "network");
    throw new Error("oauth_refresh_transient");
  }
  if (res.status !== 200) {
    const code = await oauthErrorOf(res);
    logFailure("oauth_refresh", `status=${res.status} error=${code}`);
    // Only an unusable-token answer ends the sign-in; a server hiccup does not,
    // and a rejected client is a configuration fault that leaves the tokens alone.
    if ((res.status === 400 || res.status === 401) && code === "invalid_client") throw new Error("oauth_refresh_client");
    throw new Error((res.status === 400 || res.status === 401) && TERMINAL_REFRESH_ERRORS.has(code)
      ? "oauth_refresh_terminal"
      : "oauth_refresh_transient");
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    logFailure("oauth_refresh", "status=200 body=unreadable");
    throw new Error("oauth_refresh_transient");
  }
  if (!isRecord(raw) || !str(raw.access_token)) {
    logFailure("oauth_refresh", "status=200 body=incomplete");
    throw new Error("oauth_refresh_transient");
  }
  const expiresIn = typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in) && raw.expires_in > 0 ? raw.expires_in : null;
  return {
    ...credential,
    accessToken: raw.access_token as string,
    refreshToken: str(raw.refresh_token) ?? credential.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : credential.expiresAt,
    scopes: typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : credential.scopes,
    idToken: str(raw.id_token) ?? credential.idToken,
  };
}

/**
 * End the renewable session at the revocation endpoint. True only on an HTTP
 * 200 (also what an already-invalid token gets). A network error or 5xx is
 * retried once after `retryDelayMs`; any other status is not confirmed.
 */
export async function revokeChatGptCredential(
  credential: Credential,
  fetchImpl: FetchFn = fetch,
  retryDelayMs = 1000,
): Promise<boolean> {
  if (credential.kind !== "oauth" || !credential.clientId || !credential.refreshToken) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "useful-bot/1.0" },
        body: new URLSearchParams({
          token: credential.refreshToken,
          token_type_hint: "refresh_token",
          client_id: credential.clientId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) return true;
      if (res.status < 500) return false;
    } catch {
      // Network error or timeout: one retry below.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return false;
}

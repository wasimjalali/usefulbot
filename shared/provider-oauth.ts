import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { providerMode } from "./provider-catalog.ts";
import { refreshChatGptCredential } from "./chatgpt-signin.ts";
import { isLegacyChatGptCredential, type Credential } from "./providers.ts";
import { statePath } from "./stack.ts";

/**
 * OAuth device flow for the catalogue device-code modes (github-copilot via
 * the GitHub device flow). Endpoints and client ids live in
 * shared/provider-catalog.ts; this file only drives them. The ChatGPT sign-in
 * is a browser flow and lives in shared/chatgpt-signin.ts.
 *
 * Pending device authorizations persist in a 0600 file, atomic like the
 * providers store, so a restart does not strand a user code.
 */

export interface DevicePending {
  pollId: string;
  providerId: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string | null;
  intervalMs: number;
  expiresAt: number;
  createdAt: string;
}

export type PollStatus = "pending" | "slow_down" | "complete" | "expired" | "denied" | "error";

export interface PollResult {
  status: PollStatus;
  credential?: Credential;
  error?: string;
  /** The provider the flow belongs to; the pending row is gone once it settles, so callers read it here. */
  providerId?: string;
  /** How long to wait before the next poll, after any slow_down back-off. */
  intervalMs?: number;
}

type FetchFn = typeof fetch;

/** RFC 8628 default when the vendor omits the poll interval. */
const DEFAULT_INTERVAL_MS = 5000;

/** github-copilot: re-exchange while this much of the Copilot token is left. */
const EXCHANGE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export function providerPendingPath(root = process.env.UB_PROVIDER_OAUTH_PATH): string {
  if (root) return root;
  return statePath("provider-oauth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPending(path = providerPendingPath()): Record<string, DevicePending> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return {};
    const out: Record<string, DevicePending> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      if (
        typeof value.pollId !== "string" || value.pollId !== key
        || typeof value.providerId !== "string"
        || typeof value.deviceCode !== "string"
        || typeof value.userCode !== "string"
        || typeof value.verificationUrl !== "string"
        || (value.verificationUrlComplete !== null && typeof value.verificationUrlComplete !== "string")
        || typeof value.intervalMs !== "number"
        || typeof value.expiresAt !== "number"
        || typeof value.createdAt !== "string"
      ) continue;
      // Pending entries older than their expiry are pruned on read.
      if (value.expiresAt <= Date.now()) continue;
      out[key] = value as unknown as DevicePending;
    }
    return out;
  } catch {
    return {};
  }
}

function writePending(rows: Record<string, DevicePending>, path = providerPendingPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(rows)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function savePending(entry: DevicePending, path = providerPendingPath()): void {
  const rows = readPending(path);
  rows[entry.pollId] = entry;
  writePending(rows, path);
}

function dropPending(pollId: string, path = providerPendingPath()): void {
  const rows = readPending(path);
  if (!rows[pollId]) return;
  delete rows[pollId];
  writePending(rows, path);
}

function oauthConfig(providerId: string) {
  const mode = providerMode(providerId, "oauth");
  if (!mode.oauth) throw new Error("provider_oauth");
  return mode.oauth;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Read the pending file without pruning, so poll can tell expired from unknown. */
function readRawRows(path = providerPendingPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

function isExpiredRow(value: unknown): boolean {
  return isRecord(value) && typeof value.expiresAt === "number" && value.expiresAt <= Date.now();
}

/** Start a device flow. Persists the pending entry and returns it. */
export async function startDeviceFlow(providerId: string, fetchImpl: FetchFn = fetch): Promise<DevicePending> {
  const oauth = oauthConfig(providerId);
  let raw: unknown;
  if (providerId === "github-copilot") {
    // GitHub device flow: form params, JSON accepted back.
    const res = await fetchImpl(oauth.deviceUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "useful-bot/1.0" },
      body: new URLSearchParams({ client_id: oauth.clientId, scope: oauth.scopes }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error("oauth_device_start");
    raw = await res.json();
  } else {
    throw new Error("provider_oauth");
  }
  if (!isRecord(raw)) throw new Error("oauth_device_start");
  const deviceCode = typeof raw.device_code === "string" && raw.device_code ? raw.device_code : null;
  const userCode = typeof raw.user_code === "string" && raw.user_code ? raw.user_code : null;
  const verificationUrl = typeof raw.verification_uri === "string" && raw.verification_uri ? raw.verification_uri : null;
  const verificationUrlComplete = typeof raw.verification_uri_complete === "string" && raw.verification_uri_complete
    ? raw.verification_uri_complete
    : null;
  const expiresIn = asPositiveInt(raw.expires_in);
  if (!deviceCode || !userCode || !verificationUrl || !expiresIn) throw new Error("oauth_device_start");
  // RFC 8628 section 3.2: five seconds when the server stays quiet.
  const intervalMs = (asPositiveInt(raw.interval) ?? DEFAULT_INTERVAL_MS / 1000) * 1000;
  const now = Date.now();
  const pending: DevicePending = {
    pollId: randomBytes(16).toString("hex"),
    providerId,
    deviceCode,
    userCode,
    verificationUrl,
    verificationUrlComplete,
    intervalMs,
    expiresAt: now + expiresIn * 1000,
    createdAt: new Date(now).toISOString(),
  };
  savePending(pending);
  return pending;
}

function deviceGrantBody(providerId: string, clientId: string, deviceCode: string): { url: string; init: RequestInit } {
  const oauth = oauthConfig(providerId);
  const grant = "urn:ietf:params:oauth:grant-type:device_code";
  return {
    url: oauth.tokenUrl,
    init: {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "useful-bot/1.0" },
      body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: grant }),
      signal: AbortSignal.timeout(15_000),
    },
  };
}

/**
 * Exchange a GitHub OAuth token for a short-lived Copilot inference token.
 * The catalogue notes this exchange is reported dead (404) for individual
 * users; callers treat a failure as "send the GitHub token directly".
 */
export async function exchangeCopilotToken(
  oauthToken: string,
  fetchImpl: FetchFn = fetch,
  exchangeUrl?: string,
): Promise<{ token: string; expiresAt: number }> {
  const url = exchangeUrl ?? oauthConfig("github-copilot").exchangeUrl;
  if (!url) throw new Error("oauth_exchange");
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", authorization: `Bearer ${oauthToken}`, "user-agent": "useful-bot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error("oauth_exchange");
  const raw = await res.json() as unknown;
  if (!isRecord(raw) || typeof raw.token !== "string" || !raw.token) throw new Error("oauth_exchange");
  const absolute = asPositiveInt(raw.expires_at);
  if (absolute) return { token: raw.token, expiresAt: absolute * 1000 };
  const relative = asPositiveInt(raw.refresh_in);
  if (relative) return { token: raw.token, expiresAt: Date.now() + relative * 1000 };
  throw new Error("oauth_exchange");
}

function errorOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.error === "string" && raw.error) return raw.error;
  if (isRecord(raw.error) && typeof raw.error.code === "string" && raw.error.code) return raw.error.code;
  return null;
}

/** Poll once. Deletes the pending entry when the flow settles. */
export async function pollDeviceFlow(pollId: string, fetchImpl: FetchFn = fetch): Promise<PollResult> {
  const before = readPending()[pollId];
  const result = await pollDeviceFlowStep(pollId, fetchImpl);
  const after = readPending()[pollId];
  const source = after ?? before;
  if (!source) return result;
  return { ...result, providerId: source.providerId, intervalMs: source.intervalMs };
}

async function pollDeviceFlowStep(pollId: string, fetchImpl: FetchFn): Promise<PollResult> {
  const rows = readPending();
  const pending = rows[pollId];
  if (!pending) {
    // Pruning hides expired rows, so check the raw file before giving up.
    if (isExpiredRow(readRawRows()[pollId])) {
      writePending(rows);
      return { status: "expired" };
    }
    throw new Error("oauth_poll_unknown");
  }
  if (pending.expiresAt <= Date.now()) {
    writePending(readPending());
    return { status: "expired" };
  }
  const oauth = oauthConfig(pending.providerId);
  const { url, init } = deviceGrantBody(pending.providerId, oauth.clientId, pending.deviceCode);
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { status: "error", error: "oauth_poll" };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    return { status: "error", error: "oauth_poll" };
  }
  const code = errorOf(raw);
  if (code === "authorization_pending") return { status: "pending" };
  if (code === "slow_down") {
    // Back off as RFC 8628 asks: the next poll waits five seconds longer.
    savePending({ ...pending, intervalMs: pending.intervalMs + DEFAULT_INTERVAL_MS });
    return { status: "slow_down" };
  }
  if (code === "expired_token") {
    dropPending(pollId);
    return { status: "expired" };
  }
  if (code === "access_denied") {
    dropPending(pollId);
    return { status: "denied" };
  }
  if (!isRecord(raw) || typeof raw.access_token !== "string" || !raw.access_token) {
    return { status: "error", error: code ?? "oauth_poll" };
  }
  // github-copilot: the OAuth token signs in; the exchange mints the
  // short-lived inference token when the endpoint answers.
  const credential: Credential = {
    kind: "oauth",
    accessToken: raw.access_token,
    refreshToken: null,
    expiresAt: null,
    accountId: null,
  };
  try {
    credential.exchanged = await exchangeCopilotToken(raw.access_token, fetchImpl);
  } catch {
    // Direct-token mode per the catalogue: the GitHub token itself works.
  }
  dropPending(pollId);
  return { status: "complete", credential };
}

/** Forget a pending device flow without exchanging its code. */
export function cancelDeviceFlow(pollId: string): void {
  dropPending(pollId);
}

/**
 * Refresh an OAuth credential. openai (Sign in with ChatGPT) uses the
 * refresh_token grant in shared/chatgpt-signin.ts; github-copilot exchanges the OAuth token for a Copilot token when the
 * exchanged one is missing or expires within five minutes.
 */
export async function refreshCredential(
  providerId: string,
  credential: Credential,
  fetchImpl: FetchFn = fetch,
): Promise<Credential> {
  if (credential.kind !== "oauth") throw new Error("provider_oauth");
  // The impersonated Codex sign-in has no issued client id and cannot refresh.
  if (providerId === "openai") return await refreshChatGptCredential(credential, fetchImpl);
  const oauth = oauthConfig(providerId);
  if (providerId === "github-copilot") {
    const held = credential.exchanged;
    if (held && held.expiresAt - Date.now() > EXCHANGE_REFRESH_WINDOW_MS) return credential;
    try {
      const exchanged = await exchangeCopilotToken(credential.accessToken, fetchImpl, oauth.exchangeUrl);
      return { ...credential, exchanged };
    } catch {
      // Direct-token mode never minted one, so there is nothing to renew.
      if (!held) return credential;
      throw new Error("oauth_exchange");
    }
  }
  throw new Error("provider_oauth");
}

/**
 * The token to send for one call. github-copilot prefers the exchanged
 * inference token and falls back to the GitHub token itself. A ChatGPT
 * sign-in made through the old Codex route (no issued client id) reports
 * expired, so it is never sent anywhere.
 */
export function accessTokenFor(
  providerId: string,
  credential: Credential,
): { token: string; expired: boolean; headers: Record<string, string> } {
  if (credential.kind === "key") return { token: credential.key, expired: false, headers: {} };
  if (credential.kind === "none") return { token: "", expired: false, headers: {} };
  if (providerId === "github-copilot" && credential.exchanged) {
    return { token: credential.exchanged.token, expired: credential.exchanged.expiresAt <= Date.now(), headers: {} };
  }
  if (isLegacyChatGptCredential(providerId, "oauth", credential)) {
    return { token: credential.accessToken, expired: true, headers: {} };
  }
  const expired = credential.expiresAt !== null && credential.expiresAt <= Date.now();
  return { token: credential.accessToken, expired, headers: {} };
}

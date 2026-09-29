import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertConnectionUrl, assertPublicHttpsUrl, assertResolvedPublic, ConnectionUrlError } from "./connection-url.ts";

/**
 * Generic MCP OAuth: protected-resource metadata, authorization-server
 * metadata, dynamic client registration, PKCE. Tokens are returned to the
 * caller; they go in Keychain, not here. Pending PKCE state is a 0600 file.
 */

export type OAuthPending = {
  state: string;
  verifier: string;
  proposalId: string;
  connectionId: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  createdAt: string;
};

export type OAuthTokenBundle = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
};

type FetchFn = typeof fetch;
let injectedFetch: FetchFn | null = null;

export function setOauthFetch(next: FetchFn | null): void {
  injectedFetch = next;
}

/** The deadline every call in this file carries. */
const OAUTH_TIMEOUT_MS = 8_000;

function activeFetch(): FetchFn {
  return injectedFetch ?? fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function oauthPendingPath(root = process.env.UB_OAUTH_PENDING_PATH): string {
  if (root) return root;
  return join(process.env.HOME ?? "/tmp", ".useful-bot/connections-oauth.json");
}

function readPending(path = oauthPendingPath()): OAuthPending[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is OAuthPending => {
      const rec = asRecord(item);
      return Boolean(rec
        && typeof rec.state === "string"
        && typeof rec.verifier === "string"
        && typeof rec.proposalId === "string"
        && typeof rec.connectionId === "string"
        && typeof rec.tokenEndpoint === "string"
        && typeof rec.clientId === "string"
        && typeof rec.redirectUri === "string");
    });
  } catch {
    return [];
  }
}

function writePending(rows: OAuthPending[], path = oauthPendingPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(rows)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function findOauthPending(state: string, path = oauthPendingPath()): OAuthPending | null {
  if (typeof state !== "string" || state.length < 8 || state.length > 256) return null;
  return readPending(path).find((row) => row.state === state) ?? null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Metadata is fetched from a host this side resolved and pinned, so a
 * redirect is refused: one of these URLs comes from the server's own
 * `www-authenticate` header, and following a hop would take a blind GET
 * somewhere that check never looked. The body is read against a limit for
 * the same reason the MCP client reads against one.
 */
const OAUTH_BODY_MAX = 512 * 1024;

async function boundedJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return JSON.parse(await res.text());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > OAUTH_BODY_MAX) throw new Error("oauth_body_too_large");
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already done */ }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const target = await assertResolvedPublic(assertPublicHttpsUrl(url));
  const res = await activeFetch()(target, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`oauth_http_${res.status}`);
  const rec = asRecord(await boundedJson(res));
  if (!rec) throw new Error("oauth_parse");
  return rec;
}

function originOf(url: string): string {
  const parsed = new URL(assertConnectionUrl(url));
  return parsed.origin;
}

function wellKnown(origin: string, path: string): string {
  return assertPublicHttpsUrl(`${origin}${path}`);
}

async function protectedResource(mcpUrl: string): Promise<{ authorizationServers: string[]; resource: string }> {
  const origin = originOf(mcpUrl);
  try {
    const rec = await getJson(wellKnown(origin, "/.well-known/oauth-protected-resource"));
    const servers = Array.isArray(rec.authorization_servers)
      ? rec.authorization_servers.filter((item): item is string => typeof item === "string")
      : [];
    if (servers.length === 0) throw new Error("oauth_no_as");
    return {
      authorizationServers: servers.map((item) => assertPublicHttpsUrl(item)),
      resource: typeof rec.resource === "string" ? assertPublicHttpsUrl(rec.resource) : assertPublicHttpsUrl(mcpUrl),
    };
  } catch (err) {
    if (err instanceof Error && err.message === "oauth_no_as") throw err;
    if (err instanceof ConnectionUrlError) throw err;
    // Probe the MCP URL for a 401 with resource_metadata.
    const res = await activeFetch()(await assertResolvedPublic(mcpUrl), {
      headers: { accept: "application/json, text/event-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    const www = res.headers.get("www-authenticate") ?? "";
    const meta = /resource_metadata="([^"]+)"/.exec(www)?.[1];
    if (meta) {
      const rec = await getJson(meta);
      const servers = Array.isArray(rec.authorization_servers)
        ? rec.authorization_servers.filter((item): item is string => typeof item === "string")
        : [];
      if (servers.length === 0) throw new Error("oauth_no_as");
      return {
        authorizationServers: servers.map((item) => assertPublicHttpsUrl(item)),
        resource: typeof rec.resource === "string" ? assertPublicHttpsUrl(rec.resource) : assertPublicHttpsUrl(mcpUrl),
      };
    }
    throw new Error("oauth_no_as");
  }
}

async function authorizationServer(issuer: string): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}> {
  const origin = originOf(issuer);
  const rec = await getJson(wellKnown(origin, "/.well-known/oauth-authorization-server"));
  if (typeof rec.authorization_endpoint !== "string" || typeof rec.token_endpoint !== "string") {
    throw new Error("oauth_as_incomplete");
  }
  return {
    authorizationEndpoint: assertPublicHttpsUrl(rec.authorization_endpoint),
    tokenEndpoint: assertPublicHttpsUrl(rec.token_endpoint),
    registrationEndpoint: typeof rec.registration_endpoint === "string"
      ? assertPublicHttpsUrl(rec.registration_endpoint)
      : null,
  };
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  name: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const res = await activeFetch()(await assertResolvedPublic(registrationEndpoint), {
    method: "POST",
    // Every other call here carries a deadline; these three did not, and a
    // token endpoint that never answers holds a tool call, a tool search and
    // a turn boundary open behind it.
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: name.slice(0, 80),
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error("oauth_register");
  const rec = asRecord(await boundedJson(res));
  if (!rec || typeof rec.client_id !== "string") throw new Error("oauth_register");
  return {
    clientId: rec.client_id,
    clientSecret: typeof rec.client_secret === "string" ? rec.client_secret : null,
  };
}

export async function startMcpOAuth(input: {
  mcpUrl: string;
  name: string;
  proposalId: string;
  connectionId: string;
  redirectUri: string;
  pendingPath?: string;
}): Promise<{ authorizeUrl: string; redirectHost: string; state: string }> {
  const resource = await protectedResource(input.mcpUrl);
  const as = await authorizationServer(resource.authorizationServers[0]);
  if (!as.registrationEndpoint) throw new Error("oauth_no_dcr");
  const client = await registerClient(as.registrationEndpoint, input.redirectUri, input.name);
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(24));
  const authorize = new URL(as.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", input.redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("resource", resource.resource);
  const pending: OAuthPending = {
    state,
    verifier,
    proposalId: input.proposalId,
    connectionId: input.connectionId,
    tokenEndpoint: as.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: input.redirectUri,
    createdAt: new Date().toISOString(),
  };
  const path = input.pendingPath ?? oauthPendingPath();
  const rows = readPending(path).filter((row) => row.proposalId !== input.proposalId);
  rows.push(pending);
  writePending(rows, path);
  return { authorizeUrl: authorize.toString(), redirectHost: authorize.hostname.toLowerCase(), state };
}

export async function completeMcpOAuth(input: {
  code: string;
  state: string;
  pendingPath?: string;
}): Promise<{ bundle: OAuthTokenBundle; pending: OAuthPending }> {
  const path = input.pendingPath ?? oauthPendingPath();
  const rows = readPending(path);
  const pending = rows.find((row) => row.state === input.state);
  if (!pending) throw new Error("oauth_state");
  const created = Date.parse(pending.createdAt);
  if (!Number.isFinite(created) || Date.now() - created > 15 * 60 * 1000) {
    writePending(rows.filter((row) => row.state !== input.state), path);
    throw new Error("oauth_expired");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  const res = await activeFetch()(await assertResolvedPublic(pending.tokenEndpoint), {
    method: "POST",
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error("oauth_token");
  const rec = asRecord(await boundedJson(res));
  if (!rec || typeof rec.access_token !== "string") throw new Error("oauth_token");
  writePending(rows.filter((row) => row.state !== input.state), path);
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : null;
  return {
    pending,
    bundle: {
      accessToken: rec.access_token,
      refreshToken: typeof rec.refresh_token === "string" ? rec.refresh_token : null,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      tokenEndpoint: pending.tokenEndpoint,
    },
  };
}

export async function refreshMcpOAuth(bundle: OAuthTokenBundle): Promise<OAuthTokenBundle> {
  if (!bundle.refreshToken) throw new Error("oauth_refresh");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
    client_id: bundle.clientId,
  });
  const res = await activeFetch()(await assertResolvedPublic(bundle.tokenEndpoint), {
    method: "POST",
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error("oauth_refresh");
  const rec = asRecord(await boundedJson(res));
  if (!rec || typeof rec.access_token !== "string") throw new Error("oauth_refresh");
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : null;
  return {
    accessToken: rec.access_token,
    refreshToken: typeof rec.refresh_token === "string" ? rec.refresh_token : bundle.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : bundle.expiresAt,
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    tokenEndpoint: bundle.tokenEndpoint,
  };
}

/**
 * Forget one pending sign-in without exchanging its code.
 *
 * `completeMcpOAuth` is otherwise the only thing that drops a row, so a
 * callback that settles without exchanging would leave the verifier, the
 * token endpoint and the client secret on disk with nothing left to reap
 * them: a retry with the same state is refused before it reaches here.
 */
export function dropOauthPending(state: string, path = oauthPendingPath()): void {
  const rows = readPending(path);
  if (!rows.some((row) => row.state === state)) return;
  writePending(rows.filter((row) => row.state !== state), path);
}

/**
 * Forget every pending sign-in for one card. `startMcpOAuth` filters the same
 * way before it writes, so a card that settles without ever reaching the
 * callback leaves nothing behind.
 */
export function dropOauthPendingForProposal(proposalId: string, path = oauthPendingPath()): void {
  const rows = readPending(path);
  if (!rows.some((row) => row.proposalId === proposalId)) return;
  writePending(rows.filter((row) => row.proposalId !== proposalId), path);
}

export function clearOauthPending(path = oauthPendingPath()): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertConnectionUrl, assertPublicHttpsUrl, assertResolvedPublic, ConnectionUrlError } from "./connection-url.ts";
import { statePath } from "./stack.ts";

/**
 * Generic MCP OAuth: protected-resource metadata, authorization-server
 * metadata, dynamic client registration, PKCE. Tokens are returned to the
 * caller; they go in Keychain, not here. Pending PKCE state is a 0600 file.
 */

/**
 * Who the authorization server was when a sign-in was made: its issuer and the
 * origin of each endpoint the flow used. A sign-in again for the same
 * connection has to meet the same server, all of it: pinning only the token
 * host would let a server that moved its sign-in page or its registration
 * endpoint keep the connection's refresh token and send the owner elsewhere.
 */
export type AsPin = {
  issuer: string;
  authorizationOrigin: string;
  tokenOrigin: string;
  registrationOrigin: string;
};

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
  /** RFC 8707 resource the sign-in was started for; sent again on the exchange. */
  resource?: string;
  pin?: AsPin;
};

export type OAuthTokenBundle = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  /** Sent on every refresh. Absent on a bundle stored before it was kept. */
  resource?: string;
  /** Absent on a bundle stored before the server was pinned. */
  pin?: AsPin;
};

type FetchFn = typeof fetch;
let injectedFetch: FetchFn | null = null;

export function setOauthFetch(next: FetchFn | null): void {
  injectedFetch = next;
}

/** The deadline every call in this file carries. */
export const OAUTH_TIMEOUT_MS = 8_000;

/**
 * The address check under the same deadline as the request after it: the
 * lookup takes no signal, and a stalled resolver must not hold a sign-in or a
 * refresh (and the refresh lock) past that deadline.
 */
function resolvedWithin(url: string): Promise<string> {
  const work = assertResolvedPublic(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ConnectionUrlError("url_resolve")), OAUTH_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  return statePath("connections-oauth.json");
}

/** A sign-in not finished in this long is abandoned; its verifier and client secret go with it. */
const PENDING_TTL_MS = 15 * 60 * 1000;

function pendingIsLive(row: OAuthPending): boolean {
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) && Date.now() - created <= PENDING_TTL_MS;
}

/** Live rows only: an abandoned one is invisible here and dropped by the next write. */
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
        && typeof rec.redirectUri === "string"
        && typeof rec.createdAt === "string")
        && pendingIsLive(item as OAuthPending);
    });
  } catch {
    return [];
  }
}

function writePending(rows: OAuthPending[], path = oauthPendingPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(rows.filter(pendingIsLive))}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function findOauthPending(state: string, path = oauthPendingPath()): OAuthPending | null {
  if (typeof state !== "string" || state.length < 8 || state.length > 256) return null;
  return readPending(path).find((row) => row.state === state) ?? null;
}

/**
 * Whether a row for this state is still on disk but past its 15 minutes: an
 * expired sign-in, as opposed to one whose row is gone because a newer
 * sign-in replaced it or finished.
 */
export function oauthPendingExpired(state: string, path = oauthPendingPath()): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return false;
    return raw.some((item) => {
      const rec = asRecord(item);
      return rec?.state === state && typeof rec.createdAt === "string" && !pendingIsLive(item as OAuthPending);
    });
  } catch {
    return false;
  }
}

/** The sign-in a card is waiting on now: starting another replaces the one before. */
export function findOauthPendingForProposal(proposalId: string, path = oauthPendingPath()): OAuthPending | null {
  return readPending(path).find((row) => row.proposalId === proposalId) ?? null;
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
  const target = await resolvedWithin(assertPublicHttpsUrl(url));
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

function wellKnown(origin: string, path: string): string {
  return assertPublicHttpsUrl(`${origin}${path}`);
}

/**
 * The resource indicator, as the server wrote it, less any fragment (RFC 8707
 * forbids one). Not normalised: `new URL(...).href` adds a slash to a bare
 * origin such as `https://example.com`, and an authorization server that
 * matches the indicator exactly then rejects it or mints a token for another
 * audience. The official MCP SDK sends the metadata's string verbatim for the
 * same reason (modelcontextprotocol/typescript-sdk #1968). Tella's sign-in
 * server answered with its own project as the audience when this string
 * differed from the one it knew (2026-10-04).
 */
function withoutFragment(value: string): string {
  const at = value.indexOf("#");
  return at === -1 ? value : value.slice(0, at);
}

/**
 * The resource a token is asked for. The metadata's own `resource` string when
 * it sits on the server's origin and is already canonical, the server's URL as
 * configured when it names none. One on another origin is refused: a server could otherwise have a
 * token minted for somebody else's API. The same string goes on the authorize
 * request, the code exchange and every refresh.
 */
function resourceFor(mcpUrl: string, declared: unknown): string {
  const server = new URL(assertConnectionUrl(mcpUrl));
  if (typeof declared !== "string") return withoutFragment(mcpUrl);
  const sent = withoutFragment(declared);
  let parsed: URL;
  try {
    parsed = new URL(sent);
  } catch {
    throw new Error("oauth_resource_invalid");
  }
  if (parsed.origin !== server.origin) throw new Error("oauth_resource_origin");
  // Sent as written, so it must already be the form a URL parser would write
  // (a bare origin may omit its slash): a spelling that needs rewriting is one
  // the authorization server may compare differently from this app.
  if (sent !== parsed.href && `${sent}/` !== parsed.href) throw new Error("oauth_resource_invalid");
  return sent;
}

/**
 * What the MCP server says when asked without a token: the 401's
 * `WWW-Authenticate` carries where its metadata is and which scope it wants.
 * Best effort. A server that does not answer this way is found by the
 * well-known documents instead; only a refused URL is fatal.
 */
async function probeChallenge(mcpUrl: string): Promise<{ resourceMetadata: string | null; scope: string | null }> {
  try {
    const res = await activeFetch()(await resolvedWithin(mcpUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "useful-bot", version: "0.0.0" } },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
    const www = res.headers.get("www-authenticate") ?? "";
    return {
      resourceMetadata: /resource_metadata="([^"]+)"/i.exec(www)?.[1] ?? null,
      scope: /(?:^|[\s,])scope="([^"]+)"/i.exec(www)?.[1] ?? null,
    };
  } catch (err) {
    if (err instanceof ConnectionUrlError) throw err;
    return { resourceMetadata: null, scope: null };
  }
}

/** The first of these documents that answers with something `accept` takes. */
async function firstDocument(
  urls: string[],
  accept: (rec: Record<string, unknown>) => boolean,
  failure: string,
): Promise<Record<string, unknown>> {
  for (const url of urls) {
    try {
      const rec = await getJson(url);
      if (accept(rec)) return rec;
    } catch (err) {
      // A URL this side refuses to fetch ends the search; one that just did
      // not answer is the next candidate's turn.
      if (err instanceof ConnectionUrlError) throw err;
    }
  }
  throw new Error(failure);
}

/** What a scope token may be (RFC 6749 section 3.3), and how much of one this side will pass on. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const SCOPE_MAX_CHARS = 1024;

/** The tokens that are scope tokens, as one string cut at the cap; null when none are. */
function scopeString(tokens: unknown[]): string | null {
  const kept: string[] = [];
  let length = 0;
  for (const token of tokens) {
    if (typeof token !== "string" || !SCOPE_TOKEN.test(token)) continue;
    if (length + token.length + (kept.length ? 1 : 0) > SCOPE_MAX_CHARS) break;
    length += token.length + (kept.length ? 1 : 0);
    kept.push(token);
  }
  return kept.length ? kept.join(" ") : null;
}

/** The scope a 401 asks for, or null when any part of it is not a scope token or the whole is too long. */
function challengeScope(raw: string | null): string | null {
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  const scope = scopeString(tokens);
  return scope !== null && scope.split(" ").length === tokens.length ? scope : null;
}

async function protectedResource(mcpUrl: string): Promise<{
  authorizationServers: string[];
  issuers: string[];
  resource: string;
  scope: string | null;
}> {
  const challenge = await probeChallenge(mcpUrl);
  const server = new URL(assertConnectionUrl(mcpUrl));
  const candidates: string[] = [];
  // The server's own pointer first, then RFC 9728's path-aware location, then the root.
  if (challenge.resourceMetadata) candidates.push(challenge.resourceMetadata);
  if (server.pathname !== "/") {
    candidates.push(wellKnown(server.origin, `/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, "")}`));
  }
  candidates.push(wellKnown(server.origin, "/.well-known/oauth-protected-resource"));
  const rec = await firstDocument(
    candidates,
    (doc) => Array.isArray(doc.authorization_servers)
      && doc.authorization_servers.some((item) => typeof item === "string"),
    "oauth_no_as",
  );
  const servers = (rec.authorization_servers as unknown[]).filter((item): item is string => typeof item === "string");
  return {
    authorizationServers: servers.map((item) => assertPublicHttpsUrl(item)),
    // As the server wrote them: the metadata's `issuer` is compared with these.
    issuers: servers,
    resource: resourceFor(mcpUrl, rec.resource),
    scope: challengeScope(challenge.scope)
      ?? (Array.isArray(rec.scopes_supported) ? scopeString(rec.scopes_supported) : null),
  };
}

/**
 * RFC 8414 first, then OIDC discovery, in the order the MCP authorization
 * spec gives: for an issuer with a path, the well-known name is inserted
 * ahead of it (and OIDC's is also tried appended); with none, the two root
 * documents.
 */
async function authorizationServer(issuer: string, declaredIssuer: string): Promise<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** The metadata lists `S256` among its code challenge methods. */
  pkceS256: boolean;
}> {
  const parsed = new URL(assertConnectionUrl(issuer));
  const path = parsed.pathname.replace(/\/$/, "");
  const urls = path
    ? [
      wellKnown(parsed.origin, `/.well-known/oauth-authorization-server${path}`),
      wellKnown(parsed.origin, `/.well-known/openid-configuration${path}`),
      wellKnown(parsed.origin, `${path}/.well-known/openid-configuration`),
    ]
    : [
      wellKnown(parsed.origin, "/.well-known/oauth-authorization-server"),
      wellKnown(parsed.origin, "/.well-known/openid-configuration"),
    ];
  const rec = await firstDocument(
    urls,
    (doc) => typeof doc.authorization_endpoint === "string" && typeof doc.token_endpoint === "string",
    "oauth_as_incomplete",
  );
  const out = {
    authorizationEndpoint: assertPublicHttpsUrl(rec.authorization_endpoint as string),
    tokenEndpoint: assertPublicHttpsUrl(rec.token_endpoint as string),
    registrationEndpoint: typeof rec.registration_endpoint === "string"
      ? assertPublicHttpsUrl(rec.registration_endpoint)
      : null,
  };
  // RFC 8414 section 3.3, and the same rule for OIDC discovery: the issuer the
  // document names is the one it was fetched for. A document that names
  // another is some other server's metadata served from this address.
  const named = typeof rec.issuer === "string" ? trimSlash(rec.issuer) : null;
  if (named === null || named !== trimSlash(declaredIssuer)) throw new Error("oauth_issuer_mismatch");
  // Only what the server says it supports counts: a document with no list is
  // not a promise that it checks the challenge (RFC 8414 section 2).
  const pkceS256 = Array.isArray(rec.code_challenge_methods_supported)
    && rec.code_challenge_methods_supported.includes("S256");
  return { issuer: named, ...out, pkceS256 };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function pinOf(as: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null }): AsPin | null {
  return as.registrationEndpoint === null ? null : {
    issuer: as.issuer,
    authorizationOrigin: new URL(as.authorizationEndpoint).origin,
    tokenOrigin: new URL(as.tokenEndpoint).origin,
    registrationOrigin: new URL(as.registrationEndpoint).origin,
  };
}

function isAsPin(value: unknown): value is AsPin {
  const rec = asRecord(value);
  if (!rec) return false;
  if (typeof rec.issuer !== "string" || rec.issuer === "") return false;
  return ["authorizationOrigin", "tokenOrigin", "registrationOrigin"].every((key) => {
    try {
      return typeof rec[key] === "string" && new URL(rec[key] as string).origin === rec[key];
    } catch {
      return false;
    }
  });
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  name: string,
  scope: string | null,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const res = await activeFetch()(await resolvedWithin(registrationEndpoint), {
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
      // As the official SDK registers: the scope the sign-in will ask for.
      ...(scope ? { scope } : {}),
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
  /**
   * A sign-in again for a connection that holds a credential: the token
   * endpoint is then required and its origin pinned, and so is the rest of the
   * server when the credential kept `expectedPin`. A credential from before the
   * pin existed is held to its token endpoint and the issuer check alone.
   */
  reauthorize?: boolean;
  expectedTokenEndpoint?: string;
  expectedPin?: unknown;
}): Promise<{ authorizeUrl: string; redirectHost: string; state: string }> {
  const resource = await protectedResource(input.mcpUrl);
  const as = await authorizationServer(resource.authorizationServers[0], resource.issuers[0]);
  const pin = pinOf(as);
  if (input.reauthorize === true) {
    let same = false;
    try {
      same = typeof input.expectedTokenEndpoint === "string"
        && input.expectedTokenEndpoint !== ""
        && new URL(as.tokenEndpoint).origin === new URL(input.expectedTokenEndpoint).origin;
      if (same && input.expectedPin !== undefined) {
        const expected = input.expectedPin;
        same = isAsPin(expected) && pin !== null
          && pin.issuer === expected.issuer
          && pin.authorizationOrigin === expected.authorizationOrigin
          && pin.tokenOrigin === expected.tokenOrigin
          && pin.registrationOrigin === expected.registrationOrigin;
      }
    } catch {
      same = false;
    }
    // Before a client is registered or anything is opened.
    if (!same) throw new Error("authorization_server_changed");
  }
  if (!as.registrationEndpoint || !pin) throw new Error("oauth_no_dcr");
  // The challenge is sent as S256 and the verifier only protects the code if
  // the server checks it. Before a client is registered.
  if (!as.pkceS256) throw new Error("oauth_no_pkce");
  const client = await registerClient(as.registrationEndpoint, input.redirectUri, input.name, resource.scope);
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
  if (resource.scope) authorize.searchParams.set("scope", resource.scope);
  // Without it a server may answer the authorize request with no refresh
  // token at all; the SDK asks for consent whenever offline_access is wanted.
  if (resource.scope?.split(" ").includes("offline_access")) authorize.searchParams.set("prompt", "consent");
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
    resource: resource.resource,
    pin,
  };
  const path = input.pendingPath ?? oauthPendingPath();
  const rows = readPending(path).filter((row) => row.proposalId !== input.proposalId);
  rows.push(pending);
  writePending(rows, path);
  return { authorizeUrl: authorize.toString(), redirectHost: authorize.hostname.toLowerCase(), state };
}

/**
 * The token endpoint refused the authorization code, or answered with no
 * token. Carries the HTTP status so a caller can tell a refusal (4xx) from a
 * server that is down (5xx, 429). Nothing the server said is kept.
 */
export class OAuthTokenError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("oauth_token");
    this.name = "OAuthTokenError";
    this.status = status;
  }
}

export async function completeMcpOAuth(input: {
  code: string;
  state: string;
  pendingPath?: string;
  /**
   * Leave the pending row where it is on success. It is this attempt's
   * identity: starting the sign-in again replaces it, so a caller that still has
   * work to do after the exchange can ask whether it is still the latest, and
   * drops the row itself when it is done.
   */
  keepPending?: boolean;
}): Promise<{ bundle: OAuthTokenBundle; pending: OAuthPending }> {
  const path = input.pendingPath ?? oauthPendingPath();
  const rows = readPending(path);
  const pending = rows.find((row) => row.state === input.state);
  // A sign-in older than fifteen minutes is not in `rows` at all.
  if (!pending) throw new Error("oauth_state");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    ...(pending.resource ? { resource: pending.resource } : {}),
  });
  const res = await activeFetch()(await resolvedWithin(pending.tokenEndpoint), {
    method: "POST",
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new OAuthTokenError(res.status);
  const rec = asRecord(await boundedJson(res));
  if (!rec || typeof rec.access_token !== "string") throw new OAuthTokenError(res.status);
  // Read again: the request above took a while, and a sign-in started or
  // dropped meanwhile is in the file now, not in `rows`.
  if (input.keepPending !== true) writePending(readPending(path).filter((row) => row.state !== input.state), path);
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
      ...(pending.resource ? { resource: pending.resource } : {}),
      ...(pending.pin ? { pin: pending.pin } : {}),
    },
  };
}

/**
 * The token endpoint answered a refresh with a refusal. Carries what it said
 * (`status` and the OAuth `error` code) so the caller can tell a refresh token
 * that is spent (`invalid_grant`) from a server that is merely down. A network
 * error, a timeout or a refused address is not this: those propagate as they
 * are.
 */
export class OAuthRefreshError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`oauth_refresh_${status}`);
    this.name = "OAuthRefreshError";
    this.status = status;
    this.code = code;
  }
}

export async function refreshMcpOAuth(bundle: OAuthTokenBundle): Promise<OAuthTokenBundle> {
  if (!bundle.refreshToken) throw new Error("oauth_refresh");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
    client_id: bundle.clientId,
    ...(bundle.resource ? { resource: bundle.resource } : {}),
  });
  const res = await activeFetch()(await resolvedWithin(bundle.tokenEndpoint), {
    method: "POST",
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) {
    let code: string | null = null;
    try {
      const error = asRecord(await boundedJson(res))?.error;
      code = typeof error === "string" ? error.slice(0, 80) : null;
    } catch {
      // A refusal with no readable body is still a refusal, without a code.
    }
    throw new OAuthRefreshError(res.status, code);
  }
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
    ...(bundle.resource ? { resource: bundle.resource } : {}),
    ...(bundle.pin ? { pin: bundle.pin } : {}),
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

import { acquireDirLockAsync } from "./dir-lock.ts";
import { connectionsPath, findConnectionById, isAuthHeaderName, type ConnectionEntry } from "./connections-store.ts";
import { connectionSecretService, keychainGet, keychainSet } from "./keychain.ts";
import { McpError } from "./mcp-http.ts";
import { OAUTH_TIMEOUT_MS, OAuthRefreshError, refreshMcpOAuth, type OAuthTokenBundle } from "./mcp-oauth.ts";

/**
 * How a connection proves who it is. eve owns this for the connections it
 * mounts; the tools this app mounts on demand call the same server over plain
 * HTTP and need the same headers, so the builders live here rather than
 * inside the eve registry file that used to hold them.
 */

export function parseBundle(raw: string | null): OAuthTokenBundle | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as OAuthTokenBundle;
    if (!rec || typeof rec.accessToken !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * An OAuth connection whose access token has run out and could not be renewed:
 * there is no refresh token, or the server said it is no longer good
 * (`invalid_grant`). The stale token is never sent. The owner has to sign in
 * again.
 */
export class OAuthExpiredError extends Error {
  readonly code = "oauth_expired";

  constructor() {
    super("oauth_expired");
    this.name = "OAuthExpiredError";
  }
}

export async function bearerFromKeychain(id: string): Promise<{ token: string; expiresAt?: number }> {
  const raw = keychainGet(connectionSecretService(id));
  if (!raw) throw new Error(`connection_secret_missing:${id}`);
  return { token: raw };
}

function isExpiring(bundle: OAuthTokenBundle): boolean {
  return Boolean(bundle.expiresAt && bundle.expiresAt < Date.now() + 30_000);
}

/**
 * What a failed refresh means. Only a refresh token the server says is spent
 * ends the sign-in: a network error, a timeout, an address this app will not
 * call or a server that is down says nothing about the token, and treating it
 * as expiry sent the owner to sign in again over an outage.
 */
function refreshFailure(err: unknown): Error {
  if (err instanceof OAuthRefreshError) {
    if ((err.status === 400 || err.status === 401) && err.code === "invalid_grant") return new OAuthExpiredError();
    if (err.status === 429 || err.status >= 500) {
      return new McpError("unreachable", "oauth_refresh_unreachable", { status: err.status });
    }
    return new McpError("auth", `oauth_refresh_${err.status}`, { status: err.status });
  }
  return new McpError("unreachable", "oauth_refresh_unreachable");
}

/**
 * One refresh per connection at a time. A refresh token is often single use,
 * so two callers refreshing together spend it twice and the second is refused
 * for a token the first just replaced.
 */
/** How often a waiter for the refresh lock looks at what the holder stored. */
const GIVE_UP_CHECK_MS = 500;

const refreshing = new Map<string, Promise<OAuthTokenBundle>>();

/**
 * The lock another process takes to refresh the same connection: a file next
 * to the connections store, one per connection, held by the kernel.
 */
export function refreshLockPath(id: string): string {
  return `${connectionsPath()}.refresh-${id}.lock`;
}

/**
 * How long to wait for it. The wait is a timer loop, not a blocking call, so
 * the service keeps answering while another process refreshes; past the
 * deadline the caller reads what the other process stored and otherwise gives
 * up with `OAuthRefreshBusyError`. The deadline is longer than the holder's
 * worst case, so a waiter does not give up on a refresh that is still
 * inside its own limits: two token requests (the second only after a refused
 * one) and a margin. Everything that takes the lock (a refresh, finishing a
 * sign-in again, deleting a connection) waits that long.
 */
export const REFRESH_LOCK_TIMEOUT_DEFAULT_MS = 2 * OAUTH_TIMEOUT_MS + 5_000;
let refreshLockTimeoutMs = REFRESH_LOCK_TIMEOUT_DEFAULT_MS;

/** Test hook; `null` restores the default. */
export function setRefreshLockTimeoutMs(ms: number | null): void {
  refreshLockTimeoutMs = ms ?? REFRESH_LOCK_TIMEOUT_DEFAULT_MS;
}

/**
 * The refresh lock could not be taken in time, so what the sign-in is now is
 * not known. It says nothing about the server or the token: a caller must not
 * record a status for it, and the next attempt simply tries again.
 */
export class OAuthRefreshBusyError extends Error {
  readonly code = "oauth_refresh_busy";

  constructor() {
    super("oauth_refresh_busy");
    this.name = "OAuthRefreshBusyError";
  }
}

/**
 * Takes a connection's refresh lock without blocking the event loop. Resolves
 * to the release function, or to `null` when `giveUp` said the caller no longer
 * needs the lock; throws `OAuthRefreshBusyError` at the deadline.
 */
export async function acquireRefreshLock(id: string, giveUp?: () => boolean): Promise<(() => void) | null> {
  try {
    return await acquireDirLockAsync(refreshLockPath(id), {
      timeoutMs: refreshLockTimeoutMs,
      errorCode: "connection_refresh_locked",
      giveUp,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "connection_refresh_locked") throw new OAuthRefreshBusyError();
    throw err;
  }
}

/** Runs `work` with the connection's refresh lock held. */
export async function withRefreshLock<T>(id: string, work: () => T | Promise<T>): Promise<T> {
  const release = await acquireRefreshLock(id);
  try {
    return await work();
  } finally {
    release!();
  }
}

/**
 * Refresh with the lock held, reading the stored bundle first: another process
 * may have refreshed since the caller read it, and its refresh token is the one
 * that still works. When the server refuses the token as spent, the stored
 * bundle is read once more: if its refresh token is not the one just sent,
 * another process rotated it while this request was out, and that bundle is
 * used (or refreshed once, if it is already running out) instead of ending the
 * sign-in. Before the new bundle is written the stored one is read a last time:
 * a sign-in completed meanwhile (a new refresh token) is not written over.
 */
async function refreshStored(id: string, service: string): Promise<OAuthTokenBundle> {
  let current = parseBundle(keychainGet(service));
  if (!current) throw new Error(`connection_secret_missing:${id}`);
  if (!isExpiring(current)) return current;
  for (let attempt = 0; ; attempt += 1) {
    if (!current.refreshToken) throw new OAuthExpiredError();
    let next: OAuthTokenBundle;
    try {
      next = await refreshMcpOAuth(current);
    } catch (err) {
      const failure = refreshFailure(err);
      if (!(failure instanceof OAuthExpiredError) || attempt > 0) throw failure;
      const latest = parseBundle(keychainGet(service));
      if (!latest || latest.refreshToken === current.refreshToken) throw failure;
      if (!isExpiring(latest)) return latest;
      current = latest;
      continue;
    }
    // The owner may have removed the connection while the server was thinking;
    // a credential written now would have no row pointing at it.
    if (!findConnectionById(id)) throw new Error("connection_missing");
    const stored = parseBundle(keychainGet(service));
    if (stored && stored.refreshToken !== current.refreshToken) {
      // Something else replaced the bundle while the request was out (the
      // owner signed in again): it wins, and this answer is not written.
      return isExpiring(stored) ? next : stored;
    }
    keychainSet(service, JSON.stringify(next));
    return next;
  }
}

function refreshOnce(id: string): Promise<OAuthTokenBundle> {
  const running = refreshing.get(id);
  if (running) return running;
  const service = connectionSecretService(id);
  const run = (async () => {
    const seen: { good: OAuthTokenBundle | null } = { good: null };
    // Another process is refreshing it: what it stores may already be good, and
    // then there is nothing left to wait for.
    // Asked on every try (every 25 ms), but the Keychain is read at most every
    // 500 ms: a read is a process spawn, and the holder cannot have finished
    // faster than that to matter.
    let lastLook = Number.NEGATIVE_INFINITY;
    const release = await acquireRefreshLock(id, () => {
      if (seen.good !== null) return true;
      const now = Date.now();
      if (now - lastLook < GIVE_UP_CHECK_MS) return false;
      lastLook = now;
      const stored = parseBundle(keychainGet(service));
      if (stored && !isExpiring(stored)) seen.good = stored;
      return seen.good !== null;
    });
    if (!release) return seen.good!;
    try {
      return await refreshStored(id, service);
    } finally {
      release();
    }
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, run);
  return run;
}

/**
 * The access token for an OAuth connection, refreshed when it is about to
 * expire. The refreshed bundle is written back, so the next caller (eve's own
 * registry or a tool wrapper) reads the live one.
 */
export async function oauthToken(entry: ConnectionEntry): Promise<{ token: string; expiresAt?: number }> {
  let bundle = parseBundle(keychainGet(connectionSecretService(entry.id)));
  if (!bundle) throw new Error(`connection_secret_missing:${entry.id}`);
  if (isExpiring(bundle)) {
    if (!bundle.refreshToken) throw new OAuthExpiredError();
    bundle = await refreshOnce(entry.id);
  }
  return { token: bundle.accessToken, expiresAt: bundle.expiresAt ?? undefined };
}

/** The header name an `apiKey` connection puts its secret in. */
export function apiKeyHeaderName(entry: ConnectionEntry): string {
  return isAuthHeaderName(entry.authHeader) ? entry.authHeader : "X-Api-Key";
}

/**
 * The request headers for one connection, for the direct HTTP path. Never
 * logged and never returned to the model: the caller passes them straight to
 * `listMcpTools` or `callMcpTool`.
 */
export async function connectionHeaders(entry: ConnectionEntry): Promise<Record<string, string>> {
  if (entry.authKind === "none") return {};
  if (entry.authKind === "apiKey") {
    return { [apiKeyHeaderName(entry)]: (await bearerFromKeychain(entry.id)).token };
  }
  if (entry.authKind === "oauth") {
    return { authorization: `Bearer ${(await oauthToken(entry)).token}` };
  }
  return { authorization: `Bearer ${(await bearerFromKeychain(entry.id)).token}` };
}

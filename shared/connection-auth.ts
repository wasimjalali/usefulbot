import { isAuthHeaderName, type ConnectionEntry } from "./connections-store.ts";
import { connectionSecretService, keychainGet, keychainSet } from "./keychain.ts";
import { refreshMcpOAuth, type OAuthTokenBundle } from "./mcp-oauth.ts";

/**
 * How a connection proves who it is. eve owns this for the connections it
 * mounts; the tools this app mounts on demand call the same server over plain
 * HTTP and need the same headers, so the builders live here rather than
 * inside the eve registry file that used to hold them.
 */

function parseBundle(raw: string | null): OAuthTokenBundle | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as OAuthTokenBundle;
    if (!rec || typeof rec.accessToken !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export async function bearerFromKeychain(id: string): Promise<{ token: string; expiresAt?: number }> {
  const raw = keychainGet(connectionSecretService(id));
  if (!raw) throw new Error(`connection_secret_missing:${id}`);
  return { token: raw };
}

/**
 * The access token for an OAuth connection, refreshed when it is about to
 * expire. The refreshed bundle is written back, so the next caller (eve's own
 * registry or a tool wrapper) reads the live one.
 */
export async function oauthToken(entry: ConnectionEntry): Promise<{ token: string; expiresAt?: number }> {
  const service = connectionSecretService(entry.id);
  let bundle = parseBundle(keychainGet(service));
  if (!bundle) throw new Error(`connection_secret_missing:${entry.id}`);
  if (bundle.expiresAt && bundle.expiresAt < Date.now() + 30_000 && bundle.refreshToken) {
    bundle = await refreshMcpOAuth(bundle);
    keychainSet(service, JSON.stringify(bundle));
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

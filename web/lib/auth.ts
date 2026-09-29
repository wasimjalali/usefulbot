import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  credentialById,
  deviceCredentials,
  phoneDisabled,
  runtimeConfig,
} from "./runtime-config.ts";
import { putBrowserSession } from "../../shared/web-sessions.ts";

const COOKIE = "ub_session";

/** Browser session lifetime. Kept in one place so cookie and record cannot drift. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export { credentialById, phoneDisabled, runtimeConfig };

export function verifyDeviceToken(token: string): { callerId: string; profile: string; credentialId: string; expiresAt: string } | null {
  const presented = digest(token);
  const now = Date.now();
  for (const cred of deviceCredentials()) {
    const stored = Buffer.from(cred.sha256, "hex");
    if (stored.length !== 32) continue;
    if (!timingSafeEqual(presented, stored)) continue;
    if (cred.revokedAt) continue;
    if (Date.parse(cred.expiresAt) <= now) continue;
    return { callerId: cred.callerId, profile: cred.profile, credentialId: cred.id, expiresAt: cred.expiresAt };
  }
  return null;
}

/**
 * Mint a browser session. A credential-bound session never outlives its
 * credential (S9): `credentialExpiresAt` caps the 12-hour record when the row
 * ends sooner. Desktop auto-sessions pass no credential.
 */
export function createBrowserSession(
  callerId: string,
  profile: string,
  credentialId: string | null = null,
  credentialExpiresAt: string | null = null,
): { token: string; csrf: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  let expiresAt = Date.now() + SESSION_TTL_MS;
  if (credentialExpiresAt) {
    const bound = Date.parse(credentialExpiresAt);
    if (Number.isFinite(bound)) expiresAt = Math.min(expiresAt, bound);
  }
  putBrowserSession(token, { callerId, profile, csrf, expiresAt, credentialId });
  return { token, csrf, expiresAt };
}

/**
 * The session cookie. `Secure` is added only on tailnet ingress (S4): the
 * loopback UI is plain http where the flag would block the cookie, and on
 * tailnet https the flag is what keeps the cookie off any future http path.
 */
export function sessionCookie(token: string, { secure = false }: { secure?: boolean } = {}): string {
  // Matching the server-side session expiry, so the app survives a reload.
  const base = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return secure ? `${base}; Secure` : base;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export { COOKIE };

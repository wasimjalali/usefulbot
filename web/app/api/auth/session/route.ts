import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { classifyIngress, originAllowed, type IngressClass } from "../../../../lib/desktop-gate";
import { rateLimited } from "../../../../lib/api-guard";
import { createBrowserSession, credentialById, phoneDisabled, sessionCookie, clearSessionCookie, verifyDeviceToken } from "../../../../lib/auth";
import { destroySession, readSession } from "../../../../lib/cookie-sessions";

/**
 * Per-source limiter key (S13): the caller must never choose its own bucket.
 * On tailnet the only Serve-attested identity is `tailscale-user-login` —
 * classifying as `tailnet` at all means it already matched the enrolled
 * tailnet identity, so every tailnet caller lands in that one bucket; absent
 * it, fall back to the *last* XFF hop, the address Serve itself appended,
 * never a caller-written first hop. Loopback has no trustworthy source at
 * all, so local callers share one bucket. Opaque, bounded; the raw identity
 * is never stored.
 */
function clientKey(request: Request, ingress: IngressClass): string {
  const identity = ingress === "tailnet"
    ? request.headers.get("tailscale-user-login")?.trim()
      ?? request.headers.get("x-forwarded-for")?.split(",").pop()?.trim()
      ?? "tailnet"
    : "loopback";
  return createHash("sha256").update(`${ingress}:${identity}`).digest("hex").slice(0, 16);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Auto-session is only for the local UI (S8): the request must be class
 * `loopback` — loopback URL and no proxy headers at all — and the caller must
 * prove it is a same-origin page, through Origin when present or Referer
 * otherwise. A bare request with neither header does not get a session.
 */
function isLocalDesktop(request: Request, ingress: IngressClass): boolean {
  if (ingress !== "loopback") return false;
  let self: URL;
  try {
    self = new URL(request.url);
  } catch {
    return false;
  }
  if (!isLoopback(self.hostname)) return false;
  const origin = request.headers.get("origin");
  if (origin) return originAllowed(request, ingress);
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    const ref = new URL(referer);
    // localhost and 127.0.0.1 are the same surface here; Next may normalise the
    // request URL host, so compare only that both ends are loopback and the
    // ports match.
    return isLoopback(ref.hostname) && ref.port === self.port;
  } catch {
    return false;
  }
}

/**
 * Useful Bot is a local app, so the desktop never sees a login wall: a
 * loopback request without a session gets one (loopback class only — S8). A
 * tailnet or unknown caller still needs a device token through POST.
 */
export async function GET(request: Request) {
  const ingress = classifyIngress(request);
  if (ingress === "unknown") {
    return NextResponse.json({ ok: false, error: "ingress" }, { status: 403 });
  }
  let session = await readSession();
  if (!session && isLocalDesktop(request, ingress)) {
    if (rateLimited(`auth:${clientKey(request, ingress)}`, 60)) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    const created = createBrowserSession("desktop", "desktop");
    session = {
      callerId: "desktop",
      profile: "desktop",
      csrf: created.csrf,
      expiresAt: created.expiresAt,
      credentialId: null,
    };
    const response = NextResponse.json({
      ok: true,
      profile: "desktop",
      expiresAt: created.expiresAt,
      csrfToken: created.csrf,
    });
    response.headers.append("set-cookie", sessionCookie(created.token));
    return response;
  }
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // A desktop-profile session never counts on the tailnet, however it was
  // minted — the introspection endpoint answers the same verdict POST
  // would have.
  if (ingress === "tailnet" && session.profile !== "phone") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // The session is only as live as the credential row it is bound to (S9):
  // a revoked or expired row makes every gated route 401, and a phone
  // session dies with phoneEnabled — introspection answers the same
  // verdict instead of reporting ok on a dead session.
  if ((session.credentialId && !credentialById(session.credentialId))
    || (session.profile === "phone" && phoneDisabled())) {
    await destroySession();
    const dead = NextResponse.json({ ok: false, error: "credential_invalid" }, { status: 401 });
    dead.headers.append("set-cookie", clearSessionCookie());
    return dead;
  }
  return NextResponse.json({
    ok: true,
    profile: session.profile,
    expiresAt: session.expiresAt,
    csrfToken: session.csrf,
    // Null on a desktop auto-session (credentialId: null); a credential-bound
    // session reports its row's expiry so Devices can show both clocks.
    credentialExpiresAt: session.credentialId
      ? credentialById(session.credentialId)?.expiresAt ?? null
      : null,
  });
}

export async function POST(request: Request) {
  const ingress = classifyIngress(request);
  if (ingress === "unknown") {
    return NextResponse.json({ ok: false, error: "ingress" }, { status: 403 });
  }
  // Failed-auth limiter (S13): the per-source 30/min bucket is keyed on the
  // ingress class plus its trusted hop, and a global 100/min bucket caps all
  // sources together so a spray across addresses still fills one bucket.
  if (rateLimited(`auth:${clientKey(request, ingress)}`, 30)
    || rateLimited("auth:global", 100)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const identity = verifyDeviceToken(header.slice("Bearer ".length).trim());
  if (!identity) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // A desktop credential never signs in over the tailnet (F3): the phone
  // credential is the only one a proxied request may turn into a session.
  if (ingress === "tailnet" && identity.profile !== "phone") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // The S9 invariant belongs at mint too: a phone credential is dead while
  // phone access is disabled — answer the use-side verdict instead of
  // minting a session every gated route would kill the next request.
  if (identity.profile === "phone" && phoneDisabled()) {
    return NextResponse.json({ ok: false, error: "credential_invalid" }, { status: 401 });
  }
  // Re-issuing a session must retire the one it replaces, or the old cookie
  // stays valid until its own expiry.
  await destroySession();
  const created = createBrowserSession(
    identity.callerId,
    identity.profile,
    identity.credentialId,
    identity.expiresAt,
  );
  const response = NextResponse.json({
    ok: true,
    profile: identity.profile,
    expiresAt: created.expiresAt,
    csrfToken: created.csrf,
    // The bound credential's own expiry (S9 row), null for a desktop
    // auto-session: Settings > Devices shows both clocks (spec 6.2).
    credentialExpiresAt: identity.expiresAt,
  });
  response.headers.append("set-cookie", sessionCookie(created.token, { secure: ingress === "tailnet" }));
  return response;
}

export async function DELETE(request: Request) {
  const ingress = classifyIngress(request);
  if (ingress === "unknown") {
    return NextResponse.json({ ok: false, error: "ingress" }, { status: 403 });
  }
  if (rateLimited(`auth:${clientKey(request, ingress)}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const session = await readSession();
  if (session) {
    const csrf = request.headers.get("x-ub-csrf");
    if (!csrf || csrf !== session.csrf) {
      return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
    }
  }
  await destroySession();
  const response = NextResponse.json({ ok: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

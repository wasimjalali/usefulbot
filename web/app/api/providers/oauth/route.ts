import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { oauthStartVerdict } from "../../../../lib/providers-write";
import { startChatGptSignIn } from "../../../../../shared/chatgpt-signin.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`providers-oauth:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: { providerId?: unknown; newAccount?: unknown; clientId?: unknown; retryClientId?: unknown };
  try {
    body = await readJson(request) as typeof body;
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    // A retired route, an unknown provider and one with no sign-in entry are refused here (UB-015).
    const verdict = oauthStartVerdict(providerId);
    if (verdict.status === 409) return NextResponse.json({ ok: false, error: verdict.error, message: verdict.message }, { status: 409 });
    if (verdict.status === 400) return NextResponse.json({ ok: false, error: verdict.error }, { status: 400 });
    // Browser flow: the app opens the authorize URL, the loopback callback
    // route finishes the sign-in and the poll reports it.
    const started = startChatGptSignIn({
      newAccount: body.newAccount === true,
      ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
      ...(typeof body.retryClientId === "string" ? { retryClientId: body.retryClientId } : {}),
    });
    return NextResponse.json({
      ok: true,
      pollId: started.pollId,
      flow: "browser",
      userCode: "",
      verificationUrl: started.authorizeUrl,
      verificationUrlComplete: null,
      expiresAt: started.expiresAt,
      intervalMs: started.intervalMs,
      account: started.account,
      accounts: started.accounts,
      reusesSaved: started.reusesSaved,
      clientId: started.clientId,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

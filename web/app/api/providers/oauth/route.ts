import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { providerMode } from "../../../../../shared/provider-catalog.ts";
import { startDeviceFlow } from "../../../../../shared/provider-oauth.ts";

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
  let body: { providerId?: unknown };
  try {
    body = await readJson(request) as typeof body;
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    // Only providers with a device flow entry accept this route.
    providerMode(providerId, "oauth");
    const pending = await startDeviceFlow(providerId);
    return NextResponse.json({
      ok: true,
      pollId: pending.pollId,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
      verificationUrlComplete: pending.verificationUrlComplete,
      expiresAt: pending.expiresAt,
      intervalMs: pending.intervalMs,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

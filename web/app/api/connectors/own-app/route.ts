import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { connectorsCallbackUrl } from "../../../../lib/connectors-callback";
import { connectOwnApp, describeOwnApp, isKeyRejected } from "../../../../../shared/composio.ts";

export const runtime = "nodejs";

/**
 * The owner's own OAuth app for a connector Composio has no app of its own
 * for (TikTok, X, Spotify). GET says which credentials the app needs and the
 * redirect URI to register; POST hands them to Composio and starts the
 * sign-in. Same gate, CSRF header and rate bucket as the connectors route.
 * The credentials pass through to Composio and are never stored or logged
 * here; the response carries only the sign-in URL.
 */

function csrfOk(request: Request, gate: { session: { csrf: string } }): boolean {
  const csrf = request.headers.get("x-ub-csrf");
  return Boolean(csrf && csrf === gate.session.csrf);
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const toolkit = new URL(request.url).searchParams.get("toolkit");
  if (!toolkit) return NextResponse.json({ ok: false, error: "toolkit_required" }, { status: 400 });
  try {
    const form = await describeOwnApp(toolkit);
    return NextResponse.json({ ok: true, ...form });
  } catch (err) {
    const error = isKeyRejected(err) ? "key_rejected" : errorCode(err, "own_app_unavailable");
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = (await readJson(request)) as { toolkit?: unknown; credentials?: unknown };
    if (typeof body.toolkit !== "string" || !body.toolkit) {
      return NextResponse.json({ ok: false, error: "toolkit_required" }, { status: 400 });
    }
    if (!body.credentials || typeof body.credentials !== "object" || Array.isArray(body.credentials)) {
      return NextResponse.json({ ok: false, error: "own_app_fields" }, { status: 400 });
    }
    const result = await connectOwnApp(
      body.toolkit,
      body.credentials as Record<string, unknown>,
      connectorsCallbackUrl(gate.session.profile),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    const error = isKeyRejected(err) ? "key_rejected" : errorCode(err, "own_app_failed");
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}

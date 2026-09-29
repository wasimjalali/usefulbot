import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited } from "../../../../../../lib/api-guard";
import { regenerateImage } from "../../../../../../lib/image-regenerate";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Regenerate a lost image in place, owner only. Each call is a paid image, so
 * it takes the CSRF token like any other change and a tight rate limit.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`regenerate:${gate.session.callerId}`, 6)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const { id } = await context.params;
  try {
    const saved = await regenerateImage(id);
    return NextResponse.json({ ok: true, path: saved.path });
  } catch (err) {
    console.error(`[media] regenerate ${id} failed`, err);
    return apiError(err) ?? NextResponse.json({ ok: false, error: errorCode(err, "regenerate_failed") }, { status: 500 });
  }
}

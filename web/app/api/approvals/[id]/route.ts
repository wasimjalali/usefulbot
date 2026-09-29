import { NextResponse } from "next/server";
import { ApprovalStore, defaultApprovalsPath } from "../../../../../agent/lib/approvals.ts";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../../lib/api-guard";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`approvals:${gate.session.callerId}`, 120)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: { decision?: string; actionSha256?: string };
  try {
    body = await readJson(request) as { decision?: string; actionSha256?: string };
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (typeof body.actionSha256 !== "string") {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const record = new ApprovalStore(Date.now, defaultApprovalsPath()).decide(
      id,
      body.decision,
      body.actionSha256,
    );
    return NextResponse.json({ ok: true, id: record.id, decision: body.decision, status: record.status });
  } catch (err) {
    const code = errorCode(err, "approval_error");
    // Contention on the store lock is transient, so ask the caller to retry.
    if (code === "approvals_locked") {
      return NextResponse.json({ ok: false, error: "approvals_locked" }, { status: 503 });
    }
    // The id is a debugging aid echoed from the URL, not internal state; the
    // errorCode gate still replaces any fs or parse error with the fallback.
    const status = code.startsWith("approval_not_found") ? 404 : 400;
    return NextResponse.json({ ok: false, error: code }, { status });
  }
}

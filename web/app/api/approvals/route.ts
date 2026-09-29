import { NextResponse } from "next/server";
import { ApprovalStore, defaultApprovalsPath } from "../../../../agent/lib/approvals.ts";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { errorCode, rateLimited } from "../../../lib/api-guard";

export const runtime = "nodejs";

function store(): ApprovalStore {
  return new ApprovalStore(Date.now, defaultApprovalsPath());
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  // The card list polls; a generous cap still stops a runaway loop from
  // hammering the store lock.
  if (rateLimited(`approvals:${gate.session.callerId}`, 240)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    return NextResponse.json({ ok: true, approvals: store().listPending() });
  } catch (err) {
    const code = errorCode(err, "approval_error");
    // Contention on the store lock is transient, so ask the caller to retry.
    // The decide route maps this the same way; without it the 1.5s poll gets
    // an unhandled 500 whenever the agent process holds the lock.
    if (code === "approvals_locked") {
      return NextResponse.json({ ok: false, error: "approvals_locked" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: code }, { status: 400 });
  }
}

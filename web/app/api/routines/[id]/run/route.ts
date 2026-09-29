import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { errorCode, rateLimited } from "../../../../../lib/api-guard";
import { agentsEnabled, startRoutineNow } from "../../../../../lib/agent-exec";
import { readRoutine } from "../../../../../../shared/routines-store.ts";

export const runtime = "nodejs";

/**
 * Manual "Test run". A run has up to an hour, far longer than the app's
 * request timeout, so it starts in the background and the pane reads the
 * outcome from the routine's run history on its next poll.
 *
 * A paused routine still runs from here. Pausing stops the schedule, and the
 * owner pressing this button is not the schedule; refusing would leave no way
 * to try a routine before turning it back on.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!agentsEnabled()) {
    return NextResponse.json({ ok: false, error: "agent_credential_missing" }, { status: 503 });
  }
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`routine-run:${gate.session.callerId}`, 20)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const { id } = await context.params;
  try {
    const routine = readRoutine(id);
    if (!routine) return NextResponse.json({ ok: false, error: "routine_missing" }, { status: 404 });
    // The claim happens here, before the response: a caller told "started"
    // and then left with a swallowed claim failure would have no history row
    // to show and no error anywhere.
    void startRoutineNow(id).catch(() => undefined);
    return NextResponse.json({ ok: true, started: true, routineId: id });
  } catch (err) {
    const code = errorCode(err);
    // A double click is contention, not a fault: ask the caller to retry.
    if (code === "routine_busy") {
      return NextResponse.json({ ok: false, error: code }, { status: 409 });
    }
    // A contended store lock is also transient.
    if (code === "routines_locked") {
      return NextResponse.json({ ok: false, error: code }, { status: 503 });
    }
    if (code === "routine_missing") {
      return NextResponse.json({ ok: false, error: code }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: code }, { status: 400 });
  }
}

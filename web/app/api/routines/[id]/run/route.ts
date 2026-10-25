import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { rateLimited } from "../../../../../lib/api-guard";
import { engineRunRoutine, EngineUnavailableError } from "../../../../../../shared/engine-client.ts";
import { readRoutine } from "../../../../../../shared/routines-store.ts";

export const runtime = "nodejs";

/**
 * Manual "Test run". The engine claims the routine and runs it in the
 * routine's own chat (SPEC 5.11); a run has up to an hour, so this answers when
 * the engine has taken it and the pane reads the outcome from the routine's run
 * history on its next poll.
 *
 * A paused routine still runs from here. Pausing stops the schedule, and the
 * owner pressing this button is not the schedule; refusing would leave no way
 * to try a routine before turning it back on.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
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
  if (!readRoutine(id)) return NextResponse.json({ ok: false, error: "routine_missing" }, { status: 404 });
  try {
    const run = await engineRunRoutine(id);
    // The engine's own answer and status: routine_busy 409, routine_missing 404 and the rest.
    return NextResponse.json(run.ok ? { ...run.body, ok: true, started: true, routineId: id } : run.body, { status: run.status });
  } catch (err) {
    if (err instanceof EngineUnavailableError) return NextResponse.json({ ok: false, error: "engine_unavailable" }, { status: 503 });
    if (err instanceof Error && err.message === "engine_credential_missing") {
      return NextResponse.json({ ok: false, error: "engine_credential_missing" }, { status: 503 });
    }
    throw err;
  }
}

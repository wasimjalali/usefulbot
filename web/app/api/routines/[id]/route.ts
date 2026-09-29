import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../../lib/api-guard";
import { deleteRoutine, readRoutine, updateRoutine } from "../../../../../shared/routines-store.ts";

export const runtime = "nodejs";

type Gate = Awaited<ReturnType<typeof requireOwner>>;

/** Desktop session, matching origin and a matching CSRF token, or a response. */
async function guard(request: Request): Promise<NextResponse | Extract<Gate, { session: unknown }>> {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`routines:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  return gate;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request);
  if (gate instanceof NextResponse) return gate;
  const { id } = await context.params;
  try {
    const body = await readJson(request) as {
      name?: unknown;
      instruction?: unknown;
      schedules?: unknown;
      timezone?: unknown;
      active?: unknown;
    };
    const routine = updateRoutine(id, body);
    return NextResponse.json({ ok: true, routine });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    const code = errorCode(err);
    return NextResponse.json({ ok: false, error: code }, { status: code === "routine_missing" ? 404 : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request);
  if (gate instanceof NextResponse) return gate;
  const { id } = await context.params;
  try {
    if (!readRoutine(id)) {
      return NextResponse.json({ ok: false, error: "routine_missing" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: deleteRoutine(id) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

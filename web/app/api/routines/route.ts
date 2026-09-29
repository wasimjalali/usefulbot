import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { createRoutine, deleteRoutine, listRoutines, readRoutine } from "../../../../shared/routines-store.ts";
import { readShell } from "../../../../shared/shell-io.ts";

export const runtime = "nodejs";

/**
 * Routines for the details pane. Same desktop gate, origin check, CSRF header
 * and rate limit as the shell route; the store itself is locked, so a write
 * from here cannot clobber one from an agent tool.
 */

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (id) {
    const routine = readRoutine(id);
    if (!routine) return NextResponse.json({ ok: false, error: "routine_missing" }, { status: 404 });
    return NextResponse.json({ ok: true, routine });
  }
  const botId = params.get("botId");
  if (!botId) return NextResponse.json({ ok: false, error: "bot_required" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, routines: listRoutines(botId) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "routines_unavailable") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`routines:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = await readJson(request) as {
      botId?: unknown;
      name?: unknown;
      instruction?: unknown;
      schedules?: unknown;
      timezone?: unknown;
      active?: unknown;
    };
    if (typeof body.botId !== "string" || !body.botId) {
      return NextResponse.json({ ok: false, error: "bot_required" }, { status: 400 });
    }
    // A routine that names no live bot would never run and would keep firing
    // nothing after the bot is gone.
    if (!readShell().bots.some((bot) => bot.id === body.botId)) {
      return NextResponse.json({ ok: false, error: "bot_missing" }, { status: 400 });
    }
    const routine = createRoutine({
      botId: body.botId,
      name: typeof body.name === "string" ? body.name : "",
      instruction: typeof body.instruction === "string" ? body.instruction : "",
      schedules: body.schedules,
      timezone: body.timezone,
      active: body.active,
    });
    // The two stores have separate locks, so the bot can be deleted between the
    // check above and the write. Narrow that window here; a rollback that
    // cannot take the lock is not worth failing twice over, because the tick's
    // orphan sweep collects whatever this misses.
    if (!readShell().bots.some((bot) => bot.id === routine.botId)) {
      try {
        deleteRoutine(routine.id);
      } catch {
        /* swept on the next tick */
      }
      return NextResponse.json({ ok: false, error: "bot_missing" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, routine });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

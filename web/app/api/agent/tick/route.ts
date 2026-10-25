import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isGateError, originAllowed, requireOwner } from "../../../../lib/desktop-gate";
import { rateLimited } from "../../../../lib/api-guard";
import { sweepOrphanStateIfDue } from "../../../../lib/agent-exec";
import { pumpConnects } from "../../../../../shared/connect-flow.ts";
import { pumpConnections } from "../../../../../shared/connection-flow.ts";
import { seedDefaultConnections } from "../../../../../shared/connections-store.ts";

/**
 * The connect pumps and the orphan sweep. The app POSTs here every few
 * seconds: the owner's sign-in for a connect card finishes in a browser tab,
 * and this is what notices it and has the engine resume the bot. Routines and
 * everything else that runs a turn live in the engine now. The browser reaches
 * it as a same-origin desktop request.
 */

async function authorised(request: Request): Promise<boolean> {
  // Browser callers carry the desktop session cookie (SameSite=Strict, so a
  // cross-site page does not have it). A present Origin must be allowed; a
  // caller that omits Origin must prove itself with the session CSRF token.
  const origin = request.headers.get("origin");
  if (origin && !originAllowed(request)) return false;
  const gate = await requireOwner(request);
  if (isGateError(gate)) return false;
  if (!origin) {
    const csrf = request.headers.get("x-ub-csrf");
    if (!csrf || csrf !== gate.session.csrf) return false;
  }
  return true;
}

export async function GET(request: Request) {
  if (!(await authorised(request))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  if (!(await authorised(request))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // The UI polls this every few seconds; the bucket is generous but stops a
  // runaway loop from piling up pump work. Key on a hash, never the raw cookie.
  // Ahead of the sweep as well as the pumps: both take file locks.
  const key = createHash("sha256").update(request.headers.get("cookie") ?? "local").digest("hex").slice(0, 16);
  if (rateLimited(`tick:${key}`, 120)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  // Routines whose bot is gone are visible through the routines route, so a
  // teardown that failed would otherwise wait for the next tick to heal.
  const swept = sweepOrphanStateIfDue();
  // Connect cards share the tick: the owner's sign-in finishes in a browser
  // tab, and this is what notices it and wakes the bot. Both pumps are
  // single-flight, so a fast poll cannot stack work.
  void pumpConnects().catch((err) => console.error("[useful-bot] connect pump failed", err));
  void pumpConnections().catch((err) => console.error("[useful-bot] connection pump failed", err));
  try { seedDefaultConnections(); } catch { /* a locked file retries next tick */ }
  return NextResponse.json({ ok: true, started: true, swept: swept.length });
}

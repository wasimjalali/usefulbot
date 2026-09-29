import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isGateError, originAllowed, requireOwner } from "../../../../lib/desktop-gate";
import { rateLimited } from "../../../../lib/api-guard";
import {
  agentsEnabled,
  handoffsInFlight,
  pumpHandoffs,
  pumpRoutines,
  routinesInFlight,
  backgroundWorkingBotIds,
  sweepOrphanStateIfDue,
} from "../../../../lib/agent-exec";
import { pumpConnects } from "../../../../../shared/connect-flow.ts";
import { pumpConnections } from "../../../../../shared/connection-flow.ts";
import { seedDefaultConnections } from "../../../../../shared/connections-store.ts";

/**
 * Handoff pump and routine scheduler. The sending agent tool only queues a
 * record, so delivery is driven from here: the UI poll POSTs every few seconds
 * and wakePump() POSTs once right after a send. The same tick is where due
 * routines fire. The agent key reaches this route as a header; the browser
 * reaches it as a same-origin desktop request.
 */

function keyMatches(candidate: string | null): boolean {
  if (!candidate) return false;
  const probe = createHash("sha256").update(candidate).digest();
  const secrets = [process.env.UB_CHANNEL_JWT, process.env.UB_CHANNEL_JWT_SECRET]
    .filter((value): value is string => Boolean(value));
  return secrets.some((secret) => {
    const expected = createHash("sha256").update(secret).digest();
    return timingSafeEqual(probe, expected);
  });
}

async function authorised(request: Request): Promise<boolean> {
  if (keyMatches(request.headers.get("x-ub-agent-key"))) return true;
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
  if (!agentsEnabled() || !(await authorised(request))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    ok: true,
    enabled: agentsEnabled(),
    inFlight: handoffsInFlight(),
    workingBotIds: backgroundWorkingBotIds(),
    routinesInFlight: routinesInFlight(),
  });
}

export async function POST(request: Request) {
  // Authorisation first: an unauthorised caller should not learn from the
  // status code whether this app has an agent credential.
  if (!(await authorised(request))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // The UI polls this every few seconds; the bucket is generous but stops a
  // runaway loop from piling up pump work. Key on a hash, never the raw token.
  // Ahead of the sweep as well as the pumps: both take file locks.
  const identity = request.headers.get("x-ub-agent-key") ?? request.headers.get("cookie") ?? "local";
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (rateLimited(`tick:${key}`, 120)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  // Ahead of the credential gate on purpose. Routines whose bot is gone are
  // visible through the routines route, which needs no credential, and a
  // teardown that failed before a key was revoked would otherwise wait for one
  // to come back before it healed.
  const swept = sweepOrphanStateIfDue();
  if (!agentsEnabled()) {
    return NextResponse.json({ ok: false, error: "agent_credential_missing", swept: swept.length }, { status: 503 });
  }
  const raw = Number(new URL(request.url).searchParams.get("limit") ?? "2");
  const limit = Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.trunc(raw))) : 2;
  // Delivery can take up to two minutes. Answer now and let the pump run in the
  // background: the UI poll would otherwise stay blocked and stop scheduling
  // ticks, and queue state is durable anyway.
  void pumpHandoffs(limit).catch(() => undefined);
  // Routines share the tick so the owner needs nothing running but the app.
  // Both pumps are single-flight, so a fast poll cannot stack work.
  void pumpRoutines(limit).catch(() => undefined);
  // Connect cards share the tick too: the owner's sign-in finishes in a
  // browser tab, and this is what notices it and wakes the bot.
  void pumpConnects().catch(() => undefined);
  void pumpConnections().catch(() => undefined);
  try { seedDefaultConnections(); } catch { /* a locked file retries next tick */ }
  return NextResponse.json({
    ok: true,
    enabled: agentsEnabled(),
    started: true,
    swept: swept.length,
    inFlight: handoffsInFlight(),
    workingBotIds: backgroundWorkingBotIds(),
    routinesInFlight: routinesInFlight(),
  });
}

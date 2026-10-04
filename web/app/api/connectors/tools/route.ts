import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited } from "../../../../lib/api-guard";
import { listToolkitTools } from "../../../../../shared/composio.ts";

export const runtime = "nodejs";

/**
 * The tools one connected Composio app offers, for the Connectors detail
 * view. Same desktop gate and rate limit as the connectors route. An app that
 * isn't connected is refused.
 */

const STATUS: Record<string, number> = {
  toolkit_invalid: 400,
  not_connected: 404,
};

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const toolkit = new URL(request.url).searchParams.get("toolkit");
  if (!toolkit) return NextResponse.json({ ok: false, error: "toolkit_required" }, { status: 400 });
  try {
    const tools = await listToolkitTools(toolkit);
    return NextResponse.json({ ok: true, tools }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    const code = errorCode(err, "tools_unavailable");
    return NextResponse.json({ ok: false, error: code }, { status: STATUS[code] ?? 502 });
  }
}

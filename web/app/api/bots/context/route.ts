import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { errorCode } from "../../../../lib/api-guard";
import { botContextReport } from "../../../../lib/agent-exec";

export const runtime = "nodejs";

/**
 * The numbers behind a bot's instruction counter and its Generalist seed.
 * Read only.
 */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const botId = new URL(request.url).searchParams.get("botId")?.trim() ?? "";
  if (!botId) return NextResponse.json({ ok: false, error: "bot_required" }, { status: 400 });
  try {
    const report = botContextReport(botId);
    if (!report) return NextResponse.json({ ok: false, error: "bot_missing" }, { status: 404 });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "context_unavailable") }, { status: 400 });
  }
}

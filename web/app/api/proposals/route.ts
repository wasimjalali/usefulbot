import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { safeId } from "../../../lib/engine-proxy";
import { openProposals } from "../../../../shared/agent-store.ts";

export const runtime = "nodejs";

/**
 * The open connect-app and connect-server cards the bot raised, each with its
 * phase. The app polls it while a card waits on a sign-in. Confirm and dismiss
 * stay on PUT /api/shell.
 */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const botId = safeId(new URL(request.url).searchParams.get("botId")?.trim());
  if (!botId) return NextResponse.json({ ok: false, error: "botId" }, { status: 400 });
  return NextResponse.json({ ok: true, botId, proposals: openProposals(botId) });
}

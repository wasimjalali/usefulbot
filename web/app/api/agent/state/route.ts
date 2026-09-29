import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { threadSnapshot } from "../../../../../shared/agent-store.ts";

/**
 * Durable thread state for the open chat. Desktop only: the transcript is the
 * owner's view of every event a bot produced, plus the proposals still waiting
 * on an answer. Handoff delivery is driven separately by the tick route.
 */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const botId = new URL(request.url).searchParams.get("botId")?.trim();
  if (!botId) {
    return NextResponse.json({ ok: false, error: "botId" }, { status: 400 });
  }
  const { events, proposals } = threadSnapshot(botId);
  return NextResponse.json({ ok: true, botId, events, proposals });
}

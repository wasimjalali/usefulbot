import { NextResponse } from "next/server";
import { ApprovalStore, defaultApprovalsPath } from "../../../../agent/lib/approvals.ts";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { errorCode, rateLimited } from "../../../lib/api-guard";
import { readShell } from "../../../../shared/shell-io.ts";
import { resolveSessionBot } from "../../../../shared/session-bindings.ts";

export const runtime = "nodejs";

function store(): ApprovalStore {
  return new ApprovalStore(Date.now, defaultApprovalsPath());
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  // The card list polls; a generous cap still stops a runaway loop from
  // hammering the store lock.
  if (rateLimited(`approvals:${gate.session.callerId}`, 240)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    // Each card names the bot whose chat it belongs to (a sub-agent's card, the
    // bot of its root session) and the session that raised it.
    const shell = readShell();
    const approvals = store().listPending().map(({ rootSessionId, subagent, ...card }) => {
      const botId = resolveSessionBot(rootSessionId ?? card.sessionId, shell);
      const botName = shell.bots.find((bot) => bot.id === botId)?.name ?? null;
      // The root session names the chat a sub-agent's card belongs to; a root's own card is its session.
      return { ...card, rootSessionId: rootSessionId ?? card.sessionId, botId, botName, subagent: subagent === true };
    });
    return NextResponse.json({ ok: true, approvals });
  } catch (err) {
    const code = errorCode(err, "approval_error");
    // Contention on the store lock is transient, so ask the caller to retry.
    // The decide route maps this the same way; without it the 1.5s poll gets
    // an unhandled 500 whenever the agent process holds the lock.
    if (code === "approvals_locked") {
      return NextResponse.json({ ok: false, error: "approvals_locked" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: code }, { status: 400 });
  }
}

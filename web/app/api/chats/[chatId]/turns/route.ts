import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { relayJson, safeId } from "../../../../../lib/engine-proxy";

export const runtime = "nodejs";

/**
 * Send a message (or Retry) into the chat. The body is validated here and
 * relayed rebuilt from its validated fields; the engine admits the turn or
 * refuses it with a typed code (SPEC 5.5, 6.4).
 */
export async function POST(request: Request, context: { params: Promise<{ chatId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  return relayJson(request, gate.session, { method: "POST", path: `/chats/${chatId}/turns`, body: "turn" });
}

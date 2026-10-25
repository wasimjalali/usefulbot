import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { relayJson, safeId } from "../../../../../lib/engine-proxy";

export const runtime = "nodejs";

/** Stops the chat's running turn and drops its queued messages. Answers 202 at once. */
export async function POST(request: Request, context: { params: Promise<{ chatId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  return relayJson(request, gate.session, { method: "POST", path: `/chats/${chatId}/cancel`, bucket: "control" });
}

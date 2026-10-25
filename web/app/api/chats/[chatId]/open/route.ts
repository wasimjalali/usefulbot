import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { relayJson, safeId } from "../../../../../lib/engine-proxy";

export const runtime = "nodejs";

/** Marks the chat current and open in the app, which clears its reply-ready mark. */
export async function POST(request: Request, context: { params: Promise<{ chatId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  return relayJson(request, gate.session, { method: "POST", path: `/chats/${chatId}/open`, bucket: "control" });
}

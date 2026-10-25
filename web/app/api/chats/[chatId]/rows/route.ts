import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { engineQuery, relayJson, safeId } from "../../../../../lib/engine-proxy";

export const runtime = "nodejs";

/** A page of the chat's transcript rows, newest first when `before` is absent (SPEC 5.12). */
export async function GET(request: Request, context: { params: Promise<{ chatId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  const query = engineQuery(request, { before: "cursor", limit: "int" });
  return relayJson(request, gate.session, { method: "GET", path: `/chats/${chatId}/rows${query}` });
}

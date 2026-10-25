import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { engineQuery, relayStream, safeId } from "../../../../../lib/engine-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chat's live NDJSON event stream (SPEC 6.2). Relayed without buffering and
 * without a deadline; the client closing it closes the engine's side too.
 */
export async function GET(request: Request, context: { params: Promise<{ chatId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  const query = engineQuery(request, { after: "int", epoch: "cursor" });
  return relayStream(request, `/chats/${chatId}/events${query}`);
}

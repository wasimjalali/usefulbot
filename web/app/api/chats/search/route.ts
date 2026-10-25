import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { engineQuery, relayJson } from "../../../../lib/engine-proxy";

export const runtime = "nodejs";

/** Chats whose title, preview or message text matches (SPEC 5.4). */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const query = engineQuery(request, { q: "text", limit: "int" });
  return relayJson(request, gate.session, { method: "GET", path: `/chats/search${query}` });
}

import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { ApiError } from "../../../lib/api-guard";
import { engineQuery, relayJson, safeId } from "../../../lib/engine-proxy";

export const runtime = "nodejs";

/** The bot's chats, newest first, paged (SPEC 6.1). */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const query = engineQuery(request, { botId: "id", before: "cursor", limit: "int", includeFixtures: "flag" });
  return relayJson(request, gate.session, { method: "GET", path: `/chats${query}` });
}

/** A new chat for the bot; it becomes the bot's current one. */
export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  return relayJson(request, gate.session, {
    method: "POST",
    path: "/chats",
    body: "json",
    checkBody: (body) => {
      const botId = safeId(body.botId);
      if (!botId) throw new ApiError(400, "bot_required");
      return { botId };
    },
  });
}

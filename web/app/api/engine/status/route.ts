import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { relayJson } from "../../../../lib/engine-proxy";

export const runtime = "nodejs";

/**
 * Which chats are working, waiting on the owner, reply-ready or failed (SPEC
 * 6.1). The app polls it with the approvals poll.
 */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  return relayJson(request, gate.session, { method: "GET", path: "/status" });
}

import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { ApiError } from "../../../../lib/api-guard";
import { relayJson, safeId } from "../../../../lib/engine-proxy";

export const runtime = "nodejs";

type Context = { params: Promise<{ chatId: string }> };

/** Rename a chat: 1 to 60 characters. */
export async function PATCH(request: Request, context: Context) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  return relayJson(request, gate.session, {
    method: "PATCH",
    path: `/chats/${chatId}`,
    body: "json",
    checkBody: (body) => {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title.length < 1 || title.length > 60) throw new ApiError(400, "title_invalid");
      return { title };
    },
  });
}

/** Delete a chat to the engine's trash. Refused while a turn runs (409 chat_busy). */
export async function DELETE(request: Request, context: Context) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const chatId = safeId((await context.params).chatId);
  if (!chatId) return Response.json({ ok: false, error: "chat_not_found" }, { status: 404 });
  return relayJson(request, gate.session, { method: "DELETE", path: `/chats/${chatId}` });
}

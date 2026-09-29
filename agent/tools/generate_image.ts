import { defineTool } from "eve/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission } from "../lib/permission.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { toolRouterIds } from "../lib/router-identity.ts";
import { appendAgentEvent, releaseSend, reserveSend } from "../../shared/agent-store.ts";
import { writeImage } from "../../shared/images-store.ts";
import { saveImage } from "../../shared/media-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { ROUTER_HOST, ROUTER_PORT } from "../../shared/policy.ts";

/** Image models answer slowly; two and a half minutes is the tool's ceiling. */
const GENERATE_TIMEOUT_MS = 150_000;

export default defineTool({
  description:
    "Draw an image from a text prompt with the owner's image model and place it in this chat. Use it when the owner asks for a picture, illustration, icon or render. It only works when an image-capable provider (an OpenAI, xAI, Z.ai or OpenRouter API key) is connected in Settings; when it is not, say so instead of retrying. It uses the owner's default image model; pass `model` (an image model id from list_models, with its `connectionId` when two providers offer the same id) only when the owner asks for a model or the job clearly needs a different one, since some models cost far more per image. The drawing lands in the transcript by itself and is saved in the owner's Library, the Useful Bot folder in Documents (the result gives its path): answer in text and do not link or embed the file. The Library is where it belongs. Do not copy, move or save it anywhere else (Desktop, Downloads, a project folder) unless the owner asks for a copy there, for this image or as a standing preference; an attached folder, full access or an earlier file saved elsewhere is not such a request. When the owner does name a place, copy the Library file there and keep the Library one.",
  inputSchema: z.object({
    prompt: z.string().min(1).max(4000),
    size: z.enum(["square", "wide", "tall"]).optional(),
    model: z.string().min(1).max(200).optional(),
    connectionId: z.string().min(1).max(200).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    // An image costs real money at the provider and lands in the transcript,
    // so Read only refuses it like every other change inside the app.
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    if (input.connectionId && !input.model) {
      return { status: "failed", error: "connection_without_model", hint: "Pass the image model id as `model` with its connectionId, or neither for the default." };
    }
    const token = process.env.UB_ROUTER_DESKTOP_TOKEN;
    if (!token) {
      throw new Error("router token missing");
    }
    const ids = toolRouterIds(ctx);
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("image", requestId)) {
      return { status: "duplicate", error: "that requestId was already sent", requestId };
    }
    let res: Response;
    try {
      res = await fetch(`http://${ROUTER_HOST}:${ROUTER_PORT}/v1/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(ids
            ? { "x-useful-session-id": ids.sessionId, "x-useful-request-id": randomUUID() }
            : { "x-useful-session-id": randomUUID(), "x-useful-request-id": randomUUID() }),
        },
        body: JSON.stringify({
          model: "image",
          prompt: input.prompt,
          size: input.size,
          ...(input.model ? { image_model: input.model } : {}),
          ...(input.model && input.connectionId ? { image_connection: input.connectionId } : {}),
        }),
        signal: AbortSignal.any([AbortSignal.timeout(GENERATE_TIMEOUT_MS), ...(ctx?.abortSignal ? [ctx.abortSignal] : [])]),
      });
    } catch (err) {
      if (requestId) releaseSend("image", requestId);
      throw err;
    }
    if (!res.ok) {
      if (requestId) releaseSend("image", requestId);
      const body = await res.json().catch(() => null) as { error?: { code?: unknown; retryable?: unknown } } | null;
      const code = typeof body?.error?.code === "string" ? body.error.code : `http_${res.status}`;
      if (code === "image_model_unknown" || code === "image_model_ambiguous") {
        return {
          status: "failed",
          error: code,
          hint: code === "image_model_ambiguous"
            ? "Two providers offer that model id. Pass the connectionId from list_models too."
            : "That is not one of the owner's image models. Call list_models with kind image for the exact ids, or leave model out to use the default.",
        };
      }
      if (code === "provider_incompatible" || code === "upstream_credential_missing" || code === "provider_disconnected") {
        return {
          status: "unavailable",
          error: "No image-capable provider is connected. The owner can add an OpenAI, xAI, Z.ai or OpenRouter API key in Settings, or pick an image model there.",
        };
      }
      return { status: "failed", error: code };
    }
    const json = await res.json().catch(() => null) as {
      data?: Array<{ b64_json?: unknown; mime?: unknown }>;
      model?: unknown;
      provider?: unknown;
    } | null;
    const item = Array.isArray(json?.data)
      ? json.data.find((row) => typeof row?.b64_json === "string" && row.b64_json.length > 0)
      : undefined;
    if (!item || typeof item.b64_json !== "string") {
      if (requestId) releaseSend("image", requestId);
      return { status: "failed", error: "empty_image" };
    }
    const imageId = `img${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    // Everything from here runs after the provider billed. Each failure ends
    // in a plain, final answer the bot relays, never a thrown error it would
    // retry (and pay for again).
    let botId = "";
    let botName = "Useful Bot";
    try {
      const shell = readShell();
      botId = activeBotId(shell, ctx);
      botName = shell.bots.find((bot) => bot.id === botId)?.name ?? botName;
    } catch (err) {
      console.error(`[media] could not read the roster for image ${imageId}`, err);
    }
    const mime = typeof item.mime === "string" ? item.mime : "image/png";
    const provider = typeof json?.provider === "string" ? json.provider : "";
    const model = typeof json?.model === "string" ? json.model : "";
    // The provider has billed by now, so the bytes must land somewhere. The
    // media folder first; if it cannot take them (no Documents access, a
    // locked or unreadable index, a full disk) the app's own store keeps
    // them, and they move into the folder on the next Library load.
    let savedPath: string | undefined;
    try {
      savedPath = saveImage({
        id: imageId,
        mime,
        bytes: Buffer.from(item.b64_json, "base64"),
        prompt: input.prompt,
        provider,
        model,
        botId,
        botName,
      }).path;
    } catch (err) {
      console.error(`[media] could not save image ${imageId} to the media folder`, err);
      try {
        writeImage({ id: imageId, mime, b64: item.b64_json, prompt: input.prompt, provider, model });
      } catch (fallbackErr) {
        console.error(`[media] could not keep image ${imageId} at all`, fallbackErr);
        if (requestId) releaseSend("image", requestId);
        return {
          status: "failed",
          error: "image_not_saved",
          hint: "The image was generated and billed but could not be saved on this Mac. Tell the owner why (disk full or no access to Documents) and do not retry until they fix it.",
        };
      }
    }
    let shown = Boolean(botId);
    if (shown) {
      try {
        appendAgentEvent(botId, {
          kind: "image",
          text: input.prompt,
          imageId,
          id: `img_${imageId}`,
        });
      } catch (err) {
        console.error(`[media] could not add image ${imageId} to the chat`, err);
        shown = false;
      }
    }
    const where = savedPath
      ? `Saved in the Library as ${savedPath}. Leave it there: copy it somewhere else only if the owner asked for that place.`
      : "Kept in the app's own store for now; it moves into the Useful Bot folder in Documents on the next Library load, so there is no file path to copy yet.";
    return {
      status: "generated",
      imageId,
      ...(savedPath ? { path: savedPath } : {}),
      model: model || undefined,
      note: shown
        ? `The image is in the chat now. ${where} Describe it in words if that helps, but the owner already sees it.`
        : `The image was generated and kept, but it could not be added to this chat. ${where} Tell the owner it is in the Library; do not generate it again.`,
    };
  },
});

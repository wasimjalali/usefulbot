import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { migrateLegacyImagesThrottled } from "../../../../../lib/media-migrate";
import { readImage } from "../../../../../../shared/images-store.ts";
import { readMediaBytes, sniffImage } from "../../../../../../shared/media-store.ts";

export const runtime = "nodejs";

function answer(bytes: Buffer, mime: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": mime,
      // Not immutable: a relinked file answers under the same id.
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      // Defence in depth: whatever these bytes are, nothing in them runs.
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": "inline; filename=\"image\"",
    },
  });
}

/**
 * One generated image's bytes, owner only. The transcript row names the id.
 * A 404 says why in its body: "moved" when the index names a file that is no
 * longer at its path (the row offers Locate and Regenerate), "missing" when
 * nothing does (Regenerate). A file that is there but unreadable, or not an
 * image, is a 500: Locate could not fix it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const { id } = await context.params;
  let found = readMediaBytes(id);
  if (found.status === "missing") {
    try {
      if (migrateLegacyImagesThrottled().moved > 0) found = readMediaBytes(id);
    } catch (err) {
      console.error("[media] legacy migration failed", err);
    }
  }
  if (found.status === "missing" || found.status === "moved") {
    // Still in the app's own store (the folder could not take it yet, or a
    // Regenerate could not write its file there).
    // Checked like the media path: the bytes must be an image, and the type
    // served is what they are, not what the record says.
    const legacy = readImage(id);
    if (legacy) {
      const bytes = Buffer.from(legacy.b64, "base64");
      const mime = sniffImage(bytes);
      if (!mime) {
        console.error(`[media] legacy image ${id} is not an image`);
        return new Response("error", { status: 500, headers: { "cache-control": "no-store" } });
      }
      return answer(bytes, mime);
    }
  }
  if (found.status === "ok" && found.item.kind === "image") return answer(found.bytes, found.mime);
  if (found.status === "error") {
    console.error(`[media] image ${id} unreadable: ${found.code}`);
    return new Response("error", { status: 500, headers: { "cache-control": "no-store" } });
  }
  const reason = found.status === "moved" ? "moved" : "missing";
  return new Response(reason, { status: 404, headers: { "cache-control": "no-store" } });
}

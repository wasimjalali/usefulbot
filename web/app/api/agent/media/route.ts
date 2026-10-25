import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { errorCode } from "../../../../lib/api-guard";
import { findMedia, listMedia, mediaRoot, readMediaBytes, type MediaKind } from "../../../../../shared/media-store.ts";
import { legacyImageIds } from "../../../../../shared/images-store.ts";
import { drainHeldImages } from "../../../../lib/held-images";

export const runtime = "nodejs";

/** The Library: every saved image, drawing and page, newest first, owner only. */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind: MediaKind | undefined = kindParam === "image" || kindParam === "drawing" || kindParam === "page" ? kindParam : undefined;
  try {
    // Images the folder refused earlier move in now if it takes them.
    drainHeldImages();
    const items = listMedia({
      kind,
      botId: url.searchParams.get("botId") ?? undefined,
      query: url.searchParams.get("q")?.slice(0, 200) ?? undefined,
    });
    // Images the folder has not taken yet (it refused them): the Library says
    // how many, rather than leaving them out without a word.
    // Only records still on their way in: one held behind a removed or
    // unreadable entry stays put by design and is not a backlog.
    const held = legacyImageIds().filter((id) => {
      const entry = findMedia(id);
      return !entry || (!entry.forgotten && readMediaBytes(id).status === "moved");
    }).length;
    return NextResponse.json({ ok: true, root: mediaRoot(), items, held }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[media] Library list failed", err);
    return NextResponse.json({ ok: false, error: errorCode(err, "media_list_failed") }, { status: 500 });
  }
}

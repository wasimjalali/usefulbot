import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../lib/desktop-gate";
import { errorCode } from "../../../../lib/api-guard";
import { migrateDrawings, migrateLegacyImages } from "../../../../lib/media-migrate";
import { findMedia, listMedia, mediaRoot, readMediaBytes, type MediaKind } from "../../../../../shared/media-store.ts";
import { legacyImageIds } from "../../../../../shared/images-store.ts";

export const runtime = "nodejs";

/** The Library: every saved image, drawing and page, newest first, owner only. */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  // Catch up anything not in the folder yet. A failure here is logged and the
  // Library still lists what it has; the next load tries again.
  try {
    migrateLegacyImages();
    migrateDrawings();
  } catch (err) {
    console.error("[media] catch-up failed", err);
  }
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind: MediaKind | undefined = kindParam === "image" || kindParam === "drawing" || kindParam === "page" ? kindParam : undefined;
  try {
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

import { deleteImage, legacyImageIds, readImage } from "../../shared/images-store.ts";
import { findMedia, readMediaBytes, saveImage, sniffImage } from "../../shared/media-store.ts";
import { peekShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";

/**
 * Images the media folder refused when they were made (no Documents access, a
 * full disk) wait in the app's own store; `generate_image` and Regenerate put
 * them there so a billed image is never lost. The Library load moves them into
 * the folder once it takes them, keeping their ids so the chat rows still load.
 * A record goes only once its file and index entry exist; one that fails stays
 * and the next load tries again.
 */
const RETRY_MS = 60 * 1000;
let lastRun = 0;

export function drainHeldImages(now = Date.now()): { moved: number; failed: number } {
  if (now - lastRun < RETRY_MS) return { moved: 0, failed: 0 };
  lastRun = now;
  const ids = legacyImageIds();
  if (ids.length === 0) return { moved: 0, failed: 0 };
  const botName = peekShell()?.bots.find((bot) => bot.id === DEFAULT_BOT_ID)?.name ?? "Useful Bot";
  let moved = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      // An entry the owner removed, or whose file is there but unreadable,
      // keeps its record untouched: a Remove is not undone behind their back,
      // and the record may be the only readable copy.
      const entry = findMedia(id);
      const status = entry ? readMediaBytes(id).status : "missing";
      if (entry && (entry.forgotten || status === "error")) continue;
      const lost = entry !== null && status === "moved";
      if (!entry || lost) {
        const record = readImage(id);
        if (!record) continue;
        const bytes = Buffer.from(record.b64, "base64");
        // Bytes that are not an image would be saved and read as moved on
        // every load; they stay a failure instead of a new file each time.
        if (!sniffImage(bytes)) {
          failed += 1;
          continue;
        }
        saveImage({
          id,
          mime: record.mime,
          bytes,
          prompt: record.prompt,
          model: record.model,
          provider: record.provider,
          botId: entry?.botId ?? DEFAULT_BOT_ID,
          botName: entry?.botName ?? botName,
          chatId: entry?.chatId ?? null,
          createdAt: Number.isNaN(Date.parse(record.createdAt)) ? undefined : new Date(record.createdAt),
          replace: lost,
        });
        // A replacement the index turned down leaves the record as the copy.
        if (lost && readMediaBytes(id).status !== "ok") continue;
      }
      deleteImage(id);
      moved += 1;
    } catch (err) {
      failed += 1;
      console.error(`[media] could not move held image ${id} into the folder`, err);
    }
  }
  return { moved, failed };
}

/** Tests only: forget the throttle. */
export function resetHeldImagesClock(): void {
  lastRun = 0;
}

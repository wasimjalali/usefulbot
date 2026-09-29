import { readAgentStore } from "../../shared/agent-store.ts";
import { deleteImage, legacyImageIds, readImage } from "../../shared/images-store.ts";
import { findMedia, readMediaBytes, readMediaIndex, saveDrawing, saveImage, sniffImage } from "../../shared/media-store.ts";
import { peekShell } from "../../shared/shell-io.ts";
import { readWidget, type WidgetRecord } from "../../shared/widgets-store.ts";

/** Only Excalidraw scenes are drawings; another MCP app's `elements` argument is not. */
export function isExcalidrawWidget(record: Pick<WidgetRecord, "connectionId" | "toolName" | "arguments">): boolean {
  return (record.connectionId === "excalidraw" || record.toolName.startsWith("excalidraw__"))
    && "elements" in record.arguments;
}

/** The first label or text in the scene names the file; "Drawing" otherwise. */
export function drawingTitle(elements: unknown): string {
  let list = elements;
  if (typeof list === "string") {
    try { list = JSON.parse(list) as unknown; } catch { return "Drawing"; }
  }
  if (!Array.isArray(list)) return "Drawing";
  for (const el of list) {
    const rec = el && typeof el === "object" ? el as { text?: unknown; label?: { text?: unknown } } : {};
    const text = typeof rec.text === "string" ? rec.text : typeof rec.label?.text === "string" ? rec.label.text : "";
    if (text.trim()) return `Drawing - ${text.trim()}`;
  }
  return "Drawing";
}

/** Save one Excalidraw widget to the media folder, dated when it was first drawn. */
export function saveWidgetDrawing(record: WidgetRecord, botId: string, botName: string, drawnAt?: string): void {
  if (!isExcalidrawWidget(record)) return;
  const when = drawnAt && !Number.isNaN(Date.parse(drawnAt)) ? new Date(drawnAt) : undefined;
  saveDrawing({
    id: record.id,
    elements: record.arguments.elements,
    title: drawingTitle(record.arguments.elements),
    files: record.arguments.files,
    botId,
    botName,
    provider: record.connectionId,
    createdAt: when,
  });
}

/**
 * Every Excalidraw drawing still in a chat gets its file, dated by the event
 * that first showed it. Drawings made before the Library existed, and any
 * whose save failed when they were drawn, land here on the next load.
 */
/** Widget ids already looked at and found not to be drawings (charts and other apps). */
const notDrawings = new Set<string>();

export function migrateDrawings(): { saved: number; failed: number } {
  const known = new Set([...readMediaIndex().map((item) => item.id), ...notDrawings]);
  const bots = peekShell()?.bots ?? [];
  let saved = 0;
  let failed = 0;
  for (const thread of readAgentStore().threads) {
    for (const event of thread.events) {
      if (!event.widgetId || known.has(event.widgetId)) continue;
      known.add(event.widgetId);
      try {
        const record = readWidget(event.widgetId);
        if (!record) continue;
        if (!isExcalidrawWidget(record)) {
          notDrawings.add(event.widgetId);
          continue;
        }
        saveWidgetDrawing(record, thread.botId, bots.find((bot) => bot.id === thread.botId)?.name ?? "Useful Bot", event.at);
        saved += 1;
      } catch (err) {
        failed += 1;
        console.error(`[media] could not save drawing ${event.widgetId}`, err);
      }
    }
  }
  return { saved, failed };
}

/**
 * Move the images stored as base64 records in ~/.useful-bot/images into the
 * media folder as real files, keeping their ids so the chat rows still load.
 * The old record is removed only once its file and index entry exist. A
 * record that fails stays where it is and the next call tries again.
 */
const LEGACY_OWNER_WAIT_MS = 2 * 60 * 1000;
const LEGACY_RETRY_MS = 60 * 1000;
let lastLegacyRun = 0;

/**
 * The image route runs the migration when an id is missing. It moves every
 * record in one pass, so a burst of missing rows (or a folder that keeps
 * refusing) would repeat it per request: once a minute is enough.
 */
export function migrateLegacyImagesThrottled(): { moved: number; failed: number } {
  if (Date.now() - lastLegacyRun < LEGACY_RETRY_MS) return { moved: 0, failed: 0 };
  lastLegacyRun = Date.now();
  return migrateLegacyImages();
}

export function migrateLegacyImages(): { moved: number; failed: number } {
  const ids = legacyImageIds();
  if (ids.length === 0) return { moved: 0, failed: 0 };
  const owners = new Map<string, string>();
  for (const thread of readAgentStore().threads) {
    for (const event of thread.events) {
      if (event.imageId) owners.set(event.imageId, thread.botId);
    }
  }
  const bots = peekShell()?.bots ?? [];
  let moved = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      // An entry whose file is gone takes the record's bytes in its place:
      // that is a Regenerate the folder could not take at the time. One the
      // owner removed, or whose file is there but unreadable, keeps its
      // record untouched: a Remove is not undone behind their back, and the
      // record may be the only readable copy.
      const entry = findMedia(id);
      const status = entry ? readMediaBytes(id).status : "missing";
      if (entry && (entry.forgotten || status === "error")) continue;
      const lost = entry !== null && status === "moved";
      if (entry && !lost && readImage(id)) {
        console.error(`[media] dropping the app-store copy of image ${id}: the folder already serves its file`);
      }
      if (!entry || lost) {
        const record = readImage(id);
        if (!record) continue;
        // Bytes that are not an image would be saved and read as moved on
        // every load; they stay a failure instead of a new file each time.
        if (!sniffImage(Buffer.from(record.b64, "base64"))) {
          failed += 1;
          continue;
        }
        // A fallback record is written just before its chat event. One with
        // no event yet waits a little, so it is filed under its bot rather
        // than under no bot for good. An entry already names its bot.
        if (!entry && !owners.has(id) && Date.now() - Date.parse(record.createdAt) < LEGACY_OWNER_WAIT_MS) continue;
        const botId = entry?.botId ?? owners.get(id) ?? "";
        saveImage({
          id,
          mime: record.mime,
          bytes: Buffer.from(record.b64, "base64"),
          prompt: record.prompt,
          model: record.model,
          provider: record.provider,
          botId,
          botName: bots.find((bot) => bot.id === botId)?.name ?? entry?.botName ?? "Useful Bot",
          createdAt: Number.isNaN(Date.parse(record.createdAt)) ? undefined : new Date(record.createdAt),
          replace: lost,
        });
        // The record goes only once the folder serves the image: a
        // replacement the index turned down leaves the record as the copy.
        if (lost && readMediaBytes(id).status !== "ok") continue;
      }
      deleteImage(id);
      moved += 1;
    } catch (err) {
      failed += 1;
      console.error(`[media] could not migrate image ${id}`, err);
    }
  }
  return { moved, failed };
}

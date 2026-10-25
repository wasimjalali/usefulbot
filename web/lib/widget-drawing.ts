import { saveDrawing } from "../../shared/media-store.ts";
import type { WidgetRecord } from "../../shared/widgets-store.ts";

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
    chatId: record.chatId ?? null,
    createdAt: when,
  });
}

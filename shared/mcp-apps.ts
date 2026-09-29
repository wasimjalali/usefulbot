/**
 * Pull an MCP App widget out of an eve action event. Excalidraw's
 * create_view carries `_meta.ui.resourceUri` on the tool and `elements` in
 * the input. We persist the arguments; the host page fetches the HTML.
 */

export type WidgetDraft = {
  connectionId: string;
  toolName: string;
  resourceUri: string | null;
  arguments: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function qualifiedName(data: Record<string, unknown> | undefined): string {
  const name = data?.toolName ?? data?.name ?? data?.tool;
  return typeof name === "string" ? name : "";
}

function connectionIdOf(toolName: string): string | null {
  const cut = toolName.indexOf("__");
  if (cut <= 0) return null;
  const id = toolName.slice(0, cut);
  return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

function argumentsOf(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const direct = asRecord(data?.arguments) ?? asRecord(data?.input) ?? asRecord(data?.args);
  if (direct) return direct;
  if (typeof data?.arguments === "string") {
    try {
      const parsed = JSON.parse(data.arguments);
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

function resourceUriOf(data: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
  const meta = asRecord(data?._meta);
  const ui = asRecord(meta?.ui) ?? asRecord(data?.ui);
  if (typeof ui?.resourceUri === "string" && ui.resourceUri.startsWith("ui://")) return ui.resourceUri;
  if (typeof meta?.["ui/resourceUri"] === "string" && meta["ui/resourceUri"].startsWith("ui://")) {
    return meta["ui/resourceUri"];
  }
  if (typeof args.elements === "string") return "ui://excalidraw/mcp-app.html";
  return null;
}

export const WIDGET_JSON_MAX = 200_000;
export const WIDGETS_PER_THREAD_MAX = 40;

export function widgetPayloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return WIDGET_JSON_MAX + 1;
  }
}

export function widgetPayloadTooLarge(args: Record<string, unknown>, result: unknown): boolean {
  if (widgetPayloadBytes(args) > WIDGET_JSON_MAX) return true;
  if (widgetPayloadBytes(result) > WIDGET_JSON_MAX) return true;
  const elements = args.elements;
  return typeof elements === "string" && elements.length > WIDGET_JSON_MAX;
}

export function parseWidgetDraft(data: unknown): WidgetDraft | null {
  const rec = asRecord(data);
  if (!rec) return null;
  const nested = asRecord(rec.result) ?? asRecord(rec.data) ?? rec;
  const toolName = qualifiedName(nested) || qualifiedName(rec);
  const connectionId = connectionIdOf(toolName);
  if (!connectionId) return null;
  const args = argumentsOf(nested) ?? argumentsOf(rec);
  const resourceUri = resourceUriOf(nested, args) ?? resourceUriOf(rec, args);
  const looksLikeApp = Boolean(resourceUri) || toolName.endsWith("__create_view") || typeof args.elements === "string";
  if (!looksLikeApp) return null;
  return { connectionId, toolName, resourceUri, arguments: args };
}

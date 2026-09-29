import { findConnectionById } from "./connections-store.ts";
import { readMcpResource } from "./mcp-http.ts";
import type { WidgetRecord } from "./widgets-store.ts";

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const ESM = "https://esm.sh";
const CSP_ORIGIN = /^https:\/\/[a-z0-9.-]+$/i;
const MAX_CSP_DOMAINS = 8;

function cspExtra(domains: string[]): string {
  const extra = domains
    .filter((d) => CSP_ORIGIN.test(d) && d.toLowerCase() !== ESM)
    .slice(0, MAX_CSP_DOMAINS);
  return [ESM, ...extra].join(" ");
}

function cspFor(domains: string[]): string {
  const extra = cspExtra(domains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${extra}`,
    `style-src 'unsafe-inline' ${extra}`,
    `img-src data: blob: ${extra}`,
    `font-src data: ${extra}`,
    `connect-src ${extra}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Host page for an MCP App. The widget HTML is srcdoc'd into a sandboxed
 * iframe. The page answers ui/initialize and pushes the stored tool input.
 * Links, full screen and the app's own tool calls go to the native side
 * through the `ubHost` handler, which checks each one again: the handler is
 * visible to the app frame too.
 *
 * A srcdoc frame inherits this page's policy on top of its own, so the host
 * carries the same allowlist as the app. With a stricter host policy every
 * script the app loads is blocked and the card stays blank. The host itself
 * loads nothing: its one script is inline.
 */
function withCsp(html: string, domains: string[]): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(domains)}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `${meta}${html}`;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * An Excalidraw scene whose last camera does not cover its shapes gets that
 * camera widened to fit them, keeping Excalidraw's 4:3 camera shape. Bots
 * pick the camera by hand and often draw past its edge (a 400-wide camera
 * over a box ending at 430), and the live view then cuts the drawing in the
 * chat and in the Library alike. A camera that already covers the scene, or
 * a scene with no camera, is left exactly as the bot drew it.
 */
export function fitExcalidrawCamera(args: Record<string, unknown>): Record<string, unknown> {
  const raw = args.elements;
  let list: unknown;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  } catch {
    return args;
  }
  if (!Array.isArray(list)) return args;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let box: Box | null = null;
  const grow = (x: number, y: number) => {
    box = box
      ? { minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) }
      : { minX: x, minY: y, maxX: x, maxY: y };
  };
  // A scene built on a checkpoint or with deletions is not fully in this
  // list, so its bounds here are not the drawing on screen: leave it be.
  if (list.some((el) => el && typeof el === "object" && ["restoreCheckpoint", "delete"].includes(String((el as Record<string, unknown>).type)))) {
    return args;
  }
  let cameraIndex = -1;
  list.forEach((el, index) => {
    if (!el || typeof el !== "object") return;
    const rec = el as Record<string, unknown>;
    if (rec.type === "cameraUpdate") { cameraIndex = index; return; }
    if (rec.isDeleted === true) return;
    const x = num(rec.x);
    const y = num(rec.y);
    if (x === null || y === null) return;
    const points = Array.isArray(rec.points) ? rec.points : null;
    if (points && points.length > 0) {
      for (const point of points) {
        if (Array.isArray(point) && num(point[0]) !== null && num(point[1]) !== null) grow(x + point[0], y + point[1]);
      }
    } else {
      // Text often carries no size: estimate it from the string and font.
      const fontSize = num(rec.fontSize) ?? 20;
      const text = typeof rec.text === "string" ? rec.text : "";
      const lines = text.split("\n");
      const estWidth = Math.max(...lines.map((line) => line.length)) * fontSize * 0.55;
      const estHeight = lines.length * fontSize * 1.25;
      grow(x, y);
      grow(x + (num(rec.width) ?? (text ? estWidth : 0)), y + (num(rec.height) ?? (text ? estHeight : 0)));
    }
  });
  const bounds = box as Box | null;
  if (cameraIndex < 0 || !bounds) return args;
  const camera = list[cameraIndex] as Record<string, unknown>;
  const cx = num(camera.x) ?? 0;
  const cy = num(camera.y) ?? 0;
  const cw = num(camera.width) ?? 0;
  const ch = num(camera.height) ?? 0;
  if (cw > 0 && ch > 0 && bounds.minX >= cx && bounds.minY >= cy && bounds.maxX <= cx + cw && bounds.maxY <= cy + ch) return args;
  const pad = 40;
  let width = Math.max(cw, bounds.maxX - bounds.minX + pad * 2);
  let height = Math.max(ch, bounds.maxY - bounds.minY + pad * 2);
  if (width / height > 4 / 3) height = width * 3 / 4;
  else width = height * 4 / 3;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const fitted = [...list];
  fitted[cameraIndex] = {
    ...camera,
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
  return { ...args, elements: typeof raw === "string" ? JSON.stringify(fitted) : fitted };
}

export function renderWidgetHost(record: WidgetRecord, appHtml: string, cspDomains: string[], degraded = false): string {
  const excalidraw = record.connectionId === "excalidraw" || record.toolName.startsWith("excalidraw__");
  const payload = jsonScript({
    id: record.id,
    toolName: record.toolName,
    arguments: excalidraw ? fitExcalidrawCamera(record.arguments) : record.arguments,
    result: record.result,
    degraded,
  });
  const framed = withCsp(appHtml, cspDomains);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(cspDomains)}">
<style>
  html, body { margin: 0; background: #fff; overflow: hidden; }
  iframe { display: block; width: 100%; height: 480px; border: 0; background: #fff; }
</style>
</head>
<body>
<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
const payload = ${payload};
const iframe = document.getElementById("app");
iframe.srcdoc = ${jsonScript(framed)};
const host = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ubHost;
// The app itself could not be served (connection gone, resource fetch
// failed): tell the native side, so the row collapses to its compact
// unavailable state instead of holding a 480px blank.
if (payload.degraded && host) host.postMessage({ kind: "status", status: "unavailable" });
let displayMode = "inline";
let inlineHeight = 480;
// Bumped whenever the native side changes the mode on its own, so a reply
// to an older request cannot undo it.
let modeEpoch = 0;
const resends = [];
function stopResends() {
  while (resends.length) clearTimeout(resends.pop());
}
function send(msg) {
  iframe.contentWindow && iframe.contentWindow.postMessage(msg, "*");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id: id, result: result });
}
function fail(id, message, code) {
  send({ jsonrpc: "2.0", id: id, error: { code: code || -32000, message: String(message).slice(0, 200) } });
}
function containerHeight() {
  return displayMode === "fullscreen" ? window.innerHeight : inlineHeight;
}
function pushInput() {
  send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: payload.arguments || {} } });
  if (payload.result) {
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: payload.result });
  }
}
function applyMode(mode) {
  displayMode = mode === "fullscreen" ? "fullscreen" : "inline";
  iframe.style.height = containerHeight() + "px";
}
function contextChanged() {
  send({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: displayMode, containerDimensions: { height: containerHeight() } }
  });
}
// The app asks; the native side decides. It answers { mode } with the mode it
// actually set, and calls this when the reader leaves full screen without
// asking the app (Escape on the overlay, the chat switching away).
window.ubHostContext = function (ctx) {
  modeEpoch++;
  stopResends();
  if (ctx && ctx.displayMode) applyMode(ctx.displayMode);
  contextChanged();
};
window.addEventListener("resize", () => {
  if (displayMode !== "fullscreen") return;
  applyMode("fullscreen");
  contextChanged();
});
window.addEventListener("message", (event) => {
  if (event.source !== iframe.contentWindow) return;
  const data = event.data;
  if (!data || data.jsonrpc !== "2.0" || typeof data.method !== "string") return;
  const params = data.params || {};
  if (data.method === "ui/initialize") {
    reply(data.id, {
      protocolVersion: "2026-01-26",
      hostCapabilities: host ? { openLinks: {}, serverTools: {} } : {},
      hostInfo: { name: "useful-bot", version: "0.0.0" },
      hostContext: {
        theme: "light",
        displayMode: displayMode,
        availableDisplayModes: host ? ["inline", "fullscreen"] : ["inline"],
        platform: "desktop",
        containerDimensions: { width: 720, height: containerHeight() },
        toolInfo: { tool: { name: payload.toolName, inputSchema: { type: "object" } } }
      }
    });
    return;
  }
  if (data.method === "ui/notifications/initialized") {
    pushInput();
    // An app may attach its input handler a moment after it says it is
    // ready (Excalidraw does, in a React effect), and a notification sent
    // before that is dropped for good: the card stays blank. The app does
    // not say when it is listening, so send again over the first seconds,
    // and stop as soon as the reader acts in it: a repeat must not land on
    // top of an edit.
    for (const delay of [250, 750, 1500, 3000]) resends.push(setTimeout(pushInput, delay));
    return;
  }
  if (data.method === "ui/notifications/size-changed" && params.height) {
    inlineHeight = Math.max(240, Math.min(720, Number(params.height) || 480));
    if (displayMode === "inline") iframe.style.height = inlineHeight + "px";
    return;
  }
  if (data.id === undefined || data.id === null) return;
  const id = data.id;
  stopResends();
  if (data.method === "ui/update-model-context") {
    reply(id, {});
    return;
  }
  if (!host) {
    fail(id, "Method not found", -32601);
    return;
  }
  if (data.method === "tools/call") {
    host.postMessage({ kind: "tool", name: String(params.name || ""), arguments: params.arguments || {} })
      .then((result) => reply(id, result), (err) => fail(id, err && err.message || err));
    return;
  }
  if (data.method === "ui/open-link") {
    host.postMessage({ kind: "link", url: String(params.url || "") })
      .then(() => reply(id, {}), (err) => fail(id, err && err.message || err));
    return;
  }
  if (data.method === "ui/request-display-mode") {
    const epoch = modeEpoch;
    host.postMessage({ kind: "mode", mode: params.mode === "fullscreen" ? "fullscreen" : "inline" })
      .then((result) => {
        if (epoch === modeEpoch) applyMode(result && result.mode);
        reply(id, { mode: displayMode });
      }, (err) => fail(id, err && err.message || err));
    return;
  }
  fail(id, "Method not found", -32601);
});
</script>
</body>
</html>`;
}

/**
 * The app page an MCP server serves for its widgets (Excalidraw's editor) is
 * the same for every drawing, and reading it costs two round trips to the
 * server. It is kept ten minutes per server and resource, and opens that land
 * while a read is running share it, so a chat full of drawings or a Library
 * detail opens without waiting on the network each time. A failed read is
 * not kept.
 */
const APP_PAGE_TTL_MS = 10 * 60 * 1000;
const APP_PAGE_KEY = Symbol.for("useful-bot.mcp-app-pages");
// On globalThis: the dev server gives each route its own copy of this module.
const appPages: Map<string, { at: number; read: Promise<Awaited<ReturnType<typeof readMcpResource>>> }> =
  ((globalThis as Record<symbol, unknown>)[APP_PAGE_KEY] ??= new Map()) as Map<string, { at: number; read: Promise<Awaited<ReturnType<typeof readMcpResource>>> }>;

function appPage(url: string, uri: string): Promise<Awaited<ReturnType<typeof readMcpResource>>> {
  const key = `${url}\n${uri}`;
  const hit = appPages.get(key);
  if (hit && Date.now() - hit.at < APP_PAGE_TTL_MS) return hit.read;
  const read = readMcpResource(url, uri);
  appPages.set(key, { at: Date.now(), read });
  read.catch(() => {
    if (appPages.get(key)?.read === read) appPages.delete(key);
  });
  return read;
}

export async function htmlForWidget(record: WidgetRecord): Promise<{ html: string; mimeType: string }> {
  const entry = findConnectionById(record.connectionId);
  const resourceUri = record.resourceUri ?? "ui://excalidraw/mcp-app.html";
  if (!entry || entry.kind !== "mcp") {
    return { html: renderWidgetHost(record, emptyCanvas(record), [], true), mimeType: "text/html; charset=utf-8" };
  }
  try {
    const resource = await appPage(entry.url, resourceUri);
    const domains = [
      ...(resource.csp?.resourceDomains ?? []),
      ...(resource.csp?.connectDomains ?? []),
    ];
    return {
      html: renderWidgetHost(record, resource.text, domains),
      mimeType: "text/html; charset=utf-8",
    };
  } catch {
    return { html: renderWidgetHost(record, emptyCanvas(record), [], true), mimeType: "text/html; charset=utf-8" };
  }
}

function emptyCanvas(_record: WidgetRecord): string {
  return `<!doctype html><html><body style="margin:0;font:13px/1.4 sans-serif;color:#171717;padding:16px">Drawing</body></html>`;
}

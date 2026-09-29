import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseWidgetDraft, widgetPayloadTooLarge, WIDGET_JSON_MAX } from "../shared/mcp-apps.ts";
import { renderWidgetHost } from "../shared/mcp-app-host.ts";
import type { WidgetRecord } from "../shared/widgets-store.ts";

test("create_view input becomes a widget draft", () => {
  const draft = parseWidgetDraft({
    toolName: "excalidraw__create_view",
    arguments: { elements: "[{\"type\":\"rectangle\",\"id\":\"r1\"}]" },
  });
  assert.equal(draft?.connectionId, "excalidraw");
  assert.equal(draft?.resourceUri, "ui://excalidraw/mcp-app.html");
  assert.equal(typeof draft?.arguments.elements, "string");
  assert.equal(parseWidgetDraft({ toolName: "bash", arguments: { command: "ls" } }), null);
});

test("the host page does not break out of the JSON script", () => {
  const record: WidgetRecord = {
    id: "callid1234",
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: { elements: "</script><script>alert(1)</script>" },
    result: null,
    createdAt: new Date().toISOString(),
  };
  const html = renderWidgetHost(record, "<html><body>app</body></html>", ["https://esm.sh"]);
  assert.equal(html.includes("</script><script>alert"), false);
  assert.equal(html.includes("\\u003c/script>"), true);
  assert.equal(html.includes("ui/notifications/tool-input"), true);
  assert.equal(html.includes("https://esm.sh"), true);
  assert.equal(html.includes('method.startsWith("ui/")'), false);
});

test("the host page pins esm.sh even when the app lists no CSP domains", () => {
  const record: WidgetRecord = {
    id: "callid5678",
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: {},
    result: null,
    createdAt: new Date().toISOString(),
  };
  const html = renderWidgetHost(record, "<html><body>app</body></html>", []);
  assert.equal(html.includes("https://esm.sh"), true);
  assert.equal(widgetPayloadTooLarge({ elements: "x" }, null), false);
  assert.equal(widgetPayloadTooLarge({ elements: "x".repeat(WIDGET_JSON_MAX + 1) }, null), true);
});

test("the host page carries the app allowlist, since a srcdoc frame inherits it", () => {
  const record: WidgetRecord = {
    id: "callid9012",
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: { elements: "[]" },
    result: null,
    createdAt: new Date().toISOString(),
  };
  const html = renderWidgetHost(record, "<html><head></head><body>app</body></html>", []);
  const hostPolicy = html.slice(0, html.indexOf("<style>"));
  assert.match(hostPolicy, /script-src 'unsafe-inline' 'unsafe-eval' https:\/\/esm\.sh/);
  assert.equal(hostPolicy.includes("connect-src 'none'"), false);
});

test("the handshake names the tool with an input schema, which the app validates", () => {
  const record: WidgetRecord = {
    id: "callid3456",
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: { elements: "[]" },
    result: null,
    createdAt: new Date().toISOString(),
  };
  const html = renderWidgetHost(record, "<html><body>app</body></html>", []);
  assert.match(html, /toolInfo: \{ tool: \{ name: payload\.toolName, inputSchema: \{ type: "object" \} \} \}/);
});

/** Run the host page's script against a fake window and app frame. */
function runHost(bridge: ((msg: Record<string, unknown>) => Promise<unknown>) | null, degraded = false) {
  const record: WidgetRecord = {
    id: "callid7777",
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: { elements: "[]" },
    result: null,
    createdAt: new Date().toISOString(),
  };
  const html = renderWidgetHost(record, "<html><body>app</body></html>", [], degraded);
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const toApp: Array<Record<string, any>> = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const frameWindow = { postMessage: (msg: Record<string, any>) => toApp.push(JSON.parse(JSON.stringify(msg))) };
  const iframe = { contentWindow: frameWindow, style: {} as Record<string, string>, srcdoc: "" };
  const window: Record<string, any> = {
    innerHeight: 900,
    addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; },
    webkit: bridge ? { messageHandlers: { ubHost: { postMessage: bridge } } } : undefined,
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((fn) => fn());
  };
  vm.runInNewContext(script, {
    window,
    document: { getElementById: () => iframe },
    Number,
    Math,
    String,
    setTimeout: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const fromApp = (data: Record<string, unknown>) => listeners.message({ source: frameWindow, data: { jsonrpc: "2.0", ...data } });
  return { toApp, fromApp, iframe, window, tick };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a degraded host tells the native side the widget is unavailable, a healthy one stays quiet", async () => {
  const degraded: Array<Record<string, unknown>> = [];
  runHost(async (msg) => { degraded.push(JSON.parse(JSON.stringify(msg))); return {}; }, true);
  assert.deepEqual(degraded, [{ kind: "status", status: "unavailable" }]);

  const healthy: Array<Record<string, unknown>> = [];
  runHost(async (msg) => { healthy.push(JSON.parse(JSON.stringify(msg))); return {}; });
  assert.deepEqual(healthy, []);
});

test("the host passes the app's tool call, link and full screen to the native side", async () => {
  const asked: Array<Record<string, unknown>> = [];
  const host = runHost(async (msg) => {
    asked.push(JSON.parse(JSON.stringify(msg)));
    if (msg.kind === "tool") return { content: [{ type: "text", text: "https://excalidraw.com/#json=x" }] };
    if (msg.kind === "mode") return { mode: msg.mode };
    return {};
  });
  host.fromApp({ id: 1, method: "ui/initialize", params: {} });
  const init = host.toApp[0].result;
  assert.deepEqual(init.hostCapabilities, { openLinks: {}, serverTools: {} });
  assert.deepEqual(init.hostContext.availableDisplayModes, ["inline", "fullscreen"]);

  host.fromApp({ id: 2, method: "tools/call", params: { name: "export_to_excalidraw", arguments: { json: "{}" } } });
  host.fromApp({ id: 3, method: "ui/open-link", params: { url: "https://excalidraw.com/#json=x" } });
  host.fromApp({ id: 4, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await settle();
  assert.deepEqual(asked, [
    { kind: "tool", name: "export_to_excalidraw", arguments: { json: "{}" } },
    { kind: "link", url: "https://excalidraw.com/#json=x" },
    { kind: "mode", mode: "fullscreen" },
  ]);
  const byId = (id: number) => host.toApp.find((msg) => msg.id === id);
  assert.equal(byId(2)?.result.content[0].text, "https://excalidraw.com/#json=x");
  assert.deepEqual(byId(3)?.result, {});
  assert.deepEqual(byId(4)?.result, { mode: "fullscreen" });
  assert.equal(host.iframe.style.height, "900px");

  // Leaving full screen from the native side tells the app.
  host.window.ubHostContext({ displayMode: "inline" });
  const changed = host.toApp.at(-1);
  assert.equal(changed?.method, "ui/notifications/host-context-changed");
  assert.equal(changed?.params.displayMode, "inline");
  assert.equal(host.iframe.style.height, "480px");
});

test("a refused request fails instead of hanging, and unknown ones get method-not-found", async () => {
  const host = runHost(async () => { throw new Error("link_refused"); });
  host.fromApp({ id: 5, method: "ui/open-link", params: { url: "file:///etc/passwd" } });
  host.fromApp({ id: 6, method: "ui/message", params: {} });
  host.fromApp({ id: 7, method: "ui/update-model-context", params: {} });
  await settle();
  const byId = (id: number) => host.toApp.find((msg) => msg.id === id);
  assert.equal(byId(5)?.error.message, "link_refused");
  assert.equal(byId(6)?.error.code, -32601);
  assert.deepEqual(byId(7)?.result, {});
});

test("without the native bridge the host offers no links or full screen", () => {
  const host = runHost(null);
  host.fromApp({ id: 1, method: "ui/initialize", params: {} });
  host.fromApp({ id: 2, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  assert.deepEqual(host.toApp[0].result.hostCapabilities, {});
  assert.deepEqual(host.toApp[0].result.hostContext.availableDisplayModes, ["inline"]);
  assert.equal(host.toApp[1].error.code, -32601);
});

test("the drawing is sent again over the first seconds, for an app that listens late", () => {
  const host = runHost(null);
  const inputs = () => host.toApp.filter((msg) => msg.method === "ui/notifications/tool-input").length;
  host.fromApp({ method: "ui/notifications/initialized" });
  assert.equal(inputs(), 1);
  host.tick();
  assert.equal(inputs(), 5);
  host.tick();
  assert.equal(inputs(), 5);
});

test("the resends stop once the reader acts in the drawing", async () => {
  const host = runHost(async () => ({ mode: "fullscreen" }));
  const inputs = () => host.toApp.filter((msg) => msg.method === "ui/notifications/tool-input").length;
  host.fromApp({ method: "ui/notifications/initialized" });
  host.fromApp({ id: 9, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  host.tick();
  assert.equal(inputs(), 1);
});

test("a full-screen reply that lands after the reader left full screen does not undo it", async () => {
  let answer: (value: unknown) => void = () => {};
  const host = runHost(() => new Promise((resolve) => { answer = resolve; }));
  host.fromApp({ id: 1, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  host.window.ubHostContext({ displayMode: "inline" });
  answer({ mode: "fullscreen" });
  await settle();
  assert.equal(host.iframe.style.height, "480px");
  assert.deepEqual(host.toApp.find((msg) => msg.id === 1)?.result, { mode: "inline" });
});

test("an Excalidraw camera that cuts its drawing is widened to fit, 4:3; one that fits is untouched", async () => {
  const { fitExcalidrawCamera } = await import("../shared/mcp-app-host.ts");
  const cut = [
    { type: "cameraUpdate", x: 0, y: 0, width: 400, height: 300 },
    { type: "rectangle", x: 50, y: 115, width: 140, height: 70 },
    { type: "arrow", x: 190, y: 150, width: 100, height: 0, points: [[0, 0], [100, 0]] },
    { type: "rectangle", x: 290, y: 115, width: 140, height: 70 },
  ];
  const fitted = JSON.parse(fitExcalidrawCamera({ elements: JSON.stringify(cut) }).elements as string) as Array<Record<string, number>>;
  const camera = fitted[0]!;
  assert.ok(camera.x <= 50 && camera.x + camera.width >= 430, "covers the right box");
  assert.ok(Math.abs(camera.width / camera.height - 4 / 3) < 0.02, "keeps 4:3");
  assert.deepEqual(fitted.slice(1), cut.slice(1));
  const fits = { elements: [{ type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 }, { type: "rectangle", x: 10, y: 10, width: 50, height: 50 }] };
  assert.equal(fitExcalidrawCamera(fits), fits);
  const noCamera = { elements: [{ type: "rectangle", x: 10, y: 10, width: 50, height: 50 }] };
  assert.equal(fitExcalidrawCamera(noCamera), noCamera);
});

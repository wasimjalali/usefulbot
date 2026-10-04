import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionIcon,
  iconIsDue,
  iconLinksFromHtml,
  ICON_RETRY_MS,
  readIcons,
  registrableDomain,
  resolveIcon,
  serverInfoIcon,
  setIconFetch,
  settleIcons,
  startDueIcons,
} from "../shared/connection-icons.ts";
import { listPublicConnections } from "../shared/connections-admin.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { seedDefaultConnections, upsertConnection } from "../shared/connections-store.ts";
import type { ConnectionEntry } from "../shared/connections-store.ts";
import { setDiscoveryLogger } from "../shared/connection-tools.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function env(): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-icons-"));
  process.env.UB_STATE_ROOT = dir;
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  process.env.UB_CONNECTION_TOOLS_PATH = join(dir, "connection-tools.json");
  setConnectionLookup(async () => "8.8.8.8");
  setDiscoveryLogger(() => {});
  return dir;
}

type Route = { type: string; body: Uint8Array | string; status?: number };

/** A stub network: URL to answer; anything else is a 404. Records every URL asked. */
function net(routes: Record<string, Route>): string[] {
  const asked: string[] = [];
  setIconFetch(async (input, init) => {
    assert.equal(init?.redirect, "error");
    asked.push(input);
    const hit = routes[input];
    if (!hit) return new Response("no", { status: 404 });
    return new Response(hit.body as BodyInit, { status: hit.status ?? 200, headers: { "content-type": hit.type } });
  });
  return asked;
}

function entry(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: "tella", kind: "mcp", name: "Tella", url: "https://api.tella.com/mcp", description: "d",
    authKind: "none", authHeader: null, toolsAllow: null, createdAt: new Date().toISOString(), ...overrides,
  };
}

test("registrableDomain drops subdomains and keeps country second levels", () => {
  assert.equal(registrableDomain("mcp.excalidraw.com"), "excalidraw.com");
  assert.equal(registrableDomain("api.tella.com"), "tella.com");
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("localhost"), null);
  assert.equal(registrableDomain("10.0.0.4"), null);
});

test("serverInfoIcon takes the first https src only", () => {
  assert.equal(serverInfoIcon({ icons: [{ src: "http://x/a.png" }, { src: "https://x/b.png" }] }), "https://x/b.png");
  assert.equal(serverInfoIcon({ icons: [{ src: "data:image/png;base64,AA" }] }), null);
  assert.equal(serverInfoIcon({}), null);
  assert.equal(serverInfoIcon(null), null);
});

test("iconLinksFromHtml ranks apple-touch-icon, then raster, then svg, and drops http", () => {
  const html = `<head>
    <link rel="icon" href="/x.svg">
    <link rel='shortcut icon' href='/fav.png'>
    <link href="/apple.png" rel="apple-touch-icon">
    <link rel="icon" href="http://insecure/a.png">
    <link rel="stylesheet" href="/a.css"></head>`;
  assert.deepEqual(iconLinksFromHtml(html, "https://tella.com/"), [
    "https://tella.com/apple.png", "https://tella.com/fav.png", "https://tella.com/x.svg",
  ]);
});

test("resolveIcon prefers the icon serverInfo names, even over a home page icon", async () => {
  env();
  const asked = net({
    "https://cdn.tella.com/logo.png": { type: "image/png", body: PNG },
    "https://tella.com/": { type: "text/html", body: '<link rel="icon" href="/fav.png">' },
    "https://tella.com/fav.png": { type: "image/png", body: PNG },
  });
  const icon = await resolveIcon("https://api.tella.com/mcp", { icons: [{ src: "https://cdn.tella.com/logo.png" }] });
  assert.equal(icon, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  assert.deepEqual(asked, ["https://cdn.tella.com/logo.png"]);
});

test("resolveIcon falls from serverInfo to the home page link, then to favicon.ico", async () => {
  env();
  let asked = net({
    "https://tella.com/": { type: "text/html; charset=utf-8", body: '<link rel="apple-touch-icon" href="/apple.png">' },
    "https://tella.com/apple.png": { type: "image/png", body: PNG },
  });
  assert.match((await resolveIcon("https://api.tella.com/mcp", { icons: [{ src: "https://cdn.tella.com/missing.png" }] })) ?? "", /^data:image\/png;base64,/);
  assert.deepEqual(asked, ["https://cdn.tella.com/missing.png", "https://tella.com/", "https://tella.com/apple.png"]);

  asked = net({ "https://tella.com/favicon.ico": { type: "image/x-icon", body: PNG } });
  assert.match((await resolveIcon("https://api.tella.com/mcp")) ?? "", /^data:image\/png;base64,/); // the bytes decide the type, not the header
  assert.deepEqual(asked, ["https://tella.com/", "https://www.tella.com/", "https://tella.com/favicon.ico"]);
});

test("resolveIcon refuses a non-image, an oversized image and a private address", async () => {
  env();
  net({
    "https://tella.com/favicon.ico": { type: "text/html", body: "<html>" },
    "https://www.tella.com/": { type: "text/html", body: '<link rel="icon" href="/big.png">' },
    "https://www.tella.com/big.png": { type: "image/png", body: new Uint8Array(64 * 1024 + 1) },
  });
  assert.equal(await resolveIcon("https://api.tella.com/mcp"), null);
  net({ "https://tella.com/favicon.ico": { type: "image/png", body: new Uint8Array(64 * 1024).fill(1, 0).map((_, i) => PNG[i] ?? 0) } });
  assert.notEqual(await resolveIcon("https://api.tella.com/mcp"), null);
  setConnectionLookup(async () => "10.0.0.5");
  const asked = net({ "https://tella.com/favicon.ico": { type: "image/png", body: PNG } });
  assert.equal(await resolveIcon("https://api.tella.com/mcp"), null);
  assert.deepEqual(asked, []);
  assert.equal(await resolveIcon("http://127.0.0.1:9/mcp"), null);
});

test("startDueIcons stores the answer once, dedupes, and retries a miss only after the wait", async () => {
  env();
  const asked = net({ "https://tella.com/favicon.ico": { type: "image/png", body: PNG } });
  const row = entry();
  upsertConnection({ ...row, description: "Tella MCP server" });
  startDueIcons([row]);
  startDueIcons([row]);
  await settleIcons();
  const count = asked.length;
  assert.match(connectionIcon("tella") ?? "", /^data:image\/png;base64,/);
  startDueIcons([row]);
  await settleIcons();
  assert.equal(asked.length, count, "a stored icon is not fetched again");
  assert.equal(iconIsDue(row, readIcons().tella), false);
  // A moved server is resolved again.
  assert.equal(iconIsDue(entry({ url: "https://api.other.com/mcp" }), readIcons().tella), true);
  // A miss waits, then retries.
  const miss = { host: "api.tella.com", icon: null, checkedAt: new Date().toISOString() };
  assert.equal(iconIsDue(row, miss), false);
  assert.equal(iconIsDue(row, miss, Date.now() + ICON_RETRY_MS + 1000), true);
});

test("the connections list carries the icon, null until one is found", async () => {
  env();
  seedDefaultConnections();
  net({ "https://excalidraw.com/favicon.ico": { type: "image/png", body: PNG } });
  assert.equal(listPublicConnections()[0].icon, null);
  startDueIcons([entry({ id: "excalidraw", url: "https://mcp.excalidraw.com/mcp" })]);
  await settleIcons();
  const row = listPublicConnections().find((item) => item.id === "excalidraw");
  assert.match(row?.icon ?? "", /^data:image\/png;base64,/);
});

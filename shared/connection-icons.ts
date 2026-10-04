import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertPublicHttpsUrl, assertResolvedPublic } from "./connection-url.ts";
import { findConnectionById, type ConnectionEntry } from "./connections-store.ts";
import { statePath } from "./stack.ts";

/**
 * A logo for each direct connection, found once on the server and kept as a
 * data: URI so the app never fetches from a server the owner connected.
 * Order: the site's icon from the registrable domain's home page, then
 * `/favicon.ico` there. Every fetch goes through the SSRF guards, refuses
 * redirects, times out at 5 s and accepts only PNG, JPEG or ICO images (by
 * content type and leading bytes) up to 64 KB.
 */

export const ICON_MAX_BYTES = 64 * 1024;
const PAGE_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/** A connection that had no icon is looked at again after this long. */
export const ICON_RETRY_MS = 6 * 60 * 60 * 1000;

type IconFetch = (input: string, init?: RequestInit) => Promise<Response>;
let injectedFetch: IconFetch | null = null;

/** Tests swap the network for a stub. Passing nothing restores it. */
export function setIconFetch(next: IconFetch | null): void {
  injectedFetch = next;
}

export type IconRecord = {
  /** The host the icon was resolved for; a connection moved elsewhere is resolved again. */
  host: string;
  icon: string | null;
  checkedAt: string;
};

export function connectionIconsPath(): string {
  return statePath("connection-icons.json");
}

export function readIcons(path = connectionIconsPath()): Record<string, IconRecord> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { icons?: Record<string, unknown> };
    const out: Record<string, IconRecord> = {};
    for (const [id, raw] of Object.entries(parsed.icons ?? {})) {
      const r = raw as Partial<IconRecord> | null;
      if (!r || typeof r.host !== "string" || typeof r.checkedAt !== "string") continue;
      // Only raster types the fetch path can store; older SVG entries are dropped so they resolve again.
      const icon = typeof r.icon === "string" && /^data:image\/(png|jpeg|x-icon|vnd\.microsoft\.icon);base64,/.test(r.icon) ? r.icon : null;
      out[id] = { host: r.host, icon, checkedAt: r.checkedAt };
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // A damaged file is a cache that is gone, not a reason to fail the list.
    console.error(`[connection-icons] ${path} is unreadable: ${err instanceof Error ? err.message : "unknown"}`);
    return {};
  }
}

function writeIcons(icons: Record<string, IconRecord>, path = connectionIconsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, icons }), { mode: 0o600 });
  renameSync(tmp, path);
}

export function connectionIcon(id: string, path = connectionIconsPath()): string | null {
  return readIcons(path)[id]?.icon ?? null;
}

export function removeConnectionIcon(id: string, path = connectionIconsPath()): void {
  const icons = readIcons(path);
  if (!(id in icons)) return;
  delete icons[id];
  writeIcons(icons, path);
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

/**
 * The domain a site's home page lives on: the last two labels, or three when
 * the second to last is a country second level (`example.co.uk`). A small
 * rule rather than the public suffix list; a miss only means a worse icon.
 */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  const tld = labels[labels.length - 1];
  const take = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The https icon an MCP initialize result's `serverInfo.icons` names, if any. */
export function serverInfoIcon(serverInfo: unknown): string | null {
  const icons = (serverInfo as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(icons)) return null;
  for (const item of icons) {
    const src = (item as { src?: unknown } | null)?.src;
    if (typeof src === "string" && src.startsWith("https://")) return src;
  }
  return null;
}

type IconLink = { href: string; rank: number };

/** The icon links of a home page, best first: apple-touch-icon, then raster icons, then svg. */
export function iconLinksFromHtml(html: string, pageUrl: string): string[] {
  const found: IconLink[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const rel = attr("rel");
    const href = attr("href");
    if (!rel || !href) continue;
    const relValue = (rel[1] ?? rel[2] ?? rel[3] ?? "").toLowerCase().split(/\s+/);
    const target = href[1] ?? href[2] ?? href[3] ?? "";
    let rank: number;
    if (relValue.includes("apple-touch-icon") || relValue.includes("apple-touch-icon-precomposed")) rank = 0;
    else if (relValue.includes("icon")) rank = /\.svg(\?|$)/i.test(target) ? 2 : 1;
    else continue;
    try {
      const url = new URL(target.replace(/&amp;/g, "&"), pageUrl);
      if (url.protocol !== "https:") continue;
      found.push({ href: url.toString(), rank });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((item) => item.href);
}

async function guardedFetch(rawUrl: string): Promise<Response> {
  const url = await assertResolvedPublic(assertPublicHttpsUrl(rawUrl));
  const run: IconFetch = injectedFetch ?? ((input, init) => fetch(input, init));
  return run(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "UsefulBot/1" } });
}

/** At most `max` bytes of the body, or null when it runs past the cap. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/x-icon", "image/vnd.microsoft.icon"]);

/** The content type the leading bytes prove (PNG, JPEG or ICO), or null. */
function iconMagicType(b: Uint8Array): string | null {
  const png = b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v);
  const jpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const ico = b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
  return png ? "image/png" : jpeg ? "image/jpeg" : ico ? "image/x-icon" : null;
}

/** One image as a data: URI, or null when it isn't a small image. */
export async function fetchImageDataUri(url: string): Promise<string | null> {
  try {
    const res = await guardedFetch(url);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ICON_TYPES.has(type)) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await readCapped(res, ICON_MAX_BYTES);
    const proven = bytes && bytes.byteLength > 0 ? iconMagicType(bytes) : null;
    if (!bytes || !proven) return null;
    return `data:${proven};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

async function iconFromHomePage(pageUrl: string): Promise<string | null> {
  let html: string;
  try {
    const res = await guardedFetch(pageUrl);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("html")) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await readCapped(res, PAGE_MAX_BYTES);
    if (!bytes) return null;
    html = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  for (const href of iconLinksFromHtml(html, pageUrl).slice(0, 4)) {
    const icon = await fetchImageDataUri(href);
    if (icon) return icon;
  }
  return null;
}

/** Resolve one connection's icon. Null when no step finds one; `serverInfo` is tried first when a caller has it. */
export async function resolveIcon(mcpUrl: string, serverInfo?: unknown): Promise<string | null> {
  let host: string;
  try {
    host = new URL(mcpUrl).hostname;
  } catch {
    return null;
  }
  const named = serverInfoIcon(serverInfo);
  if (named) {
    const icon = await fetchImageDataUri(named);
    if (icon) return icon;
  }
  const domain = registrableDomain(host);
  if (!domain) return null;
  // A bare domain often redirects to www, and redirects are refused, so both are tried.
  for (const origin of [`https://${domain}/`, `https://www.${domain}/`]) {
    const icon = await iconFromHomePage(origin);
    if (icon) return icon;
  }
  return fetchImageDataUri(`https://${domain}/favicon.ico`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Whether the connection has no fresh answer, found or not found. */
export function iconIsDue(entry: ConnectionEntry, record: IconRecord | undefined, now = Date.now()): boolean {
  if (!record || record.host !== hostOf(entry.url)) return true;
  if (record.icon) return false;
  return now - Date.parse(record.checkedAt) >= ICON_RETRY_MS;
}

const running = new Map<string, Promise<void>>();

/**
 * Resolve, in the background, the icon of every connection that has none
 * recorded. One run per id at a time; never awaited by the list.
 */
export function startDueIcons(entries: readonly ConnectionEntry[], path = connectionIconsPath()): void {
  const icons = readIcons(path);
  for (const entry of entries) {
    if (running.has(entry.id) || !iconIsDue(entry, icons[entry.id])) continue;
    const host = hostOf(entry.url);
    const run = resolveIcon(entry.url)
      .then((icon) => {
        // The connection was removed while the lookup ran: nothing to record for it.
        if (!findConnectionById(entry.id)) return;
        // Read again here: another id's run may have written since this one began.
        const latest = readIcons(path);
        latest[entry.id] = { host, icon, checkedAt: new Date().toISOString() };
        writeIcons(latest, path);
      })
      .catch((err) => console.error(`[connection-icons] ${entry.id}: ${err instanceof Error ? err.message : "unknown"}`))
      .finally(() => running.delete(entry.id));
    running.set(entry.id, run);
  }
}

/** Resolves when every icon run now going has finished. */
export async function settleIcons(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running.values()]);
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-facing URL rules for owner-approved MCP and OpenAPI servers, and for
 * every URL fetched while talking to them (OAuth discovery, token, widget
 * HTML). https anywhere public; http only on 127.0.0.1.
 */

const MAX_URL = 2048;
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const BLOCKED_LABELS = new Set(["local", "internal", "localhost", "invalid", "onion"]);

export class ConnectionUrlError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ConnectionUrlError";
  }
}

function octet(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (value.length > 1 && value.startsWith("0")) return null;
  return n;
}

function isLoopbackV4(hostname: string): boolean {
  return hostname === "127.0.0.1";
}

function isBlockedV4(hostname: string): boolean {
  const m = V4.exec(hostname);
  if (!m) return false;
  const a = octet(m[1]);
  const b = octet(m[2]);
  const c = octet(m[3]);
  const d = octet(m[4]);
  if (a === null || b === null || c === null || d === null) return true;
  if (a === 127) return hostname !== "127.0.0.1";
  if (a === 10 || a === 0 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isDnsName(hostname: string): boolean {
  if (!DNS.test(hostname)) return false;
  const labels = hostname.toLowerCase().split(".");
  const tld = labels[labels.length - 1];
  if (BLOCKED_LABELS.has(tld)) return false;
  if (/^\d+$/.test(tld)) return false;
  return true;
}

/**
 * Parse and accept a connection or discovery URL. Returns the normalised
 * href (hash dropped, trailing junk refused). Throws ConnectionUrlError.
 */
export function assertConnectionUrl(raw: string): string {
  if (typeof raw !== "string") throw new ConnectionUrlError("url_invalid");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL) throw new ConnectionUrlError("url_invalid");
  if (/[\s\\]/.test(trimmed)) throw new ConnectionUrlError("url_invalid");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConnectionUrlError("url_invalid");
  }
  if (parsed.username || parsed.password) throw new ConnectionUrlError("url_credentials");
  if (parsed.hash) parsed.hash = "";
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (host.includes(":") || host.startsWith("[") || host === "localhost" || host === "::1") {
    throw new ConnectionUrlError("url_host");
  }
  const loopback = isLoopbackV4(host);
  if (protocol === "http:") {
    if (!loopback) throw new ConnectionUrlError("url_http");
  } else if (protocol !== "https:") {
    throw new ConnectionUrlError("url_protocol");
  }
  if (loopback) {
    if (parsed.port && !/^\d{1,5}$/.test(parsed.port)) throw new ConnectionUrlError("url_host");
    return parsed.href;
  }
  if (V4.test(host)) {
    if (isBlockedV4(host)) throw new ConnectionUrlError("url_host");
    throw new ConnectionUrlError("url_host");
  }
  if (!isDnsName(host)) throw new ConnectionUrlError("url_host");
  return parsed.href;
}

/** Hostname only, for the card. Empty when the URL cannot be parsed. */
export function connectionHost(url: string): string {
  try {
    return new URL(assertConnectionUrl(url)).hostname.toLowerCase();
  } catch {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
}

export function isHttpsPublicHost(url: string, expectedHost: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol.toLowerCase() !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost") return false;
    return host === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Discovery, token and registration URLs must be https on a public host.
 * The loopback http exception is only for an owner-typed MCP URL.
 */
export function assertPublicHttpsUrl(raw: string): string {
  const href = assertConnectionUrl(raw);
  const parsed = new URL(href);
  if (parsed.protocol !== "https:") throw new ConnectionUrlError("url_http");
  if (parsed.hostname === "127.0.0.1") throw new ConnectionUrlError("url_host");
  return href;
}

/** What a lookup answers: one address, or every address the name has. */
type LookupFn = (hostname: string) => Promise<string | string[]>;
let injectedLookup: LookupFn | null = null;

export function setConnectionLookup(next: LookupFn | null): void {
  injectedLookup = next;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function v6Groups(address: string): number[] | null {
  let text = address.split("%")[0];
  // A dotted v4 tail (`::ffff:10.0.0.4`) is two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (tail) {
    const m = V4.exec(tail);
    const bytes = m ? m.slice(1).map(octet) : [];
    if (bytes.length !== 4 || bytes.some((byte) => byte === null)) return null;
    const [a, b, c, d] = bytes as number[];
    text = `${text.slice(0, text.length - tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : NaN));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function v4OfGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Whether an address a name resolved to is one this app must not call: the v4
 * ranges `isBlockedV4` knows plus loopback, and for v6 the unspecified,
 * loopback, link-local, site-local, unique-local and multicast ranges and any
 * v6 form that carries a v4 address (mapped, compatible, NAT64, 6to4), judged
 * by the v4 inside. An address that is not an address is refused.
 */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address === "127.0.0.1" || isBlockedV4(address);
  if (family !== 6) return true;
  const g = v6Groups(address);
  if (!g) return true;
  const inner = (high: number, low: number) => isBlockedAddress(v4OfGroups(high, low));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return inner(g[6], g[7]);
  // ::, ::1 and the deprecated v4-compatible ::a.b.c.d, which is all of ::/96.
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return inner(g[6], g[7]);
  if (g[0] === 0x2002) return inner(g[1], g[2]);
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * Resolve the host and refuse private, link-local, metadata and loopback
 * answers. Call this before every network fetch of a public URL.
 *
 * Every answer in both families is judged, and one that is private refuses
 * the host: a name with a public address and a private one beside it is how a
 * rebinding or split-horizon record gets past a check of the first answer.
 *
 * Not closed: the fetch that follows resolves the name again, so a record that
 * changes between this check and that connection is not caught. Closing it
 * means connecting to the address checked here (a dispatcher whose lookup
 * returns only it). `undici` is not a dependency of this repo, only of eve
 * (8.x) and a few packages (7.x), and every fetch site would have to carry the
 * dispatcher, so the window stays until that is wired.
 */
export async function assertResolvedPublic(raw: string): Promise<string> {
  const href = assertConnectionUrl(raw);
  const host = new URL(href).hostname.toLowerCase();
  if (host === "127.0.0.1") return href;
  let answers: string[];
  try {
    const found = injectedLookup
      ? await injectedLookup(host)
      : (await lookup(host, { all: true })).map((item) => item.address);
    answers = Array.isArray(found) ? found : [found];
  } catch {
    throw new ConnectionUrlError("url_resolve");
  }
  if (answers.length === 0) throw new ConnectionUrlError("url_resolve");
  if (answers.some(isBlockedAddress)) throw new ConnectionUrlError("url_resolved");
  return href;
}

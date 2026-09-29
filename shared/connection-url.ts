import { lookup } from "node:dns/promises";

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

type LookupFn = (hostname: string) => Promise<string>;
let injectedLookup: LookupFn | null = null;

export function setConnectionLookup(next: LookupFn | null): void {
  injectedLookup = next;
}

/**
 * Resolve the host and refuse private, link-local, metadata and loopback
 * answers. Call this before every network fetch of a public URL.
 */
export async function assertResolvedPublic(raw: string): Promise<string> {
  const href = assertConnectionUrl(raw);
  const host = new URL(href).hostname.toLowerCase();
  if (host === "127.0.0.1") return href;
  let address: string;
  try {
    address = injectedLookup
      ? await injectedLookup(host)
      : (await lookup(host, { family: 4 })).address;
  } catch {
    throw new ConnectionUrlError("url_resolve");
  }
  if (address.includes(":")) throw new ConnectionUrlError("url_host");
  if (address === "127.0.0.1" || isBlockedV4(address)) throw new ConnectionUrlError("url_resolved");
  return href;
}

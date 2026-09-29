import { isLoopbackHost, originHeaderAllowed } from "../../shared/origin.ts";
import { runtimeConfig } from "./runtime-config.ts";

/**
 * Spec 4.2's three request classes. `tailnet` is a request Tailscale Serve
 * forwarded: the tailnet identity headers, an `https` forwarded proto and a
 * first `X-Forwarded-For` hop inside the tailnet address space. `unknown` is
 * every other request that carries real proxy material at all — half a header
 * set is an attacker, not a configuration — and it is always refused, never
 * read as loopback.
 *
 * One wrinkle the spec could not see at authoring time: Next's server
 * synthesizes `x-forwarded-for/host/port/proto` on every request it accepts
 * (base-server `??=` fills them from the socket), so "zero proxy headers" is
 * unreachable at the route layer. The loopback rule therefore treats a
 * synthesized loopback echo — every XFF hop loopback, proto `http` or absent,
 * forwarded host loopback or absent, no tailscale-* or `forwarded` header —
 * as no proxy material. Any value outside that set means a real proxy spoke
 * and the request must satisfy the complete tailnet set or fail `unknown`.
 * A local client that writes the same loopback echo itself is already inside
 * the loopback trust domain, so nothing extra is granted.
 *
 * No next/ imports: the classifier is pure so it stays unit-testable under
 * node --test, which cannot resolve the next/server package entry.
 */
export type IngressClass = "loopback" | "tailnet" | "unknown";

/** Headers a request that passed through a proxy may carry. Presence of any
 * one of them means the request is not a plain loopback client. */
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "forwarded",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
] as const;

/** Single-valued headers: a second occurrence folds into `a, b` and is a
 * conflict (spec 4.2: a repeated header is a conflict, not "take the first"). */
const SINGLE_VALUE_HEADERS = [
  "x-forwarded-proto",
  "x-forwarded-host",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
] as const;

function hasConflict(request: Request): boolean {
  return SINGLE_VALUE_HEADERS.some((name) => (request.headers.get(name) ?? "").includes(","));
}

function forwardedHops(request: Request): string[] {
  const value = request.headers.get("x-forwarded-for");
  if (!value) return [];
  // Entries are never dropped: an empty first hop must stay empty so it fails
  // the tailnet/loopback checks instead of promoting the next hop into the
  // trusted position.
  return value.split(",").map((hop) => hop.trim());
}

function isLoopbackAddress(value: string): boolean {
  const unbracketed = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1" || unbracketed === "::ffff:127.0.0.1") return true;
  if (unbracketed.startsWith("::ffff:")) return isLoopbackAddress(unbracketed.slice(7));
  const v4 = parseIpv4(unbracketed);
  return v4 !== null && (v4 >>> 24) === 127;
}

/**
 * Whether the proxy material a request carries could be only the framework's
 * loopback echo: every XFF hop loopback, proto `http` (or absent), forwarded
 * host loopback (or absent), and none of the headers only a real proxy
 * sends — `forwarded`, the tailscale-* set, an `https` proto or a remote hop.
 */
function onlyLoopbackEcho(request: Request): boolean {
  if (request.headers.get("forwarded") !== null) return false;
  if (PROXY_HEADERS.slice(5).some((name) => request.headers.get(name) !== null)) return false;
  const proto = request.headers.get("x-forwarded-proto");
  if (proto !== null && proto.trim() !== "http") return false;
  const host = request.headers.get("x-forwarded-host");
  if (host !== null) {
    let hostname = "";
    try {
      hostname = new URL(`http://${host.trim()}`).hostname;
    } catch {
      return false;
    }
    if (!isLoopbackHost(hostname)) return false;
  }
  const hops = forwardedHops(request);
  return hops.length > 0 && hops.every(isLoopbackAddress);
}

/** True for an address inside Tailscale's space: CGNAT 100.64.0.0/10 or the
 * tailnet ULA prefix fd7a:115c:a1e0::/48. Anything unparseable is false. */
function inTailnetSpace(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return false;
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  if (unbracketed.includes(":")) return inTailnetV6(unbracketed);
  const v4 = parseIpv4(unbracketed);
  if (v4 === null) return false;
  // 100.64.0.0/10: first octet 100, second in 64..127.
  return ((v4 >>> 24) & 0xff) === 100 && (((v4 >>> 16) & 0xff) & 0xc0) === 0x40;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let address = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    address = (address << 8) | octet;
  }
  return address >>> 0;
}

/** Expand an IPv6 literal to eight 16-bit groups; null when malformed. */
function ipv6Groups(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const token of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      groups.push(parseInt(token, 16));
    }
    return groups;
  };
  const left = parse(halves[0]);
  if (left === null) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parse(halves[1]);
  if (right === null) return null;
  if (left.length + right.length > 8) return null;
  const zeros = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

function inTailnetV6(value: string): boolean {
  // A v4-mapped tailnet address (::ffff:100.x) classifies by its IPv4 tail.
  if (value.includes(".")) {
    const tail = value.split(":").pop() ?? "";
    return parseIpv4(tail) !== null && inTailnetSpace(tail);
  }
  const groups = ipv6Groups(value);
  if (groups === null) return false;
  // fd7a:115c:a1e0::/48 — the first three groups are the prefix.
  return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
}

function urlHost(request: Request): string {
  try {
    return new URL(request.url).hostname;
  } catch {
    return "";
  }
}

/**
 * Classify the request per spec 4.2. Fail closed: only the complete tailnet
 * header set earns `tailnet`, and only a request carrying no real proxy
 * material on a loopback URL earns `loopback`.
 */
export function classifyIngress(request: Request): IngressClass {
  const hasProxyHeader = PROXY_HEADERS.some((name) => request.headers.get(name) !== null);
  if (!hasProxyHeader || onlyLoopbackEcho(request)) {
    return isLoopbackHost(urlHost(request)) ? "loopback" : "unknown";
  }
  if (hasConflict(request)) return "unknown";
  const config = runtimeConfig();
  // The tailnet record persists after `--revoke-phone` (only phoneEnabled
  // flips), so a revoked phone's requests still carry the enrolled tailnet
  // signature. Classify them `tailnet` even while phoneEnabled is false —
  // the auth layer then answers `credential_invalid` (§4.8) rather than an
  // ingress refusal the phone cannot tell from a runtime outage.
  const tailnet = config?.tailnet ?? null;
  if (!tailnet) return "unknown";
  const login = request.headers.get("tailscale-user-login")?.trim() ?? "";
  if (login !== tailnet.userLogin) return "unknown";
  if ((request.headers.get("x-forwarded-proto")?.trim() ?? "") !== "https") return "unknown";
  const hops = forwardedHops(request);
  if (hops.length === 0 || !inTailnetSpace(hops[0])) return "unknown";
  return "tailnet";
}

/**
 * Origin check (spec 4.3.7): absent passes; the configured tailnet origin
 * passes only when the request is actually tailnet ingress; everything else
 * falls to the loopback rule, which already refuses `null` and remote hosts.
 */
export function originAllowed(request: Request, ingress: IngressClass = classifyIngress(request)): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    const tailnet = runtimeConfig()?.tailnet;
    if (tailnet && ingress === "tailnet" && origin === tailnet.httpsOrigin) {
      return true;
    }
  }
  return originHeaderAllowed(request.headers.get("origin"), request.url);
}

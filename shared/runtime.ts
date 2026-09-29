import { readFileSync, existsSync } from "node:fs";
import { CALLER_LIMITS, type Profile } from "./policy.ts";

export interface CredentialDigest {
  id: string;
  kind: "device" | "channel" | "router";
  sha256: string;
  callerId: string;
  profile: Profile | "ops";
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * The enrolled tailnet details `--pair-phone` records (spec S2). `httpsOrigin`
 * is the Mac's Tailscale Serve origin; `userLogin` is the enrolled tailnet
 * identity the ingress classifier checks requests against; `phoneIpv4`/
 * `phoneIpv6` and `macIdentity` are the owner-visible enrollment details the
 * Devices panes display.
 */
export interface TailnetConfig {
  httpsOrigin: string;
  userLogin: string;
  phoneIpv4: string;
  phoneIpv6: string;
  macIdentity: string;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  phoneEnabled: boolean;
  tailnet: TailnetConfig | null;
  sandbox: { backend: "just-bash"; evidenceId: string; imageDigest: null };
  goBalanceDisabledConfirmedAt: string | null;
  searchKeyRequired: false;
  credentials: CredentialDigest[];
}

const ALLOWED_KEYS = new Set([
  "schemaVersion",
  "phoneEnabled",
  "tailnet",
  "sandbox",
  "goBalanceDisabledConfirmedAt",
  "searchKeyRequired",
  "credentials",
]);

const CREDENTIAL_KINDS = new Set(["device", "channel", "router"]);
const CREDENTIAL_PROFILES = new Set(Object.keys(CALLER_LIMITS));

function validateCredential(value: unknown, index: number): void {
  const fail = (reason: string): never => {
    throw new Error(`runtime_config_credential:${index}:${reason}`);
  };
  if (!value || typeof value !== "object") fail("shape");
  const cred = value as Record<string, unknown>;
  if (typeof cred.id !== "string" || cred.id.length === 0) fail("id");
  if (typeof cred.kind !== "string" || !CREDENTIAL_KINDS.has(cred.kind)) fail("kind");
  if (typeof cred.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(cred.sha256)) fail("sha256");
  if (typeof cred.callerId !== "string" || cred.callerId.length === 0) fail("callerId");
  if (typeof cred.profile !== "string" || !CREDENTIAL_PROFILES.has(cred.profile)) fail("profile");
  if (typeof cred.expiresAt !== "string" || !Number.isFinite(Date.parse(cred.expiresAt))) fail("expiresAt");
  if (cred.revokedAt !== null
    && (typeof cred.revokedAt !== "string" || !Number.isFinite(Date.parse(cred.revokedAt)))) {
    fail("revokedAt");
  }
}

export function loadRuntimeConfig(path: string): RuntimeConfig {
  if (!existsSync(path)) {
    throw new Error(`runtime_config_missing:${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`runtime_config_unknown_key:${key}`);
    }
  }
  if (raw.schemaVersion !== 1) {
    throw new Error("runtime_config_schema");
  }
  if (raw.searchKeyRequired !== false) {
    throw new Error("runtime_config_search_key");
  }
  const credentials = raw.credentials;
  if (!Array.isArray(credentials)) {
    throw new Error("runtime_config_credentials");
  }
  credentials.forEach((credential, index) => validateCredential(credential, index));
  validateTailnet(raw);
  return raw as unknown as RuntimeConfig;
}

/**
 * Canonical https origin: scheme https, non-empty host, no credentials, path,
 * query or fragment, and no port but the implicit 443. The string form is what
 * `Origin` headers carry, so the comparison elsewhere is exact.
 */
function isCanonicalHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !url.hostname) return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "/" || url.search || url.hash) return false;
  if (url.port && url.port !== "443") return false;
  return url.origin === value;
}

const TAILNET_FIELDS = ["httpsOrigin", "userLogin", "phoneIpv4", "phoneIpv6", "macIdentity"] as const;

function validateTailnet(raw: Record<string, unknown>): void {
  if (typeof raw.phoneEnabled !== "boolean") {
    throw new Error("runtime_config_phone_enabled");
  }
  const tailnet = raw.tailnet;
  if (tailnet === null) {
    // Phone access off requires no tailnet record; enabling one without the
    // other is the misconfiguration this invariant exists to refuse.
    if (raw.phoneEnabled === true) {
      throw new Error("runtime_config_phone_no_tailnet");
    }
    return;
  }
  if (!tailnet || typeof tailnet !== "object" || Array.isArray(tailnet)) {
    throw new Error("runtime_config_tailnet");
  }
  const record = tailnet as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(TAILNET_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`runtime_config_tailnet_key:${key}`);
    }
  }
  for (const field of TAILNET_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`runtime_config_tailnet:${field}`);
    }
  }
  if (!isCanonicalHttpsOrigin(record.httpsOrigin as string)) {
    throw new Error("runtime_config_tailnet:httpsOrigin");
  }
}

export function limitsFor(profile: Profile | "ops") {
  return CALLER_LIMITS[profile];
}

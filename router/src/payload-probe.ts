import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stackName } from "../../shared/stack.ts";

/**
 * Dev-only payload probe (UB-009). With UB_PAYLOAD_PROBE_DIR set, every
 * request body the router sends to a provider is written there as JSON, so
 * "what the model sees" can be read, not guessed. The body only: headers
 * never reach this module, and credential-shaped keys and values in the body
 * are replaced on a best-effort basis (a scrub is a pattern list, not a
 * guarantee). Refused outright on the daily stack.
 */

type Env = Record<string, string | undefined>;

// A key name that contains one of these has its string values replaced (also
// strings in an array under it). Numbers and objects are left to the walk.
const SECRET_KEY = /key|token|secret|password|auth|cookie/i;
const DATA_URI = /data:[^,\s"']{0,200};base64,[A-Za-z0-9+/=]+/g;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:gsk_|xai-|nvapi-)[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{12,}/g,
];
export const REDACTED = "[redacted]";

export function scrub(value: unknown, secret = false): unknown {
  if (typeof value === "string") {
    if (secret) return REDACTED;
    // Data URIs (images) go first: they are large and hold no credential.
    const text = value.replace(DATA_URI, (uri) => `[data uri, ${uri.length} bytes]`);
    // Tool-call arguments arrive as a JSON string: scrub what is inside it.
    if (/^\s*[[{]/.test(text)) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return JSON.stringify(scrub(parsed));
      } catch { /* not JSON: scrub it as text */ }
    }
    return SECRET_VALUE.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
  }
  // Array elements inherit the context (`"api_keys": ["abc"]`); an object's
  // own keys decide for their values, so a schema property named "key" stays readable.
  if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = scrub(inner, SECRET_KEY.test(key));
    return out;
  }
  return value;
}

let announced = false;

/** The folder to dump into, or null. A daily stack never gets one. */
export function probeDir(env: Env = process.env): string | null {
  const dir = env.UB_PAYLOAD_PROBE_DIR?.trim();
  if (!dir) return null;
  if (stackName(env) !== "dev") {
    if (!announced) {
      announced = true;
      process.stderr.write(`${JSON.stringify({ service: "router", warning: "payload_probe_refused", reason: "not the dev stack" })}\n`);
    }
    return null;
  }
  if (!announced) {
    announced = true;
    process.stderr.write(`${JSON.stringify({ service: "router", warning: "payload_probe_active", dir })}\n`);
  }
  return dir;
}

/** Never throws: a probe that cannot write must not fail a turn. */
export function dumpUpstreamBody(upstream: string, model: string, body: unknown, env: Env = process.env): string | null {
  try {
    // Inside the try: an invalid UB_STACK makes stackName() throw, and a probe
    // must never fail a turn. An invalid stack is refused and logged once.
    const dir = probeDir(env);
    if (!dir) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "_");
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}-${safe(upstream)}-${safe(model)}.json`);
    writeFileSync(file, JSON.stringify(scrub(body)), { mode: 0o600 });
    return file;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: "router", warning: "payload_probe_write_failed", message: (error as Error).message })}\n`);
    return null;
  }
}

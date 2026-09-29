#!/usr/bin/env node
/**
 * Regenerate the iOS contract fixtures (spec §18): boot the real Next route
 * handlers against a fixture config and record each response. Run after a
 * route under test/fixtures/ios-contract changes; commit the output.
 *
 *   node scripts/ios-contract-fixtures.mjs
 *
 * The server runs on a scratch port with UB_ROUTER_CONFIG + UB_WEB_SESSIONS_PATH
 * pointed at a temp fixture store. Response bodies are recorded verbatim;
 * per-run secrets (csrfToken, Set-Cookie) are replaced with placeholders.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "test/fixtures/ios-contract");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

// Fixture identities — never a real tailnet or device name (repo rule).
const TAILNET = {
  httpsOrigin: "https://mac.tailnet-example.ts.net",
  userLogin: "owner@tailnet.example",
  phoneIpv4: "100.64.1.2",
  phoneIpv6: "fd7a:115c:a1e0::2",
  macIdentity: "Test Mac",
};
const PHONE_TOKEN = "contract-fixture-phone-token-32bytes";
const DESKTOP_TOKEN = "contract-fixture-desktop-token-32byt";

const sha256 = (v) => createHash("sha256").update(v, "utf8").digest("hex");
const future = (days) => new Date(Date.now() + days * 86400_000).toISOString();

function writeConfig(dir, over = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: true,
    tailnet: TAILNET,
    sandbox: { backend: "just-bash", evidenceId: "fixture", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [
      { id: "device-phone", kind: "device", sha256: sha256(PHONE_TOKEN),
        callerId: "phone", profile: "phone", expiresAt: future(30), revokedAt: null },
      { id: "device-desktop", kind: "device", sha256: sha256(DESKTOP_TOKEN),
        callerId: "desktop", profile: "desktop", expiresAt: future(30), revokedAt: null },
    ],
    ...over,
  })}\n`, { mode: 0o600 });
  return file;
}

function tailnetHeaders(over = {}) {
  return {
    "tailscale-user-login": TAILNET.userLogin,
    "x-forwarded-for": TAILNET.phoneIpv4,
    "x-forwarded-proto": "https",
    ...over,
  };
}

/** One recorded exchange: request line + the real response, secrets masked. */
async function call(name, { method = "GET", url, headers = {}, body, note }) {
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  const json = await res.json().catch(() => null);
  // Mask a copy for the record — the live values (csrf, cookie) still feed
  // the calls that follow.
  const recordedJson = json ? { ...json, csrfToken: json.csrfToken === undefined ? undefined : "<csrfToken>" } : null;
  const maskedHeaders = { ...headers };
  if (maskedHeaders.cookie) maskedHeaders.cookie = "<sessionCookie>";
  if (maskedHeaders["x-ub-csrf"]) maskedHeaders["x-ub-csrf"] = "<csrfToken>";
  const record = {
    note,
    request: { method, path: new URL(url).pathname, headers: maskedHeaders },
    response: {
      status: res.status,
      setCookie: res.headers.get("set-cookie") !== null,
      json: recordedJson,
    },
  };
  writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { res, json, setCookie: res.headers.get("set-cookie") ?? "" };
}

function cookieHeader(setCookie) {
  return setCookie.split(";")[0];
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "ub-contract-"));
  const configPath = writeConfig(path.join(work, "config"));
  const sessionsPath = path.join(work, "web-sessions.json");
  writeFileSync(sessionsPath, `{ "sessions": {} }\n`, { mode: 0o600 });

  const server = spawn(
    path.join(ROOT, "node_modules/next/dist/bin/next"),
    ["dev", path.join(ROOT, "web"), "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      env: {
        ...process.env,
        UB_ROUTER_CONFIG: configPath,
        UB_WEB_SESSIONS_PATH: sessionsPath,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  try {
    // Wait until the server answers anything.
    for (let i = 0; i < 120; i += 1) {
      try {
        await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        if (i === 119) throw new Error("web server never came up");
      }
    }

    const SESSION = `${BASE}/api/auth/session`;
    const STATUS = `${BASE}/api/status`;
    const loopback = { origin: BASE }; // Origin must match the request port (originHeaderAllowed).

    // --- auth: the three ingress classes -----------------------------

    await call("auth.get-loopback-auto-session", {
      url: SESSION, headers: loopback,
      note: "Loopback class auto-session (S8): the desktop login wall is loopback-only.",
    });

    await call("auth.get-loopback-no-origin", {
      url: SESSION,
      note: "Loopback address but no local Origin/Referer — no auto-session.",
    });

    await call("auth.get-tailnet-no-session", {
      url: SESSION, headers: tailnetHeaders(),
      note: "Tailnet class never auto-sessions: a Bearer token must POST first.",
    });

    const phone = await call("auth.post-tailnet-phone", {
      method: "POST", url: SESSION,
      headers: tailnetHeaders({ authorization: `Bearer ${PHONE_TOKEN}` }),
      note: "The phone credential exchanges over tailnet for a bound session.",
    });

    await call("auth.post-tailnet-desktop-credential", {
      method: "POST", url: SESSION,
      headers: tailnetHeaders({ authorization: `Bearer ${DESKTOP_TOKEN}` }),
      note: "F3: a desktop credential cannot sign in over the tailnet.",
    });

    await call("auth.post-loopback-phone", {
      method: "POST", url: SESSION,
      headers: { ...loopback, authorization: `Bearer ${PHONE_TOKEN}` },
      note: "The dev path (§7.3): phone credential signs in over loopback when phoneEnabled.",
    });

    await call("auth.post-unknown-ingress", {
      method: "POST", url: SESSION,
      headers: {
        "x-forwarded-for": "203.0.113.5",
        "x-forwarded-proto": "https",
        "tailscale-user-login": "someone-else@tailnet.example",
        authorization: `Bearer ${PHONE_TOKEN}`,
      },
      note: "Real proxy material that is not the enrolled tailnet → unknown → 403.",
    });

    // phoneEnabled off (S9 mint-side): a phone credential must not mint a
    // session every gated route would kill the next request anyway. The
    // tailnet record survives the flip, so the same verdict answers over
    // the enrolled signature too — never a bare `ingress` refusal the
    // phone could mistake for a runtime outage.
    writeConfig(path.join(work, "config"), { phoneEnabled: false });
    await new Promise((r) => setTimeout(r, 50));
    await call("auth.post-phone-disabled", {
      method: "POST", url: SESSION,
      headers: { ...loopback, authorization: `Bearer ${PHONE_TOKEN}` },
      note: "S9 at mint: while phoneEnabled is false a phone credential gets credential_invalid — the same verdict the routes answer.",
    });
    await call("auth.post-phone-disabled-tailnet", {
      method: "POST", url: SESSION,
      headers: tailnetHeaders({ authorization: `Bearer ${PHONE_TOKEN}` }),
      note: "Mint-side over tailnet while disabled: still credential_invalid, because the enrolled signature keeps the request class tailnet.",
    });
    await call("status.phone-disabled-tailnet", {
      url: STATUS, headers: tailnetHeaders({ cookie: cookieHeader(phone.setCookie) }),
      note: "Use-side over tailnet while disabled: the gate answers 401 credential_invalid — the phone lands on its §4.8 terminal, not runtimeDown.",
    });
    writeConfig(path.join(work, "config"));
    await new Promise((r) => setTimeout(r, 50));

    // --- sessions bound to credentials --------------------------------

    const cookie = cookieHeader(phone.setCookie);
    const csrf = phone.json?.csrfToken;

    await call("auth.get-session-phone", {
      url: SESSION, headers: tailnetHeaders({ cookie }),
      note: "The phone session reads back profile + both expiry clocks.",
    });

    await call("status.phone-owner", {
      url: STATUS, headers: tailnetHeaders({ cookie }),
      note: "requireOwner over the phone session: apiVersion + eve probe.",
    });

    await call("status.unauthenticated", {
      url: STATUS, headers: tailnetHeaders(),
      note: "No session at all.",
    });

    // Revocation (S9): re-write the config with the credential revoked; the
    // very next request on the live cookie must die credential_invalid at a
    // gate — and at the session route too, which mirrors the same verdict.
    writeConfig(path.join(work, "config"), {
      credentials: [
        { id: "device-phone", kind: "device", sha256: sha256(PHONE_TOKEN),
          callerId: "phone", profile: "phone", expiresAt: future(30),
          revokedAt: new Date().toISOString() },
      ],
    });
    await new Promise((r) => setTimeout(r, 50)); // let mtime advance

    await call("status.session-revoked", {
      url: STATUS, headers: tailnetHeaders({ cookie }),
      note: "S9: the bound credential revoked mid-session → 401 credential_invalid.",
    });

    await call("auth.get-session-revoked", {
      url: SESSION, headers: tailnetHeaders({ cookie }),
      note: "S9: introspection answers the same verdict — a dead credential row is a 401 credential_invalid that destroys the session and clears the cookie.",
    });

    // Un-revoke and re-mint a session for the sign-out case — the revoked
    // GET destroyed the first one. Raw fetch: the re-sign-in is a repeat of
    // auth.post-tailnet-phone and needs no fixture of its own.
    writeConfig(path.join(work, "config"));
    await new Promise((r) => setTimeout(r, 50));
    const resign = await fetch(SESSION, {
      method: "POST",
      headers: tailnetHeaders({ authorization: `Bearer ${PHONE_TOKEN}` }),
    });
    const cookie2 = cookieHeader(resign.headers.get("set-cookie") ?? "");
    const csrf2 = (await resign.json())?.csrfToken;

    await call("auth.delete-session", {
      method: "DELETE", url: SESSION,
      headers: tailnetHeaders({ cookie: cookie2, "x-ub-csrf": String(csrf2) }),
      note: "Sign-out: cookie + CSRF, the session row is destroyed.",
    });
  } finally {
    server.kill("SIGTERM");
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`contract fixtures written to ${path.relative(ROOT, OUT)}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

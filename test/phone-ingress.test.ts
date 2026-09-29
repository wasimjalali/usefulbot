import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyIngress, originAllowed } from "../web/lib/ingress.ts";
import {
  credentialById,
  createBrowserSession,
  phoneDisabled,
  sessionCookie,
  verifyDeviceToken,
} from "../web/lib/auth.ts";
import { getBrowserSession } from "../shared/web-sessions.ts";

const URL_LOOPBACK = "http://127.0.0.1:4320/api/x";
const TAILNET = {
  httpsOrigin: "https://mac.tailnet-example.ts.net",
  userLogin: "owner@tailnet.example",
  phoneIpv4: "100.64.1.2",
  phoneIpv6: "fd7a:115c:a1e0::2",
  macIdentity: "Test Mac",
};

const PHONE_TOKEN = "phone-token-fixture-32-bytes-padding";
const DESKTOP_TOKEN = "desktop-token-fixture-32-bytes-pad";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialRow(over: Record<string, unknown> = {}) {
  return {
    id: "device-phone",
    kind: "device",
    sha256: sha256(PHONE_TOKEN),
    callerId: "phone",
    profile: "phone",
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    revokedAt: null,
    ...over,
  };
}

function writeConfig(dir: string, over: Record<string, unknown> = {}): string {
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: false,
    tailnet: null,
    sandbox: { backend: "just-bash", evidenceId: "x", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [],
    ...over,
  })}\n`, { mode: 0o600 });
  return path;
}

/** Run `fn` with the env vars that point the auth layer at fixture stores. */
function withFixture<T>(configPath: string | null, fn: () => T): T {
  const prevConfig = process.env.UB_ROUTER_CONFIG;
  const prevSessions = process.env.UB_WEB_SESSIONS_PATH;
  process.env.UB_WEB_SESSIONS_PATH = join(mkdtempSync(join(tmpdir(), "ub-sess-")), "s.json");
  if (configPath === null) delete process.env.UB_ROUTER_CONFIG;
  else process.env.UB_ROUTER_CONFIG = configPath;
  try {
    return fn();
  } finally {
    if (prevConfig === undefined) delete process.env.UB_ROUTER_CONFIG;
    else process.env.UB_ROUTER_CONFIG = prevConfig;
    if (prevSessions === undefined) delete process.env.UB_WEB_SESSIONS_PATH;
    else process.env.UB_WEB_SESSIONS_PATH = prevSessions;
  }
}

function tailnetHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    "tailscale-user-login": TAILNET.userLogin,
    "x-forwarded-for": "100.64.1.2",
    "x-forwarded-proto": "https",
    ...over,
  };
}

function tailnetConfigDir(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-cfg-"));
  writeConfig(dir, { phoneEnabled: true, tailnet: TAILNET, ...over });
  return dir;
}

// MARK: - classifyIngress (spec 4.2)

test("a plain loopback request is class loopback", () => {
  withFixture(null, () => {
    assert.equal(classifyIngress(new Request(URL_LOOPBACK)), "loopback");
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, { headers: { origin: "http://127.0.0.1:4320" } })),
      "loopback",
    );
  });
});

// The framework synthesizes x-forwarded-* on every accepted request
// (next's base-server `??=` fills them from the socket). A loopback-valued
// echo is not real proxy material; anything stronger is.
test("the framework's loopback-valued echo still classifies loopback", () => {
  withFixture(null, () => {
    const echo = {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "127.0.0.1:4320",
      "x-forwarded-port": "4320",
      "x-forwarded-proto": "http",
    };
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, { headers: echo })),
      "loopback",
    );
    // A loopback chain and the v6 forms echo the same way.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: { ...echo, "x-forwarded-for": "::1, 127.0.0.1" },
      })),
      "loopback",
    );
  });
});

test("loopback URL plus any real proxy material is class unknown", () => {
  const dir = tailnetConfigDir();
  const config = join(dir, "config.json");
  withFixture(config, () => {
    // A loopback echo that claims https: a real proxy spoke without
    // tailnet identity — not the framework filling the blanks.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
        },
      })),
      "unknown",
    );
    // A forwarded host outside loopback is real proxy material too.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-host": "example.com",
          "x-forwarded-proto": "http",
        },
      })),
      "unknown",
    );
    // An XFF chain holding one remote hop is not an echo.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: {
          "x-forwarded-for": "127.0.0.1, 203.0.113.9",
          "x-forwarded-proto": "http",
        },
      })),
      "unknown",
    );
  });
});

test("the complete tailnet header set earns class tailnet", () => {
  const dir = tailnetConfigDir();
  withFixture(join(dir, "config.json"), () => {
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, { headers: tailnetHeaders() })),
      "tailnet",
    );
    // The tailnet v6 first hop is as good as the CGNAT one.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: tailnetHeaders({ "x-forwarded-for": "fd7a:115c:a1e0::2" }),
      })),
      "tailnet",
    );
    // A proxy chain's first hop is the client address: later hops may be
    // anything, only entry zero is trusted.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: tailnetHeaders({ "x-forwarded-for": "100.64.1.2, 10.0.0.1" }),
      })),
      "tailnet",
    );
  });
});

test("any partial or forged proxy material is class unknown", () => {
  const dir = tailnetConfigDir();
  const config = join(dir, "config.json");
  const cases: Record<string, Record<string, string>> = {
    "forwarding without identity": { "x-forwarded-for": "100.64.1.2", "x-forwarded-proto": "https" },
    "identity without forwarding": { "tailscale-user-login": TAILNET.userLogin },
    "login mismatch": tailnetHeaders({ "tailscale-user-login": "someone-else@tailnet.example" }),
    "proto not https": tailnetHeaders({ "x-forwarded-proto": "http" }),
    "hop outside tailnet space": tailnetHeaders({ "x-forwarded-for": "8.8.8.8" }),
    "second hop tailnet, first public": tailnetHeaders({ "x-forwarded-for": "8.8.8.8, 100.64.1.2" }),
    "edge of CGNAT range below": tailnetHeaders({ "x-forwarded-for": "100.63.255.255" }),
    "edge of CGNAT range above": tailnetHeaders({ "x-forwarded-for": "100.128.0.0" }),
    "tailnet-adjacent v6": tailnetHeaders({ "x-forwarded-for": "fd7a:115c:a1e1::1" }),
    "empty first hop": tailnetHeaders({ "x-forwarded-for": " , 100.64.1.2" }),
    "forwarded header alone": { forwarded: "for=100.64.1.2;proto=https" },
  };
  withFixture(config, () => {
    for (const [name, headers] of Object.entries(cases)) {
      assert.equal(
        classifyIngress(new Request(URL_LOOPBACK, { headers })),
        "unknown",
        name,
      );
    }
  });
});

test("a repeated single-value header is a conflict, never tailnet", () => {
  const dir = tailnetConfigDir();
  withFixture(join(dir, "config.json"), () => {
    // Headers folds a repeated field into one comma-joined value.
    const duplicated = new Headers();
    duplicated.append("tailscale-user-login", TAILNET.userLogin);
    duplicated.append("tailscale-user-login", TAILNET.userLogin);
    duplicated.set("x-forwarded-for", "100.64.1.2");
    duplicated.set("x-forwarded-proto", "https");
    assert.equal(classifyIngress(new Request(URL_LOOPBACK, { headers: duplicated })), "unknown");
    const protoDup = new Headers(tailnetHeaders());
    protoDup.append("x-forwarded-proto", "https");
    assert.equal(classifyIngress(new Request(URL_LOOPBACK, { headers: protoDup })), "unknown");
  });
});

test("phoneEnabled false with any proxy header is unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-cfg-"));
  const config = writeConfig(dir, { credentials: [credentialRow()] });
  withFixture(config, () => {
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, { headers: tailnetHeaders() })),
      "unknown",
    );
  });
});

// `--revoke-phone` flips phoneEnabled but keeps the tailnet record, so a
// revoked phone's requests still prove the enrolled signature. They classify
// `tailnet` — the auth layer's phoneDisabled check then answers
// credential_invalid (§4.8) instead of an ingress refusal the phone reads as
// runtimeDown.
test("phoneEnabled false with the tailnet record still classifies tailnet", () => {
  const dir = tailnetConfigDir({ phoneEnabled: false, credentials: [credentialRow()] });
  withFixture(join(dir, "config.json"), () => {
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, { headers: tailnetHeaders() })),
      "tailnet",
    );
    // A signature that does not match stays fail-closed.
    assert.equal(
      classifyIngress(new Request(URL_LOOPBACK, {
        headers: tailnetHeaders({ "tailscale-user-login": "someone-else@tailnet.example" }),
      })),
      "unknown",
    );
  });
});

test("a request URL off loopback with no proxy headers is unknown", () => {
  withFixture(null, () => {
    assert.equal(classifyIngress(new Request("http://192.168.1.10:4320/api/x")), "unknown");
    assert.equal(classifyIngress(new Request("https://evil.example/api/x")), "unknown");
  });
});

// MARK: - origin check (spec 4.3.7)

test("the configured tailnet origin passes only on tailnet ingress", () => {
  const dir = tailnetConfigDir();
  const config = join(dir, "config.json");
  withFixture(config, () => {
    const tailnetReq = new Request(URL_LOOPBACK, {
      headers: tailnetHeaders({ origin: TAILNET.httpsOrigin }),
    });
    assert.equal(originAllowed(tailnetReq), true);
    // The same origin over loopback is still just a foreign origin.
    const loopbackReq = new Request(URL_LOOPBACK, {
      headers: { origin: TAILNET.httpsOrigin },
    });
    assert.equal(originAllowed(loopbackReq), false);
    // `Origin: null` is refused on both classes.
    const nullOrigin = new Request(URL_LOOPBACK, {
      headers: tailnetHeaders({ origin: "null" }),
    });
    assert.equal(originAllowed(nullOrigin), false);
  });
});

// MARK: - credential binding (spec S9)

test("a credential-bound session is capped at the credential expiry", () => {
  const dir = tailnetConfigDir({ credentials: [credentialRow()] });
  withFixture(join(dir, "config.json"), () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const made = createBrowserSession("phone", "phone", "device-phone", soon);
    const stored = getBrowserSession(made.token);
    assert.equal(stored?.credentialId, "device-phone");
    assert.equal(stored?.expiresAt, Date.parse(soon));
  });
});

test("verifyDeviceToken returns the bound credential row", () => {
  const dir = tailnetConfigDir({ credentials: [credentialRow()] });
  withFixture(join(dir, "config.json"), () => {
    const identity = verifyDeviceToken(PHONE_TOKEN);
    assert.equal(identity?.credentialId, "device-phone");
    assert.equal(identity?.profile, "phone");
    assert.equal(verifyDeviceToken("wrong-token"), null);
  });
});

test("revocation without restart: the next read fails the row", () => {
  const dir = tailnetConfigDir({ credentials: [credentialRow()] });
  const config = join(dir, "config.json");
  withFixture(config, () => {
    assert.notEqual(credentialById("device-phone"), null);
    // Rewrite the config in place (the ops flow): the mtime-keyed cache has
    // to notice without the process restarting.
    writeConfig(dir, {
      phoneEnabled: true,
      tailnet: TAILNET,
      credentials: [credentialRow({ revokedAt: new Date().toISOString() })],
    });
    utimesSync(config, new Date(), new Date(Date.now() + 10_000));
    assert.equal(credentialById("device-phone"), null);
    assert.equal(verifyDeviceToken(PHONE_TOKEN), null);
  });
});

test("rotation kills sessions bound to the replaced credential (S9)", () => {
  // --rotate-phone mints a per-mint-unique row id; a session bound to the
  // revoked row resolves nothing even though a live phone row exists.
  const dir = tailnetConfigDir({
    credentials: [
      credentialRow({ id: "device-phone-old01", revokedAt: new Date().toISOString() }),
      credentialRow({ id: "device-phone-new02", sha256: sha256("rotated-phone-token-32-bytes-pad") }),
    ],
  });
  withFixture(join(dir, "config.json"), () => {
    assert.equal(credentialById("device-phone-old01"), null);
    assert.notEqual(credentialById("device-phone-new02"), null);
    assert.equal(verifyDeviceToken(PHONE_TOKEN), null);
    assert.equal(verifyDeviceToken("rotated-phone-token-32-bytes-pad")?.profile, "phone");
  });
});

test("expired and missing rows resolve to nothing", () => {
  const dir = tailnetConfigDir({
    credentials: [
      credentialRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      credentialRow({ id: "device-desktop", sha256: sha256(DESKTOP_TOKEN), callerId: "desktop", profile: "desktop" }),
    ],
  });
  withFixture(join(dir, "config.json"), () => {
    assert.equal(credentialById("device-phone"), null);
    assert.equal(credentialById("nonexistent"), null);
    assert.equal(verifyDeviceToken(PHONE_TOKEN), null);
    assert.equal(verifyDeviceToken(DESKTOP_TOKEN)?.credentialId, "device-desktop");
  });
});

test("phoneDisabled follows the config flag", () => {
  const dir = tailnetConfigDir();
  withFixture(join(dir, "config.json"), () => {
    assert.equal(phoneDisabled(), false);
  });
  const off = mkdtempSync(join(tmpdir(), "ub-cfg-"));
  writeConfig(off, {});
  withFixture(join(off, "config.json"), () => {
    assert.equal(phoneDisabled(), true);
  });
});

// MARK: - session cookie (spec S4)

test("Secure lands on the cookie only when tailnet asks for it", () => {
  const plain = sessionCookie("tok");
  assert.match(plain, /^ub_session=tok;/);
  assert.doesNotMatch(plain, /Secure/);
  const secure = sessionCookie("tok", { secure: true });
  assert.match(secure, /; Secure$/);
});

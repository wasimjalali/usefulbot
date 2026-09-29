import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The contract fixtures (spec §18): real route-handler responses recorded by
 * scripts/ios-contract-fixtures.mjs against a fixture config. These tests pin
 * the contract's invariants so a route change that regenerates fixtures also
 * has to answer for the shape it produced — a stub never substitutes for a
 * real response, and a drifted response never passes unnoticed.
 */

const DIR = join(import.meta.dirname, "fixtures/ios-contract");

function fixture(name: string): {
  note?: string;
  request: { method: string; path: string; headers: Record<string, string> };
  response: { status: number; setCookie: boolean; json: Record<string, unknown> | null };
} {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
}

test("every fixture is a recorded exchange, not a hand stub", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 8, "auth contract coverage is thin");
  for (const file of files) {
    const record = fixture(file.replace(/\.json$/, ""));
    assert.ok(record.request?.path, `${file} lacks a request`);
    assert.ok(record.response && typeof record.response.status === "number", `${file} lacks a response`);
    assert.ok(record.note, `${file} lacks a note naming what it covers`);
    // Secrets never land in the repo: per-run tokens are placeholders.
    const text = readFileSync(join(DIR, file), "utf8");
    assert.ok(!/ub_session=\S{8,}/.test(text), `${file} leaks a session cookie`);
    if (record.response.json?.csrfToken !== undefined) {
      assert.equal(record.response.json?.csrfToken, "<csrfToken>", `${file} leaks a CSRF token`);
    }
    if (record.request?.headers?.["x-ub-csrf"] !== undefined) {
      assert.equal(record.request.headers["x-ub-csrf"], "<csrfToken>", `${file} leaks a CSRF token in request headers`);
    }
  }
});

test("auth.get-loopback-auto-session: S8 loopback auto-session", () => {
  const { response } = fixture("auth.get-loopback-auto-session");
  assert.equal(response.status, 200);
  assert.equal(response.setCookie, true);
  assert.equal(response.json?.ok, true);
  assert.equal(response.json?.profile, "desktop");
  assert.ok(typeof response.json?.expiresAt === "number");
});

test("auth.get-tailnet-no-session: tailnet never auto-sessions", () => {
  const { response } = fixture("auth.get-tailnet-no-session");
  assert.equal(response.status, 401);
  assert.equal(response.setCookie, false);
});

test("auth.post-tailnet-phone: the phone credential exchanges over tailnet", () => {
  const { response } = fixture("auth.post-tailnet-phone");
  assert.equal(response.status, 200);
  assert.equal(response.setCookie, true);
  assert.equal(response.json?.profile, "phone");
  assert.ok(response.json?.credentialExpiresAt, "the bound credential's clock is reported (§6.2)");
});

test("auth.post-tailnet-desktop-credential: F3 refusal", () => {
  const { response } = fixture("auth.post-tailnet-desktop-credential");
  assert.equal(response.status, 403);
  assert.equal(response.json?.error, "forbidden");
});

test("auth.post-loopback-phone: the §7.3 dev path", () => {
  const { response } = fixture("auth.post-loopback-phone");
  assert.equal(response.status, 200);
  assert.equal(response.json?.profile, "phone");
});

test("auth.post-unknown-ingress: foreign proxy material is refused", () => {
  const { response } = fixture("auth.post-unknown-ingress");
  assert.equal(response.status, 403);
  assert.equal(response.json?.error, "ingress");
});

test("auth.get-session-phone: the session reads back both clocks", () => {
  const { response } = fixture("auth.get-session-phone");
  assert.equal(response.status, 200);
  assert.equal(response.json?.profile, "phone");
  assert.ok(response.json?.credentialExpiresAt);
});

test("auth.delete-session: sign-out destroys the session", () => {
  const { response } = fixture("auth.delete-session");
  assert.equal(response.status, 200);
  assert.equal(response.json?.ok, true);
});

test("status.phone-owner: requireOwner over the phone session (S15)", () => {
  const { response } = fixture("status.phone-owner");
  assert.equal(response.status, 200);
  assert.equal(response.json?.apiVersion, 1);
  assert.equal(response.json?.profile, "phone");
});

test("status.unauthenticated: no session is not a gate pass", () => {
  const { response } = fixture("status.unauthenticated");
  assert.equal(response.status, 401);
});

test("status.session-revoked: S9 — revoked bound credential is terminal", () => {
  const { response } = fixture("status.session-revoked");
  assert.equal(response.status, 401);
  assert.equal(response.json?.error, "credential_invalid");
});

test("auth.get-session-revoked: S9 — introspection answers the same verdict", () => {
  const { response } = fixture("auth.get-session-revoked");
  assert.equal(response.status, 401);
  assert.equal(response.json?.error, "credential_invalid");
  // The dead session is destroyed and the cookie cleared, not just refused.
  assert.equal(response.setCookie, true);
});

test("auth.post-phone-disabled: S9 — a disabled phone credential never mints", () => {
  const { response } = fixture("auth.post-phone-disabled");
  assert.equal(response.status, 401);
  assert.equal(response.json?.error, "credential_invalid");
  assert.equal(response.setCookie, false);
});

test("auth.post-phone-disabled-tailnet: same verdict over the enrolled tailnet", () => {
  const { response } = fixture("auth.post-phone-disabled-tailnet");
  assert.equal(response.status, 401);
  assert.equal(response.json?.error, "credential_invalid");
  assert.equal(response.setCookie, false);
});

test("status.phone-disabled-tailnet: the gate answers credential_invalid over tailnet", () => {
  const { response } = fixture("status.phone-disabled-tailnet");
  assert.equal(response.status, 401);
  assert.equal(response.json?.error, "credential_invalid");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerMode } from "../shared/provider-catalog.ts";
import {
  accessTokenFor,
  cancelDeviceFlow,
  exchangeCopilotToken,
  pollDeviceFlow,
  refreshCredential,
  startDeviceFlow,
} from "../shared/provider-oauth.ts";

function box(): string {
  const path = join(mkdtempSync(join(tmpdir(), "ub-poauth-")), "provider-oauth.json");
  process.env.UB_PROVIDER_OAUTH_PATH = path;
  return path;
}

test.afterEach(() => {
  delete process.env.UB_PROVIDER_OAUTH_PATH;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  return typeof body === "string" ? body : String(body ?? "");
}

test("github start posts a form body to the device endpoint", async () => {
  box();
  const oauth = providerMode("github-copilot", "oauth").oauth!;
  let seenUrl = "";
  let seenForm = "";
  const stub: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenForm = bodyText(init);
    return json({
      device_code: "dev-gh-1",
      user_code: "12AB-34CD",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
  };
  const pending = await startDeviceFlow("github-copilot", stub);
  assert.equal(seenUrl, oauth.deviceUrl);
  assert.ok(seenForm.includes(`client_id=${encodeURIComponent(oauth.clientId)}`));
  assert.ok(seenForm.includes("scope=read%3Auser"));
  assert.equal(pending.userCode, "12AB-34CD");
  assert.equal(pending.verificationUrlComplete, null);
});

test("start throws when the vendor answer is incomplete", async () => {
  box();
  const stub: typeof fetch = async () => json({ user_code: "X" });
  await assert.rejects(() => startDeviceFlow("github-copilot", stub), /oauth_device_start/);
  // The ChatGPT sign-in is a browser flow, not a device flow.
  await assert.rejects(() => startDeviceFlow("openai", stub), /provider_oauth/);
  const bad: typeof fetch = async () => new Response("no", { status: 400 });
  await assert.rejects(() => startDeviceFlow("github-copilot", bad), /oauth_device_start/);
});

test("github poll maps pending, slow_down, expired and denied", async () => {
  box();
  const start: typeof fetch = async () => json({
    device_code: "dev-gh-3",
    user_code: "FFFF-6666",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  });
  const first = await startDeviceFlow("github-copilot", start);
  assert.equal((await pollDeviceFlow(first.pollId, async () => json({ error: "authorization_pending" }))).status, "pending");
  assert.equal((await pollDeviceFlow(first.pollId, async () => json({ error: "slow_down" }))).status, "slow_down");
  const second = await startDeviceFlow("github-copilot", start);
  assert.equal((await pollDeviceFlow(second.pollId, async () => json({ error: "expired_token" }))).status, "expired");
  const third = await startDeviceFlow("github-copilot", start);
  assert.equal((await pollDeviceFlow(third.pollId, async () => json({ error: "access_denied" }))).status, "denied");
  await assert.rejects(() => pollDeviceFlow("nope", async () => json({})), /oauth_poll_unknown/);
});

test("cancel drops the pending flow", async () => {
  box();
  const start: typeof fetch = async () => json({
    device_code: "dev-gh-7",
    user_code: "CCCC-4444",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  });
  const pending = await startDeviceFlow("github-copilot", start);
  cancelDeviceFlow(pending.pollId);
  await assert.rejects(() => pollDeviceFlow(pending.pollId, start), /oauth_poll_unknown/);
});

test("github poll attaches the exchanged token, or completes direct when it 404s", async () => {
  box();
  const start: typeof fetch = async () => json({
    device_code: "dev-gh-2",
    user_code: "EEEE-5555",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  });
  const exchangeUrl = providerMode("github-copilot", "oauth").oauth!.exchangeUrl!;
  const future = Math.floor(Date.now() / 1000) + 1800;
  const full: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === exchangeUrl) {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer ghu_x");
      return json({ token: "cop_1", expires_at: future, refresh_in: 1500 });
    }
    return json({ access_token: "ghu_x", token_type: "bearer", scope: "read:user" });
  };
  const pending = await startDeviceFlow("github-copilot", start);
  const result = await pollDeviceFlow(pending.pollId, full);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.credential, {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
    exchanged: { token: "cop_1", expiresAt: future * 1000 },
  });

  const pending2 = await startDeviceFlow("github-copilot", start);
  const dead: typeof fetch = async (input) => {
    if (String(input) === exchangeUrl) return new Response("no", { status: 404 });
    return json({ access_token: "ghu_y" });
  };
  const direct = await pollDeviceFlow(pending2.pollId, dead);
  assert.equal(direct.status, "complete");
  assert.equal(direct.credential?.kind, "oauth");
  if (direct.credential?.kind !== "oauth") throw new Error("unreachable");
  assert.equal(direct.credential.exchanged, undefined);
});

test("github refresh exchanges only when missing or expiring soon", async () => {
  box();
  let calls = 0;
  const exchange: typeof fetch = async (input) => {
    if (String(input).includes("copilot_internal")) {
      calls += 1;
      return json({ token: "cop_new", refresh_in: 1500 });
    }
    throw new Error(`unexpected ${String(input)}`);
  };
  const fresh = await refreshCredential("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
    exchanged: { token: "cop_old", expiresAt: Date.now() + 60 * 60 * 1000 },
  }, exchange);
  assert.equal(calls, 0);
  if (fresh.kind !== "oauth") throw new Error("unreachable");
  assert.equal(fresh.exchanged?.token, "cop_old");

  const missing = await refreshCredential("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
  }, exchange);
  assert.equal(calls, 1);
  if (missing.kind !== "oauth") throw new Error("unreachable");
  assert.equal(missing.exchanged?.token, "cop_new");

  const soon = await refreshCredential("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
    exchanged: { token: "cop_old", expiresAt: Date.now() + 60_000 },
  }, exchange);
  assert.equal(calls, 2);
  if (soon.kind !== "oauth") throw new Error("unreachable");
  assert.equal(soon.exchanged?.token, "cop_new");

  // A stale exchanged token that will not renew is loud, not silent.
  const dead: typeof fetch = async () => new Response("no", { status: 404 });
  await assert.rejects(() => refreshCredential("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
    exchanged: { token: "cop_old", expiresAt: Date.now() - 1000 },
  }, dead), /oauth_exchange/);
  // Direct-token mode stays direct.
  const direct = await refreshCredential("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
  }, dead);
  assert.equal(direct.kind, "oauth");
  if (direct.kind !== "oauth") throw new Error("unreachable");
  assert.equal(direct.accessToken, "ghu_x");
  assert.equal(direct.exchanged, undefined);
});

test("exchangeCopilotToken rejects answers without a token or expiry", async () => {
  box();
  await assert.rejects(() => exchangeCopilotToken("ghu_x", async () => json({ refresh_in: 1500 })), /oauth_exchange/);
  await assert.rejects(() => exchangeCopilotToken("ghu_x", async () => new Response("no", { status: 401 })), /oauth_exchange/);
});

test("accessTokenFor picks the token, expiry and headers", () => {
  const openai = accessTokenFor("openai", {
    kind: "oauth",
    accessToken: "acc",
    refreshToken: "ref",
    expiresAt: Date.now() + 3600_000,
    accountId: null,
    clientId: "oaiapp_1",
  });
  assert.deepEqual(openai, { token: "acc", expired: false, headers: {} });
  assert.equal(accessTokenFor("openai", {
    kind: "oauth",
    accessToken: "acc",
    refreshToken: null,
    expiresAt: Date.now() - 1,
    accountId: null,
    clientId: "oaiapp_1",
  }).expired, true);
  // The old Codex sign-in has no issued client id: expired whatever its expiry says.
  assert.equal(accessTokenFor("openai", {
    kind: "oauth",
    accessToken: "acc",
    refreshToken: "ref",
    expiresAt: Date.now() + 3600_000,
    accountId: "acct_1",
  }).expired, true);
  const copilot = accessTokenFor("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
    exchanged: { token: "cop_1", expiresAt: Date.now() + 1000 },
  });
  assert.equal(copilot.token, "cop_1");
  assert.equal(copilot.expired, false);
  assert.equal(accessTokenFor("github-copilot", {
    kind: "oauth",
    accessToken: "ghu_x",
    refreshToken: null,
    expiresAt: null,
    accountId: null,
  }).token, "ghu_x");
  assert.deepEqual(accessTokenFor("openai", { kind: "key", key: "sk-1" }), { token: "sk-1", expired: false, headers: {} });
  assert.deepEqual(accessTokenFor("ollama", { kind: "none" }), { token: "", expired: false, headers: {} });
});


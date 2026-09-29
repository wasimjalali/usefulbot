import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerMode } from "../shared/provider-catalog.ts";
import {
  accessTokenFor,
  cancelDeviceFlow,
  decodeJwtAccountId,
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

function jwt(payload: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  return typeof body === "string" ? body : String(body ?? "");
}

test("openai start posts only the client id and persists the Codex flow", async () => {
  const path = box();
  const oauth = providerMode("openai", "oauth").oauth!;
  let seenUrl = "";
  let seenBody = "";
  const stub: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = bodyText(init);
    return json({ device_auth_id: "dev-openai-1", user_code: "ABCD-EFGH", interval: "5" });
  };
  const before = Date.now();
  const pending = await startDeviceFlow("openai", stub);
  assert.equal(seenUrl, oauth.deviceUrl);
  assert.deepEqual(JSON.parse(seenBody), { client_id: oauth.clientId });
  assert.equal(pending.providerId, "openai");
  assert.equal(pending.deviceCode, "dev-openai-1");
  assert.equal(pending.userCode, "ABCD-EFGH");
  assert.equal(pending.verificationUrl, oauth.verificationUrl);
  assert.equal(pending.verificationUrlComplete, null);
  assert.equal(pending.intervalMs, 5000);
  assert.ok(pending.expiresAt >= before + 15 * 60 * 1000);
  assert.ok(pending.expiresAt <= Date.now() + 15 * 60 * 1000);
  const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.ok(stored[pending.pollId]);

  // The usercode alias works, and a missing interval means five seconds.
  const alias = await startDeviceFlow("openai", async () => json({ device_auth_id: "dev-openai-1b", usercode: "WXYZ-9999" }));
  assert.equal(alias.userCode, "WXYZ-9999");
  assert.equal(alias.intervalMs, 5000);
});

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
  await assert.rejects(() => startDeviceFlow("openai", stub), /oauth_device_start/);
  const bad: typeof fetch = async () => new Response("no", { status: 400 });
  await assert.rejects(() => startDeviceFlow("github-copilot", bad), /oauth_device_start/);
});

test("openai poll stays pending on 403 then 404", async () => {
  box();
  const oauth = providerMode("openai", "oauth").oauth!;
  const start: typeof fetch = async () => json({ device_auth_id: "dev-openai-2", user_code: "WXYZ-1234", interval: "5" });
  const pending = await startDeviceFlow("openai", start);
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const waiting = (status: number): typeof fetch => async (input, init) => {
    seen.push({ url: String(input), body: JSON.parse(bodyText(init)) });
    return new Response(JSON.stringify({ error: "waiting" }), { status });
  };
  const first403 = await pollDeviceFlow(pending.pollId, waiting(403));
  assert.equal(first403.status, "pending");
  assert.equal(first403.providerId, "openai");
  assert.equal(first403.intervalMs, 5000);
  assert.equal((await pollDeviceFlow(pending.pollId, waiting(404))).status, "pending");
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.url, oauth.pollUrl);
    assert.deepEqual(call.body, { device_auth_id: "dev-openai-2", user_code: "WXYZ-1234" });
  }
  // Other failures are errors, and the entry stays for the next poll.
  const errored = await pollDeviceFlow(pending.pollId, async () => new Response("bad", { status: 500 }));
  assert.deepEqual({ status: errored.status, error: errored.error }, {
    status: "error",
    error: "oauth_poll",
  });
});

test("openai poll completes through the code exchange with the account id", async () => {
  box();
  const oauth = providerMode("openai", "oauth").oauth!;
  const start: typeof fetch = async () => json({ device_auth_id: "dev-openai-3", user_code: "QQQQ-1111", interval: "5" });
  const pending = await startDeviceFlow("openai", start);
  let seenPollBody: Record<string, unknown> = {};
  let seenExchangeForm = "";
  let seenExchangeContentType = "";
  const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === oauth.tokenUrl) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenExchangeContentType = headers["content-type"] ?? "";
      seenExchangeForm = bodyText(init);
      return json({
        id_token: idToken,
        access_token: "acc-openai",
        refresh_token: "ref-openai",
        expires_in: 3600,
      });
    }
    assert.equal(url, oauth.pollUrl);
    seenPollBody = JSON.parse(bodyText(init));
    return json({ authorization_code: "auth-code-1", code_challenge: "chal-1", code_verifier: "ver-1" });
  };
  const result = await pollDeviceFlow(pending.pollId, stub);
  assert.equal(result.status, "complete");
  assert.deepEqual(seenPollBody, { device_auth_id: "dev-openai-3", user_code: "QQQQ-1111" });
  assert.equal(seenExchangeContentType, "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seenExchangeForm)), {
    grant_type: "authorization_code",
    code: "auth-code-1",
    redirect_uri: oauth.redirectUri,
    client_id: oauth.clientId,
    code_verifier: "ver-1",
  });
  assert.deepEqual(result.credential, {
    kind: "oauth",
    accessToken: "acc-openai",
    refreshToken: "ref-openai",
    expiresAt: result.credential?.kind === "oauth" ? result.credential.expiresAt : null,
    accountId: "acct_123",
  });
  // Settled: polling again is unknown.
  await assert.rejects(() => pollDeviceFlow(pending.pollId, stub), /oauth_poll_unknown/);
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

test("openai poll keeps the entry on transport errors", async () => {
  box();
  const oauth = providerMode("openai", "oauth").oauth!;
  const start: typeof fetch = async () => json({ device_auth_id: "dev-openai-5", user_code: "AAAA-2222", interval: "5" });
  const pending = await startDeviceFlow("openai", start);
  const down: typeof fetch = async () => {
    throw new Error("down");
  };
  const downed = await pollDeviceFlow(pending.pollId, down);
  assert.deepEqual({ status: downed.status, error: downed.error }, { status: "error", error: "oauth_poll" });
  const done: typeof fetch = async (input) => {
    if (String(input) === oauth.tokenUrl) return json({ access_token: "acc-2", expires_in: 60 });
    return json({ authorization_code: "auth-code-5", code_challenge: "chal-5", code_verifier: "ver-5" });
  };
  assert.equal((await pollDeviceFlow(pending.pollId, done)).status, "complete");
});

test("openai poll reports expired once the code lifetime passes", async () => {
  const path = box();
  const start: typeof fetch = async () => json({ device_auth_id: "dev-openai-6", user_code: "BBBB-3333", interval: "5" });
  const pending = await startDeviceFlow("openai", start);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
  raw[pending.pollId] = { ...raw[pending.pollId], expiresAt: Date.now() - 1000 };
  writeFileSync(path, JSON.stringify(raw));
  assert.equal((await pollDeviceFlow(pending.pollId, start)).status, "expired");
  // Settled: polling again is unknown.
  await assert.rejects(() => pollDeviceFlow(pending.pollId, start), /oauth_poll_unknown/);
});

test("cancel drops the pending flow", async () => {
  box();
  const start: typeof fetch = async () => json({ device_auth_id: "dev-openai-7", user_code: "CCCC-4444", interval: "5" });
  const pending = await startDeviceFlow("openai", start);
  cancelDeviceFlow(pending.pollId);
  await assert.rejects(() => pollDeviceFlow(pending.pollId, start), /oauth_poll_unknown/);
});

test("openai refresh rotates tokens and keeps the account id", async () => {
  box();
  const oauth = providerMode("openai", "oauth").oauth!;
  const stub: typeof fetch = async (input, init) => {
    assert.equal(String(input), oauth.tokenUrl);
    const body = JSON.parse(bodyText(init)) as Record<string, unknown>;
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "ref-old");
    assert.equal(body.client_id, oauth.clientId);
    return json({ access_token: "acc-new", expires_in: 3600 });
  };
  const next = await refreshCredential("openai", {
    kind: "oauth",
    accessToken: "acc-old",
    refreshToken: "ref-old",
    expiresAt: Date.now() - 1000,
    accountId: "acct_123",
  }, stub);
  assert.equal(next.kind, "oauth");
  if (next.kind !== "oauth") throw new Error("unreachable");
  assert.equal(next.accessToken, "acc-new");
  assert.equal(next.refreshToken, "ref-old");
  assert.equal(next.accountId, "acct_123");
  assert.ok((next.expiresAt ?? 0) > Date.now());
  await assert.rejects(
    () => refreshCredential("openai", { kind: "oauth", accessToken: "x", refreshToken: null, expiresAt: null, accountId: null }, stub),
    /oauth_refresh/,
  );
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
    accountId: "acct_1",
  });
  assert.deepEqual(openai, { token: "acc", expired: false, headers: { "ChatGPT-Account-Id": "acct_1" } });
  assert.equal(accessTokenFor("openai", {
    kind: "oauth",
    accessToken: "acc",
    refreshToken: null,
    expiresAt: Date.now() - 1,
    accountId: null,
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

test("decodeJwtAccountId reads the account claim forms and nothing else", () => {
  assert.equal(
    decodeJwtAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_ns" } })),
    "acct_ns",
  );
  assert.equal(decodeJwtAccountId(jwt({ chatgpt_account_id: "acct_top" })), "acct_top");
  assert.equal(decodeJwtAccountId(jwt({ organizations: [{ id: "org_1" }] })), "org_1");
  assert.equal(decodeJwtAccountId(jwt({ sub: "user_1" })), null);
  assert.equal(decodeJwtAccountId("not-a-jwt"), null);
  assert.equal(decodeJwtAccountId(""), null);
});

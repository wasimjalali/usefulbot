import assert from "node:assert/strict";
import test from "node:test";
import { accessTokenFor, refreshCredential } from "../shared/provider-oauth.ts";

test("only ChatGPT refreshes: any other provider's sign-in is refused", async () => {
  const credential = { kind: "oauth" as const, accessToken: "tok", refreshToken: null, expiresAt: null, accountId: null };
  await assert.rejects(() => refreshCredential("github-copilot", credential), /provider_oauth/);
  await assert.rejects(() => refreshCredential("openai", { kind: "key", key: "k" }), /provider_oauth/);
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
  assert.deepEqual(accessTokenFor("openai", { kind: "key", key: "sk-1" }), { token: "sk-1", expired: false, headers: {} });
  assert.deepEqual(accessTokenFor("ollama", { kind: "none" }), { token: "", expired: false, headers: {} });
});


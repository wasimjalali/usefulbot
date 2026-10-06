import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  cancelChatGptSignIn,
  cancelPendingChatGptSignIn,
  isChatGptPollId,
  completeChatGptSignIn,
  pollChatGptSignIn,
  refreshChatGptCredential,
  revokeChatGptCredential,
  startChatGptSignIn,
} from "../shared/chatgpt-signin.ts";
import { accessTokenFor } from "../shared/provider-oauth.ts";
import { applyProvidersDeleteCapturing } from "../web/lib/providers-write.ts";
import { publicProviders, setOAuthCredential, emptyProviderStore, readProviderStore, writeProviderStore, type Credential } from "../shared/providers.ts";

/*
 * Failure list, written before the module (global rule). Every line is a way
 * the official Sign in with ChatGPT flow can go wrong, and each has a case below:
 *  1  callback state does not match: refused, attempt stays pending, no network call
 *  2  access_denied: settles denied, no code exchange
 *  3  new registration whose callback has no client_id: chatgpt_registration_incomplete
 *  4  reauth callback with another client_id: chatgpt_client_mismatch
 *  5  token endpoint answers 400 invalid_grant: chatgpt_token_exchange
 *  6  ID token with a bad signature, wrong iss, wrong aud, expired, wrong nonce
 *     or unknown kid: chatgpt_id_token_invalid, nothing stored
 *  7  chatgpt.tokens.use.direct not granted: chatgpt_plan_not_enabled, needsConsent
 *     saved, next authorize URL carries prompt=consent and the saved client_id
 *  8  another subject on reauth: chatgpt_account_mismatch, every registration kept,
 *     the user switches with newAccount (a second registration, the first stays)
 *  9  expired attempt: expired, a late callback is refused
 * 10  cancel, then callback: refused
 * 11  second start supersedes the first, the first callback is refused
 * 12  replayed callback after completion: refused
 * 13  authorize URL: every parameter present and encoded, agent_name_hint only on first
 *     registration, id_token_hint only with a live credential, login_hint from the
 *     saved email, loopback redirect_uri exactly, host id stable
 * 14  refresh: issued client_id + resource as a form, rotating refresh token, failure
 *     throws oauth_refresh
 * 15  revoke: 200 confirmed, 500 then 200 confirmed, 400 not confirmed
 * 16  a Codex-era credential without clientId reports expired
 */

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const PORT = 4777;
const REDIRECT = `http://127.0.0.1:${PORT}/auth/callback`;
const ALL_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

const KID = "test-kid-1";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

function box(): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-"));
  const path = join(dir, "chatgpt-signin.json");
  process.env.UB_CHATGPT_SIGNIN_PATH = path;
  process.env.UB_WEB_PORT = String(PORT);
  return path;
}

test.afterEach(() => {
  delete process.env.UB_CHATGPT_SIGNIN_PATH;
  delete process.env.UB_WEB_PORT;
});

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function mint(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof pair.privateKey } = {}): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid: opts.kid ?? KID });
  const body = b64(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(opts.key ?? pair.privateKey).toString("base64url")}`;
}

interface Server {
  calls: Array<{ url: string; form: URLSearchParams | null }>;
  /** The nonce of the attempt being answered, set by signIn(). */
  nonce: string;
  sub: string;
  email: string | null;
  scope: string;
  clientId: string;
  idTokenOverrides: Record<string, unknown>;
  idTokenKid: string;
  idTokenKey: typeof pair.privateKey;
  tokenStatus: number;
  refreshToken: string;
  revokeStatuses: number[];
  fetch: typeof fetch;
}

function authServer(): Server {
  const server: Server = {
    calls: [],
    nonce: "",
    sub: "sub-alice",
    email: "alice@example.com",
    scope: ALL_SCOPES,
    clientId: "oaiapp_alice",
    idTokenOverrides: {},
    idTokenKid: KID,
    idTokenKey: pair.privateKey,
    tokenStatus: 200,
    refreshToken: "refresh-1",
    revokeStatuses: [200],
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body;
      const form = typeof body === "string" ? new URLSearchParams(body) : body instanceof URLSearchParams ? body : null;
      server.calls.push({ url, form });
      const headers = { "content-type": "application/json" };
      if (url === JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers });
      if (url === REVOKE_URL) {
        const status = server.revokeStatuses.length > 1 ? server.revokeStatuses.shift()! : server.revokeStatuses[0]!;
        return new Response("", { status });
      }
      if (url === TOKEN_URL) {
        if (server.tokenStatus !== 200) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: server.tokenStatus, headers });
        }
        const now = Math.floor(Date.now() / 1000);
        if (form?.get("grant_type") === "refresh_token") {
          return new Response(JSON.stringify({
            access_token: `access-after-${form.get("refresh_token")}`,
            refresh_token: `${form.get("refresh_token")}-next`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: server.scope,
          }), { status: 200, headers });
        }
        const idToken = mint({
          iss: ISSUER,
          aud: server.clientId,
          sub: server.sub,
          email: server.email,
          nonce: server.nonce,
          iat: now,
          exp: now + 3600,
          ...server.idTokenOverrides,
        }, { kid: server.idTokenKid, key: server.idTokenKey });
        return new Response(JSON.stringify({
          access_token: "access-1",
          refresh_token: server.refreshToken,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: server.scope,
        }), { status: 200, headers });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  return server;
}

function parse(authorizeUrl: string): { url: URL; q: URLSearchParams } {
  const url = new URL(authorizeUrl);
  return { url, q: url.searchParams };
}

/** Start an attempt and learn its state and nonce the way the browser would hand them back. */
function signIn(server: Server, opts: Parameters<typeof startChatGptSignIn>[0] = {}) {
  const started = startChatGptSignIn(opts);
  const { q } = parse(started.authorizeUrl);
  server.nonce = q.get("nonce") ?? "";
  return { started, q, state: q.get("state") ?? "" };
}

function stateFile(path: string): {
  hostId: string;
  registrations: Array<Record<string, unknown>>;
  lastClientId: string | null;
  retryClientId: string | null;
  pending: Record<string, unknown> | null;
  lastDone: { stateHash: string; at: number } | null;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

function oauthOf(credential: Credential | undefined) {
  assert.ok(credential && credential.kind === "oauth");
  return credential;
}

test("end to end: register, poll, sign in again, refresh and revoke", async () => {
  const path = box();
  const server = authServer();

  // 13 first registration: every parameter, encoded, no returning-user hints.
  const first = signIn(server);
  assert.equal(first.started.intervalMs, 1000);
  assert.equal(first.started.account, null);
  assert.ok(first.started.expiresAt > Date.now() + 9 * 60_000 && first.started.expiresAt <= Date.now() + 10 * 60_000);
  const { url, q } = parse(first.started.authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "dynamic_agent_client");
  assert.equal(q.get("agent_name_hint"), "Useful Bot");
  assert.match(q.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(q.get("resource"), "https://api.openai.com/v1");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("state") ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.match(q.get("nonce") ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  for (const absent of ["id_token_hint", "login_hint", "prompt"]) assert.equal(q.get(absent), null);
  // Encoded: the redirect URI and the host id never appear raw in the query string.
  assert.ok(url.search.includes("redirect_uri=http%3A%2F%2F127.0.0.1%3A4777%2Fauth%2Fcallback"));
  assert.ok(url.search.includes("agent_name_hint=Useful+Bot") || url.search.includes("agent_name_hint=Useful%20Bot"));
  const hostId = q.get("ext_agent_host_id");
  assert.equal(stateFile(path).hostId, hostId);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Pending until the callback lands.
  assert.deepEqual(pollChatGptSignIn(first.started.pollId), { status: "pending" });

  // Callback: new registration carries the issued client_id.
  const persisted: Credential[] = [];
  const done = await completeChatGptSignIn(
    { state: first.state, code: "code-1", error: null, clientId: "oaiapp_alice" },
    server.fetch,
    (stored) => {
      // The credential is stored while the attempt is still unsettled.
      assert.equal(stateFile(path).pending?.outcome, null);
      persisted.push(stored);
    },
  );
  assert.equal(done.status, "complete");
  assert.equal(persisted.length, 1);
  const credential = oauthOf(done.status === "complete" ? done.credential : undefined);
  assert.equal(credential.accessToken, "access-1");
  assert.equal(credential.refreshToken, "refresh-1");
  assert.equal(credential.accountId, null);
  assert.equal(credential.clientId, "oaiapp_alice");
  assert.equal(credential.subject, "sub-alice");
  assert.equal(credential.email, "alice@example.com");
  assert.deepEqual(credential.scopes, ALL_SCOPES.split(" "));
  assert.ok(typeof credential.idToken === "string" && credential.idToken.split(".").length === 3);
  assert.ok((credential.expiresAt ?? 0) > Date.now() + 3_000_000);

  // The exchange: a form with the issued id, the same redirect, the PKCE verifier and no secret.
  const exchange = server.calls.find((call) => call.url === TOKEN_URL)!.form!;
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("client_id"), "oaiapp_alice");
  assert.equal(exchange.get("code"), "code-1");
  assert.equal(exchange.get("redirect_uri"), REDIRECT);
  assert.equal(exchange.get("resource"), "https://api.openai.com/v1");
  assert.equal(exchange.get("client_secret"), null);
  assert.equal(createHash("sha256").update(exchange.get("code_verifier") ?? "").digest("base64url"), q.get("code_challenge"));

  // Poll reports complete once, then the row is gone.
  assert.deepEqual(pollChatGptSignIn(first.started.pollId), { status: "complete" });
  assert.throws(() => pollChatGptSignIn(first.started.pollId), /oauth_poll_unknown/);

  // The registration survives; the connection is ok in the providers payload.
  assert.deepEqual(stateFile(path).registrations, [{
    clientId: "oaiapp_alice",
    subject: "sub-alice",
    email: "alice@example.com",
    needsConsent: false,
  }]);
  assert.equal(stateFile(path).lastClientId, "oaiapp_alice");
  const store = setOAuthCredential(emptyProviderStore(), "openai", credential);
  const row = publicProviders(store).connections.find((c) => c.id === "openai:oauth")!;
  assert.equal(row.status, "ok");
  assert.equal(row.accountLabel, "alice@example.com");

  // 13 returning sign-in: saved client id, login hint, no agent name, same host id.
  const again = signIn(server);
  assert.equal(again.started.account, "alice@example.com");
  assert.equal(again.q.get("client_id"), "oaiapp_alice");
  assert.equal(again.q.get("login_hint"), "alice@example.com");
  assert.equal(again.q.get("agent_name_hint"), null);
  assert.equal(again.q.get("id_token_hint"), null);
  assert.equal(again.q.get("prompt"), null);
  assert.equal(again.q.get("ext_agent_host_id"), hostId);
  // id_token_hint only with a live credential for the same client id.
  const hinted = signIn(server, { storedCredential: credential });
  assert.equal(hinted.q.get("id_token_hint"), credential.idToken);
  const foreign = signIn(server, { storedCredential: { ...credential, clientId: "oaiapp_other" } });
  assert.equal(foreign.q.get("id_token_hint"), null);
  const legacy = signIn(server, { storedCredential: { ...credential, idToken: undefined } });
  assert.equal(legacy.q.get("id_token_hint"), null);

  // 14 refresh: issued client id + resource as a form, rotating tokens.
  const refreshed = oauthOf(await refreshChatGptCredential(credential, server.fetch));
  const refreshForm = server.calls.filter((call) => call.url === TOKEN_URL).at(-1)!.form!;
  assert.equal(refreshForm.get("grant_type"), "refresh_token");
  assert.equal(refreshForm.get("client_id"), "oaiapp_alice");
  assert.equal(refreshForm.get("refresh_token"), "refresh-1");
  assert.equal(refreshForm.get("resource"), "https://api.openai.com/v1");
  assert.equal(refreshForm.get("scope"), null);
  assert.equal(refreshed.accessToken, "access-after-refresh-1");
  assert.equal(refreshed.refreshToken, "refresh-1-next");
  assert.equal(refreshed.clientId, "oaiapp_alice");
  assert.equal(refreshed.subject, "sub-alice");
  assert.equal(refreshed.idToken, credential.idToken);
  assert.deepEqual(refreshed.scopes, ALL_SCOPES.split(" "));
  assert.ok((refreshed.expiresAt ?? 0) > Date.now() + 3_000_000);
  server.tokenStatus = 400;
  await assert.rejects(() => refreshChatGptCredential(refreshed, server.fetch), /oauth_refresh/);
  await assert.rejects(() => refreshChatGptCredential({ ...refreshed, refreshToken: null }, server.fetch), /oauth_refresh/);
  server.tokenStatus = 200;

  // 15 revoke: a form with the token, the hint and the client id.
  assert.equal(await revokeChatGptCredential(refreshed, server.fetch, 5), true);
  const revokeForm = server.calls.filter((call) => call.url === REVOKE_URL).at(-1)!.form!;
  assert.equal(revokeForm.get("token"), "refresh-1-next");
  assert.equal(revokeForm.get("token_type_hint"), "refresh_token");
  assert.equal(revokeForm.get("client_id"), "oaiapp_alice");
});

test("1 state mismatch is refused, leaves the attempt pending and makes no network call", async () => {
  box();
  const server = authServer();
  const { started } = signIn(server);
  const out = await completeChatGptSignIn({ state: "not-the-state", code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(out, { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.length, 0);
  assert.deepEqual(pollChatGptSignIn(started.pollId), { status: "pending" });
  // No pending attempt at all is refused the same way.
  cancelChatGptSignIn(started.pollId);
  const none = await completeChatGptSignIn({ state: "x", code: "c", error: null, clientId: null }, server.fetch);
  assert.deepEqual(none, { status: "refused", error: "chatgpt_state_mismatch" });
});

test("2 access_denied settles denied without an exchange; other errors settle chatgpt_signin_refused", async () => {
  box();
  const server = authServer();
  const a = signIn(server);
  const denied = await completeChatGptSignIn({ state: a.state, code: null, error: "access_denied", clientId: null }, server.fetch);
  assert.deepEqual(denied, { status: "denied" });
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "denied" });
  const b = signIn(server);
  const other = await completeChatGptSignIn({ state: b.state, code: null, error: "server_error", clientId: null }, server.fetch);
  assert.deepEqual(other, { status: "error", error: "chatgpt_signin_refused" });
  assert.deepEqual(pollChatGptSignIn(b.started.pollId), { status: "error", error: "chatgpt_signin_refused" });
  assert.equal(server.calls.length, 0);
});

test("3 a new registration without client_id is incomplete and never saves dynamic_agent_client", async () => {
  const path = box();
  const server = authServer();
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: null }, server.fetch);
  assert.deepEqual(out, { status: "error", error: "chatgpt_registration_incomplete" });
  assert.equal(server.calls.length, 0);
  assert.deepEqual(stateFile(path).registrations, []);
  assert.ok(!readFileSync(path, "utf8").includes('"clientId":"dynamic_agent_client"'));
});

async function register(server: Server): Promise<void> {
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: server.clientId }, server.fetch);
  assert.equal(out.status, "complete");
  pollChatGptSignIn(a.started.pollId);
  server.calls.length = 0;
}

test("4 reauth with a different client_id is a client mismatch", async () => {
  box();
  const server = authServer();
  await register(server);
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_mallory" }, server.fetch);
  assert.deepEqual(out, { status: "error", error: "chatgpt_client_mismatch" });
  assert.equal(server.calls.length, 0);
  // The callback may also omit client_id on reauth: the saved one is used.
  const b = signIn(server);
  const ok = await completeChatGptSignIn({ state: b.state, code: "c", error: null, clientId: null }, server.fetch);
  assert.equal(ok.status, "complete");
});

const PROVISIONAL = { clientId: "oaiapp_alice", subject: null, email: null, needsConsent: false };

test("5 a 400 invalid_grant is chatgpt_token_exchange and the issued client id is kept provisionally", async () => {
  const path = box();
  const server = authServer();
  server.tokenStatus = 400;
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(out, { status: "error", error: "chatgpt_token_exchange" });
  assert.deepEqual(stateFile(path).registrations, [PROVISIONAL]);
  assert.equal(stateFile(path).lastClientId, null, "only a validated identity becomes the last client");
  assert.equal(stateFile(path).retryClientId, "oaiapp_alice");
  // The poll names the issued client so the app can offer "Try again" with it.
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "error", error: "chatgpt_token_exchange", retryClientId: "oaiapp_alice" });
  // A plain start never reuses a provisional client; only an explicit retry does.
  server.tokenStatus = 200;
  assert.equal(signIn(server).q.get("client_id"), "dynamic_agent_client");
  assert.equal(signIn(server, { newAccount: true }).q.get("client_id"), "dynamic_agent_client");
  const retry = signIn(server, { retryClientId: "oaiapp_alice" });
  assert.equal(retry.q.get("client_id"), "oaiapp_alice");
  assert.equal(retry.q.get("agent_name_hint"), null);
  assert.equal(retry.started.clientId, "oaiapp_alice");
  const done = await completeChatGptSignIn({ state: retry.state, code: "c2", error: null, clientId: null }, server.fetch);
  assert.equal(done.status, "complete");
  assert.deepEqual(stateFile(path).registrations, [{ clientId: "oaiapp_alice", subject: "sub-alice", email: "alice@example.com", needsConsent: false }]);
});

test("6 a bad ID token is rejected for each broken field and nothing is stored", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const cases: Array<[string, (s: Server) => void]> = [
    ["bad signature", (s) => { s.idTokenKey = otherPair.privateKey; }],
    ["wrong iss", (s) => { s.idTokenOverrides = { iss: "https://evil.example" }; }],
    ["wrong aud", (s) => { s.idTokenOverrides = { aud: "oaiapp_someone_else" }; }],
    ["aud array without the client", (s) => { s.idTokenOverrides = { aud: ["a", "b"] }; }],
    ["expired", (s) => { s.idTokenOverrides = { exp: past }; }],
    ["wrong nonce", (s) => { s.idTokenOverrides = { nonce: "not-mine" }; }],
    ["unknown kid", (s) => { s.idTokenKid = "kid-nobody-published"; }],
    ["missing sub", (s) => { s.idTokenOverrides = { sub: "" }; }],
    ["issued in the future", (s) => { s.idTokenOverrides = { iat: Math.floor(Date.now() / 1000) + 3600 }; }],
  ];
  for (const [name, mutate] of cases) {
    const path = box();
    const server = authServer();
    mutate(server);
    const a = signIn(server);
    const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
    assert.deepEqual(out, { status: "error", error: "chatgpt_id_token_invalid" }, name);
    assert.deepEqual(stateFile(path).registrations, [PROVISIONAL], name);
    assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "error", error: "chatgpt_id_token_invalid", retryClientId: "oaiapp_alice" }, name);
  }
  // An aud array that does contain the client id is fine.
  box();
  const server = authServer();
  server.idTokenOverrides = { aud: ["something", "oaiapp_alice"] };
  const a = signIn(server);
  const ok = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.equal(ok.status, "complete");
});

test("7 a missing chatgpt.tokens.use.direct scope stores no credential and asks for consent next time", async () => {
  const path = box();
  const server = authServer();
  server.scope = "email offline_access openid profile resource.invoke";
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(out, { status: "error", error: "chatgpt_plan_not_enabled" });
  assert.deepEqual(stateFile(path).registrations, [{
    clientId: "oaiapp_alice",
    subject: "sub-alice",
    email: "alice@example.com",
    needsConsent: true,
  }]);
  const next = signIn(server);
  assert.equal(next.q.get("prompt"), "consent");
  assert.equal(next.q.get("client_id"), "oaiapp_alice");
  // Granting it clears the flag.
  server.scope = ALL_SCOPES;
  const done = await completeChatGptSignIn({ state: next.state, code: "c", error: null, clientId: null }, server.fetch);
  assert.equal(done.status, "complete");
  assert.equal(stateFile(path).registrations[0]?.needsConsent, false);
  assert.equal(signIn(server).q.get("prompt"), null);
});

test("8 another subject on reauth is an account mismatch, keeps every registration and revokes the new tokens; newAccount registers a second one", async () => {
  const path = box();
  const server = authServer();
  await register(server);
  server.sub = "sub-bob";
  server.refreshToken = "refresh-bob";
  const a = signIn(server);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: null }, server.fetch);
  assert.deepEqual(out, { status: "error", error: "chatgpt_account_mismatch" });
  assert.equal(stateFile(path).registrations.length, 1);
  assert.equal(stateFile(path).registrations[0]?.subject, "sub-alice");
  const revoked = server.calls.filter((call) => call.url === REVOKE_URL);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.form!.get("token"), "refresh-bob");
  // Without newAccount the next start still targets the saved account.
  assert.equal(signIn(server).q.get("client_id"), "oaiapp_alice");
  // newAccount: dynamic registration, no hints, the old entry stays.
  server.clientId = "oaiapp_bob";
  const fresh = signIn(server, { newAccount: true });
  assert.equal(fresh.started.account, null);
  assert.equal(fresh.q.get("client_id"), "dynamic_agent_client");
  assert.equal(fresh.q.get("agent_name_hint"), "Useful Bot");
  assert.equal(fresh.q.get("login_hint"), null);
  assert.equal(fresh.q.get("id_token_hint"), null);
  const done = await completeChatGptSignIn({ state: fresh.state, code: "c", error: null, clientId: "oaiapp_bob" }, server.fetch);
  assert.equal(done.status, "complete");
  assert.deepEqual(stateFile(path).registrations.map((r) => [r.clientId, r.subject]), [["oaiapp_alice", "sub-alice"], ["oaiapp_bob", "sub-bob"]]);
  assert.equal(stateFile(path).lastClientId, "oaiapp_bob");
  // The stored credential decides which registration a start uses.
  const bobCredential = oauthOf(done.status === "complete" ? done.credential : undefined);
  const aliceCredential = { ...bobCredential, clientId: "oaiapp_alice" };
  const again = signIn(server, { storedCredential: aliceCredential });
  assert.equal(again.q.get("client_id"), "oaiapp_alice");
  assert.equal(again.started.account, "alice@example.com");
  // The same account in another workspace is another issued client: both survive (docs: keep registrations separate).
  server.sub = "sub-alice";
  server.clientId = "oaiapp_alice2";
  const dup = signIn(server, { newAccount: true });
  const dupDone = await completeChatGptSignIn({ state: dup.state, code: "c", error: null, clientId: "oaiapp_alice2" }, server.fetch);
  assert.equal(dupDone.status, "complete");
  assert.deepEqual(stateFile(path).registrations.map((r) => [r.clientId, r.subject]), [
    ["oaiapp_alice", "sub-alice"], ["oaiapp_bob", "sub-bob"], ["oaiapp_alice2", "sub-alice"],
  ]);
  assert.equal(stateFile(path).lastClientId, "oaiapp_alice2");
});

test("9 an expired attempt reports expired and a late callback is refused", async () => {
  const path = box();
  const server = authServer();
  const a = signIn(server);
  const file = stateFile(path);
  file.pending = { ...file.pending!, expiresAt: Date.now() - 1000 };
  writeFileSync(path, JSON.stringify(file));
  const late = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.equal(late.status, "expired");
  assert.equal(server.calls.length, 0);
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "expired" });
  const after = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.notEqual(after.status, "complete");
  assert.equal(server.calls.length, 0);
});

test("10 cancel, then a callback is refused", async () => {
  box();
  const server = authServer();
  const a = signIn(server);
  cancelChatGptSignIn(a.started.pollId);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(out, { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.length, 0);
  assert.throws(() => pollChatGptSignIn(a.started.pollId), /oauth_poll_unknown/);
});

test("11 a second start supersedes the first and the first callback is refused", async () => {
  box();
  const server = authServer();
  const first = signIn(server);
  const second = signIn(server);
  assert.notEqual(first.state, second.state);
  const stale = await completeChatGptSignIn({ state: first.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(stale, { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.length, 0);
  assert.throws(() => pollChatGptSignIn(first.started.pollId), /oauth_poll_unknown/);
  const ok = await completeChatGptSignIn({ state: second.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.equal(ok.status, "complete");
});

test("12 a replayed callback after completion is refused, also while the first is still in flight", async () => {
  box();
  const server = authServer();
  const a = signIn(server);
  const params = { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" };
  const [one, two] = await Promise.all([
    completeChatGptSignIn(params, server.fetch),
    completeChatGptSignIn(params, server.fetch),
  ]);
  assert.deepEqual([one.status, two.status].sort(), ["complete", "refused"]);
  // A replay of a completed attempt (a reloaded tab) is not a second sign-in.
  const replay = await completeChatGptSignIn(params, server.fetch);
  assert.deepEqual(replay, { status: "repeat" });
  assert.equal(server.calls.filter((call) => call.url === TOKEN_URL).length, 1);
});

test("15 revoke: 200 confirmed, 500 then 200 confirmed after a retry, 400 not confirmed, network error twice not confirmed", async () => {
  box();
  const server = authServer();
  const credential = oauthOf({
    kind: "oauth",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: null,
    accountId: null,
    clientId: "oaiapp_alice",
  });
  server.revokeStatuses = [200];
  assert.equal(await revokeChatGptCredential(credential, server.fetch, 1), true);
  server.calls.length = 0;
  server.revokeStatuses = [500, 200];
  assert.equal(await revokeChatGptCredential(credential, server.fetch, 1), true);
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL).length, 2);
  server.calls.length = 0;
  server.revokeStatuses = [400];
  assert.equal(await revokeChatGptCredential(credential, server.fetch, 1), false);
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL).length, 1);
  let tries = 0;
  const down: typeof fetch = async () => {
    tries += 1;
    throw new Error("network down");
  };
  assert.equal(await revokeChatGptCredential(credential, down, 1), false);
  assert.equal(tries, 2);
  assert.equal(await revokeChatGptCredential({ ...credential, refreshToken: null }, server.fetch, 1), false);
});

test("16 a Codex-era credential without clientId reports expired and gives no usable token", () => {
  const legacy: Credential = {
    kind: "oauth",
    accessToken: "codex-access",
    refreshToken: "codex-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "acct_codex",
  };
  const info = accessTokenFor("openai", legacy);
  assert.equal(info.expired, true);
  assert.deepEqual(info.headers, {});
  const store = setOAuthCredential(emptyProviderStore(), "openai", legacy);
  const row = publicProviders(store).connections.find((c) => c.id === "openai:oauth")!;
  assert.equal(row.status, "expired");
  assert.equal(row.accountLabel, null);
  // A current one is fine.
  const current: Credential = { ...legacy, clientId: "oaiapp_alice", email: "alice@example.com", accountId: null };
  assert.equal(accessTokenFor("openai", current).expired, false);
});

test("17 an old single registration is migrated on read", () => {
  const path = box();
  writeFileSync(path, JSON.stringify({
    hostId: "urn:uuid:11111111-1111-1111-1111-111111111111",
    registration: { clientId: "oaiapp_old", subject: "sub-old", email: "old@example.com", needsConsent: false },
    pending: null,
  }));
  const started = startChatGptSignIn({ storedCredential: null });
  const { q } = parse(started.authorizeUrl);
  assert.equal(started.account, "old@example.com");
  assert.equal(q.get("client_id"), "oaiapp_old");
  assert.equal(q.get("ext_agent_host_id"), "urn:uuid:11111111-1111-1111-1111-111111111111");
  assert.deepEqual(stateFile(path).registrations.map((r) => r.clientId), ["oaiapp_old"]);
});

test("18 a failing persist settles chatgpt_signin_refused, never complete, and revokes the new tokens", async () => {
  const path = box();
  const server = authServer();
  server.refreshToken = "refresh-persist";
  const a = signIn(server);
  const out = await completeChatGptSignIn(
    { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" },
    server.fetch,
    () => { throw new Error("disk full"); },
  );
  assert.deepEqual(out, { status: "error", error: "chatgpt_signin_refused" });
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "error", error: "chatgpt_signin_refused", retryClientId: "oaiapp_alice" });
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL)[0]?.form?.get("token"), "refresh-persist");
  assert.equal(stateFile(path).lastDone, null);
});

test("19 plan not enabled, and an attempt superseded after its exchange, both revoke the tokens they throw away", async () => {
  box();
  const server = authServer();
  server.scope = "openid email";
  server.refreshToken = "refresh-noplan";
  const a = signIn(server);
  const noPlan = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(noPlan, { status: "error", error: "chatgpt_plan_not_enabled" });
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL).at(-1)?.form?.get("token"), "refresh-noplan");

  server.scope = ALL_SCOPES;
  server.refreshToken = "refresh-superseded";
  const b = signIn(server);
  let supersededBy = "";
  const racing: typeof fetch = async (input, init) => {
    if (String(input) === TOKEN_URL && !supersededBy) {
      supersededBy = startChatGptSignIn({ storedCredential: null }).pollId;
    }
    return server.fetch(input, init);
  };
  const lost = await completeChatGptSignIn({ state: b.state, code: "c", error: null, clientId: null }, racing);
  assert.deepEqual(lost, { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL).at(-1)?.form?.get("token"), "refresh-superseded");
});

test("20 a reloaded callback after completion shows success, within ten minutes, and never exchanges again", async () => {
  box();
  const server = authServer();
  const a = signIn(server);
  const params = { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" };
  assert.equal((await completeChatGptSignIn(params, server.fetch)).status, "complete");
  pollChatGptSignIn(a.started.pollId);
  const exchanges = () => server.calls.filter((call) => call.url === TOKEN_URL).length;
  assert.equal(exchanges(), 1);
  const again = await completeChatGptSignIn(params, server.fetch);
  assert.deepEqual(again, { status: "repeat" });
  assert.equal(exchanges(), 1);
  // A different state is still refused.
  assert.deepEqual(await completeChatGptSignIn({ ...params, state: "other" }, server.fetch), { status: "refused", error: "chatgpt_state_mismatch" });
  // After ten minutes the reload is refused.
  const real = Date.now();
  const clock = mock.method(Date, "now", () => real + 11 * 60_000);
  try {
    assert.deepEqual(await completeChatGptSignIn(params, server.fetch), { status: "refused", error: "chatgpt_state_mismatch" });
  } finally {
    clock.mock.restore();
  }
});

test("21 refresh: terminal OAuth errors and transient failures are told apart", async () => {
  const credential = oauthOf({
    kind: "oauth", accessToken: "a", refreshToken: "r", expiresAt: 0, accountId: null, clientId: "oaiapp_alice",
  });
  const answer = (status: number, error?: string): typeof fetch => async () =>
    new Response(error ? JSON.stringify({ error }) : "{}", { status, headers: { "content-type": "application/json" } });
  for (const code of ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]) {
    await assert.rejects(() => refreshChatGptCredential(credential, answer(400, code)), /oauth_refresh_terminal/, code);
  }
  await assert.rejects(() => refreshChatGptCredential(credential, answer(401, "invalid_grant")), /oauth_refresh_terminal/);
  // A client the server does not accept is a configuration fault, not an unusable token.
  await assert.rejects(() => refreshChatGptCredential(credential, answer(401, "invalid_client")), /oauth_refresh_client/);
  await assert.rejects(() => refreshChatGptCredential(credential, answer(400, "invalid_client")), /oauth_refresh_client/);
  await assert.rejects(() => refreshChatGptCredential(credential, answer(400, "invalid_request")), /oauth_refresh_transient/);
  await assert.rejects(() => refreshChatGptCredential(credential, answer(500, "invalid_grant")), /oauth_refresh_transient/);
  await assert.rejects(() => refreshChatGptCredential(credential, answer(503)), /oauth_refresh_transient/);
  await assert.rejects(() => refreshChatGptCredential(credential, async () => { throw new Error("offline"); }), /oauth_refresh_transient/);
  // A credential with nothing to refresh with is terminal.
  await assert.rejects(() => refreshChatGptCredential({ ...credential, refreshToken: null }, answer(200)), /oauth_refresh_terminal/);
});

test("22 failures log a code and a safe detail, never a body, a description or a token", async () => {
  box();
  const lines: string[] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try {
    const leaky: typeof fetch = async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "SECRET-DESCRIPTION access_token=tok-leak" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const a = startChatGptSignIn({ storedCredential: null });
    const state = parse(a.authorizeUrl).q.get("state");
    await completeChatGptSignIn({ state, code: "code-leak", error: null, clientId: "oaiapp_alice" }, leaky);
    const server = authServer();
    server.idTokenOverrides = { iss: "https://evil.example" };
    const b = signIn(server);
    await completeChatGptSignIn({ state: b.state, code: "code-leak", error: null, clientId: "oaiapp_alice" }, server.fetch);
    await refreshChatGptCredential(oauthOf({ kind: "oauth", accessToken: "a", refreshToken: "refresh-leak", expiresAt: 0, accountId: null, clientId: "oaiapp_alice" }), leaky).catch(() => undefined);
  } finally {
    spy.mock.restore();
  }
  const joined = lines.join("\n");
  assert.ok(lines.length >= 3);
  for (const line of lines) assert.ok(line.startsWith("[useful-bot] chatgpt sign-in:"), line);
  assert.ok(joined.includes("chatgpt_token_exchange") && joined.includes("400") && joined.includes("invalid_grant"));
  assert.ok(joined.includes("jwt_iss"));
  for (const secret of ["SECRET-DESCRIPTION", "tok-leak", "code-leak", "refresh-leak"]) assert.ok(!joined.includes(secret), secret);
});

test("23 Add another account always registers fresh; Try again reuses the failed client explicitly", async () => {
  const path = box();
  const server = authServer();
  await register(server); // alice validated as oaiapp_alice
  // A new-account attempt that fails after the client id was issued.
  server.clientId = "oaiapp_bob";
  server.tokenStatus = 400;
  const failedTry = signIn(server, { newAccount: true });
  assert.equal(failedTry.started.clientId, null);
  await completeChatGptSignIn({ state: failedTry.state, code: "c", error: null, clientId: "oaiapp_bob" }, server.fetch);
  assert.equal(stateFile(path).retryClientId, "oaiapp_bob");
  assert.equal(stateFile(path).lastClientId, "oaiapp_alice");
  assert.equal(pollChatGptSignIn(failedTry.started.pollId).retryClientId, "oaiapp_bob");
  // The default start targets the validated account, never the provisional one.
  assert.equal(signIn(server).q.get("client_id"), "oaiapp_alice");
  // Add another account is fresh again, with the registration hints.
  const fresh = signIn(server, { newAccount: true });
  assert.equal(fresh.q.get("client_id"), "dynamic_agent_client");
  assert.equal(fresh.q.get("agent_name_hint"), "Useful Bot");
  assert.equal(fresh.started.reusesSaved, false);
  // Try again with the issued client: no registration hints.
  server.tokenStatus = 200;
  server.sub = "sub-bob";
  const retry = signIn(server, { retryClientId: "oaiapp_bob" });
  assert.equal(retry.q.get("client_id"), "oaiapp_bob");
  assert.equal(retry.q.get("agent_name_hint"), null);
  assert.equal(retry.q.get("login_hint"), null);
  assert.equal(retry.started.reusesSaved, true);
  assert.equal(retry.started.clientId, "oaiapp_bob");
  const done = await completeChatGptSignIn({ state: retry.state, code: "c", error: null, clientId: null }, server.fetch);
  assert.equal(done.status, "complete");
  assert.equal(stateFile(path).retryClientId, null);
  assert.equal(stateFile(path).lastClientId, "oaiapp_bob");
  // An unknown client id is refused.
  assert.throws(() => startChatGptSignIn({ retryClientId: "oaiapp_nobody", storedCredential: null }), /chatgpt_account_unknown/);
});

test("23b plan not enabled on an Add another account attempt: Try again sends that client with prompt=consent", async () => {
  box();
  const server = authServer();
  await register(server);
  server.clientId = "oaiapp_bob";
  server.sub = "sub-bob";
  server.email = "bob@example.com";
  server.scope = "openid email";
  const a = signIn(server, { newAccount: true });
  await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_bob" }, server.fetch);
  const polled = pollChatGptSignIn(a.started.pollId);
  assert.deepEqual(polled, { status: "error", error: "chatgpt_plan_not_enabled", retryClientId: "oaiapp_bob" });
  const retry = signIn(server, { retryClientId: polled.retryClientId });
  assert.equal(retry.q.get("client_id"), "oaiapp_bob");
  assert.equal(retry.q.get("prompt"), "consent");
  assert.equal(retry.q.get("login_hint"), "bob@example.com");
  assert.equal(retry.q.get("agent_name_hint"), null);
});

test("24 starting with a chosen saved account, the accounts list and distinct labels", async () => {
  const path = box();
  const server = authServer();
  await register(server);
  server.clientId = "oaiapp_bob";
  server.sub = "sub-bob";
  server.email = null;
  const b = signIn(server, { newAccount: true });
  await completeChatGptSignIn({ state: b.state, code: "c", error: null, clientId: "oaiapp_bob" }, server.fetch);
  server.clientId = "oaiapp_cara";
  server.sub = "sub-cara";
  server.email = "alice@example.com"; // same email as the first account, another workspace
  const c = signIn(server, { newAccount: true });
  await completeChatGptSignIn({ state: c.state, code: "c", error: null, clientId: "oaiapp_cara" }, server.fetch);
  const chosen = signIn(server, { clientId: "oaiapp_alice", storedCredential: null });
  assert.equal(chosen.q.get("client_id"), "oaiapp_alice");
  assert.equal(chosen.started.account, "alice@example.com");
  assert.equal(chosen.started.reusesSaved, true);
  assert.deepEqual(chosen.started.accounts, [
    { clientId: "oaiapp_alice", label: "alice@example.com (lice)" },
    { clientId: "oaiapp_bob", label: "ChatGPT account _bob" },
    { clientId: "oaiapp_cara", label: "alice@example.com (cara)" },
  ]);
  // Unknown and provisional ids are refused.
  assert.throws(() => startChatGptSignIn({ clientId: "oaiapp_nobody", storedCredential: null }), /chatgpt_account_unknown/);
  const file = stateFile(path);
  writeFileSync(path, JSON.stringify({ ...file, registrations: [...file.registrations, { clientId: "oaiapp_prov", subject: null, email: null, needsConsent: false }] }));
  assert.throws(() => startChatGptSignIn({ clientId: "oaiapp_prov", storedCredential: null }), /chatgpt_account_unknown/);
  // A provisional entry is not offered as an account.
  assert.ok(!startChatGptSignIn({ storedCredential: null }).accounts.some((a) => a.clientId === "oaiapp_prov"));
});

test("25 an attempt cancelled during the exchange changes nothing and only revokes its tokens", async () => {
  const path = box();
  const server = authServer();
  server.scope = "openid email"; // the missing-scope path would set needsConsent
  server.refreshToken = "refresh-cancelled";
  const a = signIn(server);
  const cancelling: typeof fetch = async (input, init) => {
    const res = await server.fetch(input, init);
    if (String(input) === TOKEN_URL) cancelChatGptSignIn(a.started.pollId);
    return res;
  };
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, cancelling);
  assert.deepEqual(out, { status: "refused", error: "chatgpt_state_mismatch" });
  const file = stateFile(path);
  assert.equal(file.lastClientId, null);
  assert.ok(file.registrations.every((r) => r.needsConsent === false && r.subject === null));
  assert.equal(server.calls.filter((call) => call.url === REVOKE_URL)[0]?.form?.get("token"), "refresh-cancelled");
});

test("26 the outcome is settled before the revoke, so a slow revoke cannot hide the real reason", async () => {
  box();
  const server = authServer();
  server.scope = "openid email";
  const a = signIn(server);
  const hanging: typeof fetch = (input, init) =>
    String(input) === REVOKE_URL ? new Promise<Response>(() => undefined) : server.fetch(input, init);
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, hanging);
  assert.deepEqual(out, { status: "error", error: "chatgpt_plan_not_enabled" });
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "error", error: "chatgpt_plan_not_enabled", retryClientId: "oaiapp_alice" });
});

test("27 a bookkeeping failure after the credential was stored still settles the attempt", async () => {
  const path = box();
  const server = authServer();
  const a = signIn(server);
  const dir = join(path, "..");
  const out = await completeChatGptSignIn(
    { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" },
    server.fetch,
    () => { chmodSync(dir, 0o500); }, // the stored credential is safe; the sign-in file can no longer be written
  );
  chmodSync(dir, 0o700);
  assert.equal(out.status, "complete");
  // The file never got the outcome, but the poll still answers complete from memory, once.
  assert.deepEqual(pollChatGptSignIn(a.started.pollId), { status: "complete" });
  assert.throws(() => pollChatGptSignIn(a.started.pollId), /oauth_poll_unknown/);
  // And a reloaded callback tab shows success.
  assert.deepEqual(await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch), { status: "repeat" });
});

test("28 an unreadable or malformed state file is never overwritten", async () => {
  const server = authServer();
  for (const make of [
    (path: string) => writeFileSync(path, "{not json"),
    (path: string) => mkdirSync(path), // reading a directory fails with EISDIR, not ENOENT
  ]) {
    const path = box();
    make(path);
    const before = (() => { try { return readFileSync(path, "utf8"); } catch { return "dir"; } })();
    const lines: string[] = [];
    const spy = mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      assert.throws(() => startChatGptSignIn({ storedCredential: null }), /chatgpt_state_unreadable/);
      await assert.rejects(() => completeChatGptSignIn({ state: "x", code: "c", error: null, clientId: null }, server.fetch), /chatgpt_state_unreadable/);
      assert.throws(() => pollChatGptSignIn("anything"), /chatgpt_state_unreadable/);
    } finally {
      spy.mock.restore();
    }
    assert.ok(lines.some((line) => line.includes("chatgpt_state_unreadable")));
    const after = (() => { try { return readFileSync(path, "utf8"); } catch { return "dir"; } })();
    assert.equal(after, before, "the saved registrations were not written over");
    assert.equal(server.calls.length, 0);
  }
  // A file that does not exist is simply a first run.
  box();
  assert.doesNotThrow(() => startChatGptSignIn({ storedCredential: null }));
});

test("29 Disconnect returns the ChatGPT credential that was really removed, from inside the delete", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-delete-"));
  const savedProviders = process.env.UB_PROVIDERS_PATH;
  const savedShell = process.env.UB_SHELL_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  try {
    const held = oauthOf({ kind: "oauth", accessToken: "a", refreshToken: "refresh-held", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_alice" });
    writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", held));
    const out = applyProvidersDeleteCapturing({ connectionId: "openai:oauth" });
    assert.equal(out.removedChatGpt?.kind === "oauth" ? out.removedChatGpt.refreshToken : null, "refresh-held");
    assert.equal(out.store.connections["openai:oauth"], undefined);
    assert.equal(readProviderStore().connections["openai:oauth"], undefined);
    // Nothing there any more: the delete fails and there is nothing to revoke.
    assert.throws(() => applyProvidersDeleteCapturing({ connectionId: "openai:oauth" }), /connection_unknown/);
    // Another connection's delete never reports a ChatGPT credential.
    writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", held));
    assert.equal(applyProvidersDeleteCapturing({ providerId: "deepseek" }).removedChatGpt, null);
  } finally {
    if (savedProviders === undefined) delete process.env.UB_PROVIDERS_PATH; else process.env.UB_PROVIDERS_PATH = savedProviders;
    if (savedShell === undefined) delete process.env.UB_SHELL_PATH; else process.env.UB_SHELL_PATH = savedShell;
  }
});

test("30 a remembered outcome answers isChatGptPollId and the poll before the file; a corrupt file never breaks other polls", async () => {
  const path = box();
  const server = authServer();
  server.scope = "openid email";
  const a = signIn(server);
  await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  writeFileSync(path, "{corrupt");
  const lines: string[] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try {
    assert.equal(isChatGptPollId(a.started.pollId), true);
    assert.equal(isChatGptPollId("some-copilot-device-poll-id"), false, "a corrupt ChatGPT file never throws for another poll");
    assert.equal(pollChatGptSignIn(a.started.pollId).error, "chatgpt_plan_not_enabled");
  } finally {
    spy.mock.restore();
  }
});

test("31 a callback for an attempt with a remembered outcome never exchanges again, even when the file row is unsettled", async () => {
  const path = box();
  const server = authServer();
  server.tokenStatus = 400;
  const dir = join(path, "..");
  const a = signIn(server);
  const lockingFetch: typeof fetch = async (input, init) => {
    const res = await server.fetch(input, init);
    if (String(input) === TOKEN_URL) chmodSync(dir, 0o500); // the outcome cannot be written to the file
    return res;
  };
  const params = { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" };
  const first = await completeChatGptSignIn(params, lockingFetch);
  chmodSync(dir, 0o700);
  assert.deepEqual(first, { status: "error", error: "chatgpt_token_exchange" });
  assert.equal(stateFile(path).pending?.outcome, null, "the file row is still unsettled");
  const exchanges = () => server.calls.filter((call) => call.url === TOKEN_URL).length;
  assert.equal(exchanges(), 1);
  server.tokenStatus = 200;
  assert.deepEqual(await completeChatGptSignIn(params, server.fetch), { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(exchanges(), 1);
  assert.equal(pollChatGptSignIn(a.started.pollId).error, "chatgpt_token_exchange");
});

test("32 an identity write that failed after the credential was stored is retried on the next start", async () => {
  const path = box();
  const server = authServer();
  const dir = join(path, "..");
  const a = signIn(server);
  const out = await completeChatGptSignIn(
    { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" },
    server.fetch,
    () => { chmodSync(dir, 0o500); },
  );
  chmodSync(dir, 0o700);
  assert.equal(out.status, "complete");
  assert.deepEqual(stateFile(path).registrations.map((r) => r.subject), [null], "only the provisional entry reached the file");
  const next = startChatGptSignIn({ storedCredential: null });
  assert.equal(parse(next.authorizeUrl).q.get("client_id"), "oaiapp_alice", "the validated registration was written first");
  assert.equal(next.account, "alice@example.com");
  assert.deepEqual(stateFile(path).registrations.map((r) => [r.clientId, r.subject]), [["oaiapp_alice", "sub-alice"]]);
});

test("33 Disconnect really cancels: a write failure propagates and a callback for the cancelled attempt stays refused", async () => {
  const path = box();
  const server = authServer();
  const dir = join(path, "..");
  const a = signIn(server);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => cancelPendingChatGptSignIn());
  } finally {
    chmodSync(dir, 0o700);
  }
  const out = await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  assert.deepEqual(out, { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.length, 0);
  // An unreadable file is the one thing it swallows.
  writeFileSync(path, "{corrupt");
  const spy = mock.method(console, "error", () => undefined);
  try {
    assert.doesNotThrow(() => cancelPendingChatGptSignIn());
  } finally {
    spy.mock.restore();
  }
});

test("34 an expired retry attempt on an issued client still names it for Try again", () => {
  const path = box();
  const file = {
    hostId: "urn:uuid:22222222-2222-2222-2222-222222222222",
    registrations: [{ clientId: "oaiapp_prov", subject: null, email: null, needsConsent: false }],
    lastClientId: null,
    retryClientId: "oaiapp_prov",
    pending: null,
    lastDone: null,
  };
  writeFileSync(path, JSON.stringify(file));
  const started = startChatGptSignIn({ retryClientId: "oaiapp_prov", storedCredential: null });
  const written = stateFile(path);
  writeFileSync(path, JSON.stringify({ ...written, pending: { ...written.pending!, expiresAt: Date.now() - 1000 } }));
  assert.deepEqual(pollChatGptSignIn(started.pollId), { status: "expired", retryClientId: "oaiapp_prov" });
  // A fresh registration that expires has no client to name.
  const fresh = startChatGptSignIn({ newAccount: true, storedCredential: null });
  const again = stateFile(path);
  writeFileSync(path, JSON.stringify({ ...again, pending: { ...again.pending!, expiresAt: Date.now() - 1000 } }));
  assert.deepEqual(pollChatGptSignIn(fresh.pollId), { status: "expired" });
});

test("35 a polled memory-only outcome leaves a tombstone: the reloaded callback never exchanges again", async () => {
  const path = box();
  const server = authServer();
  server.tokenStatus = 400;
  const dir = join(path, "..");
  const a = signIn(server);
  const lockingFetch: typeof fetch = async (input, init) => {
    const res = await server.fetch(input, init);
    if (String(input) === TOKEN_URL) chmodSync(dir, 0o500); // the outcome cannot be written
    return res;
  };
  const params = { state: a.state, code: "c", error: null, clientId: "oaiapp_alice" };
  await completeChatGptSignIn(params, lockingFetch);
  // The poll reports the error while storage is still failing, so the unsettled row stays on disk.
  assert.equal(pollChatGptSignIn(a.started.pollId).error, "chatgpt_token_exchange");
  chmodSync(dir, 0o700); // storage recovers
  assert.equal(stateFile(path).pending?.outcome, null, "the disk row is still unsettled");
  server.tokenStatus = 200;
  assert.deepEqual(await completeChatGptSignIn(params, server.fetch), { status: "refused", error: "chatgpt_state_mismatch" });
  assert.equal(server.calls.filter((call) => call.url === TOKEN_URL).length, 1);
});

test("36 recovery state is shared by every copy of the module", async () => {
  const path = box();
  const server = authServer();
  server.scope = "openid email";
  const copy = await import(new URL("../shared/chatgpt-signin.ts?copy=36", import.meta.url).href) as typeof import("../shared/chatgpt-signin.ts");
  assert.notEqual(copy.completeChatGptSignIn, completeChatGptSignIn, "a distinct module instance");
  const a = signIn(server);
  await completeChatGptSignIn({ state: a.state, code: "c", error: null, clientId: "oaiapp_alice" }, server.fetch);
  writeFileSync(path, "{corrupt"); // only memory can answer now
  const spy = mock.method(console, "error", () => undefined);
  try {
    assert.equal(copy.isChatGptPollId(a.started.pollId), true);
    assert.equal(copy.pollChatGptSignIn(a.started.pollId).error, "chatgpt_plan_not_enabled");
  } finally {
    spy.mock.restore();
  }
});

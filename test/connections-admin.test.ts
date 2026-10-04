import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteConnection,
  listPublicConnections,
  reauthorizeConnection,
  refreshConnection,
  settleDiscoveries,
  startDueDiscoveries,
} from "../shared/connections-admin.ts";
import { connectionIndex, connectionStatus, putConnectionDiscovery } from "../shared/connection-tools-store.ts";
import { discoveryRunning } from "../shared/connection-tools.ts";
import { setDiscoveryLogger } from "../shared/connection-tools.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { EXCALIDRAW_CONNECTION, findConnectionById, seedDefaultConnections, upsertConnection, type ConnectionEntry } from "../shared/connections-store.ts";
import { connectionSecretService, keychainGet, keychainSet, memoryKeychain, setKeychainDriver } from "../shared/keychain.ts";
import { setMcpFetch } from "../shared/mcp-http.ts";
import { findOauthPending, setOauthFetch, startMcpOAuth } from "../shared/mcp-oauth.ts";
import { acquireRefreshLock, refreshLockPath } from "../shared/connection-auth.ts";

const CALLBACK = "http://127.0.0.1:4320/api/connections/callback";

function paths(): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-admin-"));
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  process.env.UB_CONNECTION_TOOLS_PATH = join(dir, "connection-tools.json");
  process.env.UB_OAUTH_PENDING_PATH = join(dir, "oauth.json");
  process.env.UB_STATE_ROOT = dir;
  setConnectionLookup(async () => "8.8.8.8");
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
}

function row(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: "tella",
    kind: "mcp",
    name: "Tella",
    url: "https://api.tella.com/mcp",
    description: "Tella MCP server",
    authKind: "apiKey",
    authHeader: "X-Api-Key",
    toolsAllow: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function storeBundle(tokenEndpoint: string): void {
  keychainSet(connectionSecretService("tella"), JSON.stringify({
    accessToken: "at_secret", refreshToken: "rt_secret", expiresAt: null, clientId: "client_0", clientSecret: null, tokenEndpoint,
  }));
}

function server(mode: () => "down" | "ok") {
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    const json = (id: number | undefined, result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
    if (body.method === "initialize") return json(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (mode() === "down") return new Response("down", { status: 503 });
    return json(body.id, { tools: [
      { name: "list_videos", description: "List\nthe owner's videos" },
      { name: "create_video", description: "Create a video" },
    ] });
  }) as typeof fetch);
}

test.afterEach(() => {
  setMcpFetch(null);
  setOauthFetch(null);
  setKeychainDriver(null);
  setDiscoveryLogger(null);
  setConnectionLookup(null);
});

test("the list carries state and tools and never a credential", async () => {
  paths();
  upsertConnection(row());
  keychainSet(connectionSecretService("tella"), "sk_live_super_secret_value");
  server(() => "ok");
  const refreshed = await refreshConnection("tella");
  assert.equal(refreshed.state, "ready");
  const listed = listPublicConnections();
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    "authKind", "builtin", "checkedAt", "icon", "id", "kind", "lastError", "name", "state", "toolCount", "tools", "url",
  ]);
  assert.equal(listed[0].toolCount, 2);
  assert.deepEqual(listed[0].tools, [
    { name: "list_videos", description: "List the owner's videos" },
    { name: "create_video", description: "Create a video" },
  ]);
  const wire = JSON.stringify(listed);
  for (const forbidden of ["sk_live", "authorization", "X-Api-Key", "Bearer", "accessToken", "refreshToken"]) {
    assert.equal(wire.includes(forbidden), false, forbidden);
  }
});

test("a refresh lists again now and reports the new state, failure included", async () => {
  paths();
  upsertConnection(row({ authKind: "none", authHeader: null }));
  let mode: "down" | "ok" = "down";
  server(() => mode);
  const down = await refreshConnection("tella");
  assert.equal(down.state, "unreachable");
  assert.equal(down.lastError?.code, "http_503");
  // Inside the two-minute window, which a refresh ignores.
  mode = "ok";
  const up = await refreshConnection("tella");
  assert.equal(up.state, "ready");
  assert.equal(up.lastError, null);
  await assert.rejects(() => refreshConnection("nope"), /connection_missing/);
});

test("remove drops the row, its Keychain item, its listing and its status", async () => {
  paths();
  upsertConnection(row());
  keychainSet(connectionSecretService("tella"), "sk_live_super_secret_value");
  server(() => "ok");
  await refreshConnection("tella");
  assert.ok(connectionIndex("tella"));
  await deleteConnection("tella");
  assert.equal(findConnectionById("tella"), null);
  assert.equal(keychainGet(connectionSecretService("tella")), null);
  assert.equal(connectionIndex("tella"), null);
  assert.equal(connectionStatus("tella"), null);
  assert.deepEqual(listPublicConnections(), []);
  await assert.rejects(() => deleteConnection("tella"), /connection_missing/);
});

test("the built-in Excalidraw connection cannot be removed", async () => {
  paths();
  seedDefaultConnections();
  await assert.rejects(() => deleteConnection(EXCALIDRAW_CONNECTION.id), /connection_builtin/);
  assert.ok(findConnectionById("excalidraw"));
  assert.equal(listPublicConnections().find((item) => item.id === "excalidraw")?.builtin, true);
});

test("a row from before status was kept is described by its listing", () => {
  paths();
  upsertConnection(row());
  assert.equal(listPublicConnections()[0].state, "pending");
  putConnectionDiscovery("tella", {
    tools: [{ name: "a_tool", description: "d", inputSchema: null, inputSchemaBytes: 2 }],
    status: { state: "ready", lastError: null, checkedAt: new Date().toISOString(), toolCount: 1 },
  });
  assert.equal(listPublicConnections()[0].state, "ready");
});

test("reauthorize starts a sign-in for the same connection, and only for an OAuth one", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  storeBundle("https://authkit.tella.tv/oauth2/token");
  const json = (value: unknown, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
  const routes: Record<string, () => Response> = {
    "https://api.tella.com/mcp": () => new Response("{}", { status: 401 }),
    "https://api.tella.com/.well-known/oauth-protected-resource/mcp": () => new Response("no", { status: 404 }),
    "https://api.tella.com/.well-known/oauth-protected-resource": json({
      resource: "https://api.tella.com",
      authorization_servers: ["https://authkit.tella.tv"],
      scopes_supported: ["openid", "offline_access"],
    }),
    "https://authkit.tella.tv/.well-known/oauth-authorization-server": json({
      issuer: "https://authkit.tella.tv",
      authorization_endpoint: "https://authkit.tella.tv/oauth2/authorize",
      token_endpoint: "https://authkit.tella.tv/oauth2/token",
      registration_endpoint: "https://authkit.tella.tv/oauth2/register",
      code_challenge_methods_supported: ["S256"],
    }),
    "https://authkit.tella.tv/oauth2/register": json({ client_id: "client_1" }),
  };
  setOauthFetch((async (input: unknown) => (routes[String(input)] ?? (() => new Response("no", { status: 404 })))()) as typeof fetch);
  const first = await reauthorizeConnection("tella", CALLBACK);
  const url = new URL(first.authorizeUrl);
  assert.equal(first.redirectHost, "authkit.tella.tv");
  assert.equal(url.searchParams.get("resource"), "https://api.tella.com");
  assert.equal(url.searchParams.get("scope"), "openid offline_access");
  const pending = findOauthPending(url.searchParams.get("state") ?? "");
  assert.equal(pending?.connectionId, "tella");
  assert.equal(pending?.proposalId, "reauth_tella");
  // A second attempt replaces the first: one pending sign-in per connection.
  const second = await reauthorizeConnection("tella", CALLBACK);
  assert.equal(findOauthPending(url.searchParams.get("state") ?? ""), null);
  assert.ok(findOauthPending(new URL(second.authorizeUrl).searchParams.get("state") ?? ""));
  upsertConnection(row({ id: "keyed", url: "https://keyed.example.com/mcp", authKind: "bearer", authHeader: null }));
  await assert.rejects(() => reauthorizeConnection("keyed", CALLBACK), /not_oauth/);
  await assert.rejects(() => reauthorizeConnection("nope", CALLBACK), /connection_missing/);
});

function oauthRoutes(asHost: string) {
  const json = (value: unknown) => () =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const routes: Record<string, () => Response> = {
    "https://api.tella.com/mcp": () => new Response("{}", { status: 401 }),
    "https://api.tella.com/.well-known/oauth-protected-resource/mcp": () => new Response("no", { status: 404 }),
    "https://api.tella.com/.well-known/oauth-protected-resource": json({
      resource: "https://api.tella.com",
      authorization_servers: [`https://${asHost}`],
    }),
    [`https://${asHost}/.well-known/oauth-authorization-server`]: json({
      issuer: `https://${asHost}`,
      authorization_endpoint: `https://${asHost}/oauth2/authorize`,
      token_endpoint: `https://${asHost}/oauth2/token`,
      registration_endpoint: `https://${asHost}/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
    }),
    [`https://${asHost}/oauth2/register`]: json({ client_id: "client_1" }),
  };
  const seen: string[] = [];
  setOauthFetch((async (input: unknown) => {
    seen.push(String(input));
    return (routes[String(input)] ?? (() => new Response("no", { status: 404 })))();
  }) as typeof fetch);
  return seen;
}

test("reauthorize refuses a sign-in server on another origin, before registering or opening anything", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  storeBundle("https://authkit.tella.tv/oauth2/token");
  const seen = oauthRoutes("evil.example.com");
  await assert.rejects(() => reauthorizeConnection("tella", CALLBACK), /authorization_server_changed/);
  assert.equal(seen.some((url) => url.endsWith("/oauth2/register")), false);
  assert.equal(findOauthPending("anything-at-all"), null);
});

test("reauthorize with the credential deleted refuses with credential_missing", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  const seen = oauthRoutes("authkit.tella.tv");
  await assert.rejects(() => reauthorizeConnection("tella", CALLBACK), /credential_missing/);
  assert.equal(seen.length, 0);
});

test("the list starts discovery for rows with no status, once per id, without waiting", async () => {
  paths();
  upsertConnection(row({ authKind: "none", authHeader: null }));
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    const json = (id: number | undefined, result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
    if (body.method === "initialize") { calls += 1; await gate; return json(1, { protocolVersion: "2025-06-18" }); }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(body.id, { tools: [{ name: "list_videos", description: "d" }] });
  }) as typeof fetch);
  startDueDiscoveries();
  startDueDiscoveries();
  assert.equal(listPublicConnections()[0].state, "pending");
  release();
  await settleDiscoveries();
  assert.equal(calls, 1);
  assert.equal(listPublicConnections()[0].state, "ready");
  // Fresh now: nothing starts again.
  startDueDiscoveries();
  await settleDiscoveries();
  assert.equal(calls, 1);
});

test("a stored credential without a token endpoint refuses reauthorize", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  keychainSet(connectionSecretService("tella"), JSON.stringify({ accessToken: "at", refreshToken: null, expiresAt: null, clientId: "c", clientSecret: null }));
  const seen = oauthRoutes("authkit.tella.tv");
  await assert.rejects(() => reauthorizeConnection("tella", CALLBACK), /credential_missing/);
  assert.equal(seen.length, 0);
});

test("a reauthorize with an empty or missing expected endpoint fails closed; a first connect is unaffected", async () => {
  paths();
  const input = { mcpUrl: "https://api.tella.com/mcp", name: "Tella", proposalId: "p1", connectionId: "tella", redirectUri: CALLBACK };
  oauthRoutes("authkit.tella.tv");
  await assert.rejects(() => startMcpOAuth({ ...input, reauthorize: true, expectedTokenEndpoint: "" }), /authorization_server_changed/);
  await assert.rejects(() => startMcpOAuth({ ...input, reauthorize: true }), /authorization_server_changed/);
  await assert.rejects(() => startMcpOAuth({ ...input, reauthorize: true, expectedTokenEndpoint: "not a url" }), /authorization_server_changed/);
  const first = await startMcpOAuth(input);
  assert.equal(new URL(first.authorizeUrl).hostname, "authkit.tella.tv");
});

// UB-003 review round 1.

test("the list never carries a query string or a fragment of a connection's URL", async () => {
  paths();
  upsertConnection(row({ authKind: "none", authHeader: null, url: "https://api.tella.com/mcp?api_key=sk_live_in_the_url&x=1#frag" }));
  const listed = listPublicConnections();
  assert.equal(listed[0].url, "https://api.tella.com/mcp");
  assert.equal(JSON.stringify(listed).includes("sk_live"), false);
});

test("a reauthorize meets the whole server it signed in with: issuer and each endpoint's origin", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  const pin = {
    issuer: "https://authkit.tella.tv",
    authorizationOrigin: "https://authkit.tella.tv",
    tokenOrigin: "https://authkit.tella.tv",
    registrationOrigin: "https://authkit.tella.tv",
  };
  const store = (patch: Record<string, unknown>) => keychainSet(connectionSecretService("tella"), JSON.stringify({
    accessToken: "at_secret", refreshToken: "rt_secret", expiresAt: null, clientId: "client_0", clientSecret: null,
    tokenEndpoint: "https://authkit.tella.tv/oauth2/token", ...patch,
  }));
  const seen = oauthRoutes("authkit.tella.tv");
  store({ pin });
  assert.ok((await reauthorizeConnection("tella", CALLBACK)).authorizeUrl);
  for (const moved of [{ authorizationOrigin: "https://login.example.net" }, { registrationOrigin: "https://register.example.net" }, { issuer: "https://elsewhere.example.net" }]) {
    store({ pin: { ...pin, ...moved } });
    seen.length = 0;
    await assert.rejects(() => reauthorizeConnection("tella", CALLBACK), /authorization_server_changed/, JSON.stringify(moved));
    assert.equal(seen.some((url) => url.endsWith("/oauth2/register")), false);
  }
  // A pin that is damaged fails closed too.
  store({ pin: { issuer: "https://authkit.tella.tv" } });
  await assert.rejects(() => reauthorizeConnection("tella", CALLBACK), /authorization_server_changed/);
});

test("removing a connection stops its running discovery, leaves nothing it wrote, and forgets its pending sign-in", async () => {
  paths();
  upsertConnection(row({ authKind: "none", authHeader: null }));
  // A server that never answers tools/list and gives up only when it is told to.
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { headers: { "content-type": "application/json" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch);
  startDueDiscoveries();
  assert.equal(discoveryRunning("tella"), true);
  await deleteConnection("tella");
  assert.equal(discoveryRunning("tella"), false);
  assert.equal(findConnectionById("tella"), null);
  await settleDiscoveries();
  assert.equal(connectionStatus("tella"), null, "no status written for a removed connection");
  assert.equal(connectionIndex("tella"), null);
  // A sign-in again that was open when the connection was removed.
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  storeBundle("https://authkit.tella.tv/oauth2/token");
  oauthRoutes("authkit.tella.tv");
  const out = await reauthorizeConnection("tella", CALLBACK);
  const state = new URL(out.authorizeUrl).searchParams.get("state") ?? "";
  assert.ok(findOauthPending(state));
  await deleteConnection("tella");
  assert.equal(findOauthPending(state), null);
});

// UB-003 review round 3.

test("removing a connection waits for a refresh that holds its lock, then leaves no lock file behind", async () => {
  paths();
  upsertConnection(row({ authKind: "oauth", authHeader: null }));
  storeBundle("https://auth.example.com/token");
  const release = await acquireRefreshLock("tella");
  const removal = deleteConnection("tella");
  let done = false;
  void removal.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(done, false, "the removal is waiting for the refresh");
  assert.ok(findConnectionById("tella"), "nothing was removed under a refresh in flight");
  assert.ok(keychainGet(connectionSecretService("tella")));
  release!();
  await removal;
  assert.equal(findConnectionById("tella"), null);
  assert.equal(keychainGet(connectionSecretService("tella")), null);
  assert.equal(existsSync(`${refreshLockPath("tella")}.sqlite`), false, "the per-connection lock file is gone");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { catalogueReady, needsOwnApp, resetCatalogueMemo } from "../shared/composio-catalogue.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnectorsStore, setConnectedToolkits, setConnectorsKey, updateConnectorsStore } from "../shared/connectors-store.ts";
import {
  authorizeConnector,
  connectOwnApp,
  connectorsSession,
  describeOwnApp,
  isNoManagedAuth,
  disconnectConnector,
  executeConnectorTool,
  forgetConnected,
  countToolkitTools,
  listConnectorToolkits,
  searchConnectorTools,
  isKeyRejected,
  setComposioFactory,
  toolkitHint,
  toolkitOf,
  type ComposioLike,
  type ComposioSessionLike,
} from "../shared/composio.ts";

type ToolkitItem = Awaited<ReturnType<ComposioSessionLike["toolkits"]>>["items"][number];

function tmpPath(withKey = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ub-composio-"));
  const path = join(dir, "connectors.json");
  // Each test gets its own catalogue cache file too, and no memo from the last one.
  process.env.UB_CATALOGUE_PATH = join(dir, "catalogue.json");
  resetCatalogueMemo();
  // Stub session ids repeat across tests, so the connected memo must not carry over.
  forgetConnected();
  if (withKey) updateConnectorsStore((store) => setConnectorsKey(store, "ak_stub_1234567890"), path);
  return path;
}

interface StubState {
  created: Array<{ userId: string; config: Record<string, unknown> }>;
  used: string[];
  useThrows: unknown;
  toolkitItems: ToolkitItem[];
  executed: Array<{ slug: string; args: Record<string, unknown> | undefined }>;
  searched: Array<{ query: string; toolkits?: string[] }>;
  listed: Array<Record<string, unknown> | undefined>;
  searchResponse: unknown;
  authorized: Array<{ toolkit: string; callbackUrl?: string }>;
  deleted: string[];
  accounts: Record<string, Array<{ id: string; toolkit?: { slug: string } }>>;
  executeThrows: unknown;
  directTools: Array<{ slug: string; description?: string; inputParameters?: Record<string, unknown>; toolkit?: { slug: string } }>;
  /** Thrown by the next session.authorize, once. */
  authorizeThrows: unknown;
  /** What toolkits.get answers, by slug. */
  toolkitInfo: Record<string, Awaited<ReturnType<ComposioLike["toolkits"]["get"]>>>;
  /** The raw toolkit list the catalogue build reads its auth flags from. */
  rawToolkits: Array<{ slug: string; no_auth?: boolean; auth_schemes?: string[]; composio_managed_auth_schemes?: string[] }>;
  authConfigsListed: Array<{ id: string; name: string; isComposioManaged?: boolean }>;
  authConfigsCreated: Array<{ toolkit: string; options: Record<string, unknown> }>;
  authConfigsDeleted: string[];
  authConfigCreateThrows: unknown;
}

function stub(overrides: Partial<StubState> = {}): { state: StubState; factory: (key: string) => ComposioLike } {
  const state: StubState = {
    created: [],
    used: [],
    useThrows: null,
    toolkitItems: [],
    executed: [],
    searched: [],
    listed: [],
    searchResponse: { results: [], toolSchemas: {}, toolkits: [] },
    authorized: [],
    deleted: [],
    accounts: {},
    executeThrows: null,
    directTools: [],
    authorizeThrows: null,
    toolkitInfo: {},
    rawToolkits: [],
    authConfigsListed: [],
    authConfigsCreated: [],
    authConfigsDeleted: [],
    authConfigCreateThrows: null,
    ...overrides,
  };
  let counter = 0;
  const session = (id: string): ComposioSessionLike => ({
    sessionId: id,
    async authorize(toolkit, options) {
      state.authorized.push({ toolkit, callbackUrl: options?.callbackUrl });
      if (state.authorizeThrows) {
        const err = state.authorizeThrows;
        state.authorizeThrows = null;
        throw err;
      }
      return { id: `ca_${toolkit}`, redirectUrl: `https://connect.composio.dev/${toolkit}` };
    },
    async toolkits(options) {
      state.listed.push(options);
      if ((options?.limit ?? 0) > 50) throw Object.assign(new Error("payload.limit must be <= 50"), { statusCode: 400 });
      if (options?.search !== undefined && options.search.length < 3) {
        throw Object.assign(new Error("Validation error"), { statusCode: 400 });
      }
      const items = options?.isConnected
        ? state.toolkitItems.filter((item) => item.connection?.isActive)
        : options?.toolkits
          ? state.toolkitItems.filter((item) => options.toolkits?.includes(item.slug))
          : state.toolkitItems.filter((item) => !options?.search || item.slug.includes(options.search));
      return { items, cursor: undefined };
    },
    async search(params) {
      state.searched.push(params);
      return state.searchResponse;
    },
    async execute(slug, args) {
      state.executed.push({ slug, args });
      if (state.executeThrows) {
        const err = state.executeThrows;
        state.executeThrows = null;
        throw err;
      }
      return { data: { ok: true, slug }, successful: true };
    },
  });
  const factory = (): ComposioLike => ({
    sessions: {
      async create(userId, config) {
        state.created.push({ userId, config });
        counter += 1;
        return session(`trs_${counter}`);
      },
      async use(id) {
        state.used.push(id);
        if (state.useThrows) throw state.useThrows;
        return session(id);
      },
    },
    connectedAccounts: {
      async list(query) {
        // Paged the way Composio pages: a cursor is the offset of the next
        // page, and the last page carries no `nextCursor`.
        const all = query.userIds.flatMap((userId) => state.accounts[userId] ?? []);
        const limit = query.limit ?? all.length;
        const offset = query.cursor ? Number(query.cursor) : 0;
        state.listed.push({ limit, cursor: query.cursor });
        const items = all.slice(offset, offset + limit);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;
        return { items, nextCursor: next };
      },
      async delete(id) {
        state.deleted.push(id);
        return {};
      },
    },
    toolkits: {
      async get(slug) {
        const info = state.toolkitInfo[slug];
        if (!info) throw Object.assign(new Error("not found"), { status: 404 });
        return info;
      },
    },
    authConfigs: {
      async list() {
        return { items: state.authConfigsListed };
      },
      async create(toolkit, options) {
        if (state.authConfigCreateThrows) {
          const err = state.authConfigCreateThrows;
          state.authConfigCreateThrows = null;
          throw err;
        }
        state.authConfigsCreated.push({ toolkit, options });
        return { id: `ac_${toolkit}` };
      },
      async delete(id) {
        state.authConfigsDeleted.push(id);
        return {};
      },
    },
    client: {
      toolkits: {
        async list(query) {
          // Paged like Composio: the cursor is the offset of the next page.
          const offset = query.cursor ? Number(query.cursor) : 0;
          const limit = query.limit ?? 100;
          const items = state.rawToolkits.slice(offset, offset + limit);
          const next = offset + limit < state.rawToolkits.length ? String(offset + limit) : null;
          return { items, next_cursor: next };
        },
      },
    },
    tools: {
      async getRawComposioTools() {
        return state.directTools;
      },
    },
  });
  return { state, factory };
}

/** Composio's refusal when it has no OAuth app for a toolkit, as the SDK throws it. */
function noManagedAuth(toolkit: string): Error {
  return Object.assign(new Error(`400 no managed auth for ${toolkit}`), {
    status: 400,
    error: {
      error: {
        message: `Composio does not manage auth for toolkit ${toolkit} and no auth config without required fields is available.`,
        code: 4308,
        slug: "ToolRouterV2_NoManagedAuth",
        status: 400,
      },
    },
  });
}

const TIKTOK_INFO = {
  slug: "tiktok",
  composioManagedAuthSchemes: [],
  authConfigDetails: [
    {
      mode: "OAUTH2",
      fields: {
        authConfigCreation: {
          required: [
            { name: "client_id", displayName: "Client id", description: "Client id of the app" },
            { name: "client_secret", displayName: "Client secret", description: "Client secret of the app" },
            { name: "oauth_redirect_uri", displayName: "Redirect URI" },
          ],
        },
      },
    },
  ],
};

test.afterEach(() => setComposioFactory(null));

test("no key means no session and no network", async () => {
  const { factory } = stub();
  setComposioFactory(factory);
  await assert.rejects(() => connectorsSession(tmpPath(false)), /connectors_no_key/);
});

test("session is created once, persisted, and resumed by id", async () => {
  const { state, factory } = stub();
  setComposioFactory(factory);
  const path = tmpPath();
  const first = await connectorsSession(path);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0]?.userId, readConnectorsStore(path).userId);
  assert.deepEqual(state.created[0]?.config, { manageConnections: { enable: false }, sandbox: { enable: false } });
  assert.equal(readConnectorsStore(path).sessionId, first.sessionId);
  // Same process: cached, no use() call.
  await connectorsSession(path);
  assert.equal(state.used.length, 0);
  // Fresh process: use() with the stored id.
  setComposioFactory(factory);
  await connectorsSession(path);
  assert.deepEqual(state.used, [first.sessionId]);
  assert.equal(state.created.length, 1);
});

test("a session Composio no longer knows is replaced", async () => {
  const { state, factory } = stub({ useThrows: Object.assign(new Error("gone"), { statusCode: 404 }) });
  setComposioFactory(factory);
  const path = tmpPath();
  updateConnectorsStore((store) => {
    store.sessionId = "trs_stale";
  }, path);
  const session = await connectorsSession(path);
  assert.deepEqual(state.used, ["trs_stale"]);
  assert.equal(state.created.length, 1);
  assert.equal(readConnectorsStore(path).sessionId, session.sessionId);
});

test("other session errors are surfaced, not swallowed", async () => {
  const { factory } = stub({ useThrows: Object.assign(new Error("unauthorized"), { statusCode: 401 }) });
  setComposioFactory(factory);
  const path = tmpPath();
  updateConnectorsStore((store) => {
    store.sessionId = "trs_x";
  }, path);
  await assert.rejects(() => connectorsSession(path), /unauthorized/);
});

const GMAIL: ToolkitItem = {
  slug: "gmail",
  name: "Gmail",
  isNoAuth: false,
  logo: "https://logos/gmail.png",
  connection: { isActive: true, connectedAccount: { status: "ACTIVE", id: "ca_gmail" } },
};
const SLACK: ToolkitItem = { slug: "slack", name: "Slack", isNoAuth: false, logo: undefined };
const NOAUTH: ToolkitItem = { slug: "composio_search", name: "Composio Search", isNoAuth: true, logo: undefined };
const PENDING: ToolkitItem = {
  slug: "notion",
  name: "Notion",
  isNoAuth: false,
  connection: { isActive: false, connectedAccount: { status: "INITIATED", id: "ca_notion" } },
};

const AIRTABLE: ToolkitItem = { slug: "airtable", name: "Airtable", isNoAuth: false, logo: undefined };
const ZULIP: ToolkitItem = { slug: "zulip", name: "Zulip", isNoAuth: false, logo: undefined };
const NOTION_MCP: ToolkitItem = { slug: "notion_mcp", name: "Notion MCP", isNoAuth: false, logo: undefined };

test("listing puts connected first, then featured in order, then the rest, and refreshes the cache", async () => {
  const { factory } = stub({ toolkitItems: [ZULIP, SLACK, PENDING, AIRTABLE, GMAIL, NOAUTH] });
  setComposioFactory(factory);
  const path = tmpPath();
  // A cold open shows the connected and popular apps; the catalogue walk
  // runs behind it and the next listing has everything.
  const cold = await listConnectorToolkits({}, path);
  assert.deepEqual(cold.rows.map((row) => row.slug), ["gmail", "slack", "notion", "airtable"]);
  await catalogueReady();
  const { rows, total, nextOffset } = await listConnectorToolkits({}, path);
  assert.equal(total, 5);
  assert.equal(nextOffset, null);
  assert.deepEqual(
    rows.map((row) => [row.slug, row.connected, row.accountId, row.status]),
    [
      ["gmail", true, "ca_gmail", "ACTIVE"],
      ["slack", false, null, null],
      // A half-finished connection is not connected; the dialog tracks its
      // own pending state, so the row carries no account.
      ["notion", false, null, null],
      ["airtable", false, null, null],
      ["zulip", false, null, null],
    ],
  );
  assert.deepEqual(readConnectorsStore(path).connectedToolkits, ["gmail"]);
});

test("listing with a search filters by slug or name, lowercased", async () => {
  const { state, factory } = stub({ toolkitItems: [SLACK, GMAIL] });
  setComposioFactory(factory);
  const { rows } = await listConnectorToolkits({ search: "Sla" }, tmpPath());
  assert.deepEqual(rows.map((row) => row.slug), ["slack"]);
  const remote = state.listed.filter((options) => options?.search !== undefined).map((options) => options?.search);
  assert.deepEqual(remote, ["sla"]);
});

test("an MCP variant is listed after its plain app and hides only when no-auth", async () => {
  const { factory } = stub({ toolkitItems: [NOTION_MCP, PENDING, NOAUTH] });
  setComposioFactory(factory);
  const path = tmpPath();
  await listConnectorToolkits({}, path);
  await catalogueReady();
  const { rows } = await listConnectorToolkits({ search: "notion" }, path);
  assert.deepEqual(rows.map((row) => row.slug), ["notion", "notion_mcp"]);
  const all = await listConnectorToolkits({}, path);
  assert.ok(!all.rows.some((row) => row.noAuth));
});

test("paging walks the list and the catalogue cache makes the second open local", async () => {
  const many: ToolkitItem[] = Array.from({ length: 70 }, (_, index) => ({
    slug: `app${String(index).padStart(2, "0")}`,
    name: `App ${String(index).padStart(2, "0")}`,
    isNoAuth: false,
    logo: undefined,
  }));
  const { state, factory } = stub({ toolkitItems: [GMAIL, ...many] });
  setComposioFactory(factory);
  const path = tmpPath();
  const first = await listConnectorToolkits({ limit: 30 }, path);
  assert.equal(first.rows[0]?.slug, "gmail");
  await catalogueReady();
  const second = await listConnectorToolkits({ limit: 30 }, path);
  assert.equal(second.total, 71);
  assert.equal(second.nextOffset, 30);
  const third = await listConnectorToolkits({ offset: 60, limit: 30 }, path);
  assert.equal(third.rows.length, 11);
  assert.equal(third.nextOffset, null);
  // With the cache in place, a search touches nothing but the connected page.
  const before = state.listed.length;
  const found = await listConnectorToolkits({ search: "app 6" }, path);
  assert.equal(found.rows[0]?.slug, "app60");
  assert.equal(state.listed.slice(before).every((options) => options?.isConnected === true), true);
});

test("a one or two character search never reaches Composio", async () => {
  const { state, factory } = stub({ toolkitItems: [SLACK, GMAIL, PENDING] });
  setComposioFactory(factory);
  const { rows } = await listConnectorToolkits({ search: "sl" }, tmpPath());
  assert.deepEqual(rows.map((row) => row.slug), ["slack"]);
  assert.equal(state.listed.some((options) => options?.search !== undefined), false);
});

test("an empty connected page clears the cache, and a search never rewrites it", async () => {
  const { state, factory } = stub({ toolkitItems: [SLACK, GMAIL] });
  setComposioFactory(factory);
  const path = tmpPath();
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail", "github"]), path);
  // github is no longer reported connected by Composio: the cache follows.
  await listConnectorToolkits({ search: "sla" }, path);
  assert.deepEqual(readConnectorsStore(path).connectedToolkits, ["gmail"]);
  // Nothing connected at all: the cache empties, the agent tools refuse.
  state.toolkitItems = [SLACK];
  forgetConnected();
  await listConnectorToolkits({}, path);
  assert.deepEqual(readConnectorsStore(path).connectedToolkits, []);
});

test("a session that died after caching is dropped; reads are retried, executes are not", async () => {
  const { state, factory } = stub({ executeThrows: Object.assign(new Error("gone"), { statusCode: 410 }) });
  setComposioFactory(factory);
  const path = tmpPath();
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail"]), path);
  const first = await connectorsSession(path);
  await assert.rejects(() => executeConnectorTool("GMAIL_SEND_EMAIL", {}, path), /session_expired/);
  assert.equal(state.executed.length, 1);
  assert.equal(readConnectorsStore(path).sessionId, null);
  // The next call gets a fresh session and runs once.
  const out = await executeConnectorTool("GMAIL_SEND_EMAIL", {}, path);
  assert.deepEqual(out, { data: { ok: true, slug: "GMAIL_SEND_EMAIL" }, successful: true });
  assert.equal(state.executed.length, 2);
  assert.equal(state.created.length, 2);
  assert.notEqual(readConnectorsStore(path).sessionId, first.sessionId);
});

test("authorize returns the redirect and refuses a bad slug", async () => {
  const { state, factory } = stub();
  setComposioFactory(factory);
  const path = tmpPath();
  const result = await authorizeConnector("gmail", "http://127.0.0.1:4320/api/connectors/callback", path);
  assert.equal(result.redirectUrl, "https://connect.composio.dev/gmail");
  assert.equal(result.accountId, "ca_gmail");
  assert.equal(state.authorized[0]?.callbackUrl, "http://127.0.0.1:4320/api/connectors/callback");
  await assert.rejects(() => authorizeConnector("Gmail!", "http://x", path), /toolkit_invalid/);
});

test("an app Composio has no OAuth app for is reported as needing the owner's own", async () => {
  const { state, factory } = stub({ authorizeThrows: noManagedAuth("tiktok") });
  setComposioFactory(factory);
  const path = tmpPath();
  await assert.rejects(() => authorizeConnector("tiktok", "http://127.0.0.1:4320/api/connectors/callback", path), /connector_needs_own_app/);
  assert.equal(state.authorized.length, 1);
  // Any other refusal keeps its own shape, so the route's fallback code applies.
  state.authorizeThrows = Object.assign(new Error("boom"), { status: 500 });
  await assert.rejects(() => authorizeConnector("tiktok", "http://x", path), /boom/);
  assert.equal(isNoManagedAuth(noManagedAuth("x")), true);
  assert.equal(isNoManagedAuth(Object.assign(new Error("x"), { status: 400, error: { error: { code: 301 } } })), false);
  assert.equal(isNoManagedAuth(new Error("connector_needs_own_app")), false);
});

test("the own-app form lists Composio's required fields, hides the redirect field and marks secrets", async () => {
  const { factory } = stub({ toolkitInfo: { tiktok: TIKTOK_INFO } });
  setComposioFactory(factory);
  const path = tmpPath();
  const form = await describeOwnApp("tiktok", path);
  assert.equal(form.authScheme, "OAUTH2");
  assert.equal(form.redirectUri, "https://backend.composio.dev/api/v3/toolkits/auth/callback");
  assert.deepEqual(form.fields, [
    { name: "client_id", label: "Client id", description: "Client id of the app", secret: false },
    { name: "client_secret", label: "Client secret", description: "Client secret of the app", secret: true },
  ]);
  await assert.rejects(() => describeOwnApp("Tik Tok", path), /toolkit_invalid/);
  // An app with no OAuth scheme to bring cannot take an own app.
  await assert.rejects(
    () => connectOwnApp("tiktok_ads", { client_id: "a" }, "http://x", path),
    /not found/,
  );
});

test("connecting with an own app creates a tool-router config with the redirect uri, replaces this app's earlier one, and authorizes", async () => {
  const { state, factory } = stub({
    toolkitInfo: { tiktok: TIKTOK_INFO },
    authConfigsListed: [
      { id: "ac_old", name: "Useful Bot", isComposioManaged: false },
      { id: "ac_theirs", name: "Their dashboard config", isComposioManaged: false },
      { id: "ac_managed", name: "Useful Bot", isComposioManaged: true },
    ],
  });
  setComposioFactory(factory);
  const path = tmpPath();
  const result = await connectOwnApp(
    "tiktok",
    { client_id: " id-1 ", client_secret: "s3cret" },
    "http://127.0.0.1:4320/api/connectors/callback",
    path,
  );
  assert.equal(result.redirectUrl, "https://connect.composio.dev/tiktok");
  assert.deepEqual(state.authConfigsDeleted, ["ac_old"]);
  assert.deepEqual(state.authConfigsCreated, [
    {
      toolkit: "tiktok",
      options: {
        type: "use_custom_auth",
        authScheme: "OAUTH2",
        name: "Useful Bot",
        isEnabledForToolRouter: true,
        credentials: {
          client_id: "id-1",
          client_secret: "s3cret",
          oauth_redirect_uri: "https://backend.composio.dev/api/v3/toolkits/auth/callback",
        },
      },
    },
  ]);
  assert.equal(state.authorized.at(-1)?.callbackUrl, "http://127.0.0.1:4320/api/connectors/callback");
});

test("an own-app connect refuses missing, extra, empty or oversized credentials before touching Composio", async () => {
  const { state, factory } = stub({ toolkitInfo: { tiktok: TIKTOK_INFO } });
  setComposioFactory(factory);
  const path = tmpPath();
  const cases: Array<Record<string, unknown>> = [
    { client_id: "a" },
    { client_id: "a", client_secret: "b", scopes: "c" },
    { client_id: "a", client_secret: "" },
    { client_id: "a", client_secret: 7 },
    { client_id: "a", client_secret: "x".repeat(4097) },
    { client_id: "a", client_secret: "b", oauth_redirect_uri: "https://evil.example" },
  ];
  for (const credentials of cases) {
    await assert.rejects(() => connectOwnApp("tiktok", credentials, "http://x", path), /own_app_fields/);
  }
  assert.equal(state.authConfigsCreated.length, 0);
  assert.equal(state.authorized.length, 0);
  // Composio's own refusal of the credentials gets a code the dialog can name.
  state.authConfigCreateThrows = Object.assign(new Error("400"), {
    status: 400,
    error: { error: { code: 301, slug: "Auth_Config_ValidationError", message: "Missing required field" } },
  });
  await assert.rejects(() => connectOwnApp("tiktok", { client_id: "a", client_secret: "b" }, "http://x", path), /own_app_rejected/);
});

test("the catalogue records which apps need the owner's own OAuth app", async () => {
  const tiktok: ToolkitItem = { slug: "tiktok", name: "Tiktok", isNoAuth: false, logo: undefined };
  const shopify: ToolkitItem = { slug: "shopify", name: "Shopify", isNoAuth: false, logo: undefined };
  const { factory } = stub({
    toolkitItems: [GMAIL, tiktok, shopify, SLACK],
    rawToolkits: [
      { slug: "gmail", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
      { slug: "TIKTOK", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] },
      { slug: "shopify", auth_schemes: ["API_KEY", "OAUTH2"], composio_managed_auth_schemes: [] },
      { slug: "slack", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
    ],
  });
  setComposioFactory(factory);
  const path = tmpPath();
  await listConnectorToolkits({}, path);
  await catalogueReady();
  const page = await listConnectorToolkits({ limit: 10 }, path);
  const flags = Object.fromEntries(page.rows.map((row) => [row.slug, row.ownApp]));
  assert.deepEqual(flags, { gmail: false, slack: false, shopify: false, tiktok: true });
  assert.equal(needsOwnApp({ no_auth: true, auth_schemes: ["OAUTH2"] }), false);
  assert.equal(needsOwnApp({ auth_schemes: [], composio_managed_auth_schemes: [] }), false);
  assert.equal(needsOwnApp({ auth_schemes: ["OAUTH1"], composio_managed_auth_schemes: [] }), true);
});

test("a failed flag walk still caches the catalogue, with the flags unset", async () => {
  const { state, factory } = stub({ toolkitItems: [GMAIL, SLACK] });
  const broken: ComposioLike = { ...factory("ak_stub"), client: { toolkits: { async list() { throw Object.assign(new Error("503"), { status: 503 }); } } } };
  setComposioFactory(() => broken);
  const path = tmpPath();
  await listConnectorToolkits({}, path);
  await catalogueReady();
  const before = state.listed.length;
  const page = await listConnectorToolkits({ limit: 10 }, path);
  assert.deepEqual(page.rows.map((row) => [row.slug, row.ownApp]), [["gmail", false], ["slack", false]]);
  // The cache is in place: the second read asked Composio for the connected page only.
  assert.equal(state.listed.slice(before).every((options) => options?.isConnected === true), true);
});

test("disconnect proves ownership by listing, deletes, and drops the cache entry", async () => {
  const path = tmpPath();
  const userId = readConnectorsStore(path).userId;
  const { state, factory } = stub({
    accounts: {
      [userId]: [{ id: "ca_mine", toolkit: { slug: "gmail" } }],
      ub_someoneelse00: [{ id: "ca_other", toolkit: { slug: "slack" } }],
    },
  });
  setComposioFactory(factory);
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail", "slack"]), path);
  await disconnectConnector("ca_mine", path);
  assert.deepEqual(state.deleted, ["ca_mine"]);
  assert.deepEqual(readConnectorsStore(path).connectedToolkits, ["slack"]);
  await assert.rejects(() => disconnectConnector("ca_other", path), /account_foreign/);
  await assert.rejects(() => disconnectConnector("ca_missing", path), /account_foreign/);
  await assert.rejects(() => disconnectConnector("../x", path), /account_invalid/);
  assert.deepEqual(state.deleted, ["ca_mine"]);
});

test("disconnect finds an account past the first page of connected accounts", async () => {
  const path = tmpPath();
  const userId = readConnectorsStore(path).userId;
  // One page used to be the whole lookup, so everything past the hundredth
  // account was refused as somebody else's.
  const many = Array.from({ length: 250 }, (_, index) => ({
    id: `ca_${index}`,
    toolkit: { slug: index === 173 ? "notion" : "gmail" },
  }));
  const { state, factory } = stub({ accounts: { [userId]: many } });
  setComposioFactory(factory);
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail", "notion"]), path);
  await disconnectConnector("ca_173", path);
  assert.deepEqual(state.deleted, ["ca_173"]);
  assert.deepEqual(readConnectorsStore(path).connectedToolkits, ["gmail"]);
  // An id nobody has still walks every page and still refuses.
  await assert.rejects(() => disconnectConnector("ca_9999", path), /account_foreign/);
});

test("a tool's app is named from the cached catalogue, multi-word slugs included", () => {
  const path = tmpPath();
  const cataloguePath = process.env.UB_CATALOGUE_PATH as string;
  writeFileSync(cataloguePath, JSON.stringify({
    schemaVersion: 2,
    fetchedAt: new Date().toISOString(),
    items: [
      { slug: "zoho_mail", name: "Zoho Mail", isNoAuth: false },
      { slug: "zoho", name: "Zoho", isNoAuth: false },
      { slug: "asana", name: "Asana", isNoAuth: false },
    ],
  }));
  resetCatalogueMemo();
  // The longest whole-segment match wins, so the app is zoho_mail and not the
  // `zoho_mail_send` the old fallback invented by dropping the last word.
  assert.equal(toolkitHint("ZOHO_MAIL_SEND_EMAIL", cataloguePath), "zoho_mail");
  assert.equal(toolkitHint("ASANA_CREATE_TASK", cataloguePath), "asana");
  // Featured covers a machine with no catalogue yet.
  assert.equal(toolkitHint("MICROSOFT_TEAMS_SEND_MESSAGE", join(path, "..", "none.json")), "microsoft_teams");
  // Nothing knows it: the last word comes off, which is all that is left.
  assert.equal(toolkitHint("NEWAPP_DO_THING", cataloguePath), "newapp_do");
  assert.equal(toolkitHint("SINGLE", cataloguePath), "unknown");
});

test("search is restricted to connected toolkits and trimmed", async () => {
  const { state, factory } = stub({
    searchResponse: {
      results: [
        {
          primaryToolSlugs: ["GMAIL_FETCH_EMAILS"],
          relatedToolSlugs: ["SLACK_SEND_MESSAGE"],
          executionGuidance: "Use max_results.",
          knownPitfalls: ["Labels are case sensitive."],
        },
      ],
      toolSchemas: {
        GMAIL_FETCH_EMAILS: {
          toolkit: "GMAIL",
          toolSlug: "GMAIL_FETCH_EMAILS",
          description: "Fetch emails",
          inputSchema: { type: "object", properties: { max_results: { type: "integer" } } },
        },
        SLACK_SEND_MESSAGE: { toolkit: "SLACK", toolSlug: "SLACK_SEND_MESSAGE", description: "Send" },
      },
      toolkitConnectionStatuses: [
        { toolkit: "GMAIL", hasActiveConnection: true },
        { toolkit: "SLACK", hasActiveConnection: false },
      ],
    },
    directTools: [{ slug: "GMAIL_LIST_LABELS", description: "List labels", toolkit: { slug: "gmail" } }],
  });
  setComposioFactory(factory);
  const path = tmpPath();
  await assert.rejects(() => searchConnectorTools("mail", path), /no_connectors/);
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail"]), path);
  const result = await searchConnectorTools("unread mail", path);
  assert.deepEqual(state.searched, [{ query: "unread mail", toolkits: ["gmail"] }]);
  assert.deepEqual(result.tools.map((hit) => hit.tool), ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_LABELS"]);
  assert.equal(result.tools[0]?.toolkit, "gmail");
  assert.deepEqual(result.guidance, ["Use max_results.", "Labels are case sensitive."]);
  assert.deepEqual(result.notConnected, ["slack"]);
});

test("an MCP variant's own tools are found and its plain app is not reported missing", async () => {
  const { factory } = stub({
    searchResponse: {
      results: [{ primaryToolSlugs: ["NOTION_SEARCH_NOTION_PAGE"] }],
      toolSchemas: {
        NOTION_SEARCH_NOTION_PAGE: { toolkit: "NOTION", toolSlug: "NOTION_SEARCH_NOTION_PAGE", description: "Search" },
      },
      toolkitConnectionStatuses: [{ toolkit: "notion", hasActiveConnection: false }],
    },
    directTools: [
      { slug: "NOTION_MCP_NOTION_AI_SEARCH", description: "AI search", toolkit: { slug: "notion_mcp" } },
      { slug: "GMAIL_FETCH_EMAILS", description: "not connected here", toolkit: { slug: "gmail" } },
    ],
  });
  setComposioFactory(factory);
  const path = tmpPath();
  updateConnectorsStore((store) => setConnectedToolkits(store, ["notion_mcp"]), path);
  const result = await searchConnectorTools("search notion pages", path);
  assert.deepEqual(result.tools.map((hit) => [hit.tool, hit.toolkit]), [["NOTION_MCP_NOTION_AI_SEARCH", "notion_mcp"]]);
  assert.deepEqual(result.notConnected, []);
});

test("execute refuses toolkits that are not connected before touching the network", async () => {
  const { state, factory } = stub();
  setComposioFactory(factory);
  const path = tmpPath();
  await assert.rejects(() => executeConnectorTool("GMAIL_FETCH_EMAILS", {}, path), /no_connectors/);
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail"]), path);
  await assert.rejects(
    () => executeConnectorTool("SLACK_SEND_MESSAGE", {}, path),
    (err: Error & { toolkit?: string }) => err.message === "not_connected" && err.toolkit === "slack",
  );
  assert.equal(state.executed.length, 0);
  const out = await executeConnectorTool("GMAIL_FETCH_EMAILS", { max_results: 2 }, path);
  assert.deepEqual(state.executed, [{ slug: "GMAIL_FETCH_EMAILS", args: { max_results: 2 } }]);
  assert.deepEqual(out, { data: { ok: true, slug: "GMAIL_FETCH_EMAILS" }, successful: true });
});

test("isKeyRejected recognises Composio's 401 only", () => {
  assert.equal(isKeyRejected(Object.assign(new Error("x"), { statusCode: 401 })), true);
  assert.equal(isKeyRejected(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(isKeyRejected(Object.assign(new Error("x"), { statusCode: 404 })), false);
  assert.equal(isKeyRejected(new Error("x")), false);
  assert.equal(isKeyRejected(null), false);
});

test("toolkitOf matches a whole connected toolkit segment, longest first", () => {
  const known = ["gmail", "microsoft_teams", "microsoft"];
  assert.equal(toolkitOf("GMAIL_FETCH_EMAILS", known), "gmail");
  assert.equal(toolkitOf("MICROSOFT_TEAMS_SEND_MESSAGE", known), "microsoft_teams");
  assert.equal(toolkitOf("MICROSOFT_GRAPH_LIST", known), "microsoft");
  assert.equal(toolkitOf("GMAILX_FETCH", known), null);
  assert.equal(toolkitOf("GOOGLECALENDAR_CREATE_EVENT", known), null);
  assert.equal(toolkitOf("weird", known), null);
});

test("an exact slug with underscores is found first", async () => {
  const { factory } = stub({ toolkitItems: [NOTION_MCP, PENDING] });
  setComposioFactory(factory);
  const path = tmpPath();
  await listConnectorToolkits({}, path);
  await catalogueReady();
  const { rows } = await listConnectorToolkits({ search: "notion_mcp" }, path);
  assert.deepEqual(rows.map((row) => row.slug), ["notion_mcp"]);
});

test("countToolkitTools counts one toolkit's tools and returns null on failure", async () => {
  const { state, factory } = stub({
    toolkitItems: [GMAIL],
    directTools: [
      { slug: "GMAIL_FETCH_EMAILS", toolkit: { slug: "gmail" } },
      { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "gmail" } },
      { slug: "SLACK_POST", toolkit: { slug: "slack" } },
    ],
  });
  setComposioFactory(factory);
  const path = tmpPath();
  assert.equal(await countToolkitTools("gmail", path), 2);
  assert.equal(await countToolkitTools("not a slug", path), null);
  state.directTools = null as never;
  assert.equal(await countToolkitTools("gmail", path), null);
  assert.equal(await countToolkitTools("gmail", tmpPath(false)), null);
});

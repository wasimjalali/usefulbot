import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, listThreadEvents, readProposal, updateProposal } from "../shared/agent-store.ts";
import {
  completeConnectionOAuth,
  failConnectionOAuth,
  pumpConnections,
  resetConnectionMemo,
  SERVER_LINGER_MS,
  SERVER_WAIT_MS,
  startConnectionConfirm,
} from "../shared/connection-flow.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { EXCALIDRAW_CONNECTION, findConnectionById, readConnectionsStore, removeConnection, upsertConnection } from "../shared/connections-store.ts";

function storePathOf(): string {
  return process.env.UB_AGENT_STORE_PATH ?? "";
}
import { listHandoffs, queueHandoff } from "../shared/handoffs.ts";
import { memoryKeychain, setKeychainDriver, connectionSecretService, keychainGet, keychainSet } from "../shared/keychain.ts";
import { setMcpFetch } from "../shared/mcp-http.ts";
import { connectionIndex, connectionStatus, putConnectionOperations } from "../shared/connection-tools-store.ts";
import { discoverConnection, setDiscoveryLogger } from "../shared/connection-tools.ts";
import { ApprovalStore } from "../agent/lib/approvals.ts";
import { setApprovalStore } from "../agent/lib/write.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";
import connectionTools from "../agent/tools/connection_tools.ts";
import { MOUNTED_TOOL_BUDGET } from "../shared/policy.ts";
import { findOauthPending, setOauthFetch } from "../shared/mcp-oauth.ts";
import { acquireRefreshLock } from "../shared/connection-auth.ts";
import { writeShell } from "../shared/shell-io.ts";
import { seedStore } from "../shared/shell-store.ts";

const CALLBACK = "http://127.0.0.1:4320/api/connections/callback";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "ub-server-"));
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  process.env.UB_HANDOFF_DIR = join(dir, "handoffs");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_OAUTH_PENDING_PATH = join(dir, "oauth.json");
  process.env.UB_CONNECTION_TOOLS_PATH = join(dir, "connection-tools.json");
  resetConnectionMemo();
  setConnectionLookup(async () => "8.8.8.8");
  const shell = seedStore();
  shell.bots.push({ ...shell.bots[0], id: "b1", name: "Drawer" });
  shell.selectedBotId = "b1";
  writeShell(shell);
  return { storePath: process.env.UB_AGENT_STORE_PATH, dir };
}

function seedCard(overrides: Record<string, unknown> = {}) {
  return createProposal({
    kind: "connectServer",
    connectionKind: "mcp",
    connectionId: "example",
    name: "Example",
    description: "Example MCP server for tests",
    url: "https://mcp.example.com/mcp",
    urlHost: "mcp.example.com",
    purpose: "List the widgets",
    authKind: "none",
    authHeader: null,
    sourceBotId: "b1",
    threadId: "b1",
    phase: "proposed",
    redirectHost: null,
    waitingSince: null,
    toolCount: null,
    handoffId: null,
    ...overrides,
  });
}

function stubTools(count = 2) {
  setMcpFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    const tools = Array.from({ length: count }, (_, i) => ({
      name: i === 0 ? "read_me" : "create_view",
      _meta: { ui: { visibility: ["model", "app"] } },
    }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } }), {
      headers: { "content-type": "application/json" },
    });
  });
}

test.afterEach(() => {
  setMcpFetch(null);
  setOauthFetch(null);
  setKeychainDriver(null);
  setConnectionLookup(null);
  resetConnectionMemo();
});

test("none-auth confirm writes the registry, counts tools and queues one resume", async () => {
  const { storePath } = paths();
  stubTools(2);
  const proposal = seedCard();
  const out = await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  assert.equal(out.redirectUrl, undefined);
  const stored = readProposal(proposal.id, storePath);
  assert.equal(stored?.kind === "connectServer" && stored.phase, "connected");
  assert.equal(stored?.kind === "connectServer" && stored.toolCount, 2);
  assert.equal(stored?.status, "confirmed");
  assert.equal(findConnectionById("example")?.url, "https://mcp.example.com/mcp");
  assert.equal(listHandoffs().length, 1);
  assert.equal(listHandoffs()[0].message.includes("example"), true);
  assert.equal(listHandoffs()[0].message.includes("mcp.example.com"), false);
  assert.ok(listThreadEvents("b1", storePath).some((e) => e.kind === "note" && e.text === "Example connected" && e.connectedName === "Example"));
  assert.equal(listHandoffs()[0].message.includes("BEGIN-UNTRUSTED(connect-purpose)"), true);
});

test("apiKey confirm stores the secret in Keychain, not in JSON", async () => {
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const { storePath } = paths();
  stubTools(1);
  const proposal = seedCard({ authKind: "apiKey", authHeader: "X-Api-Key" });
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK, secret: "sk_test_secret_1" });
  assert.equal(keychainGet(connectionSecretService("example")), "sk_test_secret_1");
  const disk = readFileSync(process.env.UB_CONNECTIONS_PATH ?? "", "utf8");
  assert.equal(disk.includes("sk_test"), false);
  const stored = JSON.stringify(readProposal(proposal.id, storePath));
  assert.equal(stored.includes("sk_test"), false);
  await assert.rejects(
    startConnectionConfirm(seedCard({
      connectionId: "other",
      url: "https://other.example.com/mcp",
      urlHost: "other.example.com",
      authKind: "apiKey",
    }).id, {
      callbackUrl: CALLBACK,
      secret: "short",
    }),
    /secret_invalid/,
  );
});

test("a connected card whose resume cannot queue is retried, then leaves after the linger cap", async () => {
  const { storePath } = paths();
  stubTools(1);
  const proposal = seedCard();
  writeFileSync(process.env.UB_HANDOFF_DIR ?? "", "not a directory");
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  const stored = readProposal(proposal.id, storePath);
  assert.equal(stored?.kind === "connectServer" && stored.phase, "connected");
  assert.equal(stored?.status, "pending");
  await pumpConnections();
  assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
  await pumpConnections({ now: Date.now() + SERVER_LINGER_MS + 1000 });
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("a waiting oauth card expires after ten minutes", async () => {
  const { storePath } = paths();
  const t0 = Date.now();
  const proposal = seedCard({ authKind: "oauth", phase: "waiting", waitingSince: new Date(t0).toISOString(), redirectHost: "auth.example.com" });
  const out = await pumpConnections({ now: t0 + SERVER_WAIT_MS + 1000 });
  assert.deepEqual(out.expired, [proposal.id]);
  assert.equal((readProposal(proposal.id, storePath) as { phase: string }).phase, "expired");
});

test("overlapping pumps do not double-confirm a connected card", async () => {
  const { storePath } = paths();
  stubTools(1);
  const proposal = seedCard();
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  const results = await Promise.all([pumpConnections(), pumpConnections(), pumpConnections()]);
  assert.equal(listHandoffs().length, 1);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
  assert.ok(results.every((r) => Array.isArray(r.connected)));
});

test("an older resume of the same server is not adopted", async () => {
  paths();
  stubTools(1);
  const stale = queueHandoff({
    sourceBotId: "bot-useful",
    sourceName: "Useful Bot",
    targetBotId: "b1",
    targetName: "Drawer",
    message: "The owner connected the server example. Continue the task: List the widgets",
  });
  const earlier = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(process.env.UB_HANDOFF_DIR ?? "", `${stale.id}.json`), JSON.stringify({
    ...stale,
    status: "delivered",
    createdAt: earlier,
    updatedAt: earlier,
  }));
  const proposal = seedCard();
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  const id = (readProposal(proposal.id) as { handoffId: string }).handoffId;
  assert.notEqual(id, stale.id);
  assert.equal(listHandoffs().length, 2);
});

test("oauth complete refuses a card that is not waiting and does not fetch", async () => {
  const { storePath } = paths();
  const proposal = seedCard({ authKind: "oauth", phase: "proposed" });
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: proposal.id,
    connectionId: "example",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: null,
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
  }]));
  let fetched = false;
  setMcpFetch(async () => {
    fetched = true;
    return new Response("{}");
  });
  setOauthFetch(async () => {
    fetched = true;
    return new Response("{}");
  });
  await assert.rejects(() => completeConnectionOAuth("code-1", "statevalue123456", { storePath }), /proposal_phase/);
  assert.equal(fetched, false);
});

test("seeded Excalidraw is not a secret-bearing row", () => {
  paths();
  upsertConnection(EXCALIDRAW_CONNECTION);
  const row = findConnectionById("excalidraw");
  assert.equal(row?.authKind, "none");
  assert.deepEqual(row?.toolsAllow, ["read_me", "create_view"]);
  assert.equal(JSON.stringify(readConnectionsStore()).includes("token"), false);
});

test("a duplicate card never overwrites the live row's credential", async () => {
  // keychainSet writes with `security add-generic-password -U`, so adopting
  // the live row's id and then writing this card's secret under it would
  // replace the credential that row is using. An API key landing on an OAuth
  // row destroys its refresh token and nothing re-mints it.
  setKeychainDriver(memoryKeychain());
  paths();
  stubTools(2);
  upsertConnection({
    id: "example",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Connected first",
    authKind: "oauth",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  const bundle = JSON.stringify({ accessToken: "at_live", refreshToken: "rt_live" });
  keychainSet(connectionSecretService("example"), bundle);

  const second = seedCard({ connectionId: "example-2", name: "Example Two", authKind: "apiKey", authHeader: "X-Api-Key" });
  await startConnectionConfirm(second.id, { callbackUrl: CALLBACK, secret: "sk_test_secret_1" });

  // The row the owner connected is untouched, credential and auth shape both.
  assert.equal(keychainGet(connectionSecretService("example")), bundle);
  const rows = readConnectionsStore().connections;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "example");
  assert.equal(rows[0].authKind, "oauth");
  assert.equal(rows[0].description, "Connected first");
  // And the duplicate card is settled, not left pending on the owner.
  const card = readProposal(second.id, storePathOf());
  assert.equal(card && "phase" in card ? card.phase : null, "connected");
});

test("two cards for the same server end up as one row, not two", async () => {
  // propose_connection refuses a URL that is already connected, and allows one
  // pending card per thread. Two bots can still each hold a card for the same
  // server, and the owner can authorize both. Two rows would mount the server
  // twice, so the model would see every one of its tools twice and both copies
  // would count against the tool cap.
  const { storePath } = paths();
  stubTools(2);
  const first = seedCard();
  await startConnectionConfirm(first.id, { callbackUrl: CALLBACK });
  assert.equal(readConnectionsStore().connections.length, 1);

  const second = seedCard({ connectionId: "example-2", name: "Example Two", threadId: "b1" });
  await startConnectionConfirm(second.id, { callbackUrl: CALLBACK });

  const rows = readConnectionsStore().connections;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "example");
  // The card settles against the row that is there. Its own id is left alone,
  // so the Keychain item it may already hold stays its own.
  const card = readProposal(second.id, storePath);
  assert.equal(card && "connectionId" in card ? card.connectionId : null, "example-2");
  assert.equal(card && "phase" in card ? card.phase : null, "connected");
});

test("a second authorize on the same card keeps its own row", async () => {
  paths();
  stubTools(2);
  const card = seedCard();
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  updateProposal(card.id, (item) => {
    if (item.kind === "connectServer") {
      item.status = "pending";
      item.phase = "proposed";
    }
  });
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const rows = readConnectionsStore().connections;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "example");
});

test("an oauth sign-in that finishes after another card connected settles, it does not mint a second row", async () => {
  // The browser holds the sign-in open. Another card for the same server can
  // connect in the meantime, from a bearer card or a second oauth card. The
  // completion must not add a row (the server would be mounted twice) and must
  // not store its token (it would land on the live row's Keychain item).
  setKeychainDriver(memoryKeychain());
  const { storePath } = paths();
  const proposal = seedCard({ authKind: "oauth", phase: "waiting" });
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: proposal.id,
    connectionId: "example",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: null,
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
  }]));
  upsertConnection({
    id: "example-first",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Connected while the browser was open",
    authKind: "bearer",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  keychainSet(connectionSecretService("example-first"), "tok_live");

  // The live row is listed with its own credential, which is the one fetch
  // this settles with; the sign-in's code is never exchanged.
  setDiscoveryLogger(() => {});
  listing((id) => rpcJson(id, { tools: [{ name: "list_widgets", description: "List" }] }));
  let exchanged = false;
  setOauthFetch(async () => { exchanged = true; return new Response("{}"); });

  const out = await completeConnectionOAuth("code-1", "statevalue123456", { storePath });
  assert.equal(out.proposalId, proposal.id);
  // The code was never exchanged, so no token was minted to strand.
  assert.equal(exchanged, false);
  const rows = readConnectionsStore().connections;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "example-first");
  assert.equal(rows[0].authKind, "bearer");
  assert.equal(keychainGet(connectionSecretService("example-first")), "tok_live");
  const card = readProposal(proposal.id, storePath);
  assert.equal(card && "phase" in card ? card.phase : null, "connected");
});

test("a card that loses the row leaves no secret behind and names the row that won", async () => {
  // The lookup and the insert cannot be atomic in the caller: probeToolCount
  // awaits between them. The store's lock decides, and the card that loses
  // must not have written a Keychain item, because nothing would point at it
  // and nothing ever deletes it.
  setKeychainDriver(memoryKeychain());
  const { storePath } = paths();
  stubTools(2);
  upsertConnection({
    id: "example-first",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Won the row",
    authKind: "bearer",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  keychainSet(connectionSecretService("example-first"), "tok_winner");
  const card = seedCard({ connectionId: "example-late", authKind: "apiKey", authHeader: "X-Api-Key" });
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK, secret: "sk_test_secret_1" });

  // Nothing under the loser's own id, and, the part that matters, nothing
  // written over the winner's: keychainSet replaces in place.
  assert.equal(keychainGet(connectionSecretService("example-late")), null);
  assert.equal(keychainGet(connectionSecretService("example-first")), "tok_winner");
  assert.equal(readConnectionsStore().connections.length, 1);
  // The resume tells the bot the connection it can actually reach, not the id
  // on its own settled card.
  const resume = listHandoffs().find((item) => item.message.includes("connected the server"));
  assert.ok(resume, "the bot is resumed");
  assert.match(resume.message, /connected the server example-first\./);
});

test("an oauth completion that loses the row strands no token and no pending sign-in", async () => {
  setKeychainDriver(memoryKeychain());
  const { storePath } = paths();
  const card = seedCard({ connectionId: "example-late", authKind: "oauth", phase: "waiting" });
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: card.id,
    connectionId: "example-late",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: "shh",
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
  }]));
  upsertConnection({
    id: "example-first",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Won the row",
    authKind: "bearer",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  keychainSet(connectionSecretService("example-first"), "tok_winner");
  await completeConnectionOAuth("code-1", "statevalue123456", { storePath });

  assert.equal(keychainGet(connectionSecretService("example-late")), null);
  assert.equal(keychainGet(connectionSecretService("example-first")), "tok_winner");
  // The verifier and the client secret do not stay on disk: nothing else would
  // ever reap them, because a retry with this state is refused.
  assert.equal(findOauthPending("statevalue123456"), null);
  assert.equal(readConnectionsStore().connections.length, 1);
});

test("two servers that were handed the same id do not overwrite each other", async () => {
  // allocateConnectionId only looks at rows that exist, so two cards proposed
  // for servers with the same name, before either is connected, both get the
  // same id. Replacing by id would repoint the live row at the other URL and
  // leave its Keychain item under an id that now means a different server.
  setKeychainDriver(memoryKeychain());
  paths();
  stubTools(2);
  const first = seedCard({ authKind: "apiKey", authHeader: "X-Api-Key" });
  await startConnectionConfirm(first.id, { callbackUrl: CALLBACK, secret: "sk_first_secret_1" });
  assert.equal(keychainGet(connectionSecretService("example")), "sk_first_secret_1");

  const second = seedCard({
    connectionId: "example",
    url: "https://mcp.other.example/mcp",
    urlHost: "mcp.other.example",
    authKind: "apiKey",
    authHeader: "X-Api-Key",
  });
  await startConnectionConfirm(second.id, { callbackUrl: CALLBACK, secret: "sk_second_secret" });

  const rows = readConnectionsStore().connections;
  assert.equal(rows.length, 2);
  const live = rows.find((row) => row.id === "example");
  assert.equal(live?.url, "https://mcp.example.com/mcp");
  // The first server keeps its own credential, and the second gets its own id.
  assert.equal(keychainGet(connectionSecretService("example")), "sk_first_secret_1");
  const other = rows.find((row) => row.url === "https://mcp.other.example/mcp");
  assert.equal(other?.id, "example-2");
  assert.equal(keychainGet(connectionSecretService("example-2")), "sk_second_secret");
});

test("a settled card does not leave its sign-in on disk", async () => {
  // Reopen on a waiting card comes back through startConnectionConfirm. If
  // another card connected the URL meanwhile, the settle returns without ever
  // reaching the callback, and the first Authorize's pending row would sit
  // there for good: the card is connected, so it can never start a fresh one.
  setKeychainDriver(memoryKeychain());
  paths();
  stubTools(2);
  const card = seedCard({ connectionId: "example-late", authKind: "oauth", phase: "waiting" });
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: card.id,
    connectionId: "example-late",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: "shh",
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
  }]));
  upsertConnection({
    id: "example-first",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Connected by another card",
    authKind: "none",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });

  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  assert.equal(findOauthPending("statevalue123456"), null);
  assert.equal(readConnectionsStore().connections.length, 1);
});

test("a connect that would overrun the mounted tool budget is refused before anything is written", async () => {
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const { storePath } = paths();
  // An OpenAPI spec mounts every operation for every turn. One that fills the
  // budget leaves no room for the next. It has to be measured to be mounted,
  // and only what is mounted is charged.
  const big = Array.from({ length: MOUNTED_TOOL_BUDGET }, (_, i) => [`/p${i}`, { get: {} }]);
  setMcpFetch(async () => new Response(JSON.stringify({ paths: Object.fromEntries(big) }), {
    headers: { "content-type": "application/json" },
  }));
  upsertConnection({
    id: "huge",
    kind: "openapi",
    name: "Huge",
    url: "https://api.example.com/openapi.json",
    description: "An OpenAPI service with many operations",
    authKind: "none",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date().toISOString(),
  });
  putConnectionOperations("huge", { operations: MOUNTED_TOOL_BUDGET, schemaBytes: 1_000, textBytes: 0, longestName: 20 });
  const proposal = seedCard({
    connectionId: "second",
    connectionKind: "openapi",
    name: "Second",
    url: "https://api2.example.com/openapi.json",
    urlHost: "api2.example.com",
    authKind: "apiKey",
    authHeader: "X-Api-Key",
  });
  await assert.rejects(
    () => startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK, secret: "sk_test_secret_1" }),
    /tool_budget_exceeded/,
  );
  // Neither the row nor the credential landed, so nothing has to be unwound.
  assert.equal(findConnectionById("second"), null);
  assert.equal(keychainGet(connectionSecretService("second")), null);
  assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
});

test("an MCP server whose tools wait to be asked for costs nothing at connect time", async () => {
  const { storePath } = paths();
  upsertConnection({
    id: "huge",
    kind: "mcp",
    name: "Huge",
    url: "https://huge.example.com/mcp",
    description: "An MCP server with two hundred tools",
    authKind: "none",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date().toISOString(),
  });
  stubTools(2);
  const proposal = seedCard();
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  assert.equal(findConnectionById("example")?.url, "https://mcp.example.com/mcp");
  // And the listing went to the index the search reads, so the first
  // find_tools after a connect answers from disk.
  assert.equal(connectionIndex("example")?.tools.length, 2);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("a spec this app could not read is not a spec with no operations in it", async () => {
  const { storePath } = paths();
  // An unreachable or oversized spec used to count as zero operations and
  // sail through the budget; eve then mounted its whole operation list on
  // every later turn.
  setMcpFetch(async () => new Response("nope", { status: 502 }));
  const proposal = seedCard({
    connectionId: "spec",
    connectionKind: "openapi",
    name: "Spec",
    url: "https://api.example.com/openapi.json",
    urlHost: "api.example.com",
  });
  await assert.rejects(
    () => startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK }),
    /tool_count_unknown/,
  );
  assert.equal(findConnectionById("spec"), null);
  assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
});

test("a spec behind a key is counted with the key the owner just pasted", async () => {
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const { storePath } = paths();
  // The row does not exist yet, so the credential cannot come from the store.
  // Without the pasted one the fetch 401s and a valid connect is refused.
  const seen: string[] = [];
  setMcpFetch(async (_input, init) => {
    const key = new Headers(init?.headers).get("x-api-key") ?? "";
    seen.push(key);
    if (key !== "sk_test_secret_1") return new Response("no", { status: 401 });
    return new Response(JSON.stringify({ paths: { "/a": { get: {} } } }), {
      headers: { "content-type": "application/json" },
    });
  });
  const proposal = seedCard({
    connectionId: "spec",
    connectionKind: "openapi",
    name: "Spec",
    url: "https://api.example.com/openapi.json",
    urlHost: "api.example.com",
    authKind: "apiKey",
    authHeader: "X-Api-Key",
  });
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK, secret: "sk_test_secret_1" });
  assert.equal(seen[0], "sk_test_secret_1");
  assert.equal(findConnectionById("spec")?.id, "spec");
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("the budget check never reads a credential the new row does not own yet", async () => {
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const { storePath } = paths();
  // An id that is free in the connections store can still have a Keychain
  // item behind it, from a row that was removed or a card that lost a race.
  keychainSet(connectionSecretService("spec"), "sk_someone_elses_secret");
  const seen: string[] = [];
  setMcpFetch(async (_input, init) => {
    seen.push(new Headers(init?.headers).get("x-api-key") ?? "");
    return new Response(JSON.stringify({ paths: { "/a": { get: {} } } }), {
      headers: { "content-type": "application/json" },
    });
  });
  const proposal = seedCard({
    connectionId: "spec",
    connectionKind: "openapi",
    name: "Spec",
    url: "https://api.example.com/openapi.json",
    urlHost: "api.example.com",
  });
  await startConnectionConfirm(proposal.id, { callbackUrl: CALLBACK });
  // A no-auth card sends no key, whatever is sitting under that id.
  assert.deepEqual([...new Set(seen)], [""]);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("a spec whose tool names would pass sixty-four under a reassigned id is refused", async () => {
  const { storePath } = paths();
  // "spec__" plus fifty-six fits, but the store can hand this row "spec-2",
  // and eve prefixes whatever id the row ends up with.
  const serve = (operationId: string) => setMcpFetch(async () => new Response(
    JSON.stringify({ paths: { "/a": { get: { operationId } } } }),
    { headers: { "content-type": "application/json" } },
  ));
  serve("o".repeat(56));
  const refused = seedCard({
    connectionId: "spec",
    connectionKind: "openapi",
    name: "Spec",
    url: "https://api.example.com/openapi.json",
    urlHost: "api.example.com",
  });
  await assert.rejects(
    () => startConnectionConfirm(refused.id, { callbackUrl: CALLBACK }),
    /tool_name_too_long/,
  );
  assert.equal(findConnectionById("spec"), null);
  assert.equal(readProposal(refused.id, storePath)?.status, "pending");
  serve("o".repeat(55));
  await startConnectionConfirm(refused.id, { callbackUrl: CALLBACK });
  assert.equal(findConnectionById("spec")?.id, "spec");
});

/** An MCP server whose tools/list answer is chosen by the test; initialize and the notification always work. */
function listing(answer: (id: number | undefined) => Response | Promise<Response>) {
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return answer(body.id);
  }) as typeof fetch);
}

const rpcJson = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });

function cardOf(id: string, storePath: string) {
  const card = readProposal(id, storePath);
  assert.equal(card?.kind, "connectServer");
  return card as Extract<NonNullable<typeof card>, { kind: "connectServer" }>;
}

test("a failing listing leaves the card failed with its reason, keeps the row and tells the bot nothing", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ["auth_failed", () => new Response("no", { status: 401 }), "auth_failed"],
    ["unreachable", () => { throw new TypeError("fetch failed"); }, "unreachable"],
    ["malformed", () => rpcJson(2, { tools: [{ name: "has.a.dot" }, { name: "has space" }] }), "malformed"],
    ["discovery_failed", () => new Response("<html>", { headers: { "content-type": "text/html" } }), "discovery_failed"],
  ];
  const cardIds: string[] = [];
  for (const [name, answer, state] of cases) {
    const id = `srv-${name.replace("_", "-")}`;
    listing(answer);
    const card = seedCard({
      connectionId: id,
      url: `https://${id}.example.com/mcp`,
      urlHost: `${id}.example.com`,
    });
    cardIds.push(card.id);
    await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
    const stored = cardOf(card.id, storePath);
    assert.equal(stored.phase, "failed", name);
    assert.equal(stored.reason, state, name);
    assert.equal(stored.toolCount, null);
    // Still pending: the owner can retry it, and nothing says it is done.
    assert.equal(stored.status, "pending");
    assert.equal(findConnectionById(id)?.url, `https://${id}.example.com/mcp`);
    assert.equal(connectionStatus(id)?.state, state);
    assert.ok(connectionStatus(id)?.lastError?.code, name);
  }
  assert.equal(listHandoffs().length, 0);
  assert.equal(listThreadEvents("b1", storePath).some((e) => e.kind === "note" && /connected/.test(String(e.text))), false);
  // The malformed one says how many it dropped.
  assert.equal(connectionStatus("srv-malformed")?.dropped, 2);
  // A pump has nothing to resume and does not settle it.
  await pumpConnections();
  for (const id of cardIds) assert.equal(cardOf(id, storePath).status, "pending");
});

test("a server with no tools is connected, and the resume says so", async () => {
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing((id) => rpcJson(id, { tools: [] }));
  const card = seedCard();
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "connected");
  assert.equal(stored.toolCount, 0);
  assert.equal(stored.reason ?? null, null);
  assert.equal(connectionStatus("example")?.state, "zero_tools");
  assert.equal(listHandoffs().length, 1);
  assert.match(listHandoffs()[0].message, /offers no tools/);
});

test("a retried failed card connects once the listing works", async () => {
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing(() => new Response("no", { status: 503 }));
  const card = seedCard();
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  assert.equal(cardOf(card.id, storePath).reason, "unreachable");
  listing((id) => rpcJson(id, { tools: [{ name: "list_widgets", description: "List" }] }));
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "connected");
  assert.equal(stored.reason ?? null, null);
  assert.equal(listHandoffs().length, 1);
});

function oauthPending(card: { id: string }, connectionId = "tella") {
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: card.id,
    connectionId,
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: null,
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
    resource: "https://mcp.example.com",
  }]));
}

const tokenReply = () => new Response(JSON.stringify({ access_token: "at_secret_1", refresh_token: "rt_secret_1", expires_in: 3600 }), {
  headers: { "content-type": "application/json" },
});

test("an oauth callback whose listing fails leaves the card failed and fires no success resume", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  // The case that was real: sign-in worked, tools/list refused the token.
  listing(() => new Response("no", { status: 401 }));
  setOauthFetch(async () => tokenReply());
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const failedOut = await completeConnectionOAuth("code-1", "statevalue123456");
  // The callback page says Connected only for a ready outcome.
  assert.deepEqual(failedOut, { proposalId: card.id, ready: false, state: "auth_failed" });
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "failed");
  assert.equal(stored.reason, "auth_failed");
  assert.equal(stored.status, "pending");
  assert.equal(listHandoffs().length, 0);
  assert.equal(connectionStatus("tella")?.state, "auth_failed");
  // The credential is kept for a refresh or a reauthorize.
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_secret_1"));
});

test("a listing that works marks the card connected, and its tools are mounted and run on the next step", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath, dir } = paths();
  // Answers by method, so a tool call that is not made as one cannot pass for a listing.
  const methods: string[] = [];
  const calls: Array<{ name?: string; arguments?: unknown }> = [];
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number; params?: { name?: string; arguments?: unknown } };
    methods.push(String(body.method));
    if (body.method === "initialize") return rpcJson(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return rpcJson(body.id, { tools: [
        { name: "list_videos", description: "List the owner's Tella videos" },
        { name: "create_video", description: "Create a video" },
      ] });
    }
    if (body.method === "tools/call") {
      calls.push({ name: body.params?.name, arguments: body.params?.arguments });
      return rpcJson(body.id, { content: [{ type: "text", text: `ran ${body.params?.name}` }] });
    }
    return new Response(`unexpected ${body.method}`, { status: 400 });
  }) as typeof fetch);
  setOauthFetch(async () => tokenReply());
  const card = seedCard({ connectionId: "tella", name: "Tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  await completeConnectionOAuth("code-1", "statevalue123456");
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "connected");
  assert.equal(stored.toolCount, 2);
  assert.equal(listHandoffs().length, 1);
  assert.equal(connectionStatus("tella")?.state, "ready");
  // No restart: the resolver reads the registry and the index as they are now.
  const resolve = (connectionTools as unknown as {
    events: { "step.started": (event: unknown, ctx: unknown) => Promise<Record<string, { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }> | null> };
  }).events["step.started"];
  const ctx = { session: { id: "s-tella" } };
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_APPROVALS_PATH = join(dir, "approvals.json");
  setApprovalStore(new ApprovalStore(Date.now, join(dir, "approvals.json")));
  upsertSessionGrant({ sessionId: "s-tella", path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
  const first = await resolve({}, ctx);
  assert.ok(first?.find_tools);
  const found = await first!.find_tools.execute({ query: "tella videos" }, ctx);
  assert.equal(found.status, "ok");
  assert.equal(found.unavailable, undefined);
  const second = await resolve({}, ctx);
  assert.ok(second?.tella__list_videos, "the tool is callable on the next step");
  assert.ok(second?.tella__create_video);
  // And it runs: a tools/call reaches the server with the arguments, and its answer comes back.
  const ran = await second!.tella__list_videos.execute({}, ctx);
  assert.equal(ran.status, "ok");
  assert.match(String(ran.result), /ran list_videos/);
  assert.deepEqual(calls, [{ name: "list_videos", arguments: {} }]);
  assert.equal(methods.filter((method) => method === "tools/call").length, 1);
});

test("reauthorize replaces the credential on the same row and relists", async () => {
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setDiscoveryLogger(() => {});
  paths();
  listing(() => new Response("no", { status: 401 }));
  const row = upsertConnection({
    id: "tella",
    kind: "mcp",
    name: "Tella",
    url: "https://mcp.example.com/mcp",
    description: "Tella MCP server",
    authKind: "oauth",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  }).entry;
  keychainSet(connectionSecretService("tella"), JSON.stringify({ accessToken: "stale", refreshToken: null, expiresAt: null, clientId: "cid", clientSecret: null, tokenEndpoint: "https://auth.example.com/token" }));
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: "reauth_tella",
    connectionId: "tella",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: null,
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
    resource: "https://mcp.example.com/",
  }]));
  // The new token is the one tools/list accepts.
  const seenAuth: string[] = [];
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    seenAuth.push(String((init?.headers as Record<string, string>).authorization));
    if (body.method === "initialize") return rpcJson(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpcJson(body.id, { tools: [{ name: "list_videos", description: "List" }] });
  }) as typeof fetch);
  setOauthFetch(async () => tokenReply());
  const reauthOut = await completeConnectionOAuth("code-2", "statevalue123456");
  assert.deepEqual(reauthOut, { proposalId: "reauth_tella", ready: true, state: "ready" });
  assert.equal(readConnectionsStore().connections.filter((item) => item.id === "tella").length, 1);
  assert.deepEqual(readConnectionsStore().connections.find((item) => item.id === "tella"), row);
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_secret_1"));
  assert.ok(seenAuth.every((value) => value === "Bearer at_secret_1"));
  assert.equal(connectionStatus("tella")?.state, "ready");
  assert.equal(findOauthPending("statevalue123456"), null);
});

// UB-003 review round 1: a card settled against a row that exists says what that row says.

function liveRow(authKind: "bearer" | "oauth" = "bearer") {
  upsertConnection({
    id: "example",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Connected first",
    authKind,
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  keychainSet(connectionSecretService("example"), "tok_live");
}

test("a second card for a server whose row is not working is failed with the row's state, and connects once the row works", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  liveRow();
  listing(() => new Response("no", { status: 401 }));
  const card = seedCard({ connectionId: "example-2", name: "Example Two" });
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const failed = cardOf(card.id, storePath);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.reason, "auth_failed");
  assert.equal(failed.status, "pending");
  assert.equal(listHandoffs().length, 0);
  assert.equal(readConnectionsStore().connections.length, 1);
  assert.equal(keychainGet(connectionSecretService("example")), "tok_live");
  // The owner fixes the row (a Refresh); the same card then connects, with the row's tool count.
  listing((id) => rpcJson(id, { tools: [{ name: "list_widgets", description: "List" }, { name: "make_widget", description: "Make" }] }));
  assert.equal((await discoverConnection(findConnectionById("example")!)).status.state, "ready");
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const connected = cardOf(card.id, storePath);
  assert.equal(connected.phase, "connected");
  assert.equal(connected.toolCount, 2);
  assert.equal(listHandoffs().length, 1);
  assert.match(listHandoffs()[0].message, /connected the server example\./);
});

test("a row nobody has listed yet is listed for the card that settles on it", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  liveRow();
  listing(() => { throw new TypeError("fetch failed"); });
  const card = seedCard({ connectionId: "example-2", name: "Example Two" });
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  assert.equal(cardOf(card.id, storePath).reason, "unreachable");
  assert.equal(connectionStatus("example")?.state, "unreachable");
  assert.equal(listHandoffs().length, 0);
});

test("an oauth sign-in that settles on a row that is not working leaves its card failed, and its pending sign-in gone", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  liveRow();
  listing(() => new Response("down", { status: 503 }));
  const card = seedCard({ connectionId: "example-late", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card, "example-late");
  let exchanged = false;
  setOauthFetch(async () => { exchanged = true; return tokenReply(); });
  await completeConnectionOAuth("code-1", "statevalue123456");
  assert.equal(exchanged, false, "no code is spent on a row that was already there");
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "failed");
  assert.equal(stored.reason, "unreachable");
  assert.equal(findOauthPending("statevalue123456"), null);
  assert.equal(listHandoffs().length, 0);
  assert.equal(keychainGet(connectionSecretService("example")), "tok_live");
});

test("a connect whose listing cannot be written down is not connected", async () => {
  setKeychainDriver(memoryKeychain());
  const lines: string[] = [];
  setDiscoveryLogger((line) => lines.push(line));
  const { storePath, dir } = paths();
  // The listing store sits under a file, so every write to it throws.
  writeFileSync(join(dir, "blocker"), "x");
  process.env.UB_CONNECTION_TOOLS_PATH = join(dir, "blocker", "connection-tools.json");
  listing((id) => rpcJson(id, { tools: [{ name: "list_widgets", description: "List" }] }));
  const card = seedCard();
  await startConnectionConfirm(card.id, { callbackUrl: CALLBACK });
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "failed");
  assert.equal(stored.reason, "discovery_failed");
  assert.equal(stored.status, "pending");
  assert.equal(listHandoffs().length, 0);
  assert.ok(lines.some((line) => /could not be written/.test(line)), lines.join("\n"));
});

/** A reauthorize sign-in waiting on the row `tella`, with the credential it holds now. */
function reauthSetup(pendingResource: string | undefined) {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  paths();
  upsertConnection({
    id: "tella",
    kind: "mcp",
    name: "Tella",
    url: "https://mcp.example.com/mcp",
    description: "Tella MCP server",
    authKind: "oauth",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(0).toISOString(),
  });
  const held = JSON.stringify({ accessToken: "held", refreshToken: null, expiresAt: null, clientId: "cid", clientSecret: null, tokenEndpoint: "https://auth.example.com/token" });
  keychainSet(connectionSecretService("tella"), held);
  writeFileSync(process.env.UB_OAUTH_PENDING_PATH ?? "", JSON.stringify([{
    state: "statevalue123456",
    verifier: "verifier-value-123456",
    proposalId: "reauth_tella",
    connectionId: "tella",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "cid",
    clientSecret: null,
    redirectUri: CALLBACK,
    createdAt: new Date().toISOString(),
    ...(pendingResource ? { resource: pendingResource } : {}),
  }]));
  return held;
}

test("a reauthorize whose sign-in was for another origin is refused before the code is spent", async () => {
  for (const resource of ["https://evil.example.net/", "https://mcp.example.com:8443/", undefined]) {
    const held = reauthSetup(resource);
    let exchanged = false;
    setOauthFetch(async () => { exchanged = true; return tokenReply(); });
    await assert.rejects(() => completeConnectionOAuth("code-2", "statevalue123456"), /oauth_resource_origin/, String(resource));
    assert.equal(exchanged, false);
    assert.equal(keychainGet(connectionSecretService("tella")), held);
    assert.equal(findOauthPending("statevalue123456"), null, "the verifier does not stay on disk");
  }
});

test("a reauthorize that finishes after the connection was removed stores nothing", async () => {
  const held = reauthSetup("https://mcp.example.com/");
  listing(() => new Response("no", { status: 401 }));
  setOauthFetch(async () => {
    removeConnection("tella");
    return tokenReply();
  });
  await assert.rejects(() => completeConnectionOAuth("code-2", "statevalue123456"), /connection_missing/);
  assert.equal(keychainGet(connectionSecretService("tella")), held);
  assert.equal(connectionStatus("tella"), null);
});

test("a token exchange that fails settles the waiting card as failed with a sanitized reason, and drops the pending sign-in", async () => {
  const cases: Array<[string, () => Response, string]> = [
    ["400 invalid_grant", () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret detail" }), { status: 400 }), "auth_failed"],
    ["401", () => new Response("no", { status: 401 }), "auth_failed"],
    ["200 with no token", () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), "auth_failed"],
    ["503", () => new Response("down", { status: 503 }), "unreachable"],
    ["429", () => new Response("slow", { status: 429 }), "unreachable"],
    ["network", () => { throw new TypeError("fetch failed"); }, "unreachable"],
  ];
  for (const [name, answer, reason] of cases) {
    setKeychainDriver(memoryKeychain());
    setDiscoveryLogger(() => {});
    const { storePath } = paths();
    setOauthFetch(async () => answer());
    const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
    oauthPending(card);
    await assert.rejects(() => completeConnectionOAuth("code-1", "statevalue123456"), /./, name);
    const stored = cardOf(card.id, storePath);
    assert.equal(stored.phase, "failed", name);
    assert.equal(stored.reason, reason, name);
    assert.equal(stored.status, "pending", name);
    assert.equal(listHandoffs().length, 0, name);
    assert.equal(findOauthPending("statevalue123456"), null, `${name}: the verifier is not left on disk`);
    assert.equal(findConnectionById("tella"), null, name);
    assert.ok(!JSON.stringify(stored).includes("secret detail"), name);
  }
});

test("the token audience log line carries no control characters and no query or fragment from the resource", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  const claims = Buffer.from(JSON.stringify({ aud: ["https://api.example.com\n[useful-bot] forged line\u001b[31m", "x".repeat(500)] })).toString("base64url");
  const jwt = `eyJhbGciOiJub25lIn0.${claims}.sig`;
  listing(() => rpcJson(2, { tools: [{ name: "list_videos" }] }));
  setOauthFetch(async () => new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), { headers: { "content-type": "application/json" } }));
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const file = process.env.UB_OAUTH_PENDING_PATH ?? "";
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  rows[0].resource = "https://mcp.example.com/mcp?key=SECRETKEY#fragment";
  writeFileSync(file, JSON.stringify(rows));
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await completeConnectionOAuth("code-1", "statevalue123456", { storePath });
  } finally {
    console.error = original;
  }
  const audLines = lines.filter((line) => line.includes("token aud="));
  assert.equal(audLines.length, 1);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(audLines[0]), "one line, no control characters");
  assert.ok(audLines[0].length < 400, "capped");
  assert.ok(audLines[0].endsWith("resource=https://mcp.example.com/mcp"), audLines[0]);
  assert.ok(!audLines[0].includes("SECRETKEY") && !audLines[0].includes("fragment"));
});

// UB-003 review round 3.

test("a duplicate callback for a state that is being exchanged returns without a second exchange and leaves the card alone", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let exchanges = 0;
  setOauthFetch(async () => {
    exchanges += 1;
    await gate;
    return tokenReply();
  });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const first = completeConnectionOAuth("code-1", "statevalue123456");
  const second = await completeConnectionOAuth("code-1", "statevalue123456");
  assert.deepEqual(second, { proposalId: card.id, ready: false, state: "pending" });
  assert.equal(cardOf(card.id, storePath).phase, "waiting", "the second callback did not settle it");
  release();
  await first;
  assert.equal(exchanges, 1, "the code is spent once");
  assert.equal(cardOf(card.id, storePath).phase, "connected");
  assert.equal(listHandoffs().length, 1);
});

test("a token exchange that fails after the card was settled does not flip it", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setOauthFetch(async () => {
    await gate;
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const attempt = completeConnectionOAuth("code-1", "statevalue123456");
  const settled = assert.rejects(attempt, /./);
  // Another path connected the card while the exchange was out.
  updateProposal(card.id, (item) => {
    if (item.kind === "connectServer") { item.phase = "connected"; item.toolCount = 1; }
  }, storePath);
  release();
  await settled;
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "connected");
  assert.equal(stored.reason ?? null, null);
});

test("an exchange failure from an older sign-in does not fail the card while a newer sign-in is pending, and the newer callback completes", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let olderSent: () => void = () => {};
  const olderOut = new Promise<void>((resolve) => { olderSent = resolve; });
  setOauthFetch(async () => {
    calls += 1;
    if (calls === 1) {
      olderSent();
      await gate;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return tokenReply();
  });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const older = completeConnectionOAuth("code-A", "statevalue123456");
  const olderFailed = assert.rejects(older, /./);
  await olderOut;
  // The owner started the sign-in again: a newer state replaces the older one for this card.
  const file = process.env.UB_OAUTH_PENDING_PATH ?? "";
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  writeFileSync(file, JSON.stringify([{ ...rows[0], state: "newerstate987654", verifier: "verifier-newer-987654" }]));
  release();
  await olderFailed;
  assert.equal(cardOf(card.id, storePath).phase, "waiting", "the older attempt failed the newer one's card");
  assert.ok(findOauthPending("newerstate987654"), "the newer sign-in is still pending");
  await completeConnectionOAuth("code-B", "newerstate987654", { storePath });
  assert.equal(cardOf(card.id, storePath).phase, "connected");
});

/** The owner started the sign-in again: a newer state replaces the older one for the same card or connection. */
function startNewerSignIn(state: string): void {
  const file = process.env.UB_OAUTH_PENDING_PATH ?? "";
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  writeFileSync(file, JSON.stringify([{ ...rows[0], state, verifier: `verifier-${state}` }]));
}

const tokenFor = (access: string) => new Response(JSON.stringify({ access_token: access, refresh_token: `rt_${access}`, expires_in: 3600 }), {
  headers: { "content-type": "application/json" },
});

test("an older sign-in that succeeds after a newer one finished stores nothing, and the newer credential stays", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let olderSent: () => void = () => {};
  const olderOut = new Promise<void>((resolve) => { olderSent = resolve; });
  setOauthFetch(async () => {
    calls += 1;
    if (calls === 1) {
      olderSent();
      await gate;
      return tokenFor("at_older");
    }
    return tokenFor("at_newer");
  });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const older = completeConnectionOAuth("code-A", "statevalue123456", { storePath });
  await olderOut;
  startNewerSignIn("newerstate987654");
  await completeConnectionOAuth("code-B", "newerstate987654", { storePath });
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_newer"));
  assert.equal(cardOf(card.id, storePath).phase, "connected");
  release();
  await assert.rejects(older, /oauth_state/); // the newer sign-in finished and dropped its row, so this one can no longer be finished
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_newer"), "the older sign-in replaced the newer credential");
  assert.ok(!keychainGet(connectionSecretService("tella"))?.includes("at_older"));
  assert.equal(listHandoffs().length, 1, "one resume, from the newer sign-in");
  assert.equal(findOauthPending("statevalue123456"), null);
});

test("an older sign-in whose listing is still being read when a newer one starts does not settle the card", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  // The server's listing is read after the exchange; the owner starts again while it is out.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held: () => void = () => {};
  const heldOut = new Promise<void>((resolve) => { held = resolve; });
  listing(async (id) => {
    held();
    await gate;
    return rpcJson(id, { tools: [{ name: "list_videos", description: "List" }] });
  });
  setOauthFetch(async () => tokenFor("at_older"));
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const older = completeConnectionOAuth("code-A", "statevalue123456", { storePath });
  await heldOut;
  startNewerSignIn("newerstate987654");
  release();
  await assert.rejects(older, /oauth_superseded/);
  assert.equal(cardOf(card.id, storePath).phase, "waiting", "the older sign-in settled the card the newer one waits on");
  assert.equal(listHandoffs().length, 0);
  assert.ok(findOauthPending("newerstate987654"), "the newer sign-in is still pending");
});

test("an older sign-in that fails after a newer one finished leaves the newer card alone", async () => {
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const { storePath } = paths();
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let olderSent: () => void = () => {};
  const olderOut = new Promise<void>((resolve) => { olderSent = resolve; });
  setOauthFetch(async () => {
    calls += 1;
    if (calls === 1) {
      olderSent();
      await gate;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return tokenFor("at_newer");
  });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  const older = completeConnectionOAuth("code-A", "statevalue123456", { storePath });
  const olderFailed = assert.rejects(older, /./);
  await olderOut;
  startNewerSignIn("newerstate987654");
  await completeConnectionOAuth("code-B", "newerstate987654", { storePath });
  release();
  await olderFailed;
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "connected");
  assert.equal(stored.reason ?? null, null);
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_newer"));
});

test("an older reauthorize that finishes after a newer one stores nothing", async () => {
  const held = reauthSetup("https://mcp.example.com/");
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let olderSent: () => void = () => {};
  const olderOut = new Promise<void>((resolve) => { olderSent = resolve; });
  setOauthFetch(async () => {
    calls += 1;
    if (calls === 1) {
      olderSent();
      await gate;
      return tokenFor("at_older");
    }
    return tokenFor("at_newer");
  });
  const older = completeConnectionOAuth("code-A", "statevalue123456");
  await olderOut;
  startNewerSignIn("newerstate987654");
  await completeConnectionOAuth("code-B", "newerstate987654");
  const afterNewer = keychainGet(connectionSecretService("tella"));
  assert.notEqual(afterNewer, held);
  assert.ok(afterNewer?.includes("at_newer"));
  release();
  await assert.rejects(older, /oauth_state/); // same: the newer row is gone
  assert.equal(keychainGet(connectionSecretService("tella")), afterNewer, "the older reauthorize put its credential over the newer one");
  assert.equal(findOauthPending("statevalue123456"), null);
});

test("a reauthorize whose listing fails is not ready", async () => {
  reauthSetup("https://mcp.example.com/");
  listing(() => new Response("no", { status: 401 }));
  setOauthFetch(async () => tokenReply());
  const out = await completeConnectionOAuth("code-2", "statevalue123456");
  assert.equal(out.ready, false);
  assert.equal(out.state, "auth_failed");
});

test("a reauthorize whose listing is still being read when a newer one starts is superseded", async () => {
  reauthSetup("https://mcp.example.com/");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held: () => void = () => {};
  const heldOut = new Promise<void>((resolve) => { held = resolve; });
  listing(async (id) => {
    held();
    await gate;
    return rpcJson(id, { tools: [{ name: "list_videos", description: "List" }] });
  });
  setOauthFetch(async () => tokenFor("at_older"));
  const older = completeConnectionOAuth("code-A", "statevalue123456");
  await heldOut;
  startNewerSignIn("newerstate987654");
  release();
  await assert.rejects(older, /oauth_superseded/);
  assert.ok(findOauthPending("newerstate987654"), "the newer sign-in is still pending");
});

test("a duplicate callback of a reauthorize does not post the code twice", async () => {
  reauthSetup("https://mcp.example.com/");
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let exchanges = 0;
  setOauthFetch(async () => {
    exchanges += 1;
    await gate;
    return tokenReply();
  });
  const first = completeConnectionOAuth("code-2", "statevalue123456");
  const second = await completeConnectionOAuth("code-2", "statevalue123456");
  assert.deepEqual(second, { proposalId: "reauth_tella", ready: false, state: "pending" });
  release();
  await first;
  assert.equal(exchanges, 1);
});

test("a reauthorize whose exchange fails drops its pending sign-in", async () => {
  const held = reauthSetup("https://mcp.example.com/");
  setOauthFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  await assert.rejects(() => completeConnectionOAuth("code-2", "statevalue123456"), /oauth_token/);
  assert.equal(findOauthPending("statevalue123456"), null, "the verifier stays on disk");
  assert.equal(keychainGet(connectionSecretService("tella")), held);
});

test("a reauthorize writes the new sign-in under the connection's refresh lock", async () => {
  const held = reauthSetup("https://mcp.example.com/");
  listing(() => rpcJson(2, { tools: [{ name: "list_videos", description: "List" }] }));
  setOauthFetch(async () => tokenReply());
  const release = await acquireRefreshLock("tella");
  const done = completeConnectionOAuth("code-2", "statevalue123456");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(keychainGet(connectionSecretService("tella")), held, "a refresh in flight is not written over");
  release!();
  await done;
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_secret_1"));
});

test("a sign-in the server refused (error= on the callback) drops its pending row and fails a waiting card", () => {
  setKeychainDriver(memoryKeychain());
  const { storePath } = paths();
  let exchanged = false;
  setOauthFetch(async () => { exchanged = true; return tokenReply(); });
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "waiting", waitingSince: new Date().toISOString() });
  oauthPending(card);
  failConnectionOAuth("statevalue123456");
  const stored = cardOf(card.id, storePath);
  assert.equal(stored.phase, "failed");
  assert.equal(stored.reason, "auth_failed");
  assert.equal(stored.status, "pending");
  assert.equal(findOauthPending("statevalue123456"), null, "the verifier does not stay on disk");
  assert.equal(listHandoffs().length, 0);
  assert.equal(exchanged, false);
  // Delivered again, or for a state nobody holds: nothing to do, nothing thrown.
  failConnectionOAuth("statevalue123456");
  failConnectionOAuth("some-other-state-123456");
  assert.equal(cardOf(card.id, storePath).phase, "failed");
});

test("a refused sign-in leaves a card that is already connected alone, and a reauthorize has no card to fail", () => {
  setKeychainDriver(memoryKeychain());
  const { storePath } = paths();
  const card = seedCard({ connectionId: "tella", authKind: "oauth", phase: "connected", waitingSince: new Date().toISOString() });
  oauthPending(card);
  failConnectionOAuth("statevalue123456");
  assert.equal(cardOf(card.id, storePath).phase, "connected");
  assert.equal(findOauthPending("statevalue123456"), null);
  // A reauthorize's pending row is dropped too; its proposal id names no card.
  const held = reauthSetup("https://mcp.example.com/");
  failConnectionOAuth("statevalue123456");
  assert.equal(findOauthPending("statevalue123456"), null);
  assert.equal(keychainGet(connectionSecretService("tella")), held, "the credential it holds is untouched");
  assert.ok(findConnectionById("tella"));
});

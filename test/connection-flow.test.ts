import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, listThreadEvents, readProposal, updateProposal } from "../shared/agent-store.ts";
import {
  completeConnectionOAuth,
  pumpConnections,
  resetConnectionMemo,
  SERVER_LINGER_MS,
  SERVER_WAIT_MS,
  startConnectionConfirm,
} from "../shared/connection-flow.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { EXCALIDRAW_CONNECTION, findConnectionById, readConnectionsStore, upsertConnection } from "../shared/connections-store.ts";

function storePathOf(): string {
  return process.env.UB_AGENT_STORE_PATH ?? "";
}
import { listHandoffs, queueHandoff } from "../shared/handoffs.ts";
import { memoryKeychain, setKeychainDriver, connectionSecretService, keychainGet, keychainSet } from "../shared/keychain.ts";
import { setMcpFetch } from "../shared/mcp-http.ts";
import { connectionIndex, putConnectionOperations } from "../shared/connection-tools-store.ts";
import { MOUNTED_TOOL_BUDGET } from "../shared/policy.ts";
import { findOauthPending, setOauthFetch } from "../shared/mcp-oauth.ts";
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

  let fetched = false;
  setMcpFetch(async () => { fetched = true; return new Response("{}"); });
  setOauthFetch(async () => { fetched = true; return new Response("{}"); });

  const out = await completeConnectionOAuth("code-1", "statevalue123456", { storePath });
  assert.equal(out.proposalId, proposal.id);
  // The code was never exchanged, so no token was minted to strand.
  assert.equal(fetched, false);
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

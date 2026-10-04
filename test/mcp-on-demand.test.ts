import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mcpToolGate, mcpToolRisk } from "../agent/lib/connector-risk.ts";
import connectionTools from "../agent/tools/connection_tools.ts";
import {
  activateSessionTools,
  connectionIndex,
  connectionStatus,
  listingIsDue,
  resetRuntimeChecks,
  LISTING_RETRY_MS,
  INDEX_TTL_MS,
  putConnectionDiscovery,
  indexedToolBytes,
  nextStamp,
  mountedDescription,
  mountedToolName,
  putConnectionIndex,
  putConnectionOperations,
  readConnectionToolsStore,
  sessionTools,
  updateConnectionToolsStore,
} from "../shared/connection-tools-store.ts";
import {
  discoverConnection,
  discoveryRunning,
  eagerConnections,
  ensureConnectionListing,
  ensureMeasured,
  findConnectionTools,
  setDiscoveryLogger,
  isEagerConnection,
  mountedToolBytes,
  mountedToolCount,
  onDemandConnections,
  scoreTool,
  searchConnectionTools,
  specNamesFit,
  splitMountedName,
} from "../shared/connection-tools.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { connectionSecretService, keychainGet, keychainSet, memoryKeychain, setKeychainDriver, type KeychainDriver } from "../shared/keychain.ts";
import { findConnectionById, removeConnection, upsertConnection, type ConnectionEntry } from "../shared/connections-store.ts";
import { toolInputSchema, rawSchemaHint, mountedSchemaBytes } from "../shared/json-schema-zod.ts";
import { McpError, setMcpFetch } from "../shared/mcp-http.ts";
import { ApprovalStore } from "../agent/lib/approvals.ts";
import { setApprovalStore } from "../agent/lib/write.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";
import { OAuthExpiredError, OAuthRefreshBusyError, REFRESH_LOCK_TIMEOUT_DEFAULT_MS, connectionHeaders, refreshLockPath, setRefreshLockTimeoutMs } from "../shared/connection-auth.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deleteConnection } from "../shared/connections-admin.ts";
import { markConnectionExpired } from "../shared/connection-tools.ts";
import { OAUTH_TIMEOUT_MS, setOauthFetch } from "../shared/mcp-oauth.ts";
import { longestOperationName, measureOpenApiSpec, measureOpenApiSpecText, specWireBytes } from "../shared/tool-wire-size.ts";
import {
  MAX_SESSION_TOOLS,
  MAX_SESSION_TOOL_BYTES,
  MOUNTED_TOOL_BUDGET,
  MOUNTED_TOOL_BYTE_BUDGET,
} from "../shared/policy.ts";

function paths(): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-ctools-"));
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  process.env.UB_CONNECTION_TOOLS_PATH = join(dir, "connection-tools.json");
  setConnectionLookup(async () => "8.8.8.8");
}

function entry(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: "example",
    kind: "mcp",
    name: "Example",
    url: "https://mcp.example.com/mcp",
    description: "Example MCP server for tests",
    authKind: "none",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test.afterEach(() => {
  setMcpFetch(null);
  setOauthFetch(null);
  setKeychainDriver(null);
  setDiscoveryLogger(null);
  setConnectionLookup(null);
});

test("every MCP server waits to be asked for; an OpenAPI spec does not", () => {
  paths();
  const big = upsertConnection(entry()).entry;
  const pinned = upsertConnection(entry({
    id: "excalidraw",
    name: "Excalidraw",
    url: "https://mcp.excalidraw.com/mcp",
    toolsAllow: ["read_me", "create_view"],
  })).entry;
  const spec = upsertConnection(entry({
    id: "weather",
    kind: "openapi",
    name: "Weather",
    url: "https://api.example.com/openapi.json",
  })).entry;
  // Nothing MCP is mounted for every turn, however short its allow-list.
  assert.equal(isEagerConnection(big), false);
  assert.equal(isEagerConnection(pinned), false);
  assert.equal(isEagerConnection(spec), true);
  // And a spec nobody has counted is not mounted either: eve builds its
  // tools from it, and a size nobody knows is not a small one.
  assert.deepEqual(eagerConnections().map((item) => item.id), []);
  putConnectionOperations("weather", { operations: 12, schemaBytes: 900, textBytes: 0, longestName: 20 });
  assert.deepEqual(eagerConnections().map((item) => item.id), ["weather"]);
  assert.deepEqual(onDemandConnections().map((item) => item.id).sort(), ["example", "excalidraw"]);
  assert.equal(mountedToolCount(spec), 12);
  assert.equal(mountedToolCount(pinned), null);
});

test("the mounted set is clamped at the budget, whatever is in the store", () => {
  paths();
  // Rows can be over budget for reasons the connect check never saw: they
  // were connected before it existed, or written by another path.
  for (let i = 0; i < 6; i++) {
    upsertConnection(entry({
      id: `spec-${i}`,
      kind: "openapi",
      name: `Spec ${i}`,
      url: `https://api${i}.example.com/openapi.json`,
    }));
    putConnectionOperations(`spec-${i}`, { operations: 25, schemaBytes: 3_000, textBytes: 0, longestName: 20 });
  }
  const mounted = eagerConnections();
  const total = mounted.reduce((sum, item) => sum + (mountedToolCount(item) ?? 0), 0);
  const bytes = mounted.reduce((sum, item) => sum + (mountedToolBytes(item) ?? 0), 0);
  assert.ok(total <= MOUNTED_TOOL_BUDGET, `mounted ${total} tools, past ${MOUNTED_TOOL_BUDGET}`);
  assert.ok(bytes <= MOUNTED_TOOL_BYTE_BUDGET, `mounted ${bytes} bytes, past ${MOUNTED_TOOL_BYTE_BUDGET}`);
  assert.ok(mounted.length > 0 && mounted.length < 6, `mounted ${mounted.length} of six`);
  // In the order they were connected, so the set is stable turn to turn.
  assert.deepEqual(mounted.map((item) => item.id), ["spec-0"].slice(0, mounted.length));
});

test("the byte budget clamps a roster the count alone would admit", () => {
  paths();
  const fat = { type: "object", properties: Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(200) }]),
  ) };
  for (let i = 0; i < 6; i++) {
    upsertConnection(entry({
      id: `fat-${i}`,
      name: `Fat ${i}`,
      url: `https://fat${i}.example.com/mcp`,
      toolsAllow: ["one", "two"],
    }));
    putConnectionIndex(`fat-${i}`, [
      { name: "one", description: "", inputSchema: fat, inputSchemaBytes: JSON.stringify(fat).length },
      { name: "two", description: "", inputSchema: fat, inputSchemaBytes: JSON.stringify(fat).length },
    ]);
  }
  const mounted = eagerConnections();
  // Twelve tools is well inside the count budget; their schemas are not.
  assert.ok(mounted.length < 6, `mounted all ${mounted.length}`);
  const bytes = mounted.reduce((sum, item) => sum + (mountedToolBytes(item) ?? 0), 0);
  assert.ok(bytes <= MOUNTED_TOOL_BYTE_BUDGET, `mounted ${bytes} bytes`);
});

test("find_tools' search ranks a name match over prose and reads the cached listing", async () => {
  paths();
  upsertConnection(entry());
  let listings = 0;
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (body.method !== "tools/list") return new Response(null, { status: 202 });
    listings += 1;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "send_message", description: "Post to a channel", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "list_channels", description: "Every channel, and who can send a message in it" },
          { name: "delete_file", description: "Remove a file" },
        ],
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const hits = await searchConnectionTools("send a message", 3);
  assert.equal(hits[0].name, "example__send_message");
  assert.equal(hits[0].tool, "send_message");
  assert.equal(hits[0].connectionName, "Example");
  assert.equal(listings, 1);
  // The listing is on disk now, so the next search does not go back out.
  const again = await searchConnectionTools("delete a file", 3);
  assert.equal(again[0].name, "example__delete_file");
  assert.equal(listings, 1);
  assert.equal(connectionIndex("example")?.tools.length, 3);
  // The schema came with it, so a mounted tool can present a real contract.
  const schema = connectionIndex("example")?.tools.find((tool) => tool.name === "send_message")?.inputSchema;
  assert.deepEqual(schema, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
});

test("an allow-list narrows what a search may hand over", async () => {
  paths();
  upsertConnection(entry({ toolsAllow: ["read_me"] }));
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
      { name: "read_me", description: "How to use this server" },
      { name: "delete_everything", description: "Not on the owner's list" },
    ] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const hits = await searchConnectionTools("read me", 5);
  assert.deepEqual(hits.map((hit) => hit.tool), ["read_me"]);
});

test("a session picks up tools up to its limit and is told when it is holding them", () => {
  paths();
  // Small tools, so the count is what bites rather than the byte budget.
  putConnectionIndex("example", Array.from({ length: MAX_SESSION_TOOLS + 3 }, (_, i) => ({
    name: `tool_${i}`,
    description: "",
    inputSchema: null,
    inputSchemaBytes: 2,
  })));
  const names = Array.from({ length: MAX_SESSION_TOOLS + 3 }, (_, i) => mountedToolName("example", `tool_${i}`));
  const first = activateSessionTools("s1", names.slice(0, 2));
  assert.deepEqual(first.tools, names.slice(0, 2));
  assert.deepEqual(first.refused, []);
  // Asking again for one it already holds is not a second slot.
  assert.deepEqual(activateSessionTools("s1", [names[0]]).tools, names.slice(0, 2));
  const rest = activateSessionTools("s1", names);
  assert.equal(rest.tools.length, MAX_SESSION_TOOLS);
  assert.equal(rest.refused.length, 3);
  assert.equal(sessionTools("s1").length, MAX_SESSION_TOOLS);
  // Another session starts from nothing.
  assert.deepEqual(sessionTools("s2"), []);
  assert.equal(Object.keys(readConnectionToolsStore().sessions).length, 1);
});

test("a session holding heavy schemas is stopped by bytes, long before the count", () => {
  paths();
  // One 3 KB schema apiece: thirteen of them clear the session byte budget
  // while the count budget would have allowed forty.
  const fat = { type: "object", properties: Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(40) }]),
  ) };
  putConnectionIndex("example", Array.from({ length: MAX_SESSION_TOOLS }, (_, i) => ({
    name: `tool_${i}`,
    description: "",
    inputSchema: fat,
    inputSchemaBytes: JSON.stringify(fat).length,
  })));
  const names = Array.from({ length: MAX_SESSION_TOOLS }, (_, i) => mountedToolName("example", `tool_${i}`));
  const outcome = activateSessionTools("s1", names);
  assert.ok(outcome.tools.length < MAX_SESSION_TOOLS, `took all ${outcome.tools.length}`);
  assert.ok(outcome.refused.length > 0);
  const bytes = outcome.tools.reduce((sum, name) => {
    const tool = connectionIndex("example")?.tools.find((item) => item.name === name.split("__")[1]);
    return sum + (tool ? indexedToolBytes(tool, "example") : 0);
  }, 0);
  assert.ok(bytes <= MAX_SESSION_TOOL_BYTES, `held ${bytes} bytes`);
});

test("a mounted name splits back into the connection and the tool", () => {
  assert.deepEqual(splitMountedName("example__send_message"), { connectionId: "example", tool: "send_message" });
  // A tool whose own name carries the separator still belongs to the first part.
  assert.deepEqual(splitMountedName("example__a__b"), { connectionId: "example", tool: "a__b" });
  assert.equal(splitMountedName("example"), null);
  assert.equal(splitMountedName("__x"), null);
  assert.equal(splitMountedName("x__"), null);
});

test("scoring puts a whole-word name match first", () => {
  const send = { name: "send_message", description: "", inputSchema: null, inputSchemaBytes: 2 };
  const prose = { name: "post_note", description: "send a message somewhere", inputSchema: null, inputSchemaBytes: 2 };
  assert.ok(scoreTool("send message", send, "Example") > scoreTool("send message", prose, "Example"));
  assert.equal(scoreTool("nothing alike", send, "Example"), 0);
});

test("an MCP tool's risk comes from its own name, with no toolkit to strip", () => {
  assert.equal(mcpToolRisk("list_channels"), "read");
  assert.equal(mcpToolRisk("get_page"), "read");
  assert.equal(mcpToolRisk("send_message"), "write");
  assert.equal(mcpToolRisk("create_view"), "write");
  assert.equal(mcpToolRisk("delete_file"), "destructive");
  assert.equal(mcpToolRisk("list_and_purge"), "destructive");
  assert.equal(mcpToolRisk(""), "write");
});

test("no name a server chose decides whether the owner is asked", () => {
  // A Composio slug is Composio's; an MCP server writes its own tool names,
  // so `list_items` might delete. The posture decides, not the name.
  assert.equal(mcpToolGate("read_only"), "refuse");
  assert.equal(mcpToolGate("auto"), "ask");
  assert.equal(mcpToolGate("full_access"), "run");
  // No grant at all behaves as auto, the way every other gate here does.
  assert.equal(mcpToolGate(null), "ask");
  // The name still labels the card.
  assert.equal(mcpToolRisk("delete_file"), "destructive");
});

test("a server's schema becomes the tool's contract, or a passthrough with the raw one", () => {
  const converted = toolInputSchema({
    type: "object",
    properties: {
      text: { type: "string", description: "What to say" },
      count: { type: "integer" },
      urgent: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      mode: { enum: ["fast", "slow"] },
      note: { type: ["string", "null"] },
      nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    required: ["text", "nested"],
  });
  assert.equal(converted.passthrough, false);
  const parsed = converted.schema.parse({ text: "hi", nested: { id: "1" }, tags: ["a"], mode: "fast", note: null });
  assert.deepEqual(parsed, { text: "hi", nested: { id: "1" }, tags: ["a"], mode: "fast", note: null });
  assert.throws(() => converted.schema.parse({ nested: { id: "1" } }));
  assert.throws(() => converted.schema.parse({ text: "hi", nested: {} }));

  // A shape outside the subset still gives a callable tool: the server
  // validates the arguments either way.
  const odd = toolInputSchema({ type: "object", properties: { when: { $ref: "#/definitions/date" } } });
  assert.equal(odd.passthrough, true);
  assert.deepEqual(odd.schema.parse({ when: "today" }), { when: "today" });
  assert.ok(rawSchemaHint({ type: "object" }).includes("JSON Schema"));
  assert.equal(rawSchemaHint(null), "");

  // No schema at all is a passthrough too, not a refusal.
  assert.equal(toolInputSchema(null).passthrough, true);
  // A schema that is not an argument list cannot be one whatever it validates.
  assert.equal(toolInputSchema({ type: "string" }).passthrough, true);
  // A free-form object stays free-form rather than becoming an empty one.
  const free = toolInputSchema({ type: "object" });
  assert.equal(free.passthrough, false);
  assert.deepEqual(free.schema.parse({ anything: 1 }), { anything: 1 });
  // The converted schema is a zod schema, the same kind `defineTool` takes.
  assert.ok(converted.schema instanceof z.ZodType);
});

test("an OpenAPI spec is weighed by the schemas eve builds from it, refs resolved", () => {
  // eve builds one tool per operation from the spec's own parameters and
  // requestBody, resolving $ref as it goes, so a schema shared by forty
  // operations is emitted forty times. A flat rate per operation missed that
  // by a factor of five and let an ordinary spec through both budgets.
  const shared = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field_${i}`, { type: "string", description: "y".repeat(30) }]),
    ),
  };
  const operation = {
    parameters: [{ name: "id", in: "path", schema: { $ref: "#/components/schemas/Id" } }],
    requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Big" } } } },
  };
  const spec = {
    paths: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/p${i}`, { post: operation }])),
    components: { schemas: { Id: { type: "string" }, Big: shared } },
  };
  const measured = measureOpenApiSpec(spec);
  assert.equal(measured?.operations, 12);
  // The shared schema counts once per operation, not once in the document.
  const onceOnTheWire = JSON.stringify(shared).length;
  assert.ok(
    measured!.schemaBytes > onceOnTheWire * 10,
    `counted ${measured?.schemaBytes} for twelve copies of ${onceOnTheWire}`,
  );
  // A spec this app cannot read is not one with nothing in it.
  assert.equal(measureOpenApiSpec({ nope: true }), null);
  assert.equal(measureOpenApiSpec("not a spec"), null);
  // A cycle cannot be weighed, and a number this side cannot stand behind is
  // worse than none: the connect is refused rather than charged a guess.
  const cyclic = {
    paths: { "/a": { get: { parameters: [{ schema: { $ref: "#/components/schemas/Loop" } }] } } },
    components: { schemas: { Loop: { items: { $ref: "#/components/schemas/Loop" } } } },
  };
  assert.equal(measureOpenApiSpec(cyclic), null);
  // So is a reference that points at nothing.
  assert.equal(measureOpenApiSpec({
    paths: { "/a": { get: { parameters: [{ schema: { $ref: "#/components/schemas/Gone" } }] } } },
  }), null);
  // And a document whose resolved shape is bigger than the walk may visit.
  const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, { $ref: "#/components/schemas/Wide" }]));
  assert.equal(measureOpenApiSpec({
    paths: { "/a": { get: { parameters: [{ schema: { $ref: "#/components/schemas/Wide" } }] } } },
    components: { schemas: { Wide: { properties: wide } } },
  }), null);
});

test("a path-level parameter is charged to every operation under it", () => {
  const spec = {
    paths: {
      "/a": {
        parameters: [{ name: "tenant", in: "query", schema: { type: "string" } }],
        get: {},
        delete: {},
      },
    },
  };
  const measured = measureOpenApiSpec(spec);
  assert.equal(measured?.operations, 2);
  const one = measureOpenApiSpec({ paths: { "/a": { parameters: spec.paths["/a"].parameters, get: {} } } });
  assert.ok(measured!.schemaBytes > one!.schemaBytes);
});

test("one enormous array in a spec is walked, not stringified", () => {
  // A subtree handed to `JSON.stringify` is unbounded work the node count
  // cannot see, and a document can hold a great many of them.
  const huge = Array.from({ length: 50_000 }, (_, i) => `value-${i}`);
  const started = Date.now();
  const measured = measureOpenApiSpec({
    paths: { "/a": { get: { parameters: [{ name: "x", schema: { enum: huge } }] } } },
  });
  // Fifty thousand entries is inside the node budget, so it is measured.
  assert.ok((measured?.schemaBytes ?? 0) > 0);
  assert.ok(Date.now() - started < 5_000, "took too long to walk");
  // Past the budget it is not measured at all, rather than guessed at.
  const past = Array.from({ length: 250_000 }, (_, i) => i);
  assert.equal(measureOpenApiSpec({
    paths: { "/a": { get: { parameters: [{ name: "x", schema: { enum: past } }] } } },
  }), null);
});

test("an operation's own words are weighed, not guessed at", () => {
  // eve puts operationId, summary and description into the tool it builds,
  // and a spec that documents itself properly carries paragraphs of them.
  const prose = "x".repeat(800);
  const documented = measureOpenApiSpec({
    paths: { "/a": { get: { operationId: "listThings", summary: prose, description: prose } } },
  });
  const bare = measureOpenApiSpec({ paths: { "/a": { get: {} } } });
  assert.equal(documented?.operations, 1);
  assert.ok(documented!.textBytes >= 1_600, `counted ${documented?.textBytes}`);
  assert.equal(bare?.textBytes, 0);
  // And the wire figure carries it, so a well-documented spec is not admitted
  // on the strength of its small schemas.
  assert.ok(specWireBytes(documented!) > specWireBytes(bare!) + 1_500);
});

test("an MCP server costs the mounted budget nothing at all", async () => {
  paths();
  const pinned = upsertConnection(entry({
    id: "excalidraw",
    name: "Excalidraw",
    url: "https://mcp.excalidraw.com/mcp",
    toolsAllow: ["read_me", "create_view"],
  })).entry;
  // However short its allow-list. eve would ask the server itself and pass
  // its schemas through uncapped, so there is no number this side could
  // charge; what a session picks up is weighed as it picks it up instead.
  assert.equal(isEagerConnection(pinned), false);
  assert.equal(mountedToolBytes(pinned), null);
  assert.deepEqual(eagerConnections().map((item) => item.id), []);
  // And nothing lists it at a turn boundary, because nothing mounts it.
  let listed = 0;
  setMcpFetch((async () => {
    listed += 1;
    return new Response("no", { status: 503 });
  }) as typeof fetch);
  await ensureMeasured([pinned]);
  await ensureMeasured([pinned]);
  assert.equal(listed, 0);
});

test("a schema too big to keep still says what the arguments are", async () => {
  paths();
  upsertConnection(entry());
  const huge = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field_${i}`, {
        type: "string",
        description: "p".repeat(200),
      }]),
    ),
    required: ["field_0"],
  };
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
      { name: "heavy", description: "Takes a lot of fields", inputSchema: huge },
    ] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  await searchConnectionTools("heavy", 3);
  const kept = connectionIndex("example")?.tools[0];
  // Dropped outright, the model got a passthrough with no contract at all:
  // it guessed, the server refused, and the step was spent.
  assert.ok(kept?.inputSchema, "kept nothing");
  const properties = kept?.inputSchema?.properties as Record<string, unknown>;
  assert.ok(Object.keys(properties).length > 5, "kept too few fields");
  assert.deepEqual(properties.field_0, { type: "string" });
  // The prose is what was dropped, not the shape.
  assert.ok(JSON.stringify(kept?.inputSchema).length <= 4 * 1024);
  assert.ok(!JSON.stringify(kept?.inputSchema).includes("pppp"));
  // And the charge is still the real size of what the server sent.
  assert.ok((kept?.inputSchemaBytes ?? 0) > 0);
});

test("the turn boundary measures its specs together, not one after another", async () => {
  paths();
  const specs = Array.from({ length: 4 }, (_, i) => upsertConnection(entry({
    id: `spec-${i}`,
    kind: "openapi",
    name: `Spec ${i}`,
    url: `https://api${i}.example.com/openapi.json`,
  })).entry);
  let inFlight = 0;
  let peak = 0;
  setMcpFetch((async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
    return new Response(JSON.stringify({ paths: { "/a": { get: {} } } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  await ensureMeasured(specs);
  // Serial would have peaked at one, holding the turn for every spec in turn.
  assert.equal(peak, 4);
});

test("a fresh index missing a figure is measured now, not in six hours", async () => {
  paths();
  const spec = upsertConnection(entry({
    id: "weather",
    kind: "openapi",
    name: "Weather",
    url: "https://api.example.com/openapi.json",
  })).entry;
  // An index an older build wrote, before the operation text was measured.
  updateConnectionToolsStore((store) => {
    store.index.weather = { fetchedAt: new Date().toISOString(), tools: [], operations: 3, schemaBytes: 90 };
  });
  assert.equal(mountedToolBytes(spec), null);
  let fetched = 0;
  setMcpFetch((async () => {
    fetched += 1;
    return new Response(JSON.stringify({ paths: { "/a": { get: {} } } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  await ensureMeasured([spec]);
  assert.equal(fetched, 1);
  assert.notEqual(mountedToolBytes(spec), null);
});

test("a session sheds tools its index no longer lists, and is not charged for them", () => {
  paths();
  putConnectionIndex("example", Array.from({ length: 12 }, (_, i) => ({
    name: `tool_${i}`,
    description: "",
    inputSchema: null,
    inputSchemaBytes: 2,
  })));
  const names = Array.from({ length: 12 }, (_, i) => mountedToolName("example", `tool_${i}`));
  assert.equal(activateSessionTools("s1", names).tools.length, 12);
  // The server drops ten of them on its next listing.
  putConnectionIndex("example", [
    { name: "tool_0", description: "", inputSchema: null, inputSchemaBytes: 2 },
    { name: "tool_1", description: "", inputSchema: null, inputSchemaBytes: 2 },
  ]);
  // Held on, they charged four kilobytes apiece for tools that could never be
  // called, and ten of them told the model it was at its limit holding none.
  const after = activateSessionTools("s1", [mountedToolName("example", "tool_1")]);
  assert.deepEqual(after.tools, [mountedToolName("example", "tool_0"), mountedToolName("example", "tool_1")]);
  // And a name the index never listed is refused rather than recorded.
  const ghost = activateSessionTools("s1", [mountedToolName("example", "never_listed")]);
  assert.deepEqual(ghost.refused, [mountedToolName("example", "never_listed")]);
});

test("a name the upstream would refuse is never handed to the model", async () => {
  paths();
  upsertConnection(entry());
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
      { name: "files.read", description: "read a file" },
      { name: "read_file", description: "read a file" },
    ] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const hits = await searchConnectionTools("read file", 5);
  assert.deepEqual(hits.map((hit) => hit.tool), ["read_file"]);
});

test("what is charged is exactly what is mounted, fence and escaping included", () => {
  // A backtick run in the server's text grows the untrusted fence, and every
  // quote and newline costs more once JSON-encoded. Estimating either from a
  // fixed fence and raw bytes let a server undercount itself by kilobytes.
  const nasty = {
    name: "odd",
    description: `${"`".repeat(900)} "quoted" \\ ${"\n".repeat(200)}`,
    inputSchema: null,
    inputSchemaBytes: 2,
  };
  const described = mountedDescription(nasty, "example", "Example");
  const onTheWire = Buffer.byteLength(JSON.stringify({
    type: "function",
    function: { name: "example__odd", description: described, parameters: {} },
  }), "utf8");
  assert.equal(indexedToolBytes(nasty, "example", "Example"), onTheWire);
  // And a connection name cannot carry a line break outside the fence.
  assert.ok(!mountedDescription(nasty, "example", "Evil\nName").startsWith("Evil\n"));
});

test("the name the provider validates is the mounted one, not the tool's own", async () => {
  paths();
  // A long connection id and a tool name that passes on its own still make a
  // mounted name past sixty-four, which the provider refuses non-retryably.
  upsertConnection(entry({ id: "a-rather-long-connection-identifier" }));
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
      { name: "short_read", description: "read" },
      { name: "a_tool_name_that_is_fine_alone_but_long", description: "read" },
      { name: "x".repeat(90), description: "read" },
    ] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const hits = await searchConnectionTools("read", 5);
  assert.deepEqual(hits.map((hit) => hit.tool), ["short_read"]);
  assert.ok(hits.every((hit) => hit.name.length <= 64));
});

test("a recursive spec is weighed from its own text instead of refused forever", () => {
  // `Node` with `children: Node[]` is ordinary, and refusing it as
  // unmeasurable made the service permanently unconnectable.
  const spec = JSON.stringify({
    paths: { "/tree": { get: { parameters: [{ name: "n", schema: { $ref: "#/components/schemas/Node" } }] } } },
    components: { schemas: { Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } } } } } },
  });
  const measured = measureOpenApiSpecText(spec);
  assert.equal(measured?.operations, 1);
  // The spec's own text, charged at the emission rate by specWireBytes.
  assert.equal(measured?.schemaBytes, Buffer.byteLength(spec, "utf8"));
  assert.ok(specWireBytes(measured!) > Buffer.byteLength(spec, "utf8"));
  // Text that is not a spec at all still has no number.
  assert.equal(measureOpenApiSpecText("not json"), null);
  assert.equal(measureOpenApiSpecText(JSON.stringify({ nope: true })), null);
});

test("a string is charged at what it costs once escaped", () => {
  // A newline is two bytes on the wire and a control character six.
  const escaped = measureOpenApiSpec({
    paths: { "/a": { get: { summary: "\n".repeat(100) + "\u0001".repeat(100) } } },
  });
  assert.ok((escaped?.textBytes ?? 0) >= 100 * 2 + 100 * 6, `counted ${escaped?.textBytes}`);
});

test("every index writer screens the mounted name, the connect probe included", () => {
  paths();
  const id = "a-rather-long-connection-identifier";
  putConnectionIndex(id, [
    { name: "short_read", description: "", inputSchema: null, inputSchemaBytes: 2 },
    { name: "a_tool_name_that_is_fine_alone_but_long", description: "", inputSchema: null, inputSchemaBytes: 2 },
  ]);
  assert.deepEqual(connectionIndex(id)?.tools.map((tool) => tool.name), ["short_read"]);
});

test("a measurement that times out keeps the figures it already had", () => {
  paths();
  const spec = entry({ id: "weather", kind: "openapi", url: "https://api.example.com/openapi.json" });
  upsertConnection(spec);
  putConnectionOperations("weather", { operations: 12, schemaBytes: 900, textBytes: 40, longestName: 20 });
  const before = mountedToolBytes(spec);
  putConnectionOperations("weather", null);
  // Still mounted on the figures it was admitted with, and the failure is
  // recorded so the next turn boundary does not refetch it.
  assert.equal(connectionIndex("weather")?.failed, true);
  assert.equal(mountedToolBytes(spec), before);
  assert.deepEqual(eagerConnections().map((item) => item.id), ["weather"]);
  // A first measurement that fails still has no figure.
  putConnectionOperations("fresh", null);
  assert.equal(connectionIndex("fresh")?.operations, undefined);
});

test("a search honours an allow-list narrowed after the listing was cached", async () => {
  paths();
  upsertConnection(entry());
  putConnectionIndex("example", [
    { name: "read_item", description: "read", inputSchema: null, inputSchemaBytes: 2 },
    { name: "read_other", description: "read", inputSchema: null, inputSchemaBytes: 2 },
  ]);
  upsertConnection(entry({ toolsAllow: ["read_item"] }));
  const hits = await searchConnectionTools("read", 5);
  assert.deepEqual(hits.map((hit) => hit.tool), ["read_item"]);
});

test("the mount re-weighs held tools against the index as it is now", async () => {
  paths();
  upsertConnection(entry());
  const lean = (i: number) => ({ name: `tool_${i}`, description: "", inputSchema: null, inputSchemaBytes: 2 });
  putConnectionIndex("example", Array.from({ length: 20 }, (_, i) => lean(i)));
  const names = Array.from({ length: 20 }, (_, i) => mountedToolName("example", `tool_${i}`));
  assert.equal(activateSessionTools("s1", names).tools.length, 20);
  const resolve = (connectionTools as unknown as {
    events: { "step.started": (event: unknown, ctx: unknown) => Promise<Record<string, unknown> | null> };
  }).events["step.started"];
  const before = await resolve({}, { session: { id: "s1" } });
  assert.equal(Object.keys(before ?? {}).filter((key) => key.includes("__")).length, 20);
  // The server republishes the same names with schemas at the keep limit.
  // Charged at activation they were lean; mounted as they are now, twenty of
  // them would be past the session's byte cap.
  putConnectionIndex("example", Array.from({ length: 20 }, (_, i) => ({ ...lean(i), inputSchemaBytes: 4_000 })));
  const after = await resolve({}, { session: { id: "s1" } });
  const mounted = Object.keys(after ?? {}).filter((key) => key.includes("__"));
  assert.ok(mounted.length < 20, `mounted ${mounted.length}`);
  const weighed = mounted.reduce((sum, key) => {
    const tool = connectionIndex("example")!.tools.find((item) => mountedToolName("example", item.name) === key)!;
    return sum + indexedToolBytes(tool, "example", "Example");
  }, 0);
  assert.ok(weighed <= MAX_SESSION_TOOL_BYTES, `weighed ${weighed}`);
});

test("a spec whose prefixed tool names pass sixty-four is never mounted", () => {
  paths();
  // eve's names: sanitized, cut to 64, then suffixed on a clash.
  const spec = {
    paths: {
      "/a": { get: { operationId: "admin.users.list" } },
      "/b/{id}": { post: {} },
      "/c": { get: { operationId: "admin.users.list" } },
    },
  };
  assert.equal(longestOperationName(spec), "admin_users_list_2".length);
  assert.equal(measureOpenApiSpec(spec)?.longestName, "admin_users_list_2".length);
  assert.equal(longestOperationName({ paths: { "/x": { get: { operationId: "y".repeat(90) } } } }), 64);
  assert.equal(specNamesFit("weather", 55), true);
  assert.equal(specNamesFit("weather", 56), false);
  assert.equal(specNamesFit("weather", undefined), false);
  const spec2 = entry({ id: "weather", kind: "openapi", url: "https://api.example.com/openapi.json" });
  upsertConnection(spec2);
  putConnectionOperations("weather", { operations: 3, schemaBytes: 100, textBytes: 0, longestName: 60 });
  assert.deepEqual(eagerConnections().map((item) => item.id), []);
  putConnectionOperations("weather", { operations: 3, schemaBytes: 100, textBytes: 0, longestName: 20 });
  assert.deepEqual(eagerConnections().map((item) => item.id), ["weather"]);
});

test("naming many clashing operations stays linear and matches eve", () => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 20_000; i += 1) paths[`/p${i}`] = { get: { operationId: "same" } };
  const started = Date.now();
  assert.equal(longestOperationName({ paths }), "same_20000".length);
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms`);
  // An explicit `x_2` is skipped over the way eve skips it.
  assert.equal(longestOperationName({ paths: {
    "/a": { get: { operationId: "x" } },
    "/b": { get: { operationId: "x_2" } },
    "/c": { get: { operationId: "x" } },
  } }), "x_3".length);
});

// UB-003: a connected server that is not working says so, instead of "found 0".

/** An MCP server answering tools/list with `tools`, or with a status. Counts its listings. */
function mcpServer(answer: () => Response | { tools: Array<Record<string, unknown>> } | "down"): { listings: number } {
  const count = { listings: 0 };
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    const json = (id: number | undefined, result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
    if (body.method === "initialize") return json(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    count.listings += 1;
    const out = answer();
    if (out === "down") throw new TypeError("fetch failed");
    if (out instanceof Response) return out;
    return json(body.id, out);
  }) as typeof fetch);
  return count;
}

const bundleJson = (patch: Record<string, unknown> = {}) => JSON.stringify({
  accessToken: "at_old",
  refreshToken: null,
  expiresAt: Date.now() - 60_000,
  clientId: "cid",
  clientSecret: null,
  tokenEndpoint: "https://auth.example.com/token",
  resource: "https://mcp.example.com",
  ...patch,
});

test("an expired token with no refresh token is never sent, and the status says expired", async () => {
  paths();
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  keychainSet(connectionSecretService("tella"), bundleJson());
  const server = mcpServer(() => ({ tools: [{ name: "list_videos" }] }));
  await assert.rejects(() => connectionHeaders(row), (err: unknown) => err instanceof OAuthExpiredError);
  const found = await discoverConnection(row);
  assert.equal(found.status.state, "expired");
  assert.equal(found.status.lastError?.code, "oauth_expired");
  assert.equal(server.listings, 0, "the stale token went nowhere");
});

test("a refresh the server refuses is oauth_expired too, and a good one is saved and used", async () => {
  paths();
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
  setOauthFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  const server = mcpServer(() => ({ tools: [{ name: "list_videos" }] }));
  await assert.rejects(() => connectionHeaders(row), (err: unknown) => err instanceof OAuthExpiredError);
  assert.equal((await discoverConnection(row)).status.state, "expired");
  assert.equal(server.listings, 0);
  // Now the server accepts it.
  let body = "";
  setOauthFetch(async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }), {
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal((await discoverConnection(row)).status.state, "ready");
  assert.match(body, /resource=https%3A%2F%2Fmcp.example.com/);
  assert.ok(keychainGet(connectionSecretService("tella"))?.includes("at_new"));
});

test("a failed or empty listing is retried after two minutes, a good one after six hours", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  let mode: "down" | "empty" | "ok" = "down";
  const server = mcpServer(() => mode === "down" ? "down" : { tools: mode === "empty" ? [] : [{ name: "list_things", description: "List" }] });
  assert.equal((await ensureConnectionListing(row)).status.state, "unreachable");
  assert.equal(server.listings, 1);
  // Inside the window it is not asked again.
  await ensureConnectionListing(row);
  assert.equal(server.listings, 1);
  const backdate = (ms: number) => {
    const status = connectionStatus("example")!;
    putConnectionDiscovery("example", {
      tools: null,
      status: { ...status, checkedAt: new Date(Date.now() - ms).toISOString() },
    });
  };
  mode = "empty";
  backdate(LISTING_RETRY_MS + 1_000);
  assert.equal((await ensureConnectionListing(row)).status.state, "zero_tools");
  assert.equal(server.listings, 2);
  // Empty is retried on the short clock too.
  mode = "ok";
  backdate(LISTING_RETRY_MS + 1_000);
  const ok = await ensureConnectionListing(row);
  assert.equal(ok.status.state, "ready");
  assert.equal(server.listings, 3);
  // A good listing three minutes old is left alone.
  backdate(LISTING_RETRY_MS + 60_000);
  await ensureConnectionListing(row);
  assert.equal(server.listings, 3);
  assert.equal(listingIsDue(connectionIndex("example"), connectionStatus("example"), Date.now() + INDEX_TTL_MS + 5 * 60_000), true);
  // The same rule from the pure side, for a row that predates status.
  const legacy = { fetchedAt: new Date(0).toISOString(), tools: [], failed: true };
  assert.equal(listingIsDue(legacy, null, 60_000), false);
  assert.equal(listingIsDue(legacy, null, LISTING_RETRY_MS + 1), true);
});

test("find_tools names a server that is not working instead of reporting found 0", async () => {
  paths();
  setDiscoveryLogger(() => {});
  upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" }));
  upsertConnection(entry({ id: "slack", name: "Slack", url: "https://mcp.slack.example.com/mcp" }));
  setMcpFetch((async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (String(input).includes("tella")) return new Response("no", { status: 401 });
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "send_message", description: "Post a message" }] } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const resolve = (connectionTools as unknown as {
    events: { "step.started": (event: unknown, ctx: unknown) => Promise<Record<string, { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }> | null> };
  }).events["step.started"];
  const ctx = { session: { id: "s-down" } };
  const tools = await resolve({}, ctx);
  const both = await tools!.find_tools.execute({ query: "send a message" }, ctx);
  assert.equal(both.found, 1);
  assert.deepEqual(both.unavailable, [{
    server: "Tella",
    state: "auth_failed",
    hint: "Ask the owner to reconnect Tella in Connectors.",
  }]);
  // Only the unavailable one matches the query: not "found 0" with nothing to say.
  const only = await tools!.find_tools.execute({ query: "tella videos" }, ctx);
  assert.equal(only.found, 0);
  assert.equal((only.unavailable as unknown[]).length, 1);
  assert.match(String(only.note), /could not be searched/);
  // The search helper carries the same facts.
  const detail = await findConnectionTools("send a message", 5);
  assert.deepEqual(detail.unavailable.map((item) => [item.connectionId, item.state]), [["tella", "auth_failed"]]);
});

test("a query that names the server puts that server's tools first", () => {
  const tool = (name: string, description: string) => ({ name, description, inputSchema: null, inputSchemaBytes: 2 });
  const tella = scoreTool("tella upload", tool("list_videos", "Videos you own"), "Tella");
  const other = scoreTool("tella upload", tool("upload_file", "Upload a file to storage"), "Drive");
  assert.ok(tella > other, `${tella} vs ${other}`);
  // The bare server name matches every tool it has.
  assert.ok(scoreTool("tella", tool("anything", ""), "Tella") > 0);
});

test("a server outside the catalogue connects, lists and is searched with no Composio key and no network but its own", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const realFetch = globalThis.fetch;
  const strays: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    strays.push(String(input));
    throw new Error("unexpected network");
  }) as typeof fetch;
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" })).entry;
    mcpServer(() => ({ tools: [{ name: "list_videos", description: "List videos" }] }));
    const found = await discoverConnection(row);
    assert.equal(found.status.state, "ready");
    const hits = await searchConnectionTools("tella videos", 3);
    assert.deepEqual(hits.map((hit) => hit.name), ["tella__list_videos"]);
    assert.deepEqual(strays, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// UB-003 review round 1: discovery is one run per connection, honest about its
// outcome and about being in progress.

const rpcResult = (id: number | undefined, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });

/** A server whose handshake works and whose tools/list is `answer(authorization)`. */
function authedServer(answer: (authorization: string) => Response | Promise<Response>): { listings: string[] } {
  const seen = { listings: [] as string[] };
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (body.method === "initialize") return rpcResult(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const authorization = String((init?.headers as Record<string, string>).authorization ?? "");
    seen.listings.push(authorization);
    return answer(authorization);
  }) as typeof fetch);
  return seen;
}

test("a listing that is not a listing at all is a failed discovery, never zero tools", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  for (const result of [null, {}, { tools: "x" }]) {
    mcpServer(() => result as never);
    const found = await discoverConnection(row);
    assert.equal(found.status.state, "discovery_failed", JSON.stringify(result));
  }
  mcpServer(() => ({ tools: [] }));
  assert.equal((await discoverConnection(row)).status.state, "zero_tools");
});

test("a server whose every input schema is broken is malformed, and one broken schema drops only that tool", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  mcpServer(() => ({ tools: [
    { name: "bad_one", inputSchema: 42 },
    { name: "bad_two", inputSchema: { type: "string" } },
  ] }));
  const bad = await discoverConnection(row);
  assert.equal(bad.status.state, "malformed");
  assert.equal(bad.status.dropped, 2);
  mcpServer(() => ({ tools: [
    { name: "bad_one", inputSchema: null },
    { name: "fine_one", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "no_schema" },
  ] }));
  const mixed = await discoverConnection(row);
  assert.equal(mixed.status.state, "ready");
  assert.equal(mixed.status.dropped, 1);
  assert.deepEqual(mixed.tools.map((tool) => tool.name), ["fine_one", "no_schema"]);
});

test("overlapping discoveries of one connection are one request to the server", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = authedServer(async () => {
    await gate;
    return rpcResult(2, { tools: [{ name: "list_things", description: "List" }] });
  });
  const first = discoverConnection(row);
  // Search, the list's background run, a Refresh: same id, no credential of their own.
  const second = discoverConnection(row);
  const third = ensureConnectionListing(row);
  assert.equal(discoveryRunning("example"), true);
  release();
  const out = await Promise.all([first, second, third]);
  assert.equal(seen.listings.length, 1);
  assert.deepEqual(out.map((item) => item.status.state), ["ready", "ready", "ready"]);
  assert.equal(discoveryRunning("example"), false);
});

test("a discovery that started before a newer one never overwrites it", async () => {
  paths();
  setDiscoveryLogger(() => {});
  setKeychainDriver(memoryKeychain());
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // The old token is refused, but only after the new sign-in has been listed.
  authedServer(async (authorization) => {
    if (authorization === "Bearer old") {
      await gate;
      return new Response("no", { status: 401 });
    }
    return rpcResult(2, { tools: [{ name: "list_videos", description: "List" }] });
  });
  const old = discoverConnection(row, { headers: { authorization: "Bearer old" } });
  // The sign-in completes with its own token while the old request is still out.
  const fresh = await discoverConnection(row, { headers: { authorization: "Bearer new" } });
  assert.equal(fresh.status.state, "ready");
  release();
  const settled = await old;
  assert.equal(settled.status.state, "ready", "the older run reports what is current");
  assert.equal(connectionStatus("tella")?.state, "ready");
  assert.deepEqual(connectionIndex("tella")?.tools.map((tool) => tool.name), ["list_videos"]);
});

test("an unreachable server with cached tools returns no callable hits, and is listed as unavailable", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" })).entry;
  let mode: "ok" | "down" = "ok";
  mcpServer(() => mode === "down" ? "down" : { tools: [{ name: "list_videos", description: "List the videos" }] });
  await discoverConnection(row);
  mode = "down";
  const down = await discoverConnection(row);
  assert.equal(down.status.state, "unreachable");
  const found = await findConnectionTools("tella videos", 5);
  assert.deepEqual(found.hits, [], "the mount guard refuses these tools, so a search must not offer them");
  assert.deepEqual(found.unavailable.map((item) => [item.connectionId, item.state]), [["tella", "unreachable"]]);
  assert.equal(connectionIndex("tella")?.tools.length, 1, "the cached listing stays on disk for a later recovery");
  // Nothing matching: the outage is not hidden behind "no connected server has that".
  const none = await findConnectionTools("zebra crossing", 5);
  assert.equal(none.hits.length, 0);
  assert.equal(none.unavailable.length, 1);
});

test("a discovery in progress is recorded as pending and keeps the tools it had", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  let hold = false;
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => { release = resolve; });
  authedServer(async () => {
    if (hold) await gate;
    return rpcResult(2, { tools: [{ name: "list_things", description: "List" }, { name: "make_thing", description: "Make" }] });
  });
  assert.equal((await discoverConnection(row)).status.state, "ready");
  hold = true;
  const running = discoverConnection(row);
  // Marked once the credential has resolved, a tick after the call.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connectionStatus("example")?.state, "pending");
  assert.equal(connectionStatus("example")?.toolCount, 2);
  assert.equal(connectionIndex("example")?.tools.length, 2, "the cached tools stay while it is checked");
  const meanwhile = await findConnectionTools("things", 5);
  assert.deepEqual(meanwhile.hits, [], "a connection being checked is not offered as callable");
  assert.deepEqual(meanwhile.unavailable.map((item) => [item.connectionId, item.state]), [["example", "pending"]]);
  release();
  assert.equal((await running).status.state, "ready");
  assert.equal(connectionStatus("example")?.state, "ready");
  // A row nobody has ever listed shows pending too, with nothing cached.
  const other = upsertConnection(entry({ id: "other", url: "https://other.example.com/mcp" })).entry;
  gate = new Promise<void>((resolve) => { release = resolve; });
  hold = true;
  const first = discoverConnection(other);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connectionStatus("other")?.state, "pending");
  assert.equal(connectionStatus("other")?.toolCount, null);
  release();
  await first;
});

test("a discovery that cannot be written down is a failed one, not a ready one", async () => {
  paths();
  const lines: string[] = [];
  setDiscoveryLogger((line) => lines.push(line));
  const row = upsertConnection(entry()).entry;
  // A store whose directory is a file: every write to it throws.
  const dir = mkdtempSync(join(tmpdir(), "ub-ctools-nowrite-"));
  writeFileSync(join(dir, "blocker"), "x");
  const storePath = join(dir, "blocker", "connection-tools.json");
  mcpServer(() => ({ tools: [{ name: "list_things", description: "List" }] }));
  const found = await discoverConnection(row, { storePath });
  assert.equal(found.status.state, "discovery_failed");
  assert.equal(found.status.lastError?.code, "store_write_failed");
  assert.equal(found.tools.length, 0);
  assert.ok(lines.some((line) => /write/.test(line) && /example/.test(line)), lines.join("\n"));
});

test("the first use after a restart lists again, then the six hours apply", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry()).entry;
  const server = mcpServer(() => ({ tools: [{ name: "list_things", description: "List" }] }));
  await ensureConnectionListing(row);
  assert.equal(server.listings, 1);
  await ensureConnectionListing(row);
  assert.equal(server.listings, 1, "fresh in this process");
  // A new process: the file says the listing is minutes old and ready.
  resetRuntimeChecks();
  assert.equal(listingIsDue(connectionIndex("example"), connectionStatus("example")), false, "pure: age alone");
  assert.equal(listingIsDue(connectionIndex("example"), connectionStatus("example"), Date.now(), "example"), true);
  await ensureConnectionListing(row);
  assert.equal(server.listings, 2);
  await ensureConnectionListing(row);
  assert.equal(server.listings, 2);
});

/** A grant and an approval store, so a mounted tool can be executed for real. */
function grantedSession(sessionId: string): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-ctools-grant-"));
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  process.env.UB_APPROVALS_PATH = join(dir, "approvals.json");
  setApprovalStore(new ApprovalStore(Date.now, join(dir, "approvals.json")));
  upsertSessionGrant({ sessionId, path: null, permission: "full_access" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
}

test("a tool call that finds the sign-in expired records it, and the tool stops being offered", async () => {
  paths();
  setDiscoveryLogger(() => {});
  setKeychainDriver(memoryKeychain());
  grantedSession("s-expired");
  const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp", authKind: "oauth" })).entry;
  keychainSet(connectionSecretService("tella"), bundleJson({ expiresAt: Date.now() + 3_600_000 }));
  mcpServer(() => ({ tools: [{ name: "list_videos", description: "List the videos" }] }));
  assert.equal((await discoverConnection(row)).status.state, "ready");
  const resolve = (connectionTools as unknown as {
    events: { "step.started": (event: unknown, ctx: unknown) => Promise<Record<string, { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }> | null> };
  }).events["step.started"];
  const ctx = { session: { id: "s-expired" } };
  const first = await resolve({}, ctx);
  await first!.find_tools.execute({ query: "tella videos" }, ctx);
  const second = await resolve({}, ctx);
  assert.ok(second?.tella__list_videos);
  // The token runs out with nothing to renew it.
  keychainSet(connectionSecretService("tella"), bundleJson());
  const called = await second!.tella__list_videos.execute({}, ctx);
  assert.equal(called.error, "oauth_expired");
  assert.equal(connectionStatus("tella")?.state, "expired");
  assert.equal(connectionIndex("tella")?.tools.length, 0);
  const third = await resolve({}, ctx);
  assert.equal(third?.tella__list_videos, undefined);
});

// UB-003 review round 1: what a failed refresh means, and one refresh at a time.

const tokenJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("only a refused refresh token expires the sign-in; a dead network, server or address is unreachable", async () => {
  paths();
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  const stored = bundleJson({ refreshToken: "rt_old" });
  keychainSet(connectionSecretService("tella"), stored);
  mcpServer(() => ({ tools: [{ name: "list_videos" }] }));
  // A listing from before, which an outage must not wipe.
  putConnectionDiscovery("tella", {
    tools: [{ name: "list_videos", description: "", inputSchema: null, inputSchemaBytes: 2 }],
    status: { state: "ready", lastError: null, checkedAt: new Date().toISOString(), toolCount: 1 },
  });
  const cases: Array<[string, () => Response, "expired" | "unreachable" | "auth_failed"]> = [
    ["400 invalid_grant", () => tokenJson({ error: "invalid_grant" }, 400), "expired"],
    ["401 invalid_grant", () => tokenJson({ error: "invalid_grant" }, 401), "expired"],
    ["400 invalid_client", () => tokenJson({ error: "invalid_client" }, 400), "auth_failed"],
    ["503", () => tokenJson({ error: "temporarily_unavailable" }, 503), "unreachable"],
    ["429", () => tokenJson({ error: "slow_down" }, 429), "unreachable"],
    ["network", () => { throw new TypeError("fetch failed"); }, "unreachable"],
    ["timeout", () => { throw new DOMException("The operation timed out", "TimeoutError"); }, "unreachable"],
    ["a 5xx body that is not JSON", () => new Response("<html>bad gateway</html>", { status: 502 }), "unreachable"],
  ];
  for (const [name, answer, state] of cases) {
    setOauthFetch(async () => answer());
    const found = await discoverConnection(row);
    assert.equal(found.status.state, state, name);
    assert.equal(keychainGet(connectionSecretService("tella")), stored, `${name}: the credential is left alone`);
  }
  assert.equal(connectionIndex("tella")?.tools.length, 0, "the last refusal emptied the listing");
  // An outage keeps the listing it had; only a definite answer drops it.
  putConnectionDiscovery("tella", {
    tools: [{ name: "list_videos", description: "", inputSchema: null, inputSchemaBytes: 2 }],
    status: { state: "ready", lastError: null, checkedAt: new Date().toISOString(), toolCount: 1 },
  });
  setOauthFetch(async () => tokenJson({}, 503));
  assert.equal((await discoverConnection(row)).status.state, "unreachable");
  assert.equal(connectionIndex("tella")?.tools.length, 1);
  // The token host resolving to a private address is the URL guard refusing, not a sign-in refused.
  setConnectionLookup(async (host) => host === "auth.example.com" ? "10.0.0.4" : "8.8.8.8");
  setOauthFetch(async () => tokenJson({ access_token: "x" }));
  const guarded = await discoverConnection(row);
  assert.equal(guarded.status.state, "unreachable");
});

test("concurrent callers share one refresh, and the stored refresh token wins over a stale read", async () => {
  paths();
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
  let requests = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setOauthFetch(async () => {
    requests += 1;
    await gate;
    return tokenJson({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 });
  });
  const both = Promise.all([connectionHeaders(row), connectionHeaders(row), connectionHeaders(row)]);
  release();
  assert.deepEqual((await both).map((headers) => headers.authorization), ["Bearer at_new", "Bearer at_new", "Bearer at_new"]);
  assert.equal(requests, 1, "a rotated refresh token is spent once");
  // Another process refreshed between this one's read and its refresh: the
  // stored bundle is used and nothing is sent.
  const mem = memoryKeychain();
  const fresh = bundleJson({ accessToken: "at_other", refreshToken: "rt_other", expiresAt: Date.now() + 3_600_000 });
  setKeychainDriver(mem);
  keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
  const packedFresh = Buffer.from(fresh, "utf8").toString("base64url");
  let reads = 0;
  const racing: KeychainDriver = {
    get(service) {
      reads += 1;
      if (reads === 1) return mem.get(service);
      mem.set(service, packedFresh);
      return mem.get(service);
    },
    set: (service, value) => mem.set(service, value),
    del: (service) => mem.del(service),
  };
  setKeychainDriver(racing);
  requests = 0;
  assert.deepEqual(await connectionHeaders(row), { authorization: "Bearer at_other" });
  assert.equal(requests, 0);
});

test("a refresh that finishes after the connection was removed stores nothing", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setDiscoveryLogger(() => {});
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  const stored = bundleJson({ refreshToken: "rt_old" });
  keychainSet(connectionSecretService("tella"), stored);
  setOauthFetch(async () => {
    removeConnection("tella");
    mem.del(connectionSecretService("tella"));
    return tokenJson({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 });
  });
  await assert.rejects(() => connectionHeaders(row), /connection_missing/);
  assert.equal(keychainGet(connectionSecretService("tella")), null, "no credential is written back for a removed connection");
});

// UB-003 review round 2.

/** `deleteConnection` also forgets a pending sign-in, which lives in a store of its own. */
function oauthPendingPath(): void {
  process.env.UB_OAUTH_PENDING_PATH = join(mkdtempSync(join(tmpdir(), "ub-ctools-oauth-")), "oauth.json");
}

type Resolver = (event: unknown, ctx: unknown) => Promise<Record<string, { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }> | null>;
const stepResolver = (): Resolver =>
  (connectionTools as unknown as { events: { "step.started": Resolver } }).events["step.started"];

test("a server refusing the credential on initialize or on a call records auth_failed and the tool stops being offered", async () => {
  for (const refuse of ["call", "initialize"] as const) {
    paths();
    setDiscoveryLogger(() => {});
    const sessionId = `s-refused-${refuse}`;
    grantedSession(sessionId);
    const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" })).entry;
    let refusing = false;
    setMcpFetch((async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (refusing && (refuse === "initialize" || body.method === "tools/call")) return new Response("no", { status: 401 });
      if (body.method === "initialize") return rpcResult(1, { protocolVersion: "2025-06-18" });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") return rpcResult(body.id, { content: [] });
      return rpcResult(body.id, { tools: [{ name: "list_videos", description: "List the videos" }] });
    }) as typeof fetch);
    assert.equal((await discoverConnection(row)).status.state, "ready");
    const resolve = stepResolver();
    const ctx = { session: { id: sessionId } };
    const first = await resolve({}, ctx);
    await first!.find_tools.execute({ query: "tella videos" }, ctx);
    const second = await resolve({}, ctx);
    assert.ok(second?.tella__list_videos, refuse);
    refusing = true;
    const called = await second!.tella__list_videos.execute({}, ctx);
    assert.equal(called.error, "auth_failed", refuse);
    assert.equal(connectionStatus("tella")?.state, "auth_failed", refuse);
    assert.equal(connectionIndex("tella")?.tools.length, 0, refuse);
    const third = await resolve({}, ctx);
    assert.equal(third?.tella__list_videos, undefined, refuse);
  }
});

test("a late refusal from a call that began before a reconnect cannot overwrite the newer ready", async () => {
  for (const failure of ["auth", "expired"] as const) {
    paths();
    setDiscoveryLogger(() => {});
    const mem = memoryKeychain();
    setKeychainDriver(mem);
    const sessionId = `s-race-${failure}`;
    grantedSession(sessionId);
    const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp", authKind: "oauth" })).entry;
    keychainSet(connectionSecretService("tella"), bundleJson({ expiresAt: Date.now() + 3_600_000 }));
    let reconnect: (() => Promise<void>) | null = null;
    setMcpFetch((async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "initialize") return rpcResult(1, { protocolVersion: "2025-06-18" });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call" && reconnect && failure === "auth") {
        // While the old-token call is out, the owner reconnects and discovery succeeds.
        const again = reconnect;
        reconnect = null;
        await again();
        return new Response("no", { status: 401 });
      }
      return rpcResult(body.id, { tools: [{ name: "list_videos", description: "List the videos" }] });
    }) as typeof fetch);
    assert.equal((await discoverConnection(row)).status.state, "ready");
    const resolve = stepResolver();
    const ctx = { session: { id: sessionId } };
    await (await resolve({}, ctx))!.find_tools.execute({ query: "tella videos" }, ctx);
    const second = await resolve({}, ctx);
    assert.ok(second?.tella__list_videos, failure);
    reconnect = async () => {
      assert.equal((await discoverConnection(row, { headers: { authorization: "Bearer new" } })).status.state, "ready");
    };
    if (failure === "expired") {
      // The token has run out; the refresh is slow, and the reconnect lands while it is out.
      keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
      setOauthFetch(async () => {
        const again = reconnect!;
        reconnect = null;
        await again();
        return tokenJson({ error: "invalid_grant" }, 400);
      });
    }
    const called = await second!.tella__list_videos.execute({}, ctx);
    assert.equal(called.status, "blocked", failure);
    assert.equal(called.error, failure === "auth" ? "auth_failed" : "oauth_expired", failure);
    assert.equal(connectionStatus("tella")?.state, "ready", `${failure}: the old call's refusal did not overwrite the reconnect`);
    assert.equal(connectionIndex("tella")?.tools.length, 1, failure);
  }
});

test("after a restart the saved tools of a connection are listed again before they are mounted", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const sessionId = "s-restart";
  const row = upsertConnection(entry()).entry;
  let tools: Array<Record<string, unknown>> = [{ name: "old_tool", description: "Old" }, { name: "other", description: "Other" }];
  let down = false;
  const server = mcpServer(() => (down ? "down" : { tools }));
  await discoverConnection(row);
  activateSessionTools(sessionId, ["example__old_tool"]);
  const resolve = stepResolver();
  const ctx = { session: { id: sessionId } };
  assert.ok((await resolve({}, ctx))?.example__old_tool, "mounted while this process has checked it");
  assert.equal(server.listings, 1);

  // The server dropped the tool while the app was not running.
  resetRuntimeChecks();
  tools = [{ name: "other", description: "Other" }];
  const after = await resolve({}, ctx);
  assert.equal(server.listings, 2, "listed again before mounting");
  assert.equal(after?.example__old_tool, undefined);

  // A server that cannot be reached at the first check mounts nothing, now or on the next step.
  activateSessionTools(sessionId, ["example__other"]);
  resetRuntimeChecks();
  down = true;
  assert.equal((await resolve({}, ctx))?.example__other, undefined);
  assert.equal((await resolve({}, ctx))?.example__other, undefined, "still held back on the next step");
  // It comes back once a listing works again.
  down = false;
  await discoverConnection(row);
  assert.ok((await resolve({}, ctx))?.example__other);
  const settled = server.listings;
  await resolve({}, ctx);
  assert.equal(server.listings, settled, "one check per runtime, not one per step");
});

test("a connection already checked in this runtime is listed again before mounting once its listing is six hours old", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const sessionId = "s-ttl";
  const row = upsertConnection(entry()).entry;
  let tools: Array<Record<string, unknown>> = [{ name: "old_tool", description: "Old" }, { name: "other", description: "Other" }];
  const server = mcpServer(() => ({ tools }));
  await discoverConnection(row);
  activateSessionTools(sessionId, ["example__old_tool"]);
  const resolve = stepResolver();
  const ctx = { session: { id: sessionId } };
  assert.ok((await resolve({}, ctx))?.example__old_tool);
  assert.equal(server.listings, 1);
  // The same process, a long-lived session: the listing is now older than the TTL.
  const status = connectionStatus("example")!;
  putConnectionDiscovery("example", {
    tools: null,
    status: { ...status, checkedAt: new Date(Date.now() - INDEX_TTL_MS - 60_000).toISOString() },
  });
  tools = [{ name: "other", description: "Other" }];
  const after = await resolve({}, ctx);
  assert.equal(server.listings, 2, "a due listing is fetched again before mounting");
  assert.equal(after?.example__old_tool, undefined, "a tool the server dropped is not mounted");
  await resolve({}, ctx);
  assert.equal(server.listings, 2, "a fresh listing is not fetched again");
});

test("saved tools stay unmounted when the first discovery after a restart came from elsewhere and did not end ready", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const sessionId = "s-restart-elsewhere";
  const row = upsertConnection(entry()).entry;
  let down = false;
  const server = mcpServer(() => (down ? "down" : { tools: [{ name: "other", description: "Other" }] }));
  await discoverConnection(row);
  activateSessionTools(sessionId, ["example__other"]);
  const resolve = stepResolver();
  const ctx = { session: { id: sessionId } };
  assert.ok((await resolve({}, ctx))?.example__other);
  // A new process; the Connectors page (or find_tools) is the first to list, and the server is down.
  resetRuntimeChecks();
  down = true;
  assert.equal((await discoverConnection(row)).status.state, "unreachable");
  assert.equal(connectionIndex("example")?.tools.length, 1, "an outage keeps the listing beside the status");
  const before = server.listings;
  assert.equal((await resolve({}, ctx))?.example__other, undefined, "the failed discovery holds the saved tools back");
  assert.equal(server.listings, before, "inside the retry window it does not ask again");
  // It comes back once a listing works again.
  down = false;
  await discoverConnection(row);
  assert.ok((await resolve({}, ctx))?.example__other);
  // A discovery that is still running is waited for, not skipped.
  resetRuntimeChecks();
  const pending = discoverConnection(row);
  assert.ok((await resolve({}, ctx))?.example__other);
  await pending;
});

test("removing a connection stops every discovery of it, and a write that started before the removal is dropped", async () => {
  paths();
  oauthPendingPath();
  setKeychainDriver(memoryKeychain());
  setDiscoveryLogger(() => {});
  upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (body.method === "initialize") return rpcResult(1, { protocolVersion: "2025-06-18" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const authorization = String((init?.headers as Record<string, string>).authorization ?? "");
    const aborted = new Promise<never>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    // The first run is stuck until released or told to stop; the second only until told to stop.
    if (authorization === "Bearer a") {
      await Promise.race([gate, aborted]);
      return rpcResult(body.id, { tools: [{ name: "list_videos", description: "List" }] });
    }
    return aborted;
  }) as typeof fetch);
  const row = findConnectionById("tella")!;
  const older = discoverConnection(row, { headers: { authorization: "Bearer a" } });
  const newer = discoverConnection(row, { headers: { authorization: "Bearer b" } });
  assert.equal(discoveryRunning("tella"), true);
  await deleteConnection("tella");
  assert.equal(discoveryRunning("tella"), false);
  release();
  await Promise.all([older, newer]);
  assert.equal(connectionStatus("tella"), null, "no status written for a removed connection");
  assert.equal(connectionIndex("tella"), null);
  // The guard does not lean on a status row that is no longer there.
  assert.equal(putConnectionDiscovery("tella", {
    tools: [{ name: "ghost", description: "", inputSchema: null, inputSchemaBytes: 2 }],
    status: { state: "ready", lastError: null, checkedAt: new Date(Date.now() - 5_000).toISOString(), toolCount: 1 },
  }), false);
  assert.equal(connectionIndex("tella"), null);
  // A connection added again under that id works normally.
  const again = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp" })).entry;
  release();
  mcpServer(() => ({ tools: [{ name: "list_videos", description: "List" }] }));
  assert.equal((await discoverConnection(again)).status.state, "ready");
  assert.equal(connectionIndex("tella")?.tools.length, 1);
});

test("a tool call that finds a sign-in expired for a removed connection writes nothing", async () => {
  paths();
  oauthPendingPath();
  setKeychainDriver(memoryKeychain());
  const row = upsertConnection(entry({ id: "tella", name: "Tella" })).entry;
  markConnectionExpired("tella");
  assert.equal(connectionStatus("tella")?.state, "expired");
  await deleteConnection(row.id);
  markConnectionExpired("tella");
  assert.equal(connectionStatus("tella"), null);
  assert.equal(connectionIndex("tella"), null);
});

/** A packed bundle as the keychain driver stores it. */
const packed = (json: string) => Buffer.from(json, "utf8").toString("base64url");

test("a refresh refused as invalid_grant uses what another process stored meanwhile, and only expires when nothing newer is there", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  const service = connectionSecretService("tella");
  keychainSet(service, bundleJson({ refreshToken: "rt_old" }));
  // Another process refreshed (and rotated the token) while this one's request was out.
  const sent: string[] = [];
  setOauthFetch(async (_input, init) => {
    sent.push(String(init?.body ?? ""));
    mem.set(service, packed(bundleJson({ accessToken: "at_other", refreshToken: "rt_other", expiresAt: Date.now() + 3_600_000 })));
    return tokenJson({ error: "invalid_grant" }, 400);
  });
  assert.deepEqual(await connectionHeaders(row), { authorization: "Bearer at_other" });
  assert.equal(sent.length, 1);
  // The other process's token is itself about to expire: one more try, with its refresh token.
  keychainSet(service, bundleJson({ refreshToken: "rt_old" }));
  sent.length = 0;
  setOauthFetch(async (_input, init) => {
    const body = String(init?.body ?? "");
    sent.push(body);
    if (body.includes("rt_old")) {
      mem.set(service, packed(bundleJson({ accessToken: "at_mid", refreshToken: "rt_mid", expiresAt: Date.now() + 1_000 })));
      return tokenJson({ error: "invalid_grant" }, 400);
    }
    return tokenJson({ access_token: "at_final", refresh_token: "rt_final", expires_in: 3600 });
  });
  assert.deepEqual(await connectionHeaders(row), { authorization: "Bearer at_final" });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /rt_mid/);
  // Nothing newer stored: the refusal stands.
  keychainSet(service, bundleJson({ refreshToken: "rt_dead" }));
  setOauthFetch(async () => tokenJson({ error: "invalid_grant" }, 400));
  await assert.rejects(() => connectionHeaders(row), (err: unknown) => err instanceof OAuthExpiredError);
});

test("a refresh that finishes after the owner signed in again does not write over the new sign-in", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  const service = connectionSecretService("tella");
  keychainSet(service, bundleJson({ refreshToken: "rt_old" }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setOauthFetch(async () => {
    await gate;
    return tokenJson({ access_token: "at_refreshed", refresh_token: "rt_refreshed", expires_in: 3600 });
  });
  const headers = connectionHeaders(row);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A sign-in completed while the refresh request was out.
  mem.set(service, packed(bundleJson({ accessToken: "at_signin", refreshToken: "rt_signin", expiresAt: Date.now() + 3_600_000 })));
  release();
  assert.deepEqual(await headers, { authorization: "Bearer at_signin" });
  assert.match(String(keychainGet(service)), /at_signin/, "the new sign-in is still what is stored");
});

/** Holds a connection's refresh lock in another process for `ms`, and resolves once it is held. */
function holdLockElsewhere(file: string, ms: number): Promise<{ done: Promise<void> }> {
  const dirLock = fileURLToPath(new URL("../shared/dir-lock.ts", import.meta.url));
  const script = `import { acquireDirLock } from ${JSON.stringify(dirLock)};`
    + `const release = acquireDirLock(${JSON.stringify(file)}, { timeoutMs: 1000, errorCode: "busy" });`
    + `console.log("locked");`
    + `setTimeout(() => { release(); process.exit(0); }, ${ms});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve({ done }));
  });
}

test("a refresh waits for another process's refresh of the same connection, then reads what it stored", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
  keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
  let sentAt = 0;
  setOauthFetch(async () => {
    sentAt = Date.now();
    return tokenJson({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 });
  });
  const held = await holdLockElsewhere(refreshLockPath("tella"), 700);
  const started = Date.now();
  assert.deepEqual(await connectionHeaders(row), { authorization: "Bearer at_new" });
  await held.done;
  assert.ok(sentAt - started >= 500, `the refresh went out ${sentAt - started}ms in, before the other process let go`);
});

test("a refresh that cannot get the lock in time reports it is not known yet, never the server unreachable", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setRefreshLockTimeoutMs(150);
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
    keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
    let requests = 0;
    setOauthFetch(async () => { requests += 1; return tokenJson({ access_token: "x", expires_in: 3600 }); });
    const held = await holdLockElsewhere(refreshLockPath("tella"), 900);
    await assert.rejects(() => connectionHeaders(row), (err: unknown) => err instanceof OAuthRefreshBusyError);
    assert.equal(requests, 0, "nothing was sent without the lock");
    await held.done;
  } finally {
    setRefreshLockTimeoutMs(null);
  }
});

test("boolean subschemas convert: true accepts anything, false accepts nothing, and the tool is not a passthrough", () => {
  const built = toolInputSchema({ type: "object", properties: { any: true, none: false, list: { type: "array", items: true } }, required: ["any", "list"] });
  assert.equal(built.passthrough, false);
  assert.equal(built.schema.safeParse({ any: { x: 1 }, list: [1, "a"] }).success, true);
  assert.equal(built.schema.safeParse({ any: 1, list: [], none: 1 }).success, false);
  assert.equal(built.schema.safeParse({ any: 1, list: [] }).success, true);
  assert.ok(mountedSchemaBytes({ type: "object", properties: { any: true, none: false } }) > 0);
});

test("a refresh waiting on a busy lock reads the Keychain at most every 500 ms, not on every 25 ms try", async () => {
  paths();
  const mem = memoryKeychain();
  let reads = 0;
  setKeychainDriver({
    get: (service) => { reads += 1; return mem.get(service); },
    set: (service, value) => mem.set(service, value),
    del: (service) => mem.del(service),
  });
  setRefreshLockTimeoutMs(5_000);
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
    keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
    setOauthFetch(async () => tokenJson({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
    const held = await holdLockElsewhere(refreshLockPath("tella"), 1_300);
    reads = 0;
    await connectionHeaders(row);
    await held.done;
    // Two before the wait (the token read and the stored read), a handful of
    // checks across 1.3 s, and the reads of the refresh itself.
    assert.ok(reads <= 12, `${reads} Keychain reads while waiting 1.3 s`);
  } finally {
    setRefreshLockTimeoutMs(null);
  }
});

test("the refresh-lock wait outlasts the holder's worst case: two token requests and a margin", () => {
  assert.ok(REFRESH_LOCK_TIMEOUT_DEFAULT_MS >= 2 * OAUTH_TIMEOUT_MS + 5_000);
});

test("a waiter that gave up on the refresh lock leaves no pending stamp, so the holder finishing later still ends ready", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setRefreshLockTimeoutMs(300);
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp", authKind: "oauth" })).entry;
    keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
    setOauthFetch(async () => tokenJson({ access_token: "x", expires_in: 3600 }));
    mcpServer(() => ({ tools: [{ name: "list_videos", description: "List" }] }));
    const held = await holdLockElsewhere(refreshLockPath("tella"), 900);
    const holderStamp = nextStamp();
    await discoverConnection(row);
    assert.notEqual(connectionStatus("tella")?.state, "pending", "the waiter that gave up left a pending stamp");
    // The holder finishes after the waiter gave up, with its older stamp.
    const wrote = putConnectionDiscovery("tella", {
      tools: [{ name: "list_videos", description: "List", inputSchema: null, inputSchemaBytes: 2 }],
      status: { state: "ready", lastError: null, checkedAt: holderStamp, toolCount: 1 },
      unlessNewer: true,
    });
    assert.equal(wrote, true, "the holder's ready was blocked by the waiter's pending stamp");
    assert.equal(connectionStatus("tella")?.state, "ready");
    await held.done;
  } finally {
    setRefreshLockTimeoutMs(null);
  }
});

test("a refresh waiting on another process stops as soon as what it stored is good, and the event loop keeps running", async () => {
  paths();
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setRefreshLockTimeoutMs(5_000);
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", authKind: "oauth" })).entry;
    const service = connectionSecretService("tella");
    keychainSet(service, bundleJson({ refreshToken: "rt_old" }));
    let requests = 0;
    setOauthFetch(async () => { requests += 1; return tokenJson({ access_token: "x", expires_in: 3600 }); });
    const held = await holdLockElsewhere(refreshLockPath("tella"), 2_000);
    // The other process stores its refreshed bundle, and is slow to let go.
    setTimeout(() => mem.set(service, packed(bundleJson({ accessToken: "at_other", refreshToken: "rt_other", expiresAt: Date.now() + 3_600_000 }))), 200);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    try {
      assert.deepEqual(await connectionHeaders(row), { authorization: "Bearer at_other" });
    } finally {
      clearInterval(timer);
    }
    const took = Date.now() - started;
    assert.ok(took < 1_200, `waited ${took} ms although the stored bundle was good after 200`);
    assert.ok(ticks >= 10, `the event loop ran ${ticks} ticks while it waited`);
    assert.equal(requests, 0);
    await held.done;
  } finally {
    setRefreshLockTimeoutMs(null);
  }
});

test("a discovery whose refresh could not get the lock records nothing, so it cannot supersede the ready the lock holder wrote", async () => {
  paths();
  setDiscoveryLogger(() => {});
  const mem = memoryKeychain();
  setKeychainDriver(mem);
  setRefreshLockTimeoutMs(400);
  try {
    const row = upsertConnection(entry({ id: "tella", name: "Tella", url: "https://api.tella.com/mcp", authKind: "oauth" })).entry;
    keychainSet(connectionSecretService("tella"), bundleJson({ refreshToken: "rt_old" }));
    setOauthFetch(async () => tokenJson({ access_token: "x", expires_in: 3600 }));
    mcpServer(() => ({ tools: [{ name: "list_videos", description: "List" }] }));
    const held = await holdLockElsewhere(refreshLockPath("tella"), 1_500);
    // The holder's own discovery started first, so its stamp is older than ours.
    const holderStamp = nextStamp();
    const discovery = discoverConnection(row);
    putConnectionDiscovery("tella", {
      tools: [{ name: "list_videos", description: "List", inputSchema: null, inputSchemaBytes: 2 }],
      status: { state: "ready", lastError: null, checkedAt: holderStamp, toolCount: 1 },
    });
    const outcome = await discovery;
    assert.equal(connectionStatus("tella")?.state, "ready", "a lock that timed out is not an unreachable server");
    assert.equal(connectionIndex("tella")?.tools.length, 1);
    assert.equal(outcome.status.state, "ready");
    await held.done;
    // Nothing was recorded, so the next discovery simply tries again.
    resetRuntimeChecks();
    const mid = memoryKeychain();
    setKeychainDriver(mid);
    keychainSet(connectionSecretService("tella"), bundleJson({ accessToken: "at_good", expiresAt: Date.now() + 3_600_000 }));
    assert.equal((await discoverConnection(row)).status.state, "ready");
  } finally {
    setRefreshLockTimeoutMs(null);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mcpToolGate, mcpToolRisk } from "../agent/lib/connector-risk.ts";
import connectionTools from "../agent/tools/connection_tools.ts";
import {
  activateSessionTools,
  connectionIndex,
  indexedToolBytes,
  mountedDescription,
  mountedToolName,
  putConnectionIndex,
  putConnectionOperations,
  readConnectionToolsStore,
  sessionTools,
  updateConnectionToolsStore,
} from "../shared/connection-tools-store.ts";
import {
  eagerConnections,
  ensureMeasured,
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
import { connectionSecretService, keychainSet, memoryKeychain, setKeychainDriver } from "../shared/keychain.ts";
import { upsertConnection, type ConnectionEntry } from "../shared/connections-store.ts";
import { toolInputSchema, rawSchemaHint } from "../shared/json-schema-zod.ts";
import { setMcpFetch } from "../shared/mcp-http.ts";
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

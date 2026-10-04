import assert from "node:assert/strict";
import test from "node:test";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { MCP_READ_TIMEOUT_MS, McpError, callMcpTool, listMcpTools, listMcpToolsWithStats, modelToolNames, readMcpResource, setMcpFetch } from "../shared/mcp-http.ts";
import { parseWidgetDraft } from "../shared/mcp-apps.ts";

test("tools/list parses SSE, drops app-only names from the model list", async () => {
  setConnectionLookup(async () => "8.8.8.8");
  const calls: string[] = [];
  setMcpFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    calls.push(body.method ?? "");
    if (body.method === "initialize") {
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(`event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "read_me", description: "docs", _meta: { ui: { visibility: ["model", "app"] } } },
          { name: "create_view", description: "draw", _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
          { name: "save_checkpoint", description: "app", _meta: { ui: { visibility: ["app"] } } },
        ],
      },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const tools = await listMcpTools("https://mcp.excalidraw.com/mcp");
    assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(tools.length, 3);
    assert.equal(tools[1].resourceUri, "ui://excalidraw/mcp-app.html");
    assert.deepEqual(modelToolNames(tools), ["read_me", "create_view"]);
    // Only a tool the server itself marked for the app is callable from it.
    assert.deepEqual(tools.map((tool) => tool.appCallable), [true, false, true]);
  } finally {
    setMcpFetch(null);
    setConnectionLookup(null);
  }
});

test("a private MCP URL is refused before fetch", async () => {
  let fetched = false;
  setMcpFetch(async () => {
    fetched = true;
    return new Response("{}");
  });
  try {
    await assert.rejects(() => listMcpTools("http://192.168.0.5/mcp"), /url_http/);
    assert.equal(fetched, false);
  } finally {
    setMcpFetch(null);
  }
});

test("tools/call runs one tool and hands back its result", async () => {
  setConnectionLookup(async () => "8.8.8.8");
  const sent: Array<{ method?: string; params?: unknown }> = [];
  setMcpFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown };
    sent.push(body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      });
    }
    return new Response(`data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [{ type: "text", text: "https://excalidraw.com/#json=a,b" }] },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const result = await callMcpTool("https://mcp.excalidraw.com/mcp", "export_to_excalidraw", { json: "{}" });
    assert.deepEqual(sent.map((item) => item.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.deepEqual(sent[2], {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "export_to_excalidraw", arguments: { json: "{}" } },
    });
    assert.deepEqual(result, { content: [{ type: "text", text: "https://excalidraw.com/#json=a,b" }] });
  } finally {
    setMcpFetch(null);
    setConnectionLookup(null);
  }
});

test("a listing and a resource read carry a deadline of their own", async () => {
  setConnectionLookup(async () => "8.8.8.8");
  const signals: Array<AbortSignal | null> = [];
  // A server that answers `initialize` and then never comes back. Without a
  // deadline this held the connect card and the widget host open for as long
  // as the socket stayed up.
  const hang = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? null);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  // A real fetch holds the loop open until its socket closes; this stub holds
  // nothing, and `AbortSignal.timeout` does not keep a process alive on its
  // own, so the deadline here is an explicit one.
  const deadline = (ms: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
  setMcpFetch(hang);
  try {
    // The deadline reaches the second round trip, not just the first, in both.
    await assert.rejects(() => listMcpTools("https://mcp.example.com/mcp", {}, deadline(20)), /abort/i);
    await assert.rejects(
      () => readMcpResource("https://mcp.example.com/mcp", "ui://x", {}, deadline(20)),
      /abort/i,
    );
    // Counted rather than asserted through `every`: a type-guard predicate
    // inside `assert.ok` narrows the array itself for the rest of the test.
    assert.equal(signals.filter((signal) => signal instanceof AbortSignal).length, signals.length);
    assert.ok(MCP_READ_TIMEOUT_MS > 0);
    // And a caller that passes none still gets one.
    signals.length = 0;
    setMcpFetch((async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? null);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const result = body.method === "initialize" ? {} : { tools: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.method === "initialize" ? 1 : 2, result }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    await listMcpTools("https://mcp.example.com/mcp");
    assert.ok(signals[0] instanceof AbortSignal);
  } finally {
    setMcpFetch(null);
    setConnectionLookup(null);
  }
});

test("a server that answers with more than this side will take is cut off", async () => {
  setConnectionLookup(async () => "8.8.8.8");
  // `res.text()` reads whatever arrives before any size check can run, so a
  // server answering with gigabytes took the app down on the way to being
  // rejected. The limit is enforced while reading now.
  let sent = 0;
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        // Far past the cap: the read must stop long before this does.
        if (sent > 512 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    await assert.rejects(() => listMcpTools("https://mcp.example.com/mcp"), /too_large/);
    assert.ok(sent < 16 * 1024 * 1024, `read ${sent} bytes before stopping`);
  } finally {
    setMcpFetch(null);
    setConnectionLookup(null);
  }
});

type Seen = {
  method: string;
  id?: number;
  params?: Record<string, unknown>;
  headers: Record<string, string>;
  result?: unknown;
  error?: { code?: number };
};

/** A server that records what it was sent and answers by method. */
function server(
  answer: (seen: Seen) => Response | Promise<Response>,
): Seen[] {
  const seen: Seen[] = [];
  setConnectionLookup(async () => "8.8.8.8");
  setMcpFetch((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } };
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const row: Seen = { method: body.method, id: body.id, params: body.params, headers, result: body.result, error: body.error };
    seen.push(row);
    return answer(row);
  }) as typeof fetch);
  return seen;
}

function json(id: number | undefined, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", ...headers },
  });
}

function reset(): void {
  setMcpFetch(null);
  setConnectionLookup(null);
}

/** Resolves when the promise does, or after a short wait, whichever comes first. */
async function waitFor(done: Promise<void>, ms = 500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

const ONE_TOOL = { tools: [{ name: "list_videos", description: "List videos" }] };

test("the 2025-06-18 handshake sends initialized and carries the version and session on every later request", async () => {
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "sess-1" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, ONE_TOOL);
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp", { authorization: "Bearer abc" });
    assert.equal(tools.length, 1);
    assert.deepEqual(seen.map((row) => row.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(seen[0].params?.protocolVersion, "2025-06-18");
    assert.equal(seen[0].headers["mcp-protocol-version"], undefined);
    // A notification has no id.
    assert.equal(seen[1].id, undefined);
    for (const row of seen.slice(1)) {
      assert.equal(row.headers["mcp-protocol-version"], "2025-06-18");
      assert.equal(row.headers["mcp-session-id"], "sess-1");
      assert.equal(row.headers.authorization, "Bearer abc");
    }
  } finally {
    reset();
  }
});

test("a server that answers with the older version is spoken to in that version", async () => {
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-03-26" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 204 });
    return json(row.id, ONE_TOOL);
  });
  try {
    await listMcpTools("https://api.example.com/mcp");
    assert.equal(seen[2].headers["mcp-protocol-version"], "2025-03-26");
    assert.equal(seen[1].headers["mcp-protocol-version"], "2025-03-26");
  } finally {
    reset();
  }
});

test("a version this side does not speak is a protocol error before anything else is sent", async () => {
  const seen = server((row) => json(row.id, { protocolVersion: "2024-11-05" }));
  try {
    await assert.rejects(
      () => listMcpTools("https://api.example.com/mcp"),
      (err: unknown) => err instanceof McpError && err.kind === "protocol" && /version/.test(err.message),
    );
    assert.deepEqual(seen.map((row) => row.method), ["initialize"]);
  } finally {
    reset();
  }
});

test("a notification streamed ahead of the response does not break the parse", async () => {
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    const note = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } };
    const ask = { jsonrpc: "2.0", id: 99, method: "ping" };
    const answer = { jsonrpc: "2.0", id: row.id, result: ONE_TOOL };
    // The answer's data is split over two lines of one event.
    const split = JSON.stringify(answer).replace(",", ",\ndata: ");
    return new Response(
      `event: message\ndata: ${JSON.stringify(note)}\n\nevent: message\ndata: ${JSON.stringify(ask)}\n\nevent: message\ndata: ${split}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp");
    assert.deepEqual(tools.map((tool) => tool.name), ["list_videos"]);
  } finally {
    reset();
  }
});

test("a server ping on the stream is answered before the server sends its result", async () => {
  const encoder = new TextEncoder();
  let release: () => void = () => {};
  const replied = new Promise<void>((resolve) => { release = resolve; });
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "sess-9" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    // The reply to the server's ping: a response, so it has no method.
    if (row.method === undefined && row.id === 77) {
      release();
      return new Response(null, { status: 202 });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "ping" })}\n\n`));
        // A server that waits for the reply. Bounded, so a client that never
        // answers fails the assertion below instead of hanging the run.
        await waitFor(replied);
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: row.id, result: ONE_TOOL })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp", { authorization: "Bearer abc" });
    assert.deepEqual(tools.map((tool) => tool.name), ["list_videos"]);
    const reply = seen.find((row) => row.method === undefined && row.id === 77);
    assert.ok(reply, "the ping was answered");
    assert.deepEqual(reply.result, {});
    assert.equal(reply.headers["mcp-session-id"], "sess-9");
    assert.equal(reply.headers["mcp-protocol-version"], "2025-06-18");
    assert.equal(reply.headers.authorization, "Bearer abc");
  } finally {
    reset();
  }
});

test("another server request on the stream is answered with method-not-found, not ignored", async () => {
  const encoder = new TextEncoder();
  let release: () => void = () => {};
  const replied = new Promise<void>((resolve) => { release = resolve; });
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (row.method === undefined && row.id === 5) {
      release();
      return new Response(null, { status: 202 });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "sampling/createMessage", params: {} })}\n\n`));
        await waitFor(replied);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: row.id, result: ONE_TOOL })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp", {});
    assert.equal(tools.length, 1);
    assert.equal(seen.find((row) => row.method === undefined && row.id === 5)?.error?.code, -32601);
  } finally {
    reset();
  }
});

test("tools/list follows nextCursor across three pages and stops at the page cap", async () => {
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    const cursor = row.params?.cursor;
    if (cursor === undefined) return json(row.id, { tools: [{ name: "one" }], nextCursor: "c2" });
    if (cursor === "c2") return json(row.id, { tools: [{ name: "two" }], nextCursor: "c3" });
    return json(row.id, { tools: [{ name: "three" }] });
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp");
    assert.deepEqual(tools.map((tool) => tool.name), ["one", "two", "three"]);
    assert.deepEqual(seen.filter((row) => row.method === "tools/list").map((row) => row.params?.cursor), [undefined, "c2", "c3"]);
  } finally {
    reset();
  }
  // A server that never stops paging is cut off at twenty pages.
  const endless = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [{ name: `t${row.id}` }], nextCursor: `c${row.id}` });
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp");
    assert.equal(endless.filter((row) => row.method === "tools/list").length, 20);
    assert.equal(tools.length, 20);
  } finally {
    reset();
  }
});

test("failures are typed: auth, unreachable, protocol and parse", async () => {
  const outcome = async (answer: (row: Seen) => Response | Promise<Response>): Promise<McpError> => {
    server(answer);
    try {
      await listMcpTools("https://api.example.com/mcp");
    } catch (err) {
      assert.ok(err instanceof McpError, `got ${String(err)}`);
      return err;
    } finally {
      reset();
    }
    throw new Error("did not fail");
  };
  const auth = await outcome(() => new Response("{}", {
    status: 401,
    headers: {
      "www-authenticate": 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="openid offline_access"',
    },
  }));
  assert.equal(auth.kind, "auth");
  assert.equal(auth.status, 401);
  assert.equal(auth.scope, "openid offline_access");
  assert.equal(auth.resourceMetadata, "https://api.example.com/.well-known/oauth-protected-resource");
  assert.equal((await outcome(() => new Response("no", { status: 403 }))).kind, "auth");
  assert.equal((await outcome(() => new Response("down", { status: 503 }))).kind, "unreachable");
  assert.equal((await outcome(() => new Response("bad", { status: 400 }))).kind, "protocol");
  assert.equal((await outcome(() => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } }))).kind, "parse");
  assert.equal((await outcome(() => {
    throw new TypeError("fetch failed");
  })).kind, "unreachable");
  // A JSON-RPC error object is the server's answer, and a protocol one.
  assert.equal((await outcome((row) => new Response(JSON.stringify({
    jsonrpc: "2.0", id: row.id, error: { code: -32601, message: "Method not found" },
  }), { headers: { "content-type": "application/json" } }))).kind, "protocol");
  // An answer for some other id is not an answer to this request.
  assert.equal((await outcome(() => json(77, {}))).kind, "protocol");
});

test("a tool call runs the same handshake and finds its own answer in a stream", async () => {
  const seen = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "s9" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    const note = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
    const answer = { jsonrpc: "2.0", id: row.id, result: { content: [{ type: "text", text: "done" }] } };
    return new Response(`data: ${JSON.stringify(note)}\n\ndata: ${JSON.stringify(answer)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const result = await callMcpTool("https://api.example.com/mcp", "x", {});
    assert.deepEqual(result, { content: [{ type: "text", text: "done" }] });
    assert.deepEqual(seen.map((row) => row.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(seen[2].headers["mcp-protocol-version"], "2025-06-18");
    assert.equal(seen[2].headers["mcp-session-id"], "s9");
  } finally {
    reset();
  }
});

test("a listing reports how many tools it dropped as invalid", async () => {
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [{ name: "ok_tool" }, { name: "x".repeat(81) }, { description: "no name" }, "junk"] });
  });
  try {
    const out = await listMcpToolsWithStats("https://api.example.com/mcp");
    assert.equal(out.tools.length, 1);
    assert.equal(out.total, 4);
    assert.equal(out.dropped, 3);
  } finally {
    reset();
  }
});

// UB-003 review round 1.

test("a tools/list result that is not an object with a tools array is a failed listing", async () => {
  for (const result of [null, {}, { tools: "x" }, { tools: { name: "a" } }, "tools", 7]) {
    server((row) => {
      if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
      if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
      return json(row.id, result);
    });
    try {
      await assert.rejects(
        () => listMcpToolsWithStats("https://api.example.com/mcp"),
        (err: unknown) => err instanceof McpError && err.kind === "protocol",
        JSON.stringify(result),
      );
    } finally {
      reset();
    }
  }
  // An honest empty listing is still one.
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [] });
  });
  try {
    assert.deepEqual(await listMcpToolsWithStats("https://api.example.com/mcp"), { tools: [], total: 0, dropped: 0 });
  } finally {
    reset();
  }
});

test("an input schema that is not an object schema drops the tool; a missing one is an empty object schema", async () => {
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [
      { name: "missing" },
      { name: "good", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "untyped", inputSchema: { properties: { q: { type: "string" } } } },
      { name: "number", inputSchema: 42 },
      { name: "nullish", inputSchema: null },
      { name: "array", inputSchema: [] },
      { name: "stringy", inputSchema: { type: "string" } },
      { name: "listy", inputSchema: { type: ["object", "null"] } },
    ] });
  });
  try {
    const out = await listMcpToolsWithStats("https://api.example.com/mcp");
    assert.deepEqual(out.tools.map((tool) => tool.name), ["missing", "good", "untyped"]);
    assert.equal(out.total, 8);
    assert.equal(out.dropped, 5);
    assert.deepEqual(out.tools[0].inputSchema, { type: "object" });
  } finally {
    reset();
  }
});

// UB-003 review round 3.

test("a schema whose nested structure is broken drops the tool; real-world keywords stay", async () => {
  const broken: Array<[string, unknown]> = [
    ["props-string", { type: "object", properties: "id" }],
    ["props-array", { type: "object", properties: [{ type: "string" }] }],
    ["prop-not-object", { type: "object", properties: { id: "string" } }],
    ["prop-null", { type: "object", properties: { id: null } }],
    ["prop-bad-type", { type: "object", properties: { id: { type: "strng" } } }],
    ["prop-type-number", { type: "object", properties: { id: { type: 3 } } }],
    ["prop-type-array-bad", { type: "object", properties: { id: { type: ["string", "nope"] } } }],
    ["prop-type-array-empty", { type: "object", properties: { id: { type: [] } } }],
    ["required-string", { type: "object", properties: {}, required: "id" }],
    ["required-numbers", { type: "object", required: [1, 2] }],
    ["items-string", { type: "object", properties: { list: { type: "array", items: "string" } } }],
    ["items-bad-type", { type: "object", properties: { list: { type: "array", items: { type: "text" } } } }],
    ["items-array-junk", { type: "object", properties: { list: { type: "array", items: [{ type: "string" }, 4] } } }],
    ["nested-props-broken", { type: "object", properties: { a: { type: "object", properties: { b: { type: "wat" } } } } }],
    ["nested-required-broken", { type: "object", properties: { a: { type: "object", required: "b" } } }],
  ];
  const kept: Array<[string, unknown]> = [
    ["refs", { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } }],
    ["anyof", { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { oneOf: [{ type: "integer" }] } } }],
    ["enum-format", { type: "object", properties: { a: { type: "string", enum: ["x"], format: "uuid" }, b: { const: 1 } } }],
    ["type-array", { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: "array", items: { type: "number" } } } }],
    ["tuple-items", { type: "object", properties: { a: { type: "array", items: [{ type: "string" }, { type: "integer" }] } } }],
    ["required-ok", { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }],
    ["nested", { type: "object", properties: { a: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] } } }],
    ["unknown-keywords", { type: "object", properties: { a: { type: "string", "x-vendor": [1, 2], pattern: "^a" } }, "$schema": "http://json-schema.org/draft-07/schema#" }],
    ["boolean-property", { type: "object", properties: { a: true, b: false, c: { type: "string" } } }],
    ["boolean-items", { type: "object", properties: { a: { type: "array", items: true }, b: { type: "array", items: [{ type: "string" }, false] } } }],
    ["boolean-nested", { type: "object", properties: { a: { type: "object", properties: { b: true } } } }],
  ];
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [...broken, ...kept].map(([name, inputSchema]) => ({ name, inputSchema })) });
  });
  try {
    const out = await listMcpToolsWithStats("https://api.example.com/mcp");
    assert.deepEqual(out.tools.map((tool) => tool.name), kept.map(([name]) => name));
    assert.equal(out.total, broken.length + kept.length);
    assert.equal(out.dropped, broken.length);
  } finally {
    reset();
  }
});

test("a schema nested far deeper than any real one is still read, not chased forever", async () => {
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 200; i += 1) deep = { type: "object", properties: { next: deep } };
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(row.id, { tools: [{ name: "deep", inputSchema: deep }] });
  });
  try {
    const out = await listMcpToolsWithStats("https://api.example.com/mcp");
    assert.equal(out.tools.length, 1);
  } finally {
    reset();
  }
});

test("a response is taken as soon as its own event arrives, without waiting for the stream to end", async () => {
  let cancelled = false;
  server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    const note = { jsonrpc: "2.0", method: "notifications/message", params: {} };
    const answer = { jsonrpc: "2.0", id: row.id, result: ONE_TOOL };
    const encoder = new TextEncoder();
    // The answer arrives in two chunks, the second split mid-event, and the
    // stream is then held open with nothing more to say.
    const text = `data: ${JSON.stringify(note)}\n\ndata: ${JSON.stringify(answer)}\n\n`;
    const cut = text.indexOf("tools") + 2;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.enqueue(encoder.encode(text.slice(cut)));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  try {
    let timer: NodeJS.Timeout | undefined;
    const tools = await Promise.race([
      listMcpTools("https://api.example.com/mcp"),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("waited for the stream to end")), 1500); }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(tools.map((tool) => tool.name), ["list_videos"]);
    assert.equal(cancelled, true, "the rest of the stream was dropped");
  } finally {
    reset();
  }
});

test("a session the server forgot is opened again once, within the same call", async () => {
  let answered404 = 0;
  const seen = server((row) => {
    if (row.method === "initialize") {
      return json(row.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": answered404 === 0 ? "old" : "new" });
    }
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (row.headers["mcp-session-id"] === "old") {
      answered404 += 1;
      return new Response("session not found", { status: 404 });
    }
    return json(row.id, ONE_TOOL);
  });
  try {
    const tools = await listMcpTools("https://api.example.com/mcp", { authorization: "Bearer abc" });
    assert.deepEqual(tools.map((tool) => tool.name), ["list_videos"]);
    assert.deepEqual(seen.map((row) => row.method), [
      "initialize", "notifications/initialized", "tools/list",
      "initialize", "notifications/initialized", "tools/list",
    ]);
    // The second handshake carries the credential and no stale session or version.
    assert.equal(seen[3].headers["mcp-session-id"], undefined);
    assert.equal(seen[3].headers["mcp-protocol-version"], undefined);
    assert.equal(seen[3].headers.authorization, "Bearer abc");
    assert.equal(seen[5].headers["mcp-session-id"], "new");
  } finally {
    reset();
  }
  // Only once: a second 404 is the answer.
  const stubborn = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" }, { "mcp-session-id": "s" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response("gone", { status: 404 });
  });
  try {
    await assert.rejects(() => listMcpTools("https://api.example.com/mcp"), (err: unknown) => err instanceof McpError && err.status === 404);
    assert.equal(stubborn.filter((row) => row.method === "initialize").length, 2);
    assert.equal(stubborn.filter((row) => row.method === "tools/list").length, 2);
  } finally {
    reset();
  }
  // No session, no recovery: a 404 on a server that never issued one is final.
  const sessionless = server((row) => {
    if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
    if (row.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response("gone", { status: 404 });
  });
  try {
    await assert.rejects(() => listMcpTools("https://api.example.com/mcp"), (err: unknown) => err instanceof McpError && err.status === 404);
    assert.equal(sessionless.filter((row) => row.method === "initialize").length, 1);
  } finally {
    reset();
  }
});

test("a rejected initialized notification is a protocol failure; 200, 202 and 204 are fine", async () => {
  for (const status of [400, 404, 405, 500]) {
    const seen = server((row) => {
      if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
      if (row.method === "notifications/initialized") return new Response("no", { status });
      return json(row.id, ONE_TOOL);
    });
    try {
      await assert.rejects(
        () => listMcpTools("https://api.example.com/mcp"),
        (err: unknown) => err instanceof McpError && err.status === status,
        String(status),
      );
      assert.equal(seen.some((row) => row.method === "tools/list"), false, `nothing after a ${status}`);
    } finally {
      reset();
    }
  }
  for (const accepted of [() => new Response("{}", { status: 200 }), () => new Response(null, { status: 202 }), () => new Response(null, { status: 204 })]) {
    server((row) => {
      if (row.method === "initialize") return json(row.id, { protocolVersion: "2025-06-18" });
      if (row.method === "notifications/initialized") return accepted();
      return json(row.id, ONE_TOOL);
    });
    try {
      assert.equal((await listMcpTools("https://api.example.com/mcp")).length, 1);
    } finally {
      reset();
    }
  }
});

test("a server error that echoes the caller's token is redacted before it is cut to length", async () => {
  setConnectionLookup(async () => "8.8.8.8");
  const token = `tok_${"x".repeat(300)}`;
  setMcpFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `bad token Bearer ${token}` } });
  });
  try {
    const err = await callMcpTool("https://mcp.example.com/mcp", "t", {}, { authorization: `Bearer ${token}` }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof McpError);
    assert.equal(err.message.includes("x".repeat(16)), false);
    assert.match(err.message, /\[redacted\]/);
  } finally {
    setMcpFetch(null);
    setConnectionLookup(null);
  }
});

test("a stalled address lookup gives up at the caller's deadline", async () => {
  setConnectionLookup(() => new Promise<string>(() => {}));
  try {
    const started = Date.now();
    const err = await listMcpTools("https://mcp.example.com/mcp", {}, AbortSignal.timeout(200)).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof McpError);
    assert.equal(err.kind, "unreachable");
    assert.ok(Date.now() - started < 2000);
  } finally {
    setConnectionLookup(null);
  }
});

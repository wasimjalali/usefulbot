import assert from "node:assert/strict";
import test from "node:test";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { MCP_READ_TIMEOUT_MS, callMcpTool, listMcpTools, modelToolNames, readMcpResource, setMcpFetch } from "../shared/mcp-http.ts";
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
    assert.deepEqual(calls, ["initialize", "tools/list"]);
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
    assert.deepEqual(sent[1], {
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
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
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

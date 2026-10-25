import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import connectServer from "../agent/tools/connect_server.ts";
import { listPendingProposals, readProposal, updateProposal } from "../shared/agent-store.ts";
import { seedDefaultConnections, upsertConnection, EXCALIDRAW_CONNECTION } from "../shared/connections-store.ts";
import { writeShell } from "../shared/shell-io.ts";
import { seedStore } from "../shared/shell-store.ts";
import { fakeCtx, type TestCtx } from "./tools/ctx.ts";

async function run<T>(input: Record<string, unknown>, ctx: TestCtx = fakeCtx()): Promise<T> {
  return (await connectServer.execute(connectServer.inputSchema.parse(input), ctx)) as T;
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), "ub-conn-tool-"));
  const previous = {
    store: process.env.UB_AGENT_STORE_PATH,
    shell: process.env.UB_SHELL_PATH,
    connections: process.env.UB_CONNECTIONS_PATH,
  };
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  const shell = seedStore();
  writeShell(shell);
  return {
    dir,
    restore() {
      const put = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      put("UB_AGENT_STORE_PATH", previous.store);
      put("UB_SHELL_PATH", previous.shell);
      put("UB_CONNECTIONS_PATH", previous.connections);
    },
  };
}

const good = {
  url: "https://mcp.example.com/mcp",
  name: "Example",
  description: "Example MCP server for tests",
  auth: "none",
};

test("connect_server creates one card and one chat row, and refuses bad urls, duplicates and already-connected", async () => {
  const env = box();
  try {
    const ctx = fakeCtx();
    const first = await run<{ status: string; proposalId: string; name: string }>(good, ctx);
    assert.equal(first.status, "awaiting_owner_confirmation");
    assert.equal(first.name, "Example");
    const stored = readProposal(first.proposalId);
    assert.equal(stored?.kind, "connectServer");
    assert.equal(stored?.kind === "connectServer" && stored.urlHost, "mcp.example.com");
    assert.equal(stored?.kind === "connectServer" && stored.authKind, "none");
    assert.equal(stored?.kind === "connectServer" && stored.connectionKind, "mcp");
    assert.equal(listPendingProposals("bot-useful").length, 1);
    // The card is a row in the chat, keyed by the proposal so a repeat adds nothing.
    assert.deepEqual(ctx.rows, [{ key: `card:${first.proposalId}`, kind: "card", proposalId: first.proposalId }]);

    const dup = await run<{ status: string }>({ ...good, name: "Again" }, ctx);
    assert.equal(dup.status, "duplicate");
    assert.equal(ctx.rows.length, 1, "a duplicate adds no row");

    updateProposal(first.proposalId, (item) => {
      if (item.kind === "connectServer") item.phase = "expired";
    });
    const second = await run<{ status: string }>({ ...good, url: "https://other.example.com/mcp", name: "Other" }, ctx);
    assert.equal(second.status, "awaiting_owner_confirmation");
    assert.equal(ctx.rows.length, 2);

    for (const url of ["http://example.com/mcp", "https://localhost/mcp", "https://10.0.0.1/mcp", "ftp://example.com/x", "https://user:pw@example.com/mcp"]) {
      assert.equal((await run<{ status: string }>({ ...good, url }, ctx)).status, "invalid_url", url);
    }
    assert.equal(ctx.rows.length, 2, "a refused url adds no row");
  } finally {
    env.restore();
  }
});

test("connect_server defaults: the name from the host, oauth, and always an MCP server", async () => {
  const env = box();
  try {
    const out = await run<{ status: string; proposalId: string; name: string }>({ url: "https://tools.example.org/mcp", kind: "openapi" });
    assert.equal(out.status, "awaiting_owner_confirmation");
    assert.equal(out.name, "tools.example.org");
    const stored = readProposal(out.proposalId);
    assert.equal(stored?.kind === "connectServer" && stored.authKind, "oauth");
    assert.equal(stored?.kind === "connectServer" && stored.connectionKind, "mcp", "OpenAPI is not a choice any more");
    assert.equal(connectServer.inputSchema.safeParse({ url: "https://x.example.com/mcp", auth: "digest" }).success, false);
  } finally {
    env.restore();
  }
});

test("a seeded Excalidraw row is already_connected", async () => {
  const env = box();
  try {
    seedDefaultConnections();
    const ctx = fakeCtx();
    const draw = { url: "https://mcp.excalidraw.com/mcp", name: "Excalidraw", description: "Draw diagrams", auth: "none" };
    const out = await run<{ status: string; id: string }>(draw, ctx);
    assert.equal(out.status, "already_connected");
    assert.equal(out.id, "excalidraw");
    upsertConnection({ ...EXCALIDRAW_CONNECTION, name: "Mine" });
    const again = await run<{ status: string }>(draw, ctx);
    assert.equal(again.status, "already_connected");
    assert.deepEqual(ctx.rows, []);
  } finally {
    env.restore();
  }
});

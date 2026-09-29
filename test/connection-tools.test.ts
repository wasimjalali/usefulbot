import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import proposeConnection from "../agent/tools/propose_connection.ts";
import { listPendingProposals, readProposal, updateProposal } from "../shared/agent-store.ts";
import { seedDefaultConnections, upsertConnection, EXCALIDRAW_CONNECTION } from "../shared/connections-store.ts";
import { writeShell } from "../shared/shell-io.ts";
import { seedStore } from "../shared/shell-store.ts";

type Tool = { execute: (input: never, context: never) => unknown };

async function run<T>(tool: Tool, input: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<T> {
  return (await tool.execute(input as never, context as never)) as T;
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), "ub-conn-tool-"));
  const previous = {
    store: process.env.UB_AGENT_STORE_PATH,
    shell: process.env.UB_SHELL_PATH,
    connections: process.env.UB_CONNECTIONS_PATH,
    bot: process.env.UB_ACTIVE_BOT_ID,
  };
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_CONNECTIONS_PATH = join(dir, "connections.json");
  process.env.UB_ACTIVE_BOT_ID = "bot-useful";
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
      put("UB_ACTIVE_BOT_ID", previous.bot);
    },
  };
}

const good = {
  kind: "mcp",
  url: "https://mcp.example.com/mcp",
  name: "Example",
  description: "Example MCP server for tests",
  authKind: "none",
  purpose: "List the widgets",
};

test("propose_connection creates one card and refuses bad urls, duplicates and already-connected", async () => {
  const env = box();
  try {
    const first = await run<{ status: string; proposalId: string; name: string }>(proposeConnection, good);
    assert.equal(first.status, "awaiting_owner_confirmation");
    assert.equal(first.name, "Example");
    const stored = readProposal(first.proposalId);
    assert.equal(stored?.kind, "connectServer");
    assert.equal(stored?.kind === "connectServer" && stored.urlHost, "mcp.example.com");
    assert.equal(stored?.kind === "connectServer" && stored.authKind, "none");
    assert.equal(listPendingProposals("bot-useful").length, 1);
    const dup = await run<{ status: string }>(proposeConnection, { ...good, purpose: "Again" });
    assert.equal(dup.status, "duplicate");
    updateProposal(first.proposalId, (item) => {
      if (item.kind === "connectServer") item.phase = "expired";
    });
    const second = await run<{ status: string }>(proposeConnection, {
      ...good,
      url: "https://other.example.com/mcp",
      name: "Other",
    });
    assert.equal(second.status, "awaiting_owner_confirmation");
    assert.equal((await run<{ status: string }>(proposeConnection, { ...good, url: "http://example.com/mcp" })).status, "invalid_url");
    assert.equal((await run<{ status: string }>(proposeConnection, { ...good, purpose: "  " })).status, "invalid_purpose");
    assert.equal((await run<{ status: string }>(proposeConnection, {
      ...good,
      url: "https://keys.example.com/mcp",
      name: "Keys",
      authKind: "apiKey",
      authHeader: "X Api Key",
    })).status, "invalid_header");
  } finally {
    env.restore();
  }
});

test("a seeded Excalidraw row is already_connected", async () => {
  const env = box();
  try {
    seedDefaultConnections();
    const out = await run<{ status: string; id: string }>(proposeConnection, {
      kind: "mcp",
      url: "https://mcp.excalidraw.com/mcp",
      name: "Excalidraw",
      description: "Draw diagrams",
      authKind: "none",
      purpose: "Draw a cat",
    });
    assert.equal(out.status, "already_connected");
    assert.equal(out.id, "excalidraw");
    upsertConnection({ ...EXCALIDRAW_CONNECTION, name: "Mine" });
    const again = await run<{ status: string }>(proposeConnection, {
      kind: "mcp",
      url: "https://mcp.excalidraw.com/mcp",
      name: "Excalidraw",
      description: "Draw diagrams",
      authKind: "none",
      purpose: "Draw a cat",
    });
    assert.equal(again.status, "already_connected");
  } finally {
    env.restore();
  }
});

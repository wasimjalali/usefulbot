import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { setOauthFetch, startMcpOAuth } from "../shared/mcp-oauth.ts";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "ub-oauth-"));
  process.env.UB_OAUTH_PENDING_PATH = join(dir, "oauth.json");
  setConnectionLookup(async () => "8.8.8.8");
}

test.afterEach(() => {
  setOauthFetch(null);
  setConnectionLookup(null);
});

test("oauth discovery refuses a loopback authorization server", async () => {
  box();
  setOauthFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      return new Response(JSON.stringify({
        authorization_servers: ["http://127.0.0.1:9"],
        resource: "https://mcp.example.com/mcp",
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("no", { status: 500 });
  });
  await assert.rejects(() => startMcpOAuth({
    mcpUrl: "https://mcp.example.com/mcp",
    name: "Example",
    proposalId: "prp_testdiscovery01",
    connectionId: "example",
    redirectUri: "http://127.0.0.1:4320/api/connections/callback",
  }), /url_http|url_host/);
});

test("oauth probe of the MCP URL refuses a host that resolves private", async () => {
  box();
  let n = 0;
  setConnectionLookup(async () => {
    n += 1;
    return n === 1 ? "8.8.8.8" : "169.254.169.254";
  });
  setOauthFetch(async () => new Response("no", { status: 404 }));
  await assert.rejects(() => startMcpOAuth({
    mcpUrl: "https://mcp.example.com/mcp",
    name: "Example",
    proposalId: "prp_testdiscovery03",
    connectionId: "example",
    redirectUri: "http://127.0.0.1:4320/api/connections/callback",
  }), /url_resolved/);
});

test("oauth discovery refuses a loopback https token host", async () => {
  box();
  setOauthFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      return new Response(JSON.stringify({
        authorization_servers: ["https://auth.example.com"],
        resource: "https://mcp.example.com/mcp",
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("oauth-authorization-server")) {
      return new Response(JSON.stringify({
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://127.0.0.1/token",
        registration_endpoint: "https://auth.example.com/register",
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("no", { status: 500 });
  });
  await assert.rejects(() => startMcpOAuth({
    mcpUrl: "https://mcp.example.com/mcp",
    name: "Example",
    proposalId: "prp_testdiscovery02",
    connectionId: "example",
    redirectUri: "http://127.0.0.1:4320/api/connections/callback",
  }), /url_host/);
});

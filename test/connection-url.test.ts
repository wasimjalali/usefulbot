import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConnectionUrl,
  assertPublicHttpsUrl,
  assertResolvedPublic,
  connectionHost,
  isHttpsPublicHost,
  setConnectionLookup,
} from "../shared/connection-url.ts";

test("https public names pass and http is only 127.0.0.1", () => {
  assert.equal(assertConnectionUrl("https://mcp.excalidraw.com/mcp"), "https://mcp.excalidraw.com/mcp");
  assert.equal(assertConnectionUrl("  https://example.com/openapi.json  "), "https://example.com/openapi.json");
  assert.equal(assertConnectionUrl("http://127.0.0.1:3333/mcp"), "http://127.0.0.1:3333/mcp");
  assert.throws(() => assertConnectionUrl("http://localhost/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("http://example.com/mcp"), /url_http/);
  assert.throws(() => assertConnectionUrl("https://localhost/mcp"), /url_host/);
  assert.equal(assertConnectionUrl("https://127.0.0.1/mcp"), "https://127.0.0.1/mcp");
});

test("credentials, private hosts and junk are refused", () => {
  assert.throws(() => assertConnectionUrl("https://user:pass@example.com/mcp"), /url_credentials/);
  assert.throws(() => assertConnectionUrl("https://192.168.1.8/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("https://10.0.0.4/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("https://169.254.169.254/latest"), /url_host/);
  assert.throws(() => assertConnectionUrl("https://172.16.0.1/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("https://intranet/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("https://foo.local/mcp"), /url_host/);
  assert.throws(() => assertConnectionUrl("ftp://example.com/mcp"), /url_protocol/);
  assert.throws(() => assertConnectionUrl("not a url"), /url_invalid/);
  assert.throws(() => assertConnectionUrl("https://example.com/mcp with space"), /url_invalid/);
});

test("discovery URLs must be public https, never loopback http", () => {
  assert.equal(assertPublicHttpsUrl("https://auth.example.com/token"), "https://auth.example.com/token");
  assert.throws(() => assertPublicHttpsUrl("http://127.0.0.1:9/token"), /url_http/);
  assert.throws(() => assertPublicHttpsUrl("https://127.0.0.1/token"), /url_host/);
  assert.throws(() => assertPublicHttpsUrl("http://example.com/token"), /url_http/);
});

test("resolved private answers are refused before fetch", async () => {
  setConnectionLookup(async () => "10.0.0.4");
  try {
    await assert.rejects(() => assertResolvedPublic("https://mcp.example.com/mcp"), /url_resolved/);
  } finally {
    setConnectionLookup(null);
  }
  setConnectionLookup(async () => "8.8.8.8");
  try {
    assert.equal(await assertResolvedPublic("https://mcp.example.com/mcp"), "https://mcp.example.com/mcp");
  } finally {
    setConnectionLookup(null);
  }
  assert.equal(await assertResolvedPublic("http://127.0.0.1:3333/mcp"), "http://127.0.0.1:3333/mcp");
});

test("hash is dropped and the card host is the hostname", () => {
  assert.equal(assertConnectionUrl("https://mcp.excalidraw.com/mcp#frag"), "https://mcp.excalidraw.com/mcp");
  assert.equal(connectionHost("https://mcp.excalidraw.com/mcp"), "mcp.excalidraw.com");
  assert.equal(isHttpsPublicHost("https://auth.example.com/authorize?x=1", "auth.example.com"), true);
  assert.equal(isHttpsPublicHost("https://evil.example.com/authorize", "auth.example.com"), false);
  assert.equal(isHttpsPublicHost("http://auth.example.com/authorize", "auth.example.com"), false);
});

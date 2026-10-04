import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REDACTED, dumpUpstreamBody } from "../router/src/payload-probe.ts";

const body = {
  model: "glm-test",
  messages: [
    { role: "system", content: "You are a bot. key sk-test-ABCDEFGH12345678 and Bearer abcdefghij123456" },
    { role: "user", content: "hello" },
  ],
  tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
  authorization: "Bearer should-not-survive-123456",
  api_key: "plain",
};

test("the probe is refused on the daily stack and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  for (const env of [{ UB_PAYLOAD_PROBE_DIR: join(dir, "d") }, { UB_STACK: "daily", UB_PAYLOAD_PROBE_DIR: join(dir, "d") }]) {
    assert.equal(dumpUpstreamBody("openai-chat", "m", body, env), null);
  }
  assert.equal(existsSync(join(dir, "d")), false);
});

test("without the variable nothing is written, even on dev", () => {
  assert.equal(dumpUpstreamBody("openai-chat", "m", body, { UB_STACK: "dev" }), null);
});

test("on dev the body is written with keys, auth fields and bearer tokens scrubbed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  const file = dumpUpstreamBody("openai-chat", "glm/test:1", body, { UB_STACK: "dev", UB_PAYLOAD_PROBE_DIR: dir });
  assert.ok(file);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-.*-[0-9a-f]{6}-openai-chat-glm_test_1\.json$/);
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("sk-test-"), "fake key survived");
  assert.ok(!/Bearer\s+abcdefghij/.test(raw), "bearer survived");
  assert.ok(!raw.includes("should-not-survive"), "authorization survived");
  const written = JSON.parse(raw);
  assert.equal(written.authorization, REDACTED);
  assert.equal(written.api_key, REDACTED);
  assert.match(written.messages[0].content, /You are a bot\. key \[redacted\] and \[redacted\]/);
  assert.equal(written.tools.length, 1);
  assert.equal(written.messages[1].content, "hello");
});

test("the summary script reads a dump", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  dumpUpstreamBody("openai-chat", "glm-test", body, { UB_STACK: "dev", UB_PAYLOAD_PROBE_DIR: dir });
  const out = execFileSync("/usr/local/bin/node", ["scripts/payload-probe-summary.mjs", dir], { encoding: "utf8" });
  assert.match(out, /model: glm-test/);
  assert.match(out, /system messages: 1 \[\d+ chars\]/);
  assert.match(out, /tools: 1, schema chars: \d+/);
  assert.match(out, /first user: hello/);
});

test("an invalid UB_STACK is refused without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  assert.equal(dumpUpstreamBody("openai-chat", "m", body, { UB_STACK: "bogus", UB_PAYLOAD_PROBE_DIR: join(dir, "d") }), null);
  assert.equal(existsSync(join(dir, "d")), false);
});

test("wide key names, more key shapes and data URIs are handled, and same-millisecond dumps do not collide", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  const env = { UB_STACK: "dev", UB_PAYLOAD_PROBE_DIR: dir };
  const big = { cookie: "a=b", x_auth_header: "zzz", messages: [
    { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(5000)}` } }, { type: "text", text: "gsk_abcdefgh1234 xai-abcdefgh1234 nvapi-abcdefgh1234 sk_live_abcdefgh1234" }] },
  ], tools: [{ parameters: { properties: { key: { type: "string" } } } }] };
  const a = dumpUpstreamBody("openai-chat", "m", big, env);
  const b = dumpUpstreamBody("openai-chat", "m", big, env);
  assert.notEqual(a, b);
  const raw = readFileSync(a!, "utf8");
  for (const leaked of ["gsk_abc", "xai-abc", "nvapi-abc", "sk_live_abc", "AAAAAAAAAA", "a=b", "zzz"]) assert.ok(!raw.includes(leaked), leaked);
  assert.match(raw, /\[data uri, \d+ bytes\]/);
  assert.deepEqual(JSON.parse(raw).tools[0].parameters.properties.key, { type: "string" });
});

test("secret context reaches array elements, tool-call argument strings are scrubbed, params data URIs collapse, numbers stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-probe-"));
  const file = dumpUpstreamBody("openai-chat", "m", {
    api_keys: ["abc123", "def456"],
    max_tokens: 4096,
    messages: [{ role: "assistant", tool_calls: [{ function: { name: "f", arguments: JSON.stringify({ password: "hunter2", note: "hi", list: ["x"], nested: { access_token: "tok999" } }) } }] },
      { role: "user", content: `see data:text/plain;charset=utf-8;base64,${"QUJD".repeat(500)} end` }],
  }, { UB_STACK: "dev", UB_PAYLOAD_PROBE_DIR: dir });
  const raw = readFileSync(file!, "utf8");
  for (const leaked of ["abc123", "def456", "hunter2", "tok999", "QUJDQUJD"]) assert.ok(!raw.includes(leaked), leaked);
  const written = JSON.parse(raw);
  assert.deepEqual(written.api_keys, [REDACTED, REDACTED]);
  assert.equal(written.max_tokens, 4096);
  const args = JSON.parse(written.messages[0].tool_calls[0].function.arguments);
  assert.equal(args.password, REDACTED);
  assert.equal(args.note, "hi");
  assert.deepEqual(args.list, ["x"]);
  assert.equal(args.nested.access_token, REDACTED);
  assert.match(written.messages[1].content, /^see \[data uri, \d+ bytes\] end$/);
});

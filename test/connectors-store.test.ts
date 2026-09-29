import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearConnectorsKey,
  emptyConnectorsStore,
  isToolkitSlug,
  parseConnectorsStore,
  publicConnectors,
  readConnectorsStore,
  setConnectedToolkits,
  setConnectorsKey,
  updateConnectorsStore,
  writeConnectorsStore,
} from "../shared/connectors-store.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ub-conn-")), "connectors.json");
}

test("key persists 0600 and never reaches the public view", () => {
  const path = tmpPath();
  updateConnectorsStore((store) => setConnectorsKey(store, "ak_test_1234567890"), path);
  const loaded = readConnectorsStore(path);
  assert.equal(loaded.apiKey, "ak_test_1234567890");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const pub = publicConnectors(loaded);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.last4, "7890");
  assert.equal(JSON.stringify(pub).includes("ak_test"), false);
  assert.equal(JSON.stringify(pub).includes(loaded.userId), false);
});

test("a new key drops the old session and connected cache", () => {
  const store = emptyConnectorsStore();
  setConnectorsKey(store, "ak_first_12345");
  store.sessionId = "trs_old";
  setConnectedToolkits(store, ["gmail"]);
  setConnectorsKey(store, "ak_first_12345");
  assert.equal(store.sessionId, "trs_old");
  setConnectorsKey(store, "ak_second_12345");
  assert.equal(store.sessionId, null);
  assert.deepEqual(store.connectedToolkits, []);
  clearConnectorsKey(store);
  assert.equal(store.apiKey, null);
});

test("key validation strips whitespace and refuses short or long keys", () => {
  const store = emptyConnectorsStore();
  assert.throws(() => setConnectorsKey(store, "short"), /connectors_key/);
  assert.throws(() => setConnectorsKey(store, "x".repeat(4097)), /connectors_key/);
  setConnectorsKey(store, "  ak_trimmed_ok  ");
  assert.equal(store.apiKey, "ak_trimmed_ok");
  setConnectorsKey(store, "ak_pasted\n with_break ");
  assert.equal(store.apiKey, "ak_pastedwith_break");
  // The docs snippet, quoted, with the export in front: only the key survives.
  setConnectorsKey(store, "export COMPOSIO_API_KEY=\"ak_from_docs_1234\"\n");
  assert.equal(store.apiKey, "ak_from_docs_1234");
  setConnectorsKey(store, "composio_api_key='ak_lower_case_ok'");
  assert.equal(store.apiKey, "ak_lower_case_ok");
  assert.throws(() => setConnectorsKey(store, "ck_for_you_consumer_key"), /connectors_key_consumer/);
});

test("user id survives a locked update and stays stable across reads", () => {
  const path = tmpPath();
  const first = updateConnectorsStore((store) => store.userId, path);
  const second = readConnectorsStore(path).userId;
  assert.equal(first, second);
  assert.match(first, /^ub_[0-9a-f]{12}$/);
});

test("connected cache is deduped, sorted and slug-checked", () => {
  const store = emptyConnectorsStore();
  setConnectedToolkits(store, ["slack", "gmail", "slack", "Bad Slug", "github"]);
  assert.deepEqual(store.connectedToolkits, ["github", "gmail", "slack"]);
  assert.equal(isToolkitSlug("googlecalendar"), true);
  assert.equal(isToolkitSlug("GMAIL"), false);
  assert.equal(isToolkitSlug("a/b"), false);
});

test("parse rejects junk and heals partial records", () => {
  assert.throws(() => parseConnectorsStore(null), /connectors_format/);
  assert.throws(() => parseConnectorsStore({ schemaVersion: 2 }), /connectors_schema/);
  assert.throws(() => parseConnectorsStore({ schemaVersion: 1, userId: "nope" }), /connectors_user/);
  const healed = parseConnectorsStore({
    schemaVersion: 1,
    userId: "ub_0123456789ab",
    apiKey: "",
    sessionId: 42,
    connectedToolkits: ["gmail", 7, "x y"],
  });
  assert.equal(healed.apiKey, null);
  assert.equal(healed.sessionId, null);
  assert.deepEqual(healed.connectedToolkits, ["gmail"]);
});

test("a corrupt connectors file is set aside instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-conn-"));
  const path = join(dir, "connectors.json");
  writeFileSync(path, "{ torn", "utf8");
  const loaded = readConnectorsStore(path);
  assert.equal(loaded.apiKey, null);
  assert.equal(existsSync(path), false);
  const backup = readdirSync(dir).find((name: string) => name.includes(".invalid."));
  assert.equal(typeof backup, "string");
});

test("update rewrites only when something changed", () => {
  const path = tmpPath();
  writeConnectorsStore(emptyConnectorsStore(), path);
  const before = readFileSync(path, "utf8");
  updateConnectorsStore(() => undefined, path);
  assert.equal(readFileSync(path, "utf8"), before);
  updateConnectorsStore((store) => setConnectedToolkits(store, ["gmail"]), path);
  assert.notEqual(readFileSync(path, "utf8"), before);
  assert.equal(typeof readConnectorsStore(path).updatedAt, "string");
});

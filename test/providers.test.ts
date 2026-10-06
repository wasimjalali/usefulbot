import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CATALOG, providerMode } from "../shared/provider-catalog.ts";
import { applyReasoning, modelsFor, snapComposer } from "../shared/models.ts";
import {
  catalogItem,
  clearConnection,
  clearProviderKey,
  composerState,
  emptyProviderStore,
  last4,
  legacyProviders,
  parseProviderStore,
  pickComposerModel,
  publicProviders,
  readProviderStore,
  recordConnectionError,
  resolveUpstream,
  setActiveConnection,
  setActiveProvider,
  setComposer,
  setOAuthCredential,
  setProviderKey,
  setRole,
  updateProviderStore,
  writeProviderStore,
} from "../shared/providers.ts";
import { usageFromPayload, usageFromSseBlock } from "../shared/usage-parse.ts";

function keyed(id: string, key: string): ReturnType<typeof setProviderKey> {
  const [providerId, mode] = id.split(":");
  return setProviderKey(emptyProviderStore(), providerId!, mode as "api", key);
}

test("provider keys persist without leaking in public view", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-prov-")), "providers.json");
  let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
  store = setActiveConnection(store, "openai:api");
  writeProviderStore(store, path);
  const loaded = readProviderStore(path);
  assert.deepEqual(loaded.connections["openai:api"]?.credential, { kind: "key", key: "sk-test-abcdef1234" });
  const pub = publicProviders(loaded, {});
  const openai = pub.connections.find((item) => item.id === "openai:api");
  assert.equal(openai?.connected, true);
  assert.equal(openai?.last4, "1234");
  assert.equal(openai?.active, true);
  assert.equal(openai?.source, "settings");
  assert.equal(JSON.stringify(pub).includes("sk-test-abcdef1234"), false);
  store = clearConnection(loaded, "openai:api");
  assert.equal(store.connections["openai:api"], undefined);
  assert.equal(store.activeConnectionId, null);
});

test("a corrupt providers file is set aside instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-prov-"));
  const path = join(dir, "providers.json");
  writeFileSync(path, "{ torn", "utf8");
  const loaded = readProviderStore(path);
  assert.deepEqual(loaded.connections, {});
  assert.equal(existsSync(path), false);
  const backup = readdirSync(dir).find((name: string) => name.includes(".invalid."));
  assert.equal(typeof backup, "string");
});

test("a v1 file migrates in memory and writes back as v2", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-prov-"));
  const path = join(dir, "providers.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    activeProviderId: "openai",
    keys: {
      "openai": { key: "sk-openai-12345678", updatedAt: "2026-01-01T00:00:00.000Z" },
      "opencode-go": { key: "go-plan-key-12345678", updatedAt: "2026-01-01T00:00:00.000Z" },
      "bogus": { key: "nope-12345678", updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    selectedModel: null,
    effort: null,
    speed: "standard",
  }));
  const loaded = readProviderStore(path);
  assert.equal(loaded.schemaVersion, 2);
  assert.ok(loaded.connections["openai:api"]);
  // The opencode-go key maps to the plan connection, unknown ids are dropped.
  assert.ok(loaded.connections["opencode-go:plan"]);
  assert.equal(loaded.connections["bogus:api"], undefined);
  assert.equal(loaded.activeConnectionId, "openai:api");
  writeProviderStore(loaded, path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number };
  assert.equal(raw.schemaVersion, 2);
  const again = readProviderStore(path);
  assert.equal(again.activeConnectionId, "openai:api");
});

test("v1 migration clears an active provider with no key, except opencode-go on env", () => {
  const none = parseProviderStore({
    schemaVersion: 1,
    activeProviderId: "openrouter",
    keys: {},
    selectedModel: null,
    effort: null,
    speed: "standard",
  }, {});
  assert.equal(none.activeConnectionId, null);
  // The env key counts as an implicit opencode-go:plan connection.
  const implicit = parseProviderStore({
    schemaVersion: 1,
    activeProviderId: "opencode-go",
    keys: {},
    selectedModel: null,
    effort: null,
    speed: "standard",
  }, { UB_OPENCODE_GO_KEY: "go-env-key-12345678" });
  assert.equal(implicit.activeConnectionId, "opencode-go:plan");
  const bare = parseProviderStore({
    schemaVersion: 1,
    activeProviderId: "opencode-go",
    keys: {},
    selectedModel: null,
    effort: null,
    speed: "standard",
  }, {});
  assert.equal(bare.activeConnectionId, null);
  // The env connection resolves even though nothing is stored. The active
  // connection names it, so this is not a fallback.
  const resolved = resolveUpstream(implicit, "workhorse", { UB_OPENCODE_GO_KEY: "go-env-key-12345678" });
  assert.equal(resolved.key, "go-env-key-12345678");
  assert.equal(resolved.fallback, false);
  const pub = publicProviders(implicit, { UB_OPENCODE_GO_KEY: "go-env-key-12345678" });
  const go = pub.connections.find((item) => item.id === "opencode-go:plan");
  assert.equal(go?.source, "env");
  assert.equal(go?.active, true);
});

test("resolveUpstream prefers the active compatible provider", () => {
  let store = setProviderKey(emptyProviderStore(), "openrouter", "api", "or-key-12345678");
  store = setActiveConnection(store, "openrouter:api");
  const resolved = resolveUpstream(store, "workhorse", {});
  assert.equal(resolved.providerId, "openrouter");
  assert.equal(resolved.modelId, "openai/gpt-4.1-mini");
  assert.equal(resolved.model, resolved.modelId);
  assert.equal(resolved.opencodeSession, false);
  assert.equal(resolved.protocol, "openai-chat");
});

test("resolveUpstream prefers the stored key over the env key", () => {
  const store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "stored-key-12345678");
  const resolved = resolveUpstream(store, "workhorse", { UB_OPENCODE_GO_KEY: "go-env-key-12345678" });
  assert.equal(resolved.providerId, "opencode-go");
  assert.equal(resolved.key, "stored-key-12345678");
});

test("resolveUpstream falls back to OpenCode env when the active key is missing", () => {
  const resolved = resolveUpstream(emptyProviderStore(), "workhorse", { UB_OPENCODE_GO_KEY: "go-env-key" });
  assert.equal(resolved.providerId, "opencode-go");
  assert.equal(resolved.modelId, "glm-5.3-flash");
  assert.equal(resolved.fallback, true);
  assert.equal(last4("go-env-key"), "-key");
});

test("resolveUpstream throws when nothing usable exists", () => {
  assert.throws(() => resolveUpstream(emptyProviderStore(), "workhorse", {}), /upstream_credential_missing/);
});

test("reviewer role overrides the active connection, else it follows it", () => {
  let store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  store = setProviderKey(store, "deepseek", "api", "ds-key-12345678");
  store = setActiveConnection(store, "opencode-go:plan");
  const fallback = resolveUpstream(store, "reviewer", {});
  assert.equal(fallback.connection.id, "opencode-go:plan");
  assert.equal(fallback.modelId, "glm-5.3");
  const withRole = setRole(store, "reviewer", { connectionId: "deepseek:api", modelId: "deepseek-reasoner", effort: "high" });
  const picked = resolveUpstream(withRole, "reviewer", {});
  assert.equal(picked.connection.id, "deepseek:api");
  assert.equal(picked.modelId, "deepseek-reasoner");
  assert.equal(picked.effort, "high");
  // Clearing the connection drops the role pointing at it.
  const cleared = clearConnection(withRole, "deepseek:api");
  assert.equal(cleared.roles.reviewer, undefined);
  const after = resolveUpstream(cleared, "reviewer", {});
  assert.equal(after.connection.id, "opencode-go:plan");
});

test("oauth credentials, errors and local connections", () => {
  let store = setOAuthCredential(emptyProviderStore(), "github-copilot", {
    kind: "oauth",
    accessToken: "ghu-test-token-12345678",
    refreshToken: null,
    expiresAt: null,
    accountId: "1234",
  });
  assert.ok(store.connections["github-copilot:oauth"]);
  store = setActiveConnection(store, "github-copilot:oauth");
  const resolved = resolveUpstream(store, "workhorse", {});
  assert.equal(resolved.key, "ghu-test-token-12345678");
  assert.equal(resolved.protocol, "openai-chat");
  const errored = recordConnectionError(store, "github-copilot:oauth", "upstream_auth_failed");
  const pub = publicProviders(errored, {});
  assert.equal(pub.connections.find((item) => item.id === "github-copilot:oauth")?.status, "error");
  // Local mode connects with no key.
  const local = setProviderKey(emptyProviderStore(), "ollama", "local", null, { baseUrl: "http://localhost:11434/v1" });
  assert.equal(local.connections["ollama:local"]?.credential.kind, "none");
  const active = setActiveConnection(local, "ollama:local");
  assert.equal(active.activeConnectionId, "ollama:local");
  assert.throws(() => setProviderKey(emptyProviderStore(), "openai", "api", "short"), /provider_key/);
  assert.throws(() => setActiveConnection(emptyProviderStore(), "openai:api"), /connection_unknown/);
});

test("publicProviders groups the catalogue and mirrors the composer in roles", () => {
  const store = keyed("openai:api", "sk-test-abcdef1234");
  const pub = publicProviders(setActiveConnection(store, "openai:api"), {});
  const kinds = pub.catalog.map((item) => item.mode);
  assert.deepEqual(kinds.slice(0, 2), ["oauth", "oauth"]);
  assert.ok(kinds.indexOf("plan") < kinds.indexOf("api"));
  assert.ok(kinds.indexOf("api") < kinds.indexOf("local"));
  assert.equal(pub.catalog.length, pub.catalog.filter((item) => item.providerId).length);
  assert.equal(pub.connections.length, 1);
  assert.equal(pub.connections[0]?.icon, "openai");
  assert.equal(pub.catalog.find((item) => item.providerId === "openai" && item.mode === "api")?.icon, "openai");
  assert.equal(pub.roles.default.connectionIcon, "openai");
  assert.equal(pub.roles.reviewer.connectionIcon, "openai");
  assert.ok(pub.roles.default.models.every((item) => item.icon === "openai"));
  assert.equal(pub.roles.default.connectionId, "openai:api");
  assert.equal(pub.roles.default.modelId, "gpt-4.1-mini");
  assert.equal(pub.roles.reviewer.connectionId, "openai:api");
  assert.equal(pub.roles.reviewer.modelId, "gpt-4.1");
  assert.ok(pub.roles.default.models.length >= 2);
});

test("catalogue icons match provider ids and key URLs point at key pages", () => {
  for (const def of PROVIDER_CATALOG) {
    assert.equal(def.icon, def.id);
  }
  assert.equal(providerMode("anthropic", "api").keyUrl, "https://platform.claude.com/settings/keys");
  assert.equal(providerMode("alibaba", "plan").keyUrl, "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key");
  assert.equal(providerMode("alibaba", "api").keyUrl, "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key");
  assert.equal(providerMode("moonshot", "api").keyUrl, "https://platform.kimi.ai");
});

test("legacy shims keep old call shapes working", () => {
  let store = setProviderKey(emptyProviderStore(), "openai", "sk-test-abcdef1234");
  assert.ok(store.connections["openai:api"]);
  store = setActiveProvider(store, "openai");
  assert.equal(store.activeConnectionId, "openai:api");
  const item = catalogItem("openai:api");
  assert.equal(item.baseUrl, "https://api.openai.com/v1");
  assert.equal(item.models.workhorse, "gpt-4.1-mini");
  store = clearProviderKey(store, "openai");
  assert.equal(store.connections["openai:api"], undefined);
});

test("modelsFor falls back to catalogue defaults per connection", () => {
  const go = modelsFor("opencode-go:plan");
  assert.equal(go.some((item) => item.efforts.includes("max")), true);
  // Bare provider ids still resolve to their old static rows.
  assert.deepEqual(modelsFor("openai").map((item) => item.id), ["gpt-4.1-mini", "gpt-4.1"]);
  const deepseek = modelsFor("deepseek:api");
  assert.deepEqual(deepseek.map((item) => item.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(modelsFor("nope:api").length, 0);
});

test("composer groups list every connected connection, active first", () => {
  let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
  store = setProviderKey(store, "deepseek", "api", "ds-key-12345678");
  store = setActiveConnection(store, "deepseek:api");
  const state = composerState(store, {});
  assert.equal(state.models.length > 0, true);
  assert.deepEqual(state.groups.map((group) => group.connectionId), ["deepseek:api", "openai:api"]);
  const openai = state.groups.find((group) => group.connectionId === "openai:api");
  assert.equal(openai?.label, "OpenAI");
  assert.equal(openai?.icon, "openai");
  assert.ok(openai && openai.models.length >= 2);
  assert.ok(openai?.models.some((model) => model.id === "gpt-4.1-mini" && model.label));
  // The flat list still mirrors the active connection for the web.
  assert.deepEqual(state.models, state.groups[0]?.models);
  // Nothing connected, so no groups either.
  assert.deepEqual(composerState(emptyProviderStore(), {}).groups, []);
});

test("composer snaps effort to what the selected model supports", () => {
  const flash = snapComposer("opencode-go:plan", "OpenCode", "glm-5.3-flash", "max", "fast");
  assert.equal(flash.providerId, "opencode-go");
  assert.equal(flash.connectionId, "opencode-go:plan");
  assert.equal(flash.effort, "max");
  assert.equal(flash.effortLabel, "Max");
  assert.equal(flash.speed, "standard");
  assert.equal(flash.speeds.some((item) => item.id === "fast"), false);
  const openaiFast = snapComposer("openai:api", "OpenAI", "gpt-4.1-mini", null, "fast");
  assert.equal(openaiFast.speed, "fast");
  assert.equal(openaiFast.speeds.some((item) => item.id === "fast"), true);
  const openai = snapComposer("openai:api", "OpenAI", "gpt-4.1-mini", "high", "standard");
  assert.equal(openai.effort, null);
  assert.equal(openai.efforts.length, 0);
  // No active connection, so the composer is empty until one connects.
  const empty = composerState(emptyProviderStore());
  assert.equal(empty.modelId, "");
  const connected = setActiveConnection(
    setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678"),
    "opencode-go:plan",
  );
  const store = setComposer(connected, { modelId: "glm-5.3", effort: "max" });  const state = composerState(store);
  assert.equal(state.modelId, "glm-5.3");
  assert.equal(state.effort, "max");
});

test("applyReasoning maps through the catalogue", () => {
  const payload = applyReasoning("opencode-go", "max", "standard", { model: "glm-5.3" });
  assert.equal(payload.reasoning_effort, "max");
  // xhigh is above the Go ladder, so it maps to the nearest lower level.
  const mapped = applyReasoning("opencode-go", "xhigh", "standard", { model: "grok-4.6" });
  assert.equal(mapped.reasoning_effort, "high");
  const medium = applyReasoning("opencode-go", "medium", "standard", { model: "glm-5.3" });
  assert.equal(medium.reasoning_effort, "low");
  const openrouter = applyReasoning("openrouter", "high", "fast", { model: "openai/gpt-4.1-mini" });
  assert.deepEqual(openrouter.reasoning, { effort: "high" });
  assert.equal(openrouter.service_tier, "priority");
  const thinking = applyReasoning("anthropic", "high", "standard", { model: "x" });
  assert.deepEqual(thinking.thinking, { type: "enabled", budget_tokens: 16384 });
  const none = applyReasoning("github-copilot", "high", "standard", { model: "gpt-4.1" });
  assert.equal("reasoning_effort" in none, false);
  assert.equal("reasoning" in none, false);
  assert.equal("thinking" in none, false);
  assert.throws(() => applyReasoning("nope", "high", "standard", {}), /provider_unknown/);
});

test("usage parser reads completion and sse payloads", () => {
  assert.deepEqual(usageFromPayload({
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  }), { inputTokens: 11, outputTokens: 4 });
  assert.equal(usageFromPayload({ id: "x" }), null);
  assert.deepEqual(usageFromSseBlock("data: {\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}\n"), {
    inputTokens: 3,
    outputTokens: 2,
  });
  // A usage-less data line before the usage line must not end the scan.
  assert.deepEqual(
    usageFromSseBlock("data: {\"foo\":1}\n\ndata: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}"),
    { inputTokens: 10, outputTokens: 5 },
  );
  // Malformed JSON before a valid usage line is skipped, not fatal.
  assert.deepEqual(
    usageFromSseBlock("data: {oops\ndata: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}"),
    { inputTokens: 7, outputTokens: 2 },
  );
  assert.equal(usageFromPayload({ usage: { prompt_tokens: 1.5, completion_tokens: 2 } }), null);
  assert.equal(usageFromPayload({ usage: { prompt_tokens: 1e12, completion_tokens: 2 } }), null);
});

test("a custom provider's secret field becomes the credential and never a public field", () => {
  const store = setProviderKey(emptyProviderStore(), "custom", "local", null, {
    name: "Lab box",
    baseUrl: "http://10.0.0.5:8000/v1",
    key: "sk-lab-secret-123456",
  });
  const conn = store.connections["custom:local"];
  assert.equal(conn?.credential.kind, "key");
  assert.equal(conn?.fields.key, undefined);
  const pub = publicProviders(store);
  assert.equal(JSON.stringify(pub).includes("sk-lab-secret"), false);
  assert.equal(pub.connections[0]?.last4, "3456");
  // No key at all is still a valid local connection.
  const bare = setProviderKey(emptyProviderStore(), "custom", "local", null, { name: "Box", baseUrl: "http://localhost:8000/v1" });
  assert.equal(bare.connections["custom:local"]?.credential.kind, "none");
});

test("an edit without a key keeps the stored credential", () => {
  let store = setProviderKey(emptyProviderStore(), "custom", "local", null, {
    name: "Lab box",
    baseUrl: "http://10.0.0.5:8000/v1",
    key: "sk-lab-secret-123456",
  });
  store = setProviderKey(store, "custom", "local", null, { name: "Lab box 2", baseUrl: "http://10.0.0.5:8000/v1" });
  const conn = store.connections["custom:local"];
  assert.equal(conn?.fields.name, "Lab box 2");
  assert.equal(conn?.credential.kind, "key");
});

test("the env Go connection stays active across a write and read", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-prov-")), "providers.json");
  const env = { UB_OPENCODE_GO_KEY: "go-env-key-12345678" } as NodeJS.ProcessEnv;
  const store = { ...emptyProviderStore(), activeConnectionId: "opencode-go:plan" };
  writeProviderStore(store, path);
  const loaded = readProviderStore(path, env);
  assert.equal(loaded.activeConnectionId, "opencode-go:plan");
  const composer = composerState(loaded, env);
  assert.equal(composer.connectionId, "opencode-go:plan");
  assert.notEqual(composer.modelId, "");
  assert.equal(readProviderStore(path, {} as NodeJS.ProcessEnv).activeConnectionId, null);
});

test("updateProviderStore applies the change under the lock and releases it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-prov-"));
  const path = join(dir, "providers.json");
  const next = updateProviderStore((store) => setProviderKey(store, "openai", "api", "sk-test-abcdef1234"), path);
  assert.equal(next.connections["openai:api"]?.credential.kind, "key");
  assert.equal(readProviderStore(path).connections["openai:api"]?.credential.kind, "key");
  assert.equal(existsSync(`${path}.lock`), false);
  // A stale lock from a crashed writer is taken over.
  mkdirSync(`${path}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  updateProviderStore((store) => store, path);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("the env Go connection can be activated and assigned a role", () => {
  const env = { UB_OPENCODE_GO_KEY: "go-env-key-12345678" } as NodeJS.ProcessEnv;
  let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
  store = setActiveConnection(store, "openai:api");
  store = setActiveConnection(store, "opencode-go:plan", env);
  assert.equal(store.activeConnectionId, "opencode-go:plan");
  assert.equal(store.connections["opencode-go:plan"]?.credential.kind, "key");
  store = setRole(store, "reviewer", { connectionId: "opencode-go:plan", modelId: "glm-5.3", effort: "high" }, env);
  assert.equal(store.roles.reviewer?.connectionId, "opencode-go:plan");
  assert.throws(() => setActiveConnection(emptyProviderStore(), "opencode-go:plan", {} as NodeJS.ProcessEnv), /connection_unknown/);
});

test("legacy rows keep one row per vendor and leave sign-ins out", () => {
  let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
  store = setOAuthCredential(store, "openai", { kind: "oauth", accessToken: "acc", refreshToken: null, expiresAt: null, accountId: null });
  const rows = legacyProviders(store, {} as NodeJS.ProcessEnv).filter((row) => row.connected);
  assert.deepEqual(rows.map((row) => row.id), ["openai"]);
});

test("a local server's collected URL is the base URL the router calls", () => {
  const env = {} as NodeJS.ProcessEnv;
  let store = setProviderKey(emptyProviderStore(), "lmstudio", "local", null, { baseUrl: "http://10.0.0.7:1234/v1" });
  store = setActiveConnection(store, "lmstudio:local", env);
  const resolved = resolveUpstream(store, "workhorse", env);
  assert.equal(resolved.baseUrl, "http://10.0.0.7:1234/v1");
  assert.equal(resolved.connection.id, "lmstudio:local");
});

test("legacy rows keep one row per vendor, the active one", () => {
  let store = setProviderKey(emptyProviderStore(), "zai", "plan", "plan-key-abcdef1234");
  store = setProviderKey(store, "zai", "api", "api-key-abcdef5678");
  store = setActiveConnection(store, "zai:api", {} as NodeJS.ProcessEnv);
  const rows = legacyProviders(store, {} as NodeJS.ProcessEnv).filter((row) => row.connected);
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.last4]), [["zai", "api", "5678"]]);
});

test("legacy rows list every keyable vendor so the old web pane can still connect", () => {
  const rows = legacyProviders(emptyProviderStore(), {} as NodeJS.ProcessEnv);
  const ids = rows.map((row) => row.id as string);
  assert.ok(ids.includes("openai") && ids.includes("anthropic") && ids.includes("opencode-go") && ids.includes("deepseek"));
  assert.equal(ids.includes("github-copilot"), false);
  assert.equal(ids.includes("custom"), false);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(rows.find((row) => row.id === "opencode-go")?.kind, "coding-plan");
  assert.equal(rows.find((row) => row.id === "openai")?.connected, false);
});

test("the router follows the picked model's connection across three providers, turn after turn", () => {
  // Three connections at once: a Go plan key, a ChatGPT sign-in and a DeepSeek
  // key. Whatever was active before, the turn after a pick goes to the picked
  // model's own connection with that connection's credential.
  const env = {} as NodeJS.ProcessEnv;
  let store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  store = setProviderKey(store, "deepseek", "api", "ds-key-12345678");
  store = setOAuthCredential(store, "openai", {
    kind: "oauth",
    accessToken: "chatgpt-access",
    refreshToken: "chatgpt-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: null,
    clientId: "oaiapp_123",
  });
  store = setActiveConnection(store, "opencode-go:plan", env);

  const picks: Array<[string, string, string, string]> = [
    // pick, provider, protocol, model the router sends
    ["openai:oauth::gpt-6-astra", "openai", "openai-responses", "gpt-6-astra"],
    ["opencode-go:plan::glm-5.3", "opencode-go", "openai-chat", "glm-5.3"],
    ["deepseek:api::deepseek-v4-flash", "deepseek", "openai-chat", "deepseek-v4-flash"],
    ["openai:oauth::gpt-5.6-luna", "openai", "openai-responses", "gpt-5.6-luna"],
    ["opencode-go:plan::glm-5.3-flash", "opencode-go", "openai-chat", "glm-5.3-flash"],
  ];
  for (const [pick, providerId, protocol, modelId] of picks) {
    store = pickComposerModel(store, pick, env);
    const resolved = resolveUpstream(store, "workhorse", env);
    assert.equal(resolved.connection.id, pick.split("::")[0], pick);
    assert.equal(resolved.providerId, providerId, pick);
    assert.equal(resolved.protocol, protocol, pick);
    assert.equal(resolved.modelId, modelId, pick);
    assert.equal(resolved.fallback, false, pick);
    assert.equal(resolved.credential, store.connections[resolved.connection.id]!.credential, pick);
  }
  // The ChatGPT turn carries the sign-in's token and issued client, at the public Responses base URL.
  store = pickComposerModel(store, "openai:oauth::gpt-6-astra", env);
  const chatgpt = resolveUpstream(store, "workhorse", env);
  assert.equal(chatgpt.baseUrl, "https://api.openai.com/v1");
  assert.equal(chatgpt.keyHeader, "bearer");
  assert.equal(chatgpt.credential.kind, "oauth");
  assert.equal(chatgpt.credential.kind === "oauth" ? chatgpt.credential.clientId : null, "oaiapp_123");
  assert.equal(chatgpt.opencodeSession, false);
  // A bare model id keeps the connection.
  store = pickComposerModel(store, "gpt-5.6-luna", env);
  assert.equal(store.activeConnectionId, "openai:oauth");
  assert.equal(resolveUpstream(store, "workhorse", env).modelId, "gpt-5.6-luna");
  // A pick on a connection that is not signed in is refused, not silently rerouted.
  assert.throws(() => pickComposerModel(store, "anthropic:api::claude-sonnet-4", env), /connection_unknown/);
  assert.throws(() => pickComposerModel(store, "nonsense::x", env), /provider_unknown|connection_unknown/);
});

test("two bots on different providers do not share a credential mid-flight", () => {
  // Each router call resolves from the store as it stands when the call
  // starts; a pick for one bot between two calls changes only later calls.
  const env = {} as NodeJS.ProcessEnv;
  let store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  store = setOAuthCredential(store, "openai", { kind: "oauth", accessToken: "chatgpt-access", refreshToken: null, expiresAt: null, accountId: "acct_1" });
  store = pickComposerModel(store, "opencode-go:plan::glm-5.3-flash", env);
  const botA = resolveUpstream(store, "workhorse", env);
  store = pickComposerModel(store, "openai:oauth::gpt-6-astra", env);
  const botB = resolveUpstream(store, "workhorse", env);
  assert.equal(botA.providerId, "opencode-go");
  assert.equal(botA.key, "go-key-12345678");
  assert.equal(botB.providerId, "openai");
  assert.equal(botB.credential.kind, "oauth");
  assert.notEqual(botA.baseUrl, botB.baseUrl);
});

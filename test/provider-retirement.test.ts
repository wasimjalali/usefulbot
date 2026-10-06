import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CATALOG, providerMode, retiredRouteMessage } from "../shared/provider-catalog.ts";
import {
  applyBotPick,
  botComposerState,
  clearConnection,
  effectiveDefault,
  parseProviderStore,
  pickComposerModel,
  ProviderRouteRetiredError,
  publicProviders,
  readProviderStore,
  resolveUpstream,
  selectionAvailability,
  setActiveConnection,
  setOAuthCredential,
  setRole,
  setProviderKey,
  emptyProviderStore,
} from "../shared/providers.ts";
import type { ModelSelection } from "../shared/session-selection.ts";
import { readShell, updateShell } from "../shared/shell-io.ts";
import { withBotSelection } from "../shared/shell-store.ts";
import { modelSelectionRefusal } from "../web/lib/agent-exec.ts";
import { applyProvidersDelete, applyProvidersPut, oauthStartRetired, oauthStartVerdict } from "../web/lib/providers-write.ts";
import { dropLegacyDeviceFlowFile } from "../shared/provider-oauth.ts";
import { statePath } from "../shared/stack.ts";

// Ways UB-015 can fail, written before the code:
// 1. a retired route still shows in the Connect list or a picker;
// 2. a stored connection of a retired route crashes the store read, or vanishes silently;
// 3. a turn on it falls back to another model or the env key instead of saying why;
// 4. the global chat connection stays on it, so the composer keeps sending there;
// 5. a bot pinned to it keeps its pin and a generic error;
// 6. it can't be removed, or its credential stays in the file after removal;
// 7. a new key or sign-in can still be stored on it, or its models are listed with the vendor;
// 8. Command Code keeps the wrong base URL or hint; the Kimi call loses our own user-agent.

const RETIRED = [
  { id: "github-copilot:oauth", providerId: "github-copilot", mode: "oauth", credential: { kind: "oauth", accessToken: "ghu-secret-token-1234", refreshToken: null, expiresAt: null, accountId: null }, text: /Copilot sign-in/ },
  { id: "zai:plan", providerId: "zai", mode: "plan", credential: { kind: "key", key: "zai-plan-secret-1234" }, text: /GLM Coding Plan.*Z\.ai API key/ },
  { id: "alibaba:plan", providerId: "alibaba", mode: "plan", credential: { kind: "key", key: "qwen-plan-secret-1234" }, text: /Qwen Coding Plan.*DashScope/ },
] as const;

const GO = "opencode-go:plan";

function stored(id: string, providerId: string, mode: string, credential: unknown) {
  return { id, providerId, mode, credential, fields: {}, updatedAt: new Date().toISOString(), lastError: null };
}

/** A providers file with a Go plan key plus all three retired connections, the first retired one active. */
function raw(active: string | null = RETIRED[1].id): Record<string, unknown> {
  const connections: Record<string, unknown> = {
    [GO]: stored(GO, "opencode-go", "plan", { kind: "key", key: "go-key-12345678" }),
  };
  for (const row of RETIRED) connections[row.id] = stored(row.id, row.providerId, row.mode, row.credential);
  return {
    schemaVersion: 2,
    connections,
    activeConnectionId: active,
    selectedModel: "glm-5.3",
    effort: null,
    speed: "standard",
    roles: {
      reviewer: { connectionId: "zai:plan", modelId: "glm-5.3", effort: null },
      image: { connectionId: "alibaba:plan", modelId: "x", effort: null },
    },
  };
}

function withWorld<T>(fn: (world: { providers: string; shell: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ub-retired-"));
  const keys = ["UB_PROVIDERS_PATH", "UB_MODELS_CACHE_PATH", "UB_SHELL_PATH", "UB_OPENCODE_GO_KEY", "UB_ACTIVE_BOT_ID"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const providers = join(dir, "providers.json");
  const shell = join(dir, "shell.json");
  process.env.UB_PROVIDERS_PATH = providers;
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  process.env.UB_SHELL_PATH = shell;
  delete process.env.UB_OPENCODE_GO_KEY;
  delete process.env.UB_ACTIVE_BOT_ID;
  writeFileSync(providers, JSON.stringify(raw()));
  const restore = () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  let result: T;
  try {
    result = fn({ providers, shell });
  } catch (error) {
    restore();
    throw error;
  }
  // An async body keeps the temp stores until it settles.
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

test("retired routes are absent from the Connect catalogue, and the live ones stay", () => {
  const store = parseProviderStore(raw(null), {});
  const catalog = publicProviders(store, {}).catalog.map((item) => `${item.providerId}:${item.mode}`);
  for (const row of RETIRED) assert.equal(catalog.includes(row.id), false, row.id);
  for (const keep of ["zai:api", "alibaba:api", "moonshot:plan", "xiaomi:plan", "minimax:plan", "opencode-go:plan", "command-code:plan", "openai:oauth"]) {
    assert.ok(catalog.includes(keep), keep);
  }
  assert.equal(PROVIDER_CATALOG.some((def) => def.id === "github-copilot" && def.modes.some((mode) => !mode.retired)), false);
});

test("a stored connection of each retired route shows as retired with its own message, and no models", () => {
  const store = parseProviderStore(raw(null), {});
  const pub = publicProviders(store, {});
  assert.deepEqual(pub.connections.map((conn) => conn.id), [GO], "only usable connections are listed as connections");
  assert.equal(pub.retired.length, 3);
  for (const row of RETIRED) {
    const shown = pub.retired.find((conn) => conn.id === row.id);
    assert.ok(shown, row.id);
    assert.equal(shown.status, "retired");
    assert.equal(shown.lastError, retiredRouteMessage(row.id));
    assert.match(shown.lastError ?? "", row.text);
    assert.deepEqual(shown.models, []);
    assert.equal(shown.active, false);
  }
  // No em dash in what the owner reads.
  for (const row of RETIRED) assert.equal((retiredRouteMessage(row.id) ?? "").includes("—"), false);
});

test("loading a store keeps a retired active connection, its model and its roles: nothing moves behind the owner's back", () => {
  const store = parseProviderStore(raw(), {});
  assert.equal(store.activeConnectionId, "zai:plan");
  assert.equal(store.selectedModel, "glm-5.3");
  assert.equal(store.roles.reviewer?.connectionId, "zai:plan");
  assert.equal(store.roles.image?.connectionId, "alibaba:plan");
  assert.equal(Object.keys(store.connections).length, 4, "the retired connections are kept to be shown and removed");
  // Nothing runs on it, and nothing else answers in its place.
  assert.equal(effectiveDefault(store, {}), null);
  assert.equal(publicProviders(store, {}).connections.some((conn) => conn.active), false);
  // Removing it (an explicit act) is what moves the default.
  assert.equal(clearConnection(store, "zai:plan").activeConnectionId, GO);
});

// The owner's own store, read back from disk. A retired chat connection used
// to be rewritten at parse time to the next connection, or to the env Go key
// (UB_OPENCODE_GO_KEY, loaded from Keychain), or a paid openai:api key, and the
// owner never saw the sentence.
test("a retired chat connection read from disk answers its sentence, with the env Go key set and with openai:api stored", async () => {
  await withWorld(async ({ providers }) => {
    const sentence = retiredRouteMessage("zai:plan");
    const file = raw();
    (file.connections as Record<string, unknown>)["openai:api"] = stored("openai:api", "openai", "api", { kind: "key", key: "sk-paid-key-12345678" });
    writeFileSync(providers, JSON.stringify(file));
    process.env.UB_OPENCODE_GO_KEY = "env-go-key-12345678";
    const env = { UB_OPENCODE_GO_KEY: "env-go-key-12345678" };
    const store = readProviderStore();
    assert.equal(store.activeConnectionId, "zai:plan");
    for (const alias of ["workhorse", "reviewer", "image"] as const) {
      assert.throws(() => resolveUpstream(store, alias, env), (error: unknown) => (
        error instanceof ProviderRouteRetiredError && error.message === (alias === "image" ? retiredRouteMessage("alibaba:plan") : sentence)
      ), alias);
    }
    // A bot with no model of its own follows the default and is refused before eve with the sentence.
    const refusal = modelSelectionRefusal(readShell().bots[0], store);
    assert.ok(refusal);
    assert.equal(refusal.status, 409);
    const body = await refusal.json() as { error: string; message: string };
    assert.equal(body.error, "provider_route_retired");
    assert.equal(body.message, sentence);
  });
});

test("a saved reviewer or image role on a retired route is refused with its sentence, even while the chat connection is live", () => {
  const live = raw(GO);
  const store = parseProviderStore(live, {});
  assert.equal(store.activeConnectionId, GO);
  const env = { UB_OPENCODE_GO_KEY: "env-go-key-12345678" };
  for (const alias of ["reviewer", "image"] as const) {
    assert.throws(() => resolveUpstream(store, alias, env), (error: unknown) => (
      error instanceof ProviderRouteRetiredError && error.message === retiredRouteMessage(alias === "reviewer" ? "zai:plan" : "alibaba:plan")
    ), alias);
  }
  assert.equal(resolveUpstream(store, "workhorse", env).providerId, "opencode-go");
});

test("a role write, an active pick and a model pick on a retired route are refused with the retired error", () => {
  const store = parseProviderStore(raw(GO), {});
  for (const row of RETIRED) {
    assert.throws(() => setRole(store, "reviewer", { connectionId: row.id, modelId: "x", effort: null }), ProviderRouteRetiredError, row.id);
    assert.throws(() => setRole(store, "image", { connectionId: row.id, modelId: "x", effort: null }), ProviderRouteRetiredError, row.id);
    assert.throws(() => setActiveConnection(store, row.id), ProviderRouteRetiredError, row.id);
    assert.throws(() => pickComposerModel(store, `${row.id}::x`, {}), ProviderRouteRetiredError, row.id);
  }
  withWorld(() => {
    assert.throws(() => applyProvidersPut({ roles: { reviewer: { connectionId: "zai:plan", modelId: "glm-5.3", effort: null } } }), ProviderRouteRetiredError);
    assert.throws(() => applyProvidersPut({ activeConnectionId: "zai:plan" }), ProviderRouteRetiredError);
    assert.throws(() => applyProvidersPut({ modelId: "zai:plan::x" }), ProviderRouteRetiredError);
  });
});

test("the sign-in start route's check names a retired route and passes the live ones", () => {
  assert.equal(oauthStartRetired("github-copilot"), retiredRouteMessage("github-copilot:oauth"));
  assert.equal(oauthStartRetired("openai"), null);
  assert.equal(oauthStartRetired("not-a-provider"), null);
  assert.equal(oauthStartRetired(""), null);
});

test("the old pending device-flow file is removed once, a missing one is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-device-flow-"));
  const file = join(dir, "provider-oauth.json");
  writeFileSync(file, "{}");
  dropLegacyDeviceFlowFile(file);
  assert.equal(existsSync(file), false);
  dropLegacyDeviceFlowFile(file);
});

test("a turn on a retired route is refused with its own code and sentence, never substituted", () => {
  const store = parseProviderStore(raw(null), {});
  for (const row of RETIRED) {
    const pick: ModelSelection = { connectionId: row.id, modelId: "some-model", effort: null, speed: "standard" };
    assert.deepEqual(selectionAvailability(store, pick), { available: false, reason: "route_retired", message: retiredRouteMessage(row.id) });
    assert.throws(() => resolveUpstream(store, "workhorse", { UB_OPENCODE_GO_KEY: "env-key-12345678" }, pick), (error: unknown) => (
      error instanceof ProviderRouteRetiredError && error.code === "provider_route_retired" && error.message === retiredRouteMessage(row.id)
    ));
    assert.equal(botComposerState(store, pick).available, false);
    assert.throws(() => applyBotPick(store, pick, { effort: "high" }, {}), ProviderRouteRetiredError);
    assert.throws(() => setActiveConnection(store, row.id), ProviderRouteRetiredError);
  }
  // An in-memory store that still names a retired chat connection is refused too, not sent to the env key.
  const stale = { ...store, activeConnectionId: "zai:plan" };
  assert.throws(() => resolveUpstream(stale, "workhorse", { UB_OPENCODE_GO_KEY: "env-key-12345678" }), ProviderRouteRetiredError);
  assert.equal(effectiveDefault(parseProviderStore(raw(GO), {}), {})?.connectionId, GO);
});

test("a retired route takes no new key or sign-in", () => {
  assert.throws(() => setProviderKey(emptyProviderStore(), "zai", "plan", "zai-new-key-12345678"), ProviderRouteRetiredError);
  assert.throws(() => setProviderKey(emptyProviderStore(), "alibaba", "plan", "qwen-new-key-12345678"), ProviderRouteRetiredError);
  assert.throws(() => setOAuthCredential(emptyProviderStore(), "github-copilot", RETIRED[0].credential), ProviderRouteRetiredError);
  // The api routes next to them still connect.
  assert.ok(setProviderKey(emptyProviderStore(), "zai", "api", "zai-api-key-12345678").connections["zai:api"]);
  assert.ok(setProviderKey(emptyProviderStore(), "alibaba", "api", "qwen-api-key-12345678").connections["alibaba:api"]);
});

test("removing a retired connection works and its credential leaves the file", () => {
  withWorld(({ providers }) => {
    for (const row of RETIRED) {
      assert.ok(readFileSync(providers, "utf8").includes(row.id));
      const after = applyProvidersDelete({ connectionId: row.id });
      assert.equal(after.connections[row.id], undefined);
      const text = readFileSync(providers, "utf8");
      const secret = row.credential.kind === "key" ? row.credential.key : row.credential.accessToken;
      assert.equal(text.includes(secret), false, `${row.id} credential gone from disk`);
    }
    assert.deepEqual(Object.keys(readProviderStore().connections), [GO]);
  });
  // clearConnection alone, on a store that still holds the three.
  const cleared = clearConnection(parseProviderStore(raw(null), {}), "zai:plan");
  assert.equal(cleared.connections["zai:plan"], undefined);
});

test("a bot pinned to a retired route is refused before eve with the route's own message, and removing it resets the pin", async () => {
  await withWorld(async () => {
    const bot = readShell().bots[0];
    const pick: ModelSelection = { connectionId: "alibaba:plan", modelId: "qwen3.7-max", effort: null, speed: "standard" };
    updateShell((current) => withBotSelection(current, bot.id, pick));
    const pinned = readShell().bots[0];
    const refusal = modelSelectionRefusal(pinned, readProviderStore());
    assert.ok(refusal);
    assert.equal(refusal.status, 409);
    const body = await refusal.json() as { error: string; message: string };
    assert.equal(body.error, "provider_route_retired");
    assert.equal(body.message, retiredRouteMessage("alibaba:plan"));
    // Removing the connection resets the pin to inherit the default. The default itself
    // is on a retired route here, so removing that one too is what lets the bot run again.
    applyProvidersDelete({ connectionId: "alibaba:plan" });
    applyProvidersDelete({ connectionId: "zai:plan" });
    assert.equal(readShell().bots[0].model, null);
    assert.equal(modelSelectionRefusal(readShell().bots[0], readProviderStore()), null);
  });
});

test("the PUT route's writer refuses a key for a retired route with the retired error", () => {
  withWorld(() => {
    assert.throws(() => applyProvidersPut({ providerId: "zai", mode: "plan", key: "zai-new-key-12345678" }), ProviderRouteRetiredError);
  });
});

test("Command Code uses the documented provider base URL and says the Go plan has no API", () => {
  const mode = providerMode("command-code", "plan");
  assert.equal(mode.baseUrl, "https://api.commandcode.ai/provider/v1");
  assert.equal(mode.listsModels, true, "docs: GET /provider/v1/models");
  assert.equal(mode.hint, "Command Code key (every plan except Go).");
});

// Round 2, item 1: removing ANOTHER connection used to repoint a retired chat
// connection to the first connected one (a paid openai:api key, or the env Go key).
test("removing an unrelated connection keeps a retired chat connection, so turns still answer the sentence", async () => {
  await withWorld(async ({ providers }) => {
    const file = raw();
    (file.connections as Record<string, unknown>)["openai:api"] = stored("openai:api", "openai", "api", { kind: "key", key: "sk-paid-key-12345678" });
    writeFileSync(providers, JSON.stringify(file));
    process.env.UB_OPENCODE_GO_KEY = "env-go-key-12345678";
    const env = { UB_OPENCODE_GO_KEY: "env-go-key-12345678" };
    const after = applyProvidersDelete({ connectionId: "alibaba:plan" });
    assert.equal(after.activeConnectionId, "zai:plan", "the retired default stays until it is itself removed");
    const store = readProviderStore();
    assert.equal(store.activeConnectionId, "zai:plan");
    assert.throws(() => resolveUpstream(store, "workhorse", env), (error: unknown) => (
      error instanceof ProviderRouteRetiredError && error.message === retiredRouteMessage("zai:plan")
    ));
    const refusal = modelSelectionRefusal(readShell().bots[0], store);
    assert.ok(refusal);
    assert.equal(refusal.status, 409);
    // Removing the retired one itself repoints, as before.
    assert.equal(clearConnection(store, "zai:plan").activeConnectionId, GO);
  });
});

// Round 2, item 3: the Providers pane must say what the router will do.
test("a saved reviewer role on a retired route is reported unavailable with its sentence, and resolveUpstream agrees", () => {
  const store = parseProviderStore(raw(GO), {});
  const env = { UB_OPENCODE_GO_KEY: "env-go-key-12345678" };
  const reviewer = publicProviders(store, env).roles.reviewer;
  assert.equal(reviewer.connectionId, "zai:plan");
  assert.equal(reviewer.modelId, "glm-5.3");
  assert.equal(reviewer.unavailable, retiredRouteMessage("zai:plan"));
  assert.throws(() => resolveUpstream(store, "reviewer", env), (error: unknown) => (
    error instanceof ProviderRouteRetiredError && error.message === reviewer.unavailable
  ));
  // A live reviewer role, and the follow-the-default case, carry no message.
  const live = parseProviderStore({ ...raw(GO), roles: {} }, {});
  assert.equal(publicProviders(live, env).roles.reviewer.unavailable ?? null, null);
  assert.equal(resolveUpstream(live, "reviewer", env).providerId, "opencode-go");
});

// Round 3, item 2: the image role says the same thing the router will.
test("a saved image role on a retired route is reported unavailable with its sentence, and resolveUpstream agrees", () => {
  const store = parseProviderStore(raw(GO), {});
  const env = { UB_OPENCODE_GO_KEY: "env-go-key-12345678" };
  const image = publicProviders(store, env).roles.image;
  assert.equal(image.connectionId, "alibaba:plan");
  assert.equal(image.unavailable, retiredRouteMessage("alibaba:plan"));
  assert.throws(() => resolveUpstream(store, "image", env), (error: unknown) => (
    error instanceof ProviderRouteRetiredError && error.message === image.unavailable
  ));
  const live = parseProviderStore({ ...raw(GO), roles: {} }, {});
  assert.equal(publicProviders(live, env).roles.image.unavailable ?? null, null);
});

// Round 2, item 4: bots pinned to the route and the reviewer role stay refused until the old connection goes.
test("the Z.ai and Alibaba retired sentences also say to disconnect the old connection", () => {
  for (const id of ["zai:plan", "alibaba:plan"]) {
    const text = retiredRouteMessage(id) ?? "";
    assert.match(text, /then disconnect this one\.$/, id);
    assert.equal(text.includes("—"), false);
  }
});

// Round 2, item 5, as behaviour (round 3, item 5): what the sign-in start route answers before it starts anything.
test("the sign-in start verdict is 409 with the sentence for a retired route, 400 for an unknown provider, and proceeds for openai", () => {
  assert.deepEqual(oauthStartVerdict("github-copilot"), {
    status: 409,
    error: "provider_route_retired",
    message: retiredRouteMessage("github-copilot:oauth"),
  });
  assert.deepEqual(oauthStartVerdict("not-a-provider"), { status: 400, error: "provider_unknown" });
  assert.deepEqual(oauthStartVerdict(""), { status: 400, error: "provider_unknown" });
  assert.deepEqual(oauthStartVerdict("openai"), { status: 200 });
  // A live provider with no sign-in entry is still the generic refusal.
  assert.deepEqual(oauthStartVerdict("anthropic"), { status: 400, error: "provider_mode_unknown" });
});

test("the old pending device-flow file is removed from its default state location", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-device-flow-default-"));
  const saved = process.env.UB_STATE_ROOT;
  process.env.UB_STATE_ROOT = dir;
  try {
    const file = statePath("provider-oauth.json");
    assert.equal(file, join(dir, "provider-oauth.json"));
    writeFileSync(file, "{}");
    dropLegacyDeviceFlowFile();
    assert.equal(existsSync(file), false);
    dropLegacyDeviceFlowFile();
  } finally {
    if (saved === undefined) delete process.env.UB_STATE_ROOT;
    else process.env.UB_STATE_ROOT = saved;
  }
});

// Round 2, item 6: the cleanup is housekeeping, so a missing agent credential must not skip it.
test("the tick runs the legacy device-flow cleanup before the agent-credential gate", () => {
  const source = readFileSync(new URL("../web/app/api/agent/tick/route.ts", import.meta.url), "utf8");
  const post = source.slice(source.indexOf("export async function POST"));
  const dropAt = post.indexOf("dropLegacyDeviceFlowFile()");
  const gateAt = post.indexOf("agent_credential_missing");
  assert.ok(dropAt > 0 && gateAt > 0 && dropAt < gateAt);
});

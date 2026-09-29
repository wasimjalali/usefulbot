import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentWindowTokens } from "../agent/lib/model-window.ts";
import { POLICY_WINDOW_TOKENS } from "../shared/policy.ts";

function withStores(fn: () => void, options: { model: string; cacheRows?: unknown[] }): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-window-"));
  const providers = join(dir, "providers.json");
  const cache = join(dir, "models-cache.json");
  writeFileSync(providers, JSON.stringify({
    schemaVersion: 2,
    connections: {
      "opencode-go:plan": {
        id: "opencode-go:plan",
        providerId: "opencode-go",
        mode: "plan",
        credential: { kind: "key", key: "test-upstream-key" },
        fields: {},
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
    },
    activeConnectionId: "opencode-go:plan",
    selectedModel: options.model,
    effort: null,
    speed: "standard",
    roles: {},
  }));
  if (options.cacheRows) {
    writeFileSync(cache, JSON.stringify({
      schemaVersion: 3,
      providers: { "opencode-go:plan": { fetchedAt: Date.now(), models: options.cacheRows } },
    }));
  }
  const previous = { providers: process.env.UB_PROVIDERS_PATH, cache: process.env.UB_MODELS_CACHE_PATH };
  process.env.UB_PROVIDERS_PATH = providers;
  process.env.UB_MODELS_CACHE_PATH = cache;
  try {
    fn();
  } finally {
    if (previous.providers === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = previous.providers;
    if (previous.cache === undefined) delete process.env.UB_MODELS_CACHE_PATH;
    else process.env.UB_MODELS_CACHE_PATH = previous.cache;
  }
}

const rows = [
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash", efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens: 1_000_000, inputs: ["text", "image"] },
  { id: "glm-5", label: "GLM 5", efforts: ["low"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens: 202_752, inputs: ["text"] },
  { id: "mystery-1", label: "Mystery", efforts: [], defaultEffort: null, speeds: ["standard"], defaultSpeed: "standard" },
];

test("the agent reports the selected model's window from the catalog", () => {
  withStores(() => assert.equal(currentWindowTokens(), 1_000_000), { model: "glm-5.3-flash", cacheRows: rows });
  withStores(() => assert.equal(currentWindowTokens(), 202_752), { model: "glm-5", cacheRows: rows });
});

test("the window falls back to the policy value when the catalog cannot say", () => {
  withStores(() => assert.equal(currentWindowTokens(), POLICY_WINDOW_TOKENS), { model: "mystery-1", cacheRows: rows });
  // No cache at all: the built-in list has no window on it either.
  withStores(() => assert.equal(currentWindowTokens(), POLICY_WINDOW_TOKENS), { model: "glm-5.3-flash" });
});

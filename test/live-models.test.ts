import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODELS_DEV_URL,
  catalogFor,
  fetchProviderModelIds,
  keyRejected,
  parseModelList,
  parseModelsDev,
  readModelsCache,
  refreshProviderModels,
  writeModelsCache,
} from "../shared/live-models.ts";
import { providerMode } from "../shared/provider-catalog.ts";
import { hydrateModel, inferCapabilities, mergeLiveModels, modelSeesImages, snapComposer } from "../shared/models.ts";

test("parseModelList reads OpenAI list envelopes", () => {
  assert.deepEqual(parseModelList({
    object: "list",
    data: [{ id: "glm-5.3-flash" }, { id: "kimi-k3" }, { id: "text-embedding-3-small" }],
  }), ["glm-5.3-flash", "kimi-k3"]);
});

test("live OpenCode IDs hydrate efforts instead of staying on the two-model fallback", () => {
  const models = mergeLiveModels("opencode-go:plan", ["kimi-k3", "glm-5.3-flash", "grok-4.6"]);
  assert.equal(models[0]?.id, "glm-5.3-flash");
  assert.equal(models.some((item) => item.id === "kimi-k3"), true);
  assert.deepEqual(hydrateModel("opencode-go:plan", "kimi-k3").efforts, ["low", "high", "max"]);
  assert.deepEqual(inferCapabilities("grok-4.6").efforts, ["low", "medium", "high", "xhigh"]);
  const composer = snapComposer("opencode-go:plan", "OpenCode", "kimi-k3", "max", "standard", models);
  assert.equal(composer.modelId, "kimi-k3");
  assert.equal(composer.models.length, 3);
  assert.equal(composer.effort, "max");
});

test("snapComposer leaves image-only models out of the chat flyout", () => {
  const models = mergeLiveModels("openai:api", ["dall-e-3", "gpt-5.6-sol"], {
    "dall-e-3": { outputs: ["image"] },
    "gpt-5.6-sol": { outputs: ["text"] },
  });
  const composer = snapComposer("openai:api", "OpenAI", "gpt-5.6-sol", null, "standard", models);
  assert.deepEqual(composer.models.map((item) => item.id), ["gpt-5.6-sol"]);
});

test("refreshProviderModels writes the fetched catalog to cache", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-")), "models-cache.json");
  const models = await refreshProviderModels({
    providerId: "opencode-go:plan",
    baseUrl: "https://opencode.ai/zen/go/v1",
    force: true,
    path,
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "glm-5.3-flash" }, { id: "minimax-m3" }, { id: "qwen3.8-flash" }],
    })),
  });
  assert.equal(models.length, 3);
  assert.equal(catalogFor("opencode-go:plan", path).some((item) => item.id === "minimax-m3"), true);
});

test("models.dev facts land on the live rows: context window and image input", async () => {
  const catalog = parseModelsDev({
    "opencode-go": {
      models: {
        "glm-5.3-flash": { limit: { context: 1_000_000, output: 131_072 }, modalities: { input: ["text", "image"], output: ["text"] } },
        "glm-5.3": { limit: { context: 1_000_000 }, modalities: { input: ["text"] } },
        "odd": { limit: { context: "big" } },
      },
    },
    junk: { models: "no" },
  });
  assert.deepEqual(catalog["opencode-go"]?.["glm-5.3-flash"], { contextTokens: 1_000_000, inputs: ["text", "image"], outputs: ["text"] });
  assert.equal(catalog["opencode-go"]?.odd, undefined);
  assert.equal(catalog.junk, undefined);

  const path = join(mkdtempSync(join(tmpdir(), "ub-models-")), "models-cache.json");
  const models = await refreshProviderModels({
    providerId: "opencode-go:plan",
    baseUrl: "https://opencode.ai/zen/go/v1",
    force: true,
    path,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === MODELS_DEV_URL) {
        return new Response(JSON.stringify({
          "opencode-go": {
            models: {
              "glm-5.3-flash": { limit: { context: 1_000_000 }, modalities: { input: ["text", "image"] } },
              "glm-5.3": { limit: { context: 1_000_000 }, modalities: { input: ["text"] } },
            },
          },
        }));
      }
      return new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }, { id: "glm-5.3" }, { id: "mystery-1" }] }));
    },
  });
  const flash = models.find((item) => item.id === "glm-5.3-flash");
  const plain = models.find((item) => item.id === "glm-5.3");
  const mystery = models.find((item) => item.id === "mystery-1");
  assert.equal(flash?.contextTokens, 1_000_000);
  assert.equal(modelSeesImages(flash), true);
  assert.equal(modelSeesImages(plain), false);
  // A model the catalog does not know says nothing, and callers treat that as unknown, not "no".
  assert.equal(mystery?.contextTokens, undefined);
  assert.equal(modelSeesImages(mystery), null);
  assert.equal(catalogFor("opencode-go:plan", path).find((item) => item.id === "glm-5.3")?.inputs?.includes("image"), false);
});

test("models.dev meta lookup uses the catalogue modelsDevId", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-")), "models-cache.json");
  const seen: string[] = [];
  const models = await refreshProviderModels({
    providerId: "zai:plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    key: "plan-key-12345678",
    force: true,
    path,
    fetchImpl: async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === MODELS_DEV_URL) {
        return new Response(JSON.stringify({
          "zai-coding-plan": {
            models: {
              "glm-5.3-flash": { limit: { context: 2_000_000 }, modalities: { input: ["text"] } },
            },
          },
          // The pay as you go entry must not leak into the plan list.
          "zai": {
            models: {
              "glm-5.3-flash": { limit: { context: 1 }, modalities: { input: ["text"] } },
            },
          },
        }));
      }
      return new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }] }));
    },
  });
  assert.ok(seen.includes(MODELS_DEV_URL));
  assert.equal(models.find((item) => item.id === "glm-5.3-flash")?.contextTokens, 2_000_000);
});

test("plan and api lists do not collide on the same provider", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-")), "models-cache.json");
  await refreshProviderModels({
    providerId: "zai:plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    force: true,
    path,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }] })),
  });
  // No live api list yet, so the api connection falls back to catalogue defaults.
  assert.deepEqual(catalogFor("zai:api", path).map((item) => item.id), ["glm-4.5-air", "glm-4.5"]);
  assert.deepEqual(catalogFor("zai:plan", path).map((item) => item.id), ["glm-5.3-flash"]);
});

test("model listing sends the catalogue key header and extra headers", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...init?.headers as Record<string, string> } });
    return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5-flash" }] }));
  };
  // MiMo plan keys ride an api-key header, not a bearer token.
  await fetchProviderModelIds("https://token-plan-sgp.xiaomimimo.com/v1", "tp-key-12345678", fetchImpl, "api-key");
  assert.equal(calls[0]?.headers["api-key"], "tp-key-12345678");
  assert.equal(calls[0]?.headers.authorization, undefined);
  // Copilot lists with its editor headers next to the bearer token.
  await fetchProviderModelIds(
    "https://api.githubcopilot.com",
    "ghu-token-12345678",
    fetchImpl,
    "bearer",
    { "X-GitHub-Api-Version": "2026-06-01", "Openai-Intent": "conversation-edits" },
  );
  assert.equal(calls[1]?.headers.authorization, "Bearer ghu-token-12345678");
  assert.equal(calls[1]?.headers["X-GitHub-Api-Version"], "2026-06-01");
  // x-api-key vendors keep their header shape.
  await fetchProviderModelIds("https://api.anthropic.com/v1", "sk-ant-12345678", fetchImpl, "x-api-key");
  assert.equal(calls[2]?.headers["x-api-key"], "sk-ant-12345678");
});

test("the ChatGPT Codex list is read by slug with hidden models left out", async () => {
  // Shape of GET chatgpt.com/backend-api/codex/models on 2026-09-19.
  const body = {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        input_modalities: [],
        default_reasoning_level: "minimal",
        supported_reasoning_levels: [{ effort: "max" }, { effort: "minimal" }, { effort: "high" }],
      },
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        visibility: "list",
        context_window: 272000,
        input_modalities: ["text", "image"],
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }, { effort: "minimal" }],
      },
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    ],
  };
  assert.deepEqual(parseModelList(body), ["gpt-5.6-sol", "gpt-6-astra"]);
  const urls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body));
  };
  const mode = providerMode("openai", "oauth");
  const ids = await fetchProviderModelIds(mode.baseUrl, "token-12345678", fetchImpl, "bearer", {}, mode.modelsQuery);
  assert.deepEqual(ids, ["gpt-5.6-sol", "gpt-6-astra"]);
  // The list is filtered by client_version and 400s without it.
  assert.equal(urls[0], "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0");
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-codex-")), "models-cache.json");
  await refreshProviderModels({
    providerId: "openai:oauth",
    baseUrl: mode.baseUrl,
    key: "token-12345678",
    query: mode.modelsQuery,
    modelsDevId: null,
    path,
    fetchImpl,
  });
  assert.deepEqual(catalogFor("openai:oauth", path).map((item) => item.id).sort(), ["gpt-5.6-sol", "gpt-6-astra"]);
  // The vendor's own name, window and reasoning levels beat the guess by name.
  const astra = catalogFor("openai:oauth", path).find((item) => item.id === "gpt-6-astra");
  assert.equal(astra?.label, "GPT-6-Astra");
  assert.equal(astra?.contextTokens, 272000);
  assert.deepEqual(astra?.inputs, ["text", "image"]);
  assert.deepEqual(astra?.efforts, ["low", "medium", "max"]);
  assert.equal(astra?.defaultEffort, "medium");
  // An empty list says nothing, and an inexpressible default snaps to the lowest level.
  const sol = catalogFor("openai:oauth", path).find((item) => item.id === "gpt-5.6-sol");
  assert.equal(sol?.inputs, undefined);
  assert.deepEqual(sol?.efforts, ["high", "max"]);
  assert.equal(sol?.defaultEffort, "high");
});

test("the Anthropic list is asked with its version header and one full page", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...init?.headers as Record<string, string> } });
    return new Response(JSON.stringify({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5", type: "model" }], has_more: false }));
  };
  const mode = providerMode("anthropic", "api");
  const ids = await fetchProviderModelIds(mode.baseUrl, "sk-ant-12345678", fetchImpl, mode.keyHeader, mode.headers, mode.modelsQuery);
  assert.deepEqual(ids, ["claude-opus-5"]);
  assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0]?.headers["x-api-key"], "sk-ant-12345678");
});

test("the parsed models cache is reused until another process replaces the file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-memo-")), "models-cache.json");
  const row = (id: string) => mergeLiveModels("opencode-go:plan", [id]);
  writeModelsCache({ schemaVersion: 3, providers: { "opencode-go:plan": { fetchedAt: 1, models: row("kimi-k3") } } }, path);
  const first = readModelsCache(path);
  assert.equal(readModelsCache(path), first, "an unchanged file is not parsed again");
  // What another process does: a whole new file renamed over this one, same
  // byte length, inside the same clock tick.
  const next = JSON.stringify({ schemaVersion: 3, providers: { "opencode-go:plan": { fetchedAt: 1, models: row("kimi-k4") } } });
  writeFileSync(`${path}.other`, `${next}\n`);
  renameSync(`${path}.other`, path);
  assert.equal(catalogFor("opencode-go:plan", path)[0]?.id, "kimi-k4");
});

test("the image list merges generators, drops SVG-only ones and survives a failed fetch", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-models-")), "models-cache.json");
  const chat = { data: [{ id: "openai/gpt-4.1-mini", architecture: { output_modalities: ["text"] } }, { id: "openai/gpt-5-image", architecture: { output_modalities: ["image", "text"] } }] };
  const images = {
    data: [
      { id: "black-forest-labs/flux.2-pro", architecture: { output_modalities: ["image"] }, supported_parameters: { output_format: { values: ["png", "jpeg"] }, aspect_ratio: { values: ["1:1", "16:9"] } } },
      { id: "recraft/recraft-v4-vector", architecture: { output_modalities: ["image"] }, supported_parameters: { output_format: { values: ["svg"] } } },
      { id: "openai/gpt-5-image", architecture: { output_modalities: ["image", "text"] }, supported_parameters: { aspect_ratio: { values: ["1:1", "3:2", "2:3"] } } },
    ],
  };
  let imagesUp = true;
  const refresh = () => refreshProviderModels({
    providerId: "openrouter:api",
    baseUrl: "https://openrouter.ai/api/v1",
    key: "sk-or-12345678",
    imagesPath: "images/models",
    modelsDevId: null,
    force: true,
    path,
    fetchImpl: async (input) => {
      if (String(input).endsWith("/images/models")) {
        return imagesUp ? new Response(JSON.stringify(images)) : new Response("down", { status: 503 });
      }
      return new Response(JSON.stringify(chat));
    },
  });
  let byId = new Map((await refresh()).map((item) => [item.id, item]));
  assert.deepEqual([...byId.keys()].sort(), ["black-forest-labs/flux.2-pro", "openai/gpt-4.1-mini", "openai/gpt-5-image"]);
  assert.equal(byId.get("black-forest-labs/flux.2-pro")?.imageGen, true);
  assert.deepEqual(byId.get("black-forest-labs/flux.2-pro")?.aspectRatios, ["1:1", "16:9"]);
  assert.equal(byId.get("openai/gpt-5-image")?.imageGen, true);
  assert.equal(byId.get("openai/gpt-4.1-mini")?.imageGen, undefined);
  assert.deepEqual(byId.get("openai/gpt-4.1-mini")?.outputs, ["text"]);

  // The image list goes down: the chat list refreshes and the image rows stay.
  imagesUp = false;
  byId = new Map((await refresh()).map((item) => [item.id, item]));
  assert.equal(byId.get("black-forest-labs/flux.2-pro")?.imageGen, true);
  assert.deepEqual(byId.get("black-forest-labs/flux.2-pro")?.aspectRatios, ["1:1", "16:9"]);
  // A dual model keeps its chat-side facts through the kept rows.
  assert.deepEqual(byId.get("openai/gpt-5-image")?.outputs, ["image", "text"]);

  // A real answer with nothing storable replaces the rows: retired models age out.
  imagesUp = true;
  images.data = [images.data[1]];
  byId = new Map((await refresh()).map((item) => [item.id, item]));
  assert.equal(byId.has("black-forest-labs/flux.2-pro"), false);
});

// The connect sheet asks the vendor about a pasted key before storing it. How
// that can go wrong: a bad key saved as if it worked (401 or 403 read as
// fine), a good key refused because the vendor was down, rate limited or the
// Mac was offline, or a good key refused because it went out in the wrong
// header for that vendor.
test("keyRejected refuses only a key the vendor answers 401 or 403", async () => {
  for (const [status, rejected] of [[401, true], [403, true], [200, false], [404, false], [429, false], [500, false], [503, false]] as const) {
    const verdict = await keyRejected("https://api.example.com/v1", "sk-test-key", async () => new Response("{}", { status }));
    assert.equal(verdict, rejected, `status ${status}`);
  }
});

test("keyRejected lets the key through when the vendor cannot be reached", async () => {
  const verdict = await keyRejected("https://api.example.com/v1", "sk-test-key", async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(verdict, false);
});

test("keyRejected sends the key the way the vendor takes it, to its model list", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response("{}", { status: 200 });
  };
  await keyRejected("https://api.anthropic.com/v1/", "sk-ant-key", fetchImpl, "x-api-key", { "anthropic-version": "2023-06-01" });
  await keyRejected("https://api.example.com/v1", "sk-bearer", fetchImpl);
  assert.equal(seen[0]?.url, "https://api.anthropic.com/v1/models");
  assert.equal(seen[0]?.headers.get("x-api-key"), "sk-ant-key");
  assert.equal(seen[0]?.headers.get("authorization"), null);
  assert.equal(seen[0]?.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(seen[1]?.headers.get("authorization"), "Bearer sk-bearer");
});

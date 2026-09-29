import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readImage,
  writeImage,
} from "../shared/images-store.ts";
import {
  emptyProviderStore,
  publicProviders,
  resolveUpstream,
  setActiveConnection,
  setComposer,
  setProviderKey,
  setRole,
  writeProviderStore,
} from "../shared/providers.ts";
import { generateImage } from "../router/src/upstreams/images.ts";
import listModels from "../agent/tools/list_models.ts";
import { modelContext } from "../agent/instructions/model.ts";
import { RouterError } from "../router/src/errors.ts";
import { setConnectionLookup } from "../shared/connection-url.ts";
import { IMAGE_BYTES_MAX } from "../shared/images-store.ts";
import { catalogFor, writeModelsCache } from "../shared/live-models.ts";
import { hydrateModel, modelIsImageGenerator, snapComposer } from "../shared/models.ts";

// A 1x1 png, the smallest real image the store is asked to keep.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function record(id: string) {
  return {
    id,
    mime: "image/png",
    b64: PNG_B64,
    prompt: "a small square",
    provider: "openai",
    model: "gpt-image-1",
  };
}

function age(dir: string, id: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(join(dir, `${id}.json`), when, when);
}

/** A provider store written to a temp file; the env var stays set until the
 * async body finishes, so reads inside it cannot reach the real file. */
async function withImageStore<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ub-images-"));
  const storePath = join(dir, "providers.json");
  const previous = process.env.UB_PROVIDERS_PATH;
  const previousCache = process.env.UB_MODELS_CACHE_PATH;
  process.env.UB_PROVIDERS_PATH = storePath;
  // The machine's own models cache stays out of it too.
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = previous;
    if (previousCache === undefined) delete process.env.UB_MODELS_CACHE_PATH;
    else process.env.UB_MODELS_CACHE_PATH = previousCache;
  }
}

test("an image record round-trips and bad ids and types are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-images-"));
  writeImage(record("imgabcdef123"), dir);
  const loaded = readImage("imgabcdef123", dir);
  assert.equal(loaded?.id, "imgabcdef123");
  assert.equal(loaded?.mime, "image/png");
  assert.equal(loaded?.b64, PNG_B64);
  assert.equal(readImage("imgmissing1", dir), null);
  assert.throws(() => writeImage(record("../escape"), dir), /image_id/);
  assert.throws(() => writeImage({ ...record("imgabcdef124"), mime: "text/html" }, dir), /image_type/);
});

test("the image role resolves only a connection whose mode serves images", () => {
  // A text-only connection cannot be picked even when it is the active one.
  const chatOnly = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  assert.throws(() => resolveUpstream(setActiveConnection(chatOnly, "opencode-go:plan"), "image", {}), /provider_incompatible/);

  // The capable connection is picked over the active text-only one.
  let store = setProviderKey(chatOnly, "openai", "api", "sk-test-abcdef1234");
  const resolved = resolveUpstream(store, "image", {});
  assert.equal(resolved.connection.id, "openai:api");
  assert.equal(resolved.modelId, "gpt-image-1");
  assert.equal(resolved.fallback, true);

  // An explicit image role pick wins and carries its model.
  store = setProviderKey(store, "xai", "api", "xai-key-12345678");
  store = setRole(store, "image", { connectionId: "xai:api", modelId: "grok-imagine-image", effort: null });
  const picked = resolveUpstream(store, "image", {});
  assert.equal(picked.connection.id, "xai:api");
  assert.equal(picked.modelId, "grok-imagine-image");
  assert.equal(picked.fallback, false);
});

test("the public image role lists capable connections only", () => {
  let store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  let pub = publicProviders(setActiveConnection(store, "opencode-go:plan"), {});
  // Nothing image-capable is connected: no pick, an empty picker.
  assert.equal(pub.roles.image.connectionId, null);
  assert.deepEqual(pub.roles.image.models, []);

  store = setProviderKey(store, "zai", "api", "zai-key-12345678");
  pub = publicProviders(store, {});
  const ids = pub.roles.image.models.map((row) => row.id);
  assert.ok(ids.includes("glm-image"));
  assert.ok(pub.roles.image.models.every((row) => row.connectionId === "zai:api"));
  // The fallback pick is the capable connection's first model.
  assert.equal(pub.roles.image.connectionId, "zai:api");
  assert.equal(pub.roles.image.modelId, "glm-image");
});

test("OpenRouter image models fill the image picker and stay out of the chat lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-images-or-"));
  const cachePath = join(dir, "models-cache.json");
  const previous = process.env.UB_MODELS_CACHE_PATH;
  process.env.UB_MODELS_CACHE_PATH = cachePath;
  try {
    const row = (id: string, outputs: string[]) => ({ ...hydrateModel("openrouter:api", id), outputs });
    writeModelsCache({
      schemaVersion: 3,
      providers: {
        "openrouter:api": {
          fetchedAt: Date.now(),
          models: [
            row("black-forest-labs/flux.2-pro", ["image"]),
            row("google/gemini-3.1-flash-image", ["image", "text"]),
            row("openai/gpt-5.1", ["text", "image"]),
            row("openrouter/auto", ["text", "image"]),
            row("openai/gpt-4.1-mini", ["text"]),
          ],
        },
      },
    }, cachePath);
    const store = setActiveConnection(setProviderKey(emptyProviderStore(), "openrouter", "api", "sk-or-12345678"), "openrouter:api");
    const pub = publicProviders(store, {});
    // Detected on connect: the role picks OpenRouter with no setup.
    assert.equal(pub.roles.image.connectionId, "openrouter:api");
    assert.equal(pub.roles.image.modelId, "google/gemini-3.1-flash-image");
    assert.deepEqual(pub.roles.image.models.map((m) => m.id), ["google/gemini-3.1-flash-image", "black-forest-labs/flux.2-pro"]);
    // Chat models that also list image output stay chat models; generators leave the chat lists.
    const chatIds = pub.roles.default.models.map((m) => m.id);
    assert.deepEqual(chatIds.sort(), ["openai/gpt-4.1-mini", "openai/gpt-5.1", "openrouter/auto"]);
    const composer = pub.connections.find((c) => c.id === "openrouter:api");
    assert.deepEqual(composer?.models.map((m) => m.id).sort(), chatIds);
    // A stale pick of an image model snaps to a chat model, never to another generator.
    const snapped = snapComposer("openrouter:api", "OpenRouter", "black-forest-labs/flux.2-pro", null, null, catalogFor("openrouter:api"));
    assert.ok(chatIds.includes(snapped.modelId));
    // The router resolves the image role to OpenRouter's /images path.
    const resolved = resolveUpstream(store, "image", {});
    assert.equal(resolved.connection.id, "openrouter:api");
    assert.equal(resolved.mode.images?.path, "images");
  } finally {
    if (previous === undefined) delete process.env.UB_MODELS_CACHE_PATH;
    else process.env.UB_MODELS_CACHE_PATH = previous;
  }
});

test("list_models shows chat and image models and the bot knows its model", async () => {
  await withImageStore(async (dir) => {
    const store = setActiveConnection(setProviderKey(emptyProviderStore(), "openrouter", "api", "sk-or-12345678"), "openrouter:api");
    writeProviderStore(setComposer(store, { modelId: "openai/gpt-4.1-mini" }), join(dir, "providers.json"));
    writeModelsCache({
      schemaVersion: 3,
      providers: {
        "openrouter:api": {
          fetchedAt: Date.now(),
          models: [
            { ...hydrateModel("openrouter:api", "black-forest-labs/flux.2-pro"), outputs: ["image"], imageGen: true },
            { ...hydrateModel("openrouter:api", "google/gemini-3.1-flash-image"), outputs: ["image", "text"], imageGen: true },
            { ...hydrateModel("openrouter:api", "openai/gpt-4.1-mini"), outputs: ["text"] },
          ],
        },
      },
    }, join(dir, "models-cache.json"));
    const out = await listModels.execute({ query: "flux" } as never, {} as never) as {
      current: { chat: { id: string } | null; image: { id: string } | null };
      chat: { total: number; models: Array<{ id: string }> };
      image: { total: number; models: Array<{ id: string; connectionId: string }> };
    };
    assert.equal(out.current.chat?.id, "openai/gpt-4.1-mini");
    assert.equal(out.current.image?.id, "google/gemini-3.1-flash-image");
    assert.equal(out.chat.total, 0);
    assert.deepEqual(out.image.models, [{ id: "black-forest-labs/flux.2-pro", label: "Flux.2 Pro", provider: "OpenRouter", connectionId: "openrouter:api" }]);
    const onlyChat = await listModels.execute({ kind: "chat" } as never, {} as never) as Record<string, unknown>;
    assert.equal("image" in onlyChat, false);

    const context = modelContext() ?? "";
    assert.match(context, /runs on .*\(openai\/gpt-4\.1-mini\) through OpenRouter/);
    assert.match(context, /generate_image draws with .*google\/gemini-3\.1-flash-image/);
  });
});

test("modelIsImageGenerator tells generators from chat models that list image output", () => {
  assert.equal(modelIsImageGenerator({ id: "recraft/recraft-v4", outputs: ["image"] }), true);
  assert.equal(modelIsImageGenerator({ id: "openai/gpt-5-image", outputs: ["image", "text"] }), true);
  assert.equal(modelIsImageGenerator({ id: "openai/gpt-5.1", outputs: ["text", "image"] }), false);
  assert.equal(modelIsImageGenerator({ id: "openai/gpt-4.1-mini", outputs: ["text"] }), false);
  assert.equal(modelIsImageGenerator({ id: "gpt-image-1" }), false);
});

test("generateImage posts to OpenRouter's /images, with no ratio while the model's ratios are unknown", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "openrouter", "api", "sk-or-12345678");
    writeProviderStore(store, join(dir, "providers.json"));
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }), { status: 200 });
    }) as typeof fetch;
    const out = await generateImage({ prompt: "a fox", size: "wide", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[0]?.url, "https://openrouter.ai/api/v1/images");
    assert.deepEqual(seen[0]?.body, { model: "google/gemini-3.1-flash-image", prompt: "a fox", n: 1 });
    assert.equal(out.images[0]?.mime, "image/png");
  });
});

test("a picked image model must be one the owner has, and gets its nearest ratio", async () => {
  await withImageStore(async (dir) => {
    writeProviderStore(setProviderKey(emptyProviderStore(), "openrouter", "api", "sk-or-12345678"), join(dir, "providers.json"));
    writeModelsCache({
      schemaVersion: 3,
      providers: {
        "openrouter:api": {
          fetchedAt: Date.now(),
          models: [
            { ...hydrateModel("openrouter:api", "openai/gpt-image-1"), outputs: ["image"], imageGen: true, aspectRatios: ["1:1", "3:2", "2:3", "auto"] },
            { ...hydrateModel("openrouter:api", "openai/gpt-4.1-mini"), outputs: ["text"] },
          ],
        },
      },
    }, join(dir, "models-cache.json"));
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as typeof fetch;
    const out = await generateImage({ prompt: "a fox", size: "wide", n: 1, pick: { modelId: "openai/gpt-image-1" }, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(out.model, "openai/gpt-image-1");
    // gpt-image takes 3:2, not 16:9.
    assert.equal(seen[0]?.aspect_ratio, "3:2");

    // A chat model, or a model on no connected provider, is refused before any call.
    for (const pick of [{ modelId: "openai/gpt-4.1-mini" }, { modelId: "dall-e-3" }, { modelId: "openai/gpt-image-1", connectionId: "openai:api" }]) {
      const err = await generateImage({ prompt: "x", n: 1, pick, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
      assert.ok(err instanceof RouterError);
      assert.equal(err.code, "image_model_unknown");
    }
    assert.equal(seen.length, 1);
  });
});

test("generateImage posts the OpenAI shape and returns the b64 data", async () => {
  await withImageStore(async (dir) => {
    let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    writeProviderStore(store, join(dir, "providers.json"));

    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
      });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as typeof fetch;

    const out = await generateImage({ prompt: "a fox", size: "wide", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[0]?.url, "https://api.openai.com/v1/images/generations");
    assert.equal(seen[0]?.auth, "Bearer sk-test-abcdef1234");
    assert.deepEqual(seen[0]?.body, { model: "gpt-image-1", prompt: "a fox", n: 1, size: "1536x1024" });
    assert.equal(out.providerId, "openai");
    assert.equal(out.model, "gpt-image-1");
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0]?.b64, PNG_B64);
    assert.equal(out.images[0]?.mime, "image/png");
  });
});

test("generateImage speaks aspect_ratio to xAI and downloads a url answer", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "xai", "api", "xai-key-12345678");
    writeProviderStore(store, join(dir, "providers.json"));

    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (calls.length === 1) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.aspect_ratio, "16:9");
        assert.equal(body.size, undefined);
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/img.png" }] }), { status: 200 });
      }
      return new Response(Buffer.from(PNG_B64, "base64"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;

    setConnectionLookup(async () => "8.8.8.8");
    try {
      const out = await generateImage({ prompt: "a fox", size: "wide", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
      assert.deepEqual(calls, ["https://api.x.ai/v1/images/generations", "https://cdn.example/img.png"]);
      assert.equal(out.images[0]?.mime, "image/png");
      assert.equal(out.images[0]?.b64, PNG_B64);
    } finally {
      setConnectionLookup(null);
    }
  });
});

test("generateImage maps a 401 to auth_failed and a 429 to a retryable limit", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    writeProviderStore(store, join(dir, "providers.json"));

    const unauthorized = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const err401 = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl: unauthorized }).catch((e) => e);
    assert.ok(err401 instanceof RouterError);
    assert.equal(err401.code, "upstream_auth_failed");

    const limited = (async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } })) as typeof fetch;
    const err429 = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl: limited }).catch((e) => e);
    assert.ok(err429 instanceof RouterError);
    assert.equal(err429.code, "upstream_rate_limited");
    assert.equal(err429.retryable, true);
  });
});

test("a url answer is screened before a byte is fetched", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "xai", "api", "xai-key-12345678");
    writeProviderStore(store, join(dir, "providers.json"));

    for (const bad of [
      "http://cdn.example/img.png",
      "https://127.0.0.1/img.png",
      "https://169.254.169.254/latest/meta-data",
      "https://user:pass@cdn.example/img.png",
      "https://cdn.example:8443/img.png",
      "https://localhost/img.png",
    ]) {
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [{ url: bad }] }), { status: 200 });
      }) as typeof fetch;
      const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
      assert.ok(err instanceof RouterError, bad);
      assert.equal(err.code, "upstream_protocol_error", bad);
      // The download was refused before fetch: only the generations call ran.
      assert.equal(calls.length, 1, bad);
    }

    // A public name that resolves to a private address is refused the same way.
    setConnectionLookup(async () => "10.0.0.4");
    try {
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/img.png" }] }), { status: 200 });
      }) as typeof fetch;
      const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
      assert.ok(err instanceof RouterError);
      assert.equal(err.code, "upstream_protocol_error");
      assert.equal(calls.length, 1);
    } finally {
      setConnectionLookup(null);
    }
  });
});

test("the download cap is enforced while streaming, not after buffering", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "xai", "api", "xai-key-12345678");
    writeProviderStore(store, join(dir, "providers.json"));

    const oversized = Buffer.alloc(IMAGE_BYTES_MAX + 8, 0x89);
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes("images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/big.png" }] }), { status: 200 });
      }
      // A declared length past the cap is refused before the body is read.
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "image/png", "content-length": String(oversized.length) } });
    }) as typeof fetch;

    setConnectionLookup(async () => "8.8.8.8");
    try {
      const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
      assert.ok(err instanceof RouterError);
      assert.equal(err.code, "upstream_protocol_error");
    } finally {
      setConnectionLookup(null);
    }
  });
});

test("an oversized b64_json answer is refused instead of stored", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    writeProviderStore(store, join(dir, "providers.json"));

    const big = Buffer.alloc(IMAGE_BYTES_MAX + 4, 0x89).toString("base64");
    const fetchImpl = (async () => new Response(
      JSON.stringify({ data: [{ b64_json: big }] }),
      { status: 200 },
    )) as typeof fetch;
    const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(10_000), fetchImpl }).catch((e) => e);
    assert.ok(err instanceof RouterError);
    assert.equal(err.code, "upstream_protocol_error");
  });
});

test("a generations body past the response cap is refused", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    writeProviderStore(store, join(dir, "providers.json"));

    const fetchImpl = (async () => new Response("x", {
      status: 200,
      headers: { "content-length": String(4 * Math.ceil(IMAGE_BYTES_MAX * 4 / 3) + 2_000_000) },
    })) as typeof fetch;
    const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
    assert.ok(err instanceof RouterError);
    assert.equal(err.code, "upstream_protocol_error");
  });
});

test("dall-e-3 takes its own sizes and a single image per call", async () => {
  await withImageStore(async (dir) => {
    let store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    store = setRole(store, "image", { connectionId: "openai:api", modelId: "dall-e-3", effort: null });
    writeProviderStore(store, join(dir, "providers.json"));

    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as typeof fetch;

    await generateImage({ prompt: "x", size: "wide", n: 4, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[0]?.size, "1792x1024");
    assert.equal(seen[0]?.n, 1);
    await generateImage({ prompt: "x", size: "tall", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[1]?.size, "1024x1792");
    await generateImage({ prompt: "x", size: "square", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[2]?.size, "1024x1024");
  });
});

test("zai takes its documented pixel sizes", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "zai", "api", "zai-key-12345678");
    writeProviderStore(store, join(dir, "providers.json"));

    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as typeof fetch;

    await generateImage({ prompt: "x", size: "wide", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl });
    assert.equal(seen[0]?.size, "1568x1056");
    assert.equal(seen[0]?.aspect_ratio, undefined);
  });
});

test("a text-only connection cannot be written as the image role", () => {
  const store = setProviderKey(emptyProviderStore(), "opencode-go", "plan", "go-key-12345678");
  assert.throws(
    () => setRole(store, "image", { connectionId: "opencode-go:plan", modelId: "anything", effort: null }),
    /provider_incompatible/,
  );
});

test("a b64 answer whose mime is not an image is refused", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "openai", "api", "sk-test-abcdef1234");
    writeProviderStore(store, join(dir, "providers.json"));

    // A valid base64 payload that sniffs to nothing known.
    const notImage = Buffer.from("<html><body>not a picture</body></html>").toString("base64");
    const fetchImpl = (async () => new Response(
      JSON.stringify({ data: [{ b64_json: notImage }] }),
      { status: 200 },
    )) as typeof fetch;
    const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
    assert.ok(err instanceof RouterError);
    assert.equal(err.code, "upstream_protocol_error");
  });
});

test("a url answer with a non-image content type is refused", async () => {
  await withImageStore(async (dir) => {
    const store = setProviderKey(emptyProviderStore(), "xai", "api", "xai-key-12345678");
    writeProviderStore(store, join(dir, "providers.json"));

    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes("images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/img.pngx" }] }), { status: 200 });
      }
      return new Response("not image bytes", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    setConnectionLookup(async () => "8.8.8.8");
    try {
      const err = await generateImage({ prompt: "x", n: 1, signal: AbortSignal.timeout(5_000), fetchImpl }).catch((e) => e);
      assert.ok(err instanceof RouterError);
      assert.equal(err.code, "upstream_protocol_error");
    } finally {
      setConnectionLookup(null);
    }
  });
});

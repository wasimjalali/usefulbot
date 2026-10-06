import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRouter } from "../src/index.ts";
import { LimitStore, estimateInputUnits } from "../src/limits.ts";
import { CEILING_RETRY_AFTER_MS, ConcurrencyGate } from "../src/concurrency.ts";
import { retryAfterMs, upstreamLimitError } from "../src/retry-after.ts";
import { AliasCircuit } from "../src/circuit.ts";
import { RouterError } from "../src/errors.ts";
import { completeUpstream, upstreamConfigError, type ResolvedUpstream } from "../src/upstreams/opencode.ts";
import { readPrefix } from "../src/read-capped.ts";
import { emptyLimitsStore, resetBudgetCache, writeLimitsStore } from "../../shared/limits-store.ts";
import { writeModelsCache } from "../../shared/live-models.ts";
import { hydrateModel } from "../../shared/models.ts";
import { clearConnection, emptyProviderStore, ProviderRouteRetiredError, readProviderStore, resolveUpstream, setOAuthCredential, setProviderKey, writeProviderStore } from "../../shared/providers.ts";
import { loadRuntimeConfig } from "../../shared/runtime.ts";
import { CALLER_LIMITS, MAX_ACTIVE_UPSTREAM, MAX_TOOL_SCHEMAS, SEARCH_LIMITS } from "../../shared/policy.ts";

// The caps scale with the owner's daily budget; these tests assume the
// default one, never the budget set on this Mac.
process.env.UB_LIMITS_PATH = join(mkdtempSync(join(tmpdir(), "ub-limits-file-")), "limits.json");

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse) => void;

const jsonFixture: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "cmpl_test",
    object: "chat.completion",
    model: "glm-5.3-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "fixture-ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  }));
};

function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

async function withRouter(
  fn: (base: string, tokens: Record<string, string>) => Promise<void>,
  handler: UpstreamHandler = jsonFixture,
) {
  const desktop = token();
  const phone = token();
  const ops = token();
  const expired = token();
  const device = token();
  const dir = mkdtempSync(join(tmpdir(), "ub-router-"));
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "usage.sqlite");
  const future = new Date(Date.now() + 86400_000).toISOString();
  const past = new Date(Date.now() - 86400_000).toISOString();
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: false,
    tailnet: null,
    sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [
      { id: "d", kind: "router", sha256: sha256hex(desktop), callerId: "desktop", profile: "desktop", expiresAt: future, revokedAt: null },
      { id: "p", kind: "router", sha256: sha256hex(phone), callerId: "phone", profile: "phone", expiresAt: future, revokedAt: null },
      { id: "o", kind: "router", sha256: sha256hex(ops), callerId: "ops", profile: "ops", expiresAt: future, revokedAt: null },
      { id: "e", kind: "router", sha256: sha256hex(expired), callerId: "old", profile: "desktop", expiresAt: past, revokedAt: null },
      { id: "dev", kind: "device", sha256: sha256hex(device), callerId: "desktop-device", profile: "desktop", expiresAt: future, revokedAt: null },
    ],
  }));

  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = (upstream.address() as { port: number }).port;
  const savedEnv = {
    key: process.env.UB_OPENCODE_GO_KEY,
    base: process.env.UB_OPENCODE_GO_BASE,
    providers: process.env.UB_PROVIDERS_PATH,
  };
  const restoreEnv = () => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("UB_OPENCODE_GO_KEY", savedEnv.key);
    restore("UB_OPENCODE_GO_BASE", savedEnv.base);
    restore("UB_PROVIDERS_PATH", savedEnv.providers);
  };
  process.env.UB_OPENCODE_GO_KEY = "test-upstream-key";
  process.env.UB_OPENCODE_GO_BASE = `http://127.0.0.1:${upPort}/v1`;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");

  let router: ReturnType<typeof startRouter> | undefined;
  try {
    router = startRouter({
      port: 0,
      configPath,
      lockPath: join(process.cwd(), "package-lock.json"),
      dbPath,
    });
    await new Promise<void>((resolve) => {
      if (router?.listening) resolve();
      else router?.once("listening", () => resolve());
    });
    const addr = router.address();
    if (!addr || typeof addr === "string") throw new Error("no listen address");
    const base = `http://127.0.0.1:${addr.port}`;
    await fn(base, { desktop, phone, ops, expired, device });
  } finally {
    await new Promise<void>((resolve) => {
      if (!router) {
        resolve();
        return;
      }
      router.close(() => resolve());
    });
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    restoreEnv();
  }
}

function ids() {
  return {
    "x-useful-session-id": randomUUID(),
    "x-useful-turn-id": randomUUID(),
    "x-useful-request-id": randomUUID(),
  };
}

test("live is unauthenticated", async () => {
  await withRouter(async (base) => {
    const res = await fetch(`${base}/health/live`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stack: "daily" });
  });
});

test("missing token is 401", async () => {
  await withRouter(async (base) => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 401);
  });
});

test("expired token is 401", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${tokens.expired}` } });
    assert.equal(res.status, 401);
  });
});

test("origin header is 403", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${tokens.desktop}`, origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
  });
});

test("phone cannot use reviewer", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.phone}`,
        "content-type": "application/json",
        ...ids(),
      },
      body: JSON.stringify({ model: "reviewer", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "alias_forbidden");
  });
});

test("desktop models lists workhorse only", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${tokens.desktop}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, "workhorse");
    assert.equal(body.data[0].context_window, 131072);
  });
});

test("duplicate request id is 409", async () => {
  await withRouter(async (base, tokens) => {
    const headers = {
      authorization: `Bearer ${tokens.desktop}`,
      "content-type": "application/json",
      ...ids(),
    };
    const body = JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] });
    const first = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(second.status, 409);
  });
});

test("completion maps model to alias", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.desktop}`,
        "content-type": "application/json",
        ...ids(),
      },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, "workhorse");
    assert.equal(body.choices[0].message.content, "fixture-ok");
    assert.equal(res.headers.get("x-useful-upstream-model"), "glm-5.3-flash");
    const usage = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${tokens.desktop}` } });
    assert.equal(usage.status, 200);
    const meter = await usage.json() as { observed_input_tokens: number; observed_output_tokens: number; requests: number; by_model: Array<{ model: string }> };
    assert.equal(meter.requests, 1);
    assert.equal(meter.observed_input_tokens, 11);
    assert.equal(meter.observed_output_tokens, 4);
    assert.equal(meter.by_model[0]?.model, "glm-5.3-flash");
  });
});

test("opencode-go forwards the model selected in the composer and reports it", async () => {
  let forwarded: Record<string, unknown> = {};
  // The window comes from the models cache; a fixture keeps the machine's own cache out of it.
  await withModelsCache(() => withRouter(async (base, tokens) => {
    writeFileSync(process.env.UB_PROVIDERS_PATH!, JSON.stringify({
      schemaVersion: 1,
      activeProviderId: "opencode-go",
      keys: { "opencode-go": { key: "test-upstream-key", updatedAt: new Date().toISOString() } },
      selectedModel: "glm-5.3",
      effort: "high",
      speed: "standard",
    }));
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-useful-upstream-model"), "glm-5.3");
    assert.equal(forwarded.model, "glm-5.3");
    assert.equal(forwarded.reasoning_effort, "high");
    // glm-5.3's catalog window is far past ten times the registry cap, so the
    // whole 32,768 goes out; a 131,072 window would get its last tenth.
    assert.equal(forwarded.max_tokens, 32_768);
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl_test",
        object: "chat.completion",
        model: "glm-5.3-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "fixture-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      }));
    });
  }));
});

function withModelsCache(fn: (path: string) => Promise<void>): Promise<void> {
  const previous = process.env.UB_MODELS_CACHE_PATH;
  const path = join(mkdtempSync(join(tmpdir(), "ub-router-models-")), "models-cache.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 3,
    providers: {
      "opencode-go": {
        fetchedAt: Date.now(),
        models: [
          { id: "glm-5.3-flash", label: "GLM 5.3 Flash", efforts: ["low", "high", "max"], defaultEffort: "low", speeds: ["standard"], defaultSpeed: "standard", contextTokens: 1_000_000, inputs: ["text", "image"] },
          { id: "glm-5.3", label: "GLM 5.3", efforts: ["low", "high", "max"], defaultEffort: "high", speeds: ["standard"], defaultSpeed: "standard", contextTokens: 1_000_000, inputs: ["text"] },
        ],
      },
    },
  }));
  process.env.UB_MODELS_CACHE_PATH = path;
  return fn(path).finally(() => {
    if (previous === undefined) delete process.env.UB_MODELS_CACHE_PATH;
    else process.env.UB_MODELS_CACHE_PATH = previous;
  });
}

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function imageTurn(extra: Record<string, unknown> = {}) {
  return {
    model: "workhorse",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is in this picture" },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    }],
    ...extra,
  };
}

test("a user image part reaches a vision model unchanged", async () => {
  let forwarded: Record<string, unknown> = {};
  await withModelsCache(() => withRouter(async (base, tokens) => {
    writeFileSync(process.env.UB_PROVIDERS_PATH!, JSON.stringify({
      schemaVersion: 1,
      activeProviderId: "opencode-go",
      keys: { "opencode-go": { key: "test-upstream-key", updatedAt: new Date().toISOString() } },
      selectedModel: "glm-5.3-flash",
      effort: "low",
      speed: "standard",
    }));
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify(imageTurn()),
    });
    assert.equal(res.status, 200);
    const content = (forwarded.messages as Array<{ content: unknown }>)[0]?.content as Array<Record<string, unknown>>;
    assert.equal(content[1]?.type, "image_url");
    assert.equal((content[1]?.image_url as { url: string }).url, PNG_DATA_URL);
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      jsonFixture(req, res);
    });
  }));
});

test("a text-only model gets a note where the image was", async () => {
  let forwarded: Record<string, unknown> = {};
  await withModelsCache(() => withRouter(async (base, tokens) => {
    writeFileSync(process.env.UB_PROVIDERS_PATH!, JSON.stringify({
      schemaVersion: 1,
      activeProviderId: "opencode-go",
      keys: { "opencode-go": { key: "test-upstream-key", updatedAt: new Date().toISOString() } },
      selectedModel: "glm-5.3",
      effort: "high",
      speed: "standard",
    }));
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify(imageTurn()),
    });
    assert.equal(res.status, 200);
    const content = (forwarded.messages as Array<{ content: unknown }>)[0]?.content as Array<Record<string, unknown>>;
    assert.equal(content[0]?.type, "text");
    assert.equal(content[1]?.type, "text");
    assert.equal(String(content[1]?.text).includes("cannot see images"), true);
    assert.equal(JSON.stringify(forwarded).includes("base64"), false);
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      jsonFixture(req, res);
    });
  }));
});

test("image parts are refused off the user role, as remote urls, and past the cap", async () => {
  await withRouter(async (base, tokens) => {
    const image = { type: "image_url", image_url: { url: PNG_DATA_URL } };
    const bodies: Array<Record<string, unknown>> = [
      { model: "workhorse", messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] },
      { model: "workhorse", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] },
      { model: "workhorse", messages: [{ role: "user", content: [{ type: "input_audio", data: "x" }] }] },
      { model: "workhorse", messages: [{ role: "user", content: [image, image, image, image, image, image] }] },
      { model: "workhorse", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PNG_DATA_URL, extra: 1 } }] }] },
    ];
    for (const body of bodies) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "unsupported_parameter");
    }
  });
});

test("estimateInputUnits reserves an image at its encoded size, an upper bound on what a model can bill", () => {
  const text = estimateInputUnits({ messages: [{ role: "user", content: "hi" }] });
  const withImage = estimateInputUnits(imageTurn());
  assert.equal(withImage >= text + PNG_DATA_URL.length, true);
});

test("device credential cannot authenticate to router", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${tokens.device}` } });
    assert.equal(res.status, 401);
  });
});

test("malformed json body is 400", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: "{ this is not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_request");
  });
});

test("request id is scoped per caller", async () => {
  await withRouter(async (base, tokens) => {
    const shared = ids();
    const body = JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] });
    const run = (token: string) => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...shared },
      body,
    });
    assert.equal((await run(tokens.desktop)).status, 200);
    assert.equal((await run(tokens.phone)).status, 200);
  });
});

test("upstream 5xx is normalized to a redacted 502", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(JSON.parse(text).error.code, "upstream_protocol_error");
    assert.equal(text.includes("secret provider detail"), false);
  }, (_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "secret provider detail" } }));
  });
});

test("upstream 429 maps to a retryable rate limit", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error.code, "upstream_rate_limited");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.retry_after_ms, 2000);
  }, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
    res.end("{}");
  });
});

test("a used-up plan answers 402 upstream_usage_limit with its reset, and is not retried", async () => {
  let calls = 0;
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.code, "upstream_usage_limit");
    assert.equal(body.error.message, `upstream_usage_limit resets_at=${resetsAt}`);
    assert.equal(body.error.retryable, false);
    assert.equal(calls, 1);
  }, (_req, res) => {
    calls += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: resetsAt } }));
  });
});

test("quota and plan limits get their own codes", async () => {
  for (const [error, code] of [
    [{ type: "usage_not_included" }, "upstream_usage_not_included"],
    [{ type: "insufficient_quota" }, "upstream_quota_exhausted"],
    [{ code: "organization_spend_limit_exceeded" }, "upstream_quota_exhausted"],
  ] as const) {
    await withRouter(async (base, tokens) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
        body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 402);
      assert.equal((await res.json()).error.code, code);
    }, (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
    });
  }
});

test("an upstream 402 is an account out of credit: 402 upstream_quota_exhausted, not retried, no circuit", async () => {
  // DeepSeek's and OpenRouter's documented bodies, then a proxy's HTML page
  // and an empty body: the status alone says the account has no credit.
  for (const body of [
    JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" } }),
    JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } }),
    "<html>Payment Required</html>",
    "",
  ]) {
    let calls = 0;
    await withRouter(async (base, tokens) => {
      // More refusals than the circuit's failure threshold: every one still
      // reaches the provider, since a top-up works at once.
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
          body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 402);
        const error = (await res.json()).error;
        assert.equal(error.code, "upstream_quota_exhausted");
        assert.equal(error.message, "upstream_quota_exhausted");
        assert.equal(error.retryable, false);
        assert.equal(calls, attempt);
      }
    }, (_req, res) => {
      calls += 1;
      res.writeHead(402, { "content-type": body.startsWith("{") ? "application/json" : "text/html" });
      res.end(body);
    });
  }
});

test("an upstream 402 marks the connection, so its row says the account is out of credit", async () => {
  await withRouter(async (base, tokens) => {
    const path = process.env.UB_PROVIDERS_PATH!;
    writeProviderStore(setProviderKey(emptyProviderStore(), "opencode-go", "plan", "test-upstream-key"), path);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 402);
    await res.text();
    const marked = Object.values(readProviderStore(path).connections).map((conn) => conn.lastError?.code);
    assert.deepEqual(marked, ["upstream_quota_exhausted"]);
  }, (_req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
  });
});

test("Kimi's spent day is a used-up limit, its per-minute limits stay waitable", async () => {
  const limit = (message: string) => upstreamLimitError(new Response(
    JSON.stringify({ error: { type: "rate_limit_reached_error", message } }),
    { status: 429 },
  ));
  const day = await limit("Your account org-1 request reached organization TPD rate limit, current: 1500001, limit: 1500000");
  assert.equal(day.code, "upstream_usage_limit");
  assert.equal(day.status, 402);
  // The wording in Kimi's error table.
  assert.equal((await limit("Organization-level TPD limit reached")).code, "upstream_usage_limit");
  for (const message of [
    "Your account org-1 request reached organization max RPM: 3, please try again after 1 seconds",
    "Your account org-1 request reached organization TPM rate limit, current: 64001, limit: 64000",
    "Organization-level concurrency limit reached",
    // An organisation whose name holds the token is still on a minute limit.
    "Your account TPD-2 request reached organization max RPM: 3, please try again after 1 seconds",
    "Your account TPD rate limit request reached organization max RPM: 3, please try again after 1 seconds",
  ]) {
    assert.equal((await limit(message)).code, "upstream_rate_limited");
  }
});

test("Z.ai's reset, given only in its message in China time, is named", async () => {
  const at = new Date(Date.now() + 3 * 3600_000);
  // The wall clock in UTC+8, the way Z.ai writes it: no zone.
  const shanghai = new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const error = await upstreamLimitError(new Response(JSON.stringify({
    error: { code: "1308", message: `Usage limit reached for 5 hour. Your limit will reset at ${shanghai}` },
  }), { status: 429 }));
  assert.equal(error.code, "upstream_usage_limit");
  assert.equal(error.message, `upstream_usage_limit resets_at=${Math.floor(at.getTime() / 1000)}`);
  // A time already past, or junk, names none.
  const stale = await upstreamLimitError(new Response(JSON.stringify({
    error: { code: "1310", message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2001-01-01 00:00:00" },
  }), { status: 429 }));
  assert.equal(stale.message, "upstream_usage_limit");
  // Another vendor's used-up limit that words a time the same way is not
  // read in China time: only Z.ai's codes are.
  const other = await upstreamLimitError(new Response(JSON.stringify({
    error: { type: "usage_limit_reached", message: `Your limit will reset at ${shanghai}` },
  }), { status: 429 }));
  assert.equal(other.message, "upstream_usage_limit");
});

test("an error body cut at its cap never ends in half a character", async () => {
  // Three bytes of a four-byte emoji fall inside the cap.
  const body = Buffer.concat([Buffer.from("x".repeat(9)), Buffer.from("😀")]);
  const text = await readPrefix(new Response(body), 12);
  assert.equal(text, "x".repeat(9));
});

test("other vendors' used-up plans are read from their documented bodies", async () => {
  const limit = (body: unknown) => upstreamLimitError(new Response(JSON.stringify(body), { status: 429 }));
  // Z.ai sends its code as a string; a number is read the same way.
  assert.equal((await limit({ error: { code: "1308", message: "Usage limit reached for 5 hour" } })).code, "upstream_usage_limit");
  assert.equal((await limit({ error: { code: 1310 } })).code, "upstream_usage_limit");
  assert.equal((await limit({ error: { code: "1311" } })).code, "upstream_usage_not_included");
  assert.equal((await limit({ error: { code: "1113" } })).code, "upstream_quota_exhausted");
  // A code named like an Object method is not a Z.ai code.
  assert.equal((await limit({ error: { code: "constructor" } })).code, "upstream_rate_limited");
  // Kimi.
  assert.equal((await limit({ error: { type: "exceeded_current_quota_error" } })).code, "upstream_quota_exhausted");
  // Google names a per-day quota, inside the array its OpenAI endpoint wraps errors in.
  const perDay = await limit([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }]);
  assert.equal(perDay.code, "upstream_usage_limit");
  assert.equal(perDay.status, 402);
  // Real rate limits stay waitable.
  for (const body of [
    { error: { code: "1302" } },
    { error: { type: "rate_limit_reached_error" } },
    [{ error: { status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }] } }],
  ]) {
    const error = await limit(body);
    assert.equal(error.code, "upstream_rate_limited");
    assert.equal(error.status, 429);
  }
});

test("a reset time that can't be one is left out of the message", async () => {
  const now = Math.round(Date.now() / 1000);
  const message = async (error: Record<string, unknown>) =>
    (await upstreamLimitError(new Response(JSON.stringify({ error: { type: "usage_limit_reached", ...error } }), { status: 429 }))).message;
  assert.equal(await message({ resets_at: 1e21 }), "upstream_usage_limit");
  assert.equal(await message({ resets_at: now - 60 }), "upstream_usage_limit");
  assert.equal(await message({ resets_in_seconds: -30 }), "upstream_usage_limit");
  // Milliseconds read as the same moment in seconds.
  assert.equal(await message({ resets_at: (now + 3600) * 1000 }), `upstream_usage_limit resets_at=${now + 3600}`);
  const inTen = Number((await message({ resets_in_seconds: 600 })).split("resets_at=")[1]);
  assert.ok(Math.abs(inTen - (now + 600)) <= 1);
});

test("upstream model 404 maps to model_unavailable", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "model_unavailable");
  }, (_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
});

test("streaming proxies sse and records usage", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(text.includes("fixture-ok"), true);
    assert.equal(text.includes("data: [DONE]"), true);
    const usage = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${tokens.desktop}` } });
    const meter = await usage.json() as { requests: number; observed_input_tokens: number };
    assert.equal(meter.requests, 1);
    assert.equal(meter.observed_input_tokens, 11);
  }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture-ok" } }] })}\r\n\r\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

test("a stream cut off after a tool call reaches eve as a tool step", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const finishes = [...text.matchAll(/"finish_reason":"(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(finishes, ["tool_calls"]);
    assert.equal(text.includes("\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\""), true);
    // The last block had no closing blank line and still arrives.
    assert.equal(text.trimEnd().endsWith("data: [DONE]"), true);
  }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } };
    // A block split across two writes is relayed whole.
    const first = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`;
    res.write(first.slice(0, 20));
    res.write(first.slice(20));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\n`);
    res.end("data: [DONE]");
  });
});

test("client abort cancels the upstream stream", async () => {
  let upstreamClosed = false;
  await withRouter(async (base, tokens) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    if (!res.body) throw new Error("no stream body");
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    res.on("close", () => {
      upstreamClosed = true;
    });
    setTimeout(() => res.end(), 1500);
  });
  assert.equal(upstreamClosed, true);
});

test("ops sees aggregate usage labeled aggregate", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const usage = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${tokens.ops}` } });
    const meter = await usage.json() as { requests: number; caller_id: string };
    assert.equal(meter.requests, 1);
    assert.equal(meter.caller_id, "aggregate");
  });
});

test("ops sees every registry model", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${tokens.ops}` } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: string }> };
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data.map((entry) => entry.id).sort(), ["reviewer", "workhorse"]);
  });
});

test("compaction's temperature and top_p are accepted and never reach the upstream", async () => {
  // eve's compaction sends temperature: 0, and eve retires the session on any
  // 4xx from here: every chat past its model's window died this way.
  let forwarded: Record<string, unknown> = {};
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], temperature: 0, top_p: 1 }),
    });
    assert.equal(res.status, 200);
    assert.equal("temperature" in forwarded, false);
    assert.equal("top_p" in forwarded, false);
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl_test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
});

test("a sampling value out of range is still refused", async () => {
  await withRouter(async (base, tokens) => {
    for (const extra of [{ temperature: 9 }, { top_p: "high" }]) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
        body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], ...extra }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "unsupported_parameter");
    }
  });
});

test("an upstream refusal names its status, type and code, never its free text", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    const error = JSON.parse(text).error;
    assert.equal(error.code, "upstream_protocol_error");
    assert.equal(error.message, "upstream_protocol_error (400 invalid_request_error/context_length_exceeded)");
    assert.equal(text.includes("sk-proj"), false);
    assert.equal(text.includes("maximum context"), false);
  }, (_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "This model's maximum context length is 128000 tokens (key sk-proj-abcdefgh1234)",
    } }));
  });
});

test("unknown completion options are rejected", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({
        model: "workhorse",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "unsupported_parameter");
  });
});

test("caller-supplied effort and service tier are rejected", async () => {
  await withRouter(async (base, tokens) => {
    for (const extra of [{ service_tier: "priority" }, { reasoning_effort: "high" }]) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
        body: JSON.stringify({
          model: "workhorse",
          messages: [{ role: "user", content: "hi" }],
          ...extra,
        }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "unsupported_parameter");
    }
  });
});

test("wrong method on a known route is 405 with Allow", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/models`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens.desktop}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  });
});

test("a model the upstream does not have opens the alias for a while, not for good", () => {
  const circuit = new AliasCircuit();
  const at = 1_000_000;
  circuit.recordFailure("workhorse", new RouterError({
    status: 502,
    type: "upstream_error",
    code: "model_unavailable",
    message: "model_unavailable",
  }), at);
  assert.throws(() => circuit.assertClosed("workhorse", at + 1_000), /circuit_open/);
  // The alias used to stay dead for the life of the process, so the only way
  // back was restarting the services.
  circuit.assertClosed("workhorse", at + 300_001);
});

test("a provider rate limit pauses the alias as a rate limit, with the time left", () => {
  const circuit = new AliasCircuit();
  const at = 3_000_000;
  circuit.recordFailure("workhorse", new RouterError({
    status: 429,
    type: "rate_limit_error",
    code: "upstream_rate_limited",
    message: "upstream_rate_limited",
    retryable: true,
    retryAfterMs: 45_000,
  }), at);
  try {
    circuit.assertClosed("workhorse", at + 5_000);
    assert.fail("the alias should be paused");
  } catch (err) {
    // Not circuit_open: the agent waits out a rate limit, never a cool-down.
    assert.equal((err as RouterError).code, "upstream_rate_limited");
    assert.equal((err as RouterError).status, 429);
    assert.equal((err as RouterError).retryAfterMs, 40_000);
  }
  circuit.assertClosed("workhorse", at + 45_001);
});

test("failures inside a longer rate-limit pause keep it a rate-limit pause", () => {
  const circuit = new AliasCircuit();
  const at = 4_000_000;
  circuit.recordFailure("workhorse", new RouterError({
    status: 429, type: "rate_limit_error", code: "upstream_rate_limited", message: "upstream_rate_limited", retryable: true, retryAfterMs: 120_000,
  }), at);
  const protocolError = new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  for (let i = 0; i < 3; i += 1) circuit.recordFailure("workhorse", protocolError, at + 1_000);
  assert.throws(() => circuit.assertClosed("workhorse", at + 60_000), /upstream_rate_limited/);
});

test("a reservation overrun keeps the alias shut, because a spend guard on a timer is not one", () => {
  const circuit = new AliasCircuit();
  circuit.disable("workhorse");
  // Its own code: the app tells the owner to wait out a circuit_open, and no
  // wait clears this one.
  assert.throws(() => circuit.assertClosed("workhorse", Date.now() + 86_400_000), /circuit_disabled/);
});

test("an open circuit says how long is left, so the app can stop retrying into it", () => {
  const circuit = new AliasCircuit();
  const at = 2_000_000;
  const protocolError = new RouterError({
    status: 502,
    type: "upstream_error",
    code: "upstream_protocol_error",
    message: "upstream_protocol_error",
  });
  for (let i = 0; i < 3; i += 1) circuit.recordFailure("workhorse", protocolError, at);
  try {
    circuit.assertClosed("workhorse", at + 10_000);
    assert.fail("the circuit should be open");
  } catch (err) {
    assert.equal(err instanceof RouterError, true);
    assert.equal((err as RouterError).code, "circuit_open");
    assert.equal((err as RouterError).retryable, true);
    assert.equal((err as RouterError).retryAfterMs, 20_000);
  }
  // One good call closes it again.
  circuit.recordSuccess("workhorse");
  circuit.assertClosed("workhorse", at + 10_000);
});

test("unknown route is 404", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/nope`, { headers: { authorization: `Bearer ${tokens.desktop}` } });
    assert.equal(res.status, 404);
  });
});

test("three protocol failures open the alias circuit", async () => {
  await withRouter(async (base, tokens) => {
    const call = () => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }] }),
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await call();
      assert.equal(res.status, 502);
      await res.text();
    }
    const opened = await call();
    assert.equal(opened.status, 503);
    const body = (await opened.json()).error;
    assert.equal(body.code, "circuit_open");
    // eve keeps only the message of a failed call, so the wait has to be
    // readable there for the app's countdown.
    const waited = Number(/retry_after_ms=(\d+)/.exec(body.message)?.[1]);
    assert.ok(waited > 0 && waited <= body.retry_after_ms + 5);
  }, (_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
});

test("oversize stream event is rejected", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes("upstream_protocol_error"), true);
  }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${"a".repeat(300 * 1024)}`);
    res.end();
  });
});

test("mid-stream protocol failures open the alias circuit", async () => {
  await withRouter(async (base, tokens) => {
    const call = () => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await call();
      assert.equal(res.status, 200);
      assert.equal((await res.text()).includes("upstream_protocol_error"), true);
    }
    const opened = await call();
    assert.equal(opened.status, 503);
    assert.equal((await opened.json()).error.code, "circuit_open");
  }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${"a".repeat(300 * 1024)}`);
    res.end();
  });
});

test("shared retry-after parser accepts seconds and http dates", () => {
  assert.equal(retryAfterMs(new Response(null, { headers: { "retry-after": "2" } })), 2000);
  const dated = retryAfterMs(new Response(null, { headers: { "retry-after": new Date(Date.now() + 3000).toUTCString() } }));
  assert.equal(typeof dated, "number");
  assert.equal((dated ?? 0) > 0, true);
  assert.equal(retryAfterMs(new Response(null)), undefined);
});

test("request ids expire after 24h", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const path = join(dir, "usage.sqlite");
  const now = Date.now();
  const store = new LimitStore(path);
  store.rememberRequest("step-1", "desktop", now - 25 * 60 * 60 * 1000);
  const reopened = new LimitStore(path);
  reopened.rememberRequest("step-1", "desktop", now);
});

test("hit enforces 24h token budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  // The default budget is 500M, so the desktop output cap is 50M (30M x 16.67 baseline factor).
  store.recordUsage({ callerId: "desktop", provider: "opencode-go", model: "glm-5.3-flash", inputTokens: 0, outputTokens: 50_000_000, at: now });
  assert.throws(() => store.hit(caller, now), /caller_budget_exhausted/);
});

test("hit enforces the aggregate 24h token budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "phone", profile: "phone" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  store.recordUsage({ callerId: "ghost", provider: "opencode-go", model: "glm-5.3-flash", inputTokens: 533_333_334, outputTokens: 0, at: now });
  assert.throws(() => store.hit(caller, now), /global_budget_exhausted/);
});

function budgetSandbox(tokens: number | null, requests: number | null): () => void {
  const prior = process.env.UB_LIMITS_PATH;
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-budget-"));
  const path = join(dir, "limits.json");
  process.env.UB_LIMITS_PATH = path;
  writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: tokens, dailyRequestBudget: requests }, path);
  resetBudgetCache();
  return () => {
    process.env.UB_LIMITS_PATH = prior;
    resetBudgetCache();
  };
}

test("a token budget lowered below what the day already used blocks the next hit, and a raise frees it", () => {
  const restore = budgetSandbox(null, null);
  try {
    const store = new LimitStore(join(mkdtempSync(join(tmpdir(), "ub-limits-")), "usage.sqlite"));
    const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
    const now = Date.now();
    store.recordUsage({ callerId: "desktop", provider: "opencode-go", model: "glm-5.3-flash", inputTokens: 5_000_000, outputTokens: 0, at: now });
    store.hit(caller, now);
    const path = process.env.UB_LIMITS_PATH!;
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 2_000_000 }, path);
    resetBudgetCache(path);
    assert.throws(() => store.hit(caller, now), /caller_budget_exhausted/);
    assert.throws(() => store.hit(caller, now), /caller_budget_exhausted/, "still blocked, predictably");
    writeLimitsStore({ ...emptyLimitsStore(), dailyTokenBudget: 10_000_000_000 }, path);
    resetBudgetCache(path);
    store.hit(caller, now);
  } finally {
    restore();
  }
});

test("the request budget is enforced for desktop and phone, lowered below the count blocks, tokens stay independent", () => {
  const restore = budgetSandbox(null, 3);
  try {
    const store = new LimitStore(join(mkdtempSync(join(tmpdir(), "ub-limits-")), "usage.sqlite"));
    const path = process.env.UB_LIMITS_PATH!;
    const desktop = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
    const now = Date.now();
    store.hit(desktop, now);
    store.hit(desktop, now + 1);
    store.hit(desktop, now + 2);
    assert.throws(() => store.hit(desktop, now + 3), /caller_budget_exhausted/);
    writeLimitsStore({ ...emptyLimitsStore(), dailyRequestBudget: 2 }, path);
    resetBudgetCache(path);
    assert.throws(() => store.hit(desktop, now + 4), /caller_budget_exhausted/, "lowered below the count used");
    writeLimitsStore({ ...emptyLimitsStore(), dailyRequestBudget: 1_000_000 }, path);
    resetBudgetCache(path);
    store.hit(desktop, now + 5);
  } finally {
    restore();
  }
  // The phone shares the desktop budget: the same cap applies to its own count.
  const restorePhone = budgetSandbox(null, 1);
  try {
    const store = new LimitStore(join(mkdtempSync(join(tmpdir(), "ub-limits-")), "usage.sqlite"));
    const phone = { callerId: "phone", profile: "phone" as const, aliases: ["workhorse"], search: true };
    const now = Date.now();
    store.hit(phone, now);
    assert.throws(() => store.hit(phone, now + 1), /caller_budget_exhausted/);
  } finally {
    restorePhone();
  }
});

test("reserve charges a ledger entry and reconcile records observed usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  const id = store.reserve({ caller, alias: "workhorse", inputUnits: 1000, outputUnits: 4096, now });
  let meter = store.summarize("desktop", now);
  assert.equal(meter.reserved_input_tokens, 1000);
  assert.equal(meter.reserved_output_tokens, 4096);
  const reconciled = store.reconcile(id, { inputTokens: 11, outputTokens: 4 }, { provider: "opencode-go", model: "glm-5.3-flash" }, now);
  assert.equal(reconciled.overrun, false);
  meter = store.summarize("desktop", now);
  assert.equal(meter.reserved_input_tokens, 0);
  assert.equal(meter.observed_input_tokens, 11);
  assert.equal(meter.observed_output_tokens, 4);
});

test("observed usage above a reservation is an overrun", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  const id = store.reserve({ caller, alias: "workhorse", inputUnits: 10, outputUnits: 10, now });
  const reconciled = store.reconcile(id, { inputTokens: 10, outputTokens: 99 }, { provider: "opencode-go", model: "glm-5.3-flash" }, now);
  assert.equal(reconciled.overrun, true);
  assert.equal(reconciled.alias, "workhorse");
});

test("concurrency gate: one per session, ten across sessions, the eleventh is a retryable 429", () => {
  const gate = new ConcurrencyGate();
  const releases: Array<() => void> = [];
  for (let i = 0; i < MAX_ACTIVE_UPSTREAM; i += 1) {
    releases.push(gate.acquire(ConcurrencyGate.key("desktop", `s${i}`)));
  }
  assert.equal(MAX_ACTIVE_UPSTREAM, 10);
  assert.equal(gate.activeCount, 10);
  // A busy session is told so even at the ceiling: 409, not the retryable 429.
  assert.throws(() => gate.acquire(ConcurrencyGate.key("desktop", "s0")), (error: unknown) => {
    const e = error as { status: number; code: string; retryable: boolean };
    return e.status === 409 && e.code === "session_busy" && e.retryable === false;
  });
  assert.throws(() => gate.acquire(ConcurrencyGate.key("desktop", "s10")), (error: unknown) => {
    const e = error as { status: number; code: string; retryable: boolean; retryAfterMs?: number };
    return e.status === 429 && e.code === "global_concurrency_limit" && e.retryable === true
      && e.retryAfterMs === CEILING_RETRY_AFTER_MS;
  });
  releases[0]();
  // Releasing twice must not free a second slot.
  releases[0]();
  assert.equal(gate.activeCount, 9);
  const eleventh = gate.acquire(ConcurrencyGate.key("desktop", "s10"));
  assert.throws(() => gate.acquire(ConcurrencyGate.key("desktop", "s11")), /global_concurrency_limit/);
  // A stale release from the first holder of s0 cannot free the new holder's slot.
  const again = (() => { releases[1](); return gate.acquire(ConcurrencyGate.key("desktop", "s0")); })();
  releases[0]();
  assert.throws(() => gate.acquire(ConcurrencyGate.key("desktop", "s0")), /session_busy/);
  eleventh();
  again();
  for (const release of releases) release();
  assert.equal(gate.activeCount, 0);
});

test("concurrency gate: the same session id under two callers is two sessions", () => {
  const gate = new ConcurrencyGate();
  gate.acquire(ConcurrencyGate.key("desktop", "s"));
  gate.acquire(ConcurrencyGate.key("reviewer", "s"));
  // The key cannot be forged by a caller id or session that contains the separator.
  assert.notEqual(ConcurrencyGate.key("a", "b\",\"c"), ConcurrencyGate.key("a\",\"b", "c"));
});

/** An upstream that holds every completion open until `open()` is called. */
function heldUpstream() {
  const waiting: Array<() => void> = [];
  let opened = false;
  let seen = 0;
  const handler: UpstreamHandler = (req, res) => {
    seen += 1;
    const finish = () => jsonFixture(req, res);
    if (opened) finish();
    else waiting.push(finish);
  };
  return {
    handler,
    seen: () => seen,
    open: () => {
      opened = true;
      for (const finish of waiting.splice(0)) finish();
    },
  };
}

function completion(base: string, bearer: string, sessionId: string, signal?: AbortSignal) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...ids(),
      "x-useful-session-id": sessionId,
    },
    body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }),
    signal,
  });
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ten sessions of one caller run together, a busy session is 409 and the eleventh is 429", async () => {
  const upstream = heldUpstream();
  await withRouter(async (base, tokens) => {
    const sessions = Array.from({ length: MAX_ACTIVE_UPSTREAM }, () => randomUUID());
    const running = sessions.map((session) => completion(base, tokens.desktop, session));
    try {
    await until(() => upstream.seen() === MAX_ACTIVE_UPSTREAM, "ten upstream calls in flight");

    const busy = await completion(base, tokens.desktop, sessions[0]);
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, "session_busy");

    const eleventh = await completion(base, tokens.desktop, randomUUID());
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.headers.get("retry-after"), "2");
    const body = await eleventh.json();
    assert.equal(body.error.code, "global_concurrency_limit");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.retry_after_ms, 2000);

    // Neither refusal reached the upstream.
    assert.equal(upstream.seen(), MAX_ACTIVE_UPSTREAM);
    } finally {
      // A failed assertion must not leave ten calls held: the router would
      // never close and the suite would hang instead of reporting.
      upstream.open();
    }
    for (const res of await Promise.all(running)) assert.equal(res.status, 200);
    const after = await completion(base, tokens.desktop, sessions[0]);
    assert.equal(after.status, 200);
    // Usage counts the eleven calls that ran, and neither refusal.
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${tokens.desktop}` } })).json();
    assert.equal(usage.requests, MAX_ACTIVE_UPSTREAM + 1);
  }, upstream.handler);
});

test("an upstream failure gives the session its slot back", async () => {
  let calls = 0;
  await withRouter(async (base, tokens) => {
    const session = randomUUID();
    const failed = await completion(base, tokens.desktop, session);
    assert.equal(failed.status >= 500, true);
    const next = await completion(base, tokens.desktop, session);
    assert.equal(next.status, 200);
  }, (req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    jsonFixture(req, res);
  });
});

test("a client that disconnects mid-call gives the session its slot back", async () => {
  const upstream = heldUpstream();
  await withRouter(async (base, tokens) => {
    const session = randomUUID();
    const controller = new AbortController();
    const dropped = completion(base, tokens.desktop, session, controller.signal);
    await until(() => upstream.seen() === 1, "the first call to reach the upstream");
    controller.abort();
    await assert.rejects(dropped);
    upstream.open();
    // The router sees the close asynchronously; the slot must come back without
    // the held upstream call ever completing.
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i += 1) {
      const res = await completion(base, tokens.desktop, session);
      status = res.status;
      if (status !== 200) {
        assert.equal(status, 409);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(status, 200);
  }, upstream.handler);
});

test("a search runs while the same session holds a completion, and the reverse", async () => {
  const upstream = heldUpstream();
  await withRouter(async (base, tokens) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const [input] = args;
      if (typeof input === "string" && input.includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({ data: { web: [{ title: "t", url: "https://example.com/", description: "s" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(...args);
    };
    try {
      const session = randomUUID();
      const thinking = completion(base, tokens.desktop, session);
      await until(() => upstream.seen() === 1, "the completion to be in flight");
      const search = await originalFetch(`${base}/v1/search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.desktop}`,
          "content-type": "application/json",
          "x-useful-session-id": session,
        },
        body: JSON.stringify({ query: "hello" }),
      });
      assert.equal(search.status, 200);
      upstream.open();
      assert.equal((await thinking).status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, upstream.handler);
});

test("the per-minute 429 says how long until a slot frees", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  for (let i = 0; i < CALLER_LIMITS.desktop.rpm; i += 1) store.hit(caller, now + i);
  assert.throws(() => store.hit(caller, now + 10_000), (error: unknown) => {
    const e = error as { code: string; retryAfterMs?: number };
    return e.code === "caller_rate_limit" && e.retryAfterMs === 50_000;
  });
  store.hit(caller, now + 60_001);
});

test("multimodal message content is rejected", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({
        model: "workhorse",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/x.png" } }] }],
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "unsupported_parameter");
  });
});

test("a tool message without an outstanding call is invalid history", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({
        model: "workhorse",
        messages: [{ role: "tool", tool_call_id: randomUUID(), content: "result" }],
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_tool_history");
  });
});

test("duplicate tool call ids are invalid history", async () => {
  await withRouter(async (base, tokens) => {
    const callId = randomUUID();
    const call = { id: callId, type: "function", function: { name: "f", arguments: "{}" } };
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({
        model: "workhorse",
        messages: [
          { role: "assistant", tool_calls: [call, call] },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_tool_history");
  });
});

test("more than MAX_TOOL_SCHEMAS tool schemas is rejected", async () => {
  const tools = Array.from({ length: MAX_TOOL_SCHEMAS + 1 }, (_, index) => ({
    type: "function",
    function: { name: `f${index}`, parameters: {} },
  }));
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({ model: "workhorse", messages: [{ role: "user", content: "hi" }], tools }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "unsupported_parameter");
  });
});

test("a well formed tool call and result is accepted", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json", ...ids() },
      body: JSON.stringify({
        model: "workhorse",
        messages: [
          { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "f", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call-1", content: "result" },
          { role: "user", content: "continue" },
        ],
      }),
    });
    assert.equal(res.status, 200);
  });
});

test("upstream config errors keep their distinct code", () => {
  assert.equal(upstreamConfigError(new Error("provider_unknown")).code, "provider_unknown");
  assert.equal(upstreamConfigError(new Error("provider_disconnected")).code, "provider_disconnected");
  assert.equal(upstreamConfigError(new Error("providers_schema")).code, "configuration_unverified");
});

test("search without the capability is 403", async () => {
  await withRouter(async (base, tokens) => {
    const res = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.ops}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "hello" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "capability_forbidden");
  });
});

test("search enforces one search per second per caller", async () => {
  await withRouter(async (base, tokens) => {
    const originalFetch = globalThis.fetch;
    const stubFetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const [input] = args;
      if (typeof input === "string" && input.includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({ data: { web: [{ title: "t", url: "https://example.com/", description: "s" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(...args);
    };
    globalThis.fetch = stubFetch;
    try {
      const post = () => originalFetch(`${base}/v1/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.desktop}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "hello" }),
      });
      const first = await post();
      assert.equal(first.status, 200);
      assert.equal((await first.json()).provider, "firecrawl-keyless");
      const second = await post();
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, "search_rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("search hits enforce the per-caller 24h cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  const step = SEARCH_LIMITS.minIntervalMs + 100;
  for (let i = 0; i < SEARCH_LIMITS.desktop; i += 1) {
    store.checkSearchLimit(caller, now + i * step);
  }
  assert.throws(() => store.checkSearchLimit(caller, now + SEARCH_LIMITS.desktop * step), /search_rate_limited/);
});

test("search hits enforce one per second per caller", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const caller = { callerId: "desktop", profile: "desktop" as const, aliases: ["workhorse"], search: true };
  const now = Date.now();
  store.checkSearchLimit(caller, now);
  assert.throws(() => store.checkSearchLimit(caller, now + 500), /search_rate_limited/);
  store.checkSearchLimit(caller, now + SEARCH_LIMITS.minIntervalMs);
});

test("search hits enforce the aggregate 24h cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-limits-"));
  const store = new LimitStore(join(dir, "usage.sqlite"));
  const now = Date.now();
  const step = SEARCH_LIMITS.minIntervalMs + 100;
  for (let i = 0; i < SEARCH_LIMITS.aggregate; i += 1) {
    store.checkSearchLimit(
      { callerId: `caller-${i}`, profile: "desktop" as const, aliases: ["workhorse"], search: true },
      now + i * step,
    );
  }
  assert.throws(() => store.checkSearchLimit(
    { callerId: "one-more", profile: "desktop" as const, aliases: ["workhorse"], search: true },
    now + SEARCH_LIMITS.aggregate * step,
  ), /search_rate_limited/);
});

test("runtime config rejects malformed credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-cfg-"));
  const write = (credential: Record<string, unknown>) => {
    const path = join(dir, `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      phoneEnabled: false,
      tailnet: null,
      sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
      goBalanceDisabledConfirmedAt: null,
      searchKeyRequired: false,
      credentials: [credential],
    }));
    return path;
  };
  const base = {
    id: "x",
    kind: "router",
    sha256: sha256hex("token"),
    callerId: "desktop",
    profile: "desktop",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  assert.doesNotThrow(() => loadRuntimeConfig(write(base)));
  assert.throws(() => loadRuntimeConfig(write({ ...base, sha256: "nothex" })), /runtime_config_credential/);
  assert.throws(() => loadRuntimeConfig(write({ ...base, expiresAt: "whenever" })), /runtime_config_credential/);
  assert.throws(() => loadRuntimeConfig(write({ ...base, kind: "bogus" })), /runtime_config_credential/);
  assert.throws(() => loadRuntimeConfig(write({ ...base, profile: "bogus" })), /runtime_config_credential/);
});

test("an oauth 401 then refresh then retry reports the refused attempt on its own, with its timing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-oauth-retry-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    if (seen.length === 1) {
      setTimeout(() => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "expired" } }));
      }, 30);
      return;
    }
    jsonFixture(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-1", expires_in: 3600, scope: "openid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { port } = server.address() as { port: number };
    const credential = { kind: "oauth", accessToken: "gh-token-12345678", refreshToken: "refresh-0", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_test" } as const;
    const resolved = {
      connection: { id: "openai:oauth" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: "openai-chat",
      keyHeader: "bearer",
      credential,
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    const attempts: { startedAt: number; firstByteAt: number | null; endedAt: number }[] = [];
    const out = await completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
      body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
      sessionId: randomUUID(),
      callerId: "desktop",
      signal: new AbortController().signal,
      resolved,
      onRefusedAttempt: (attempt) => attempts.push(attempt),
    });
    assert.equal(out.response.status, 200);
    assert.equal(seen.length, 2, "one refused attempt and one retry reached the upstream");
    assert.equal(attempts.length, 1, "exactly the refused attempt is reported");
    assert.ok(attempts[0].endedAt - attempts[0].startedAt >= 25, "its own timing, not the retry's");
    assert.ok(attempts[0].firstByteAt !== null && attempts[0].firstByteAt <= attempts[0].endedAt);
    assert.ok(out.timing.startedAt >= attempts[0].endedAt, "the retry's timing starts after the refused one ended");
    await out.response.body?.cancel();
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
});

// Kimi Code's terms: keep the tool's genuine identity, never tamper with the
// User-Agent (UB-015). The chat call to the plan route carries our own.
test("a Kimi Code plan call sends Useful Bot's own user-agent and nothing imitated", async () => {
  const agents: string[] = [];
  const server = createServer((req, res) => {
    agents.push(String(req.headers["user-agent"] ?? ""));
    jsonFixture(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const store = setProviderKey(emptyProviderStore(), "moonshot", "plan", "kimi-key-12345678");
    const real = resolveUpstream(store, "workhorse", {}, { connectionId: "moonshot:plan", modelId: "kimi-for-coding", effort: null, speed: "standard" });
    assert.equal(real.baseUrl, "https://api.kimi.com/coding/v1");
    const out = await completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
      body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
      sessionId: randomUUID(),
      callerId: "desktop",
      signal: new AbortController().signal,
      resolved: { ...real, baseUrl: `http://127.0.0.1:${port}` } as unknown as ResolvedUpstream,
    });
    assert.equal(out.response.status, 200);
    assert.deepEqual(agents, ["useful-bot/1.0"]);
    await out.response.body?.cancel();
  } finally {
    server.close();
  }
});

test("a retired route is refused with its own code and sentence, 4xx so no circuit counts it", () => {
  const sentence = "GitHub doesn't support this Copilot sign-in in Useful Bot, so it's been turned off. Pick another provider.";
  const error = upstreamConfigError(new ProviderRouteRetiredError(sentence));
  assert.equal(error.code, "provider_route_retired");
  assert.equal(error.status, 422);
  assert.ok(String(error.message).includes(sentence));
});

// Each real upstream request is one usage line: the router counts onDispatch
// (a request leaving) and onRefusedAttempt (that request settled as refused).
// Both cases below use OpenAI, whose refresh throws without a refresh token.
async function oauthRefreshFailure(expiresAt: number | null, status: number) {
  const dir = mkdtempSync(join(tmpdir(), "ub-oauth-refresh-fail-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  let reached = 0;
  const server = createServer((_req, res) => {
    reached += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "expired" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const credential = { kind: "oauth", accessToken: "tok-12345678", refreshToken: null, expiresAt, accountId: null, clientId: "oaiapp_test" } as const;
    const resolved = {
      connection: { id: "openai:oauth" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: "openai-chat",
      keyHeader: "bearer",
      credential,
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    let dispatches = 0;
    let refused = 0;
    await assert.rejects(
      completeUpstream({
        entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
        body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
        sessionId: randomUUID(),
        callerId: "desktop",
        signal: new AbortController().signal,
        resolved,
        onDispatch: () => { dispatches += 1; },
        onRefusedAttempt: () => { refused += 1; },
      }),
    );
    return { reached, dispatches, refused };
  } finally {
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
}

test("a 401 whose refresh fails is one dispatch and one refused attempt, no second request", async () => {
  const out = await oauthRefreshFailure(null, 401);
  assert.deepEqual(out, { reached: 1, dispatches: 1, refused: 1 });
});

test("an expired credential whose refresh fails sends nothing and reports no dispatch", async () => {
  const out = await oauthRefreshFailure(Date.now() - 60_000, 401);
  assert.deepEqual(out, { reached: 0, dispatches: 0, refused: 0 });
});

test("a ChatGPT sign-in without a client id (the old Codex route) is refused with no network call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-legacy-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  let reached = 0;
  const server = createServer((_req, res) => {
    reached += 1;
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const resolved = {
      connection: { id: "openai:oauth" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: "openai-chat",
      keyHeader: "bearer",
      credential: { kind: "oauth", accessToken: "codex-token", refreshToken: "codex-refresh", expiresAt: Date.now() + 3_600_000, accountId: "acct_codex" },
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    await assert.rejects(
      completeUpstream({
        entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
        body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
        sessionId: randomUUID(),
        callerId: "desktop",
        signal: new AbortController().signal,
        resolved,
      }),
      (err: unknown) => err instanceof RouterError && err.code === "upstream_auth_failed",
    );
    assert.equal(reached, 0);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
});

test("two parallel calls with an expired ChatGPT token share one refresh, and a stale holder reuses the stored token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-refresh-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  const expired = {
    kind: "oauth",
    accessToken: "old-access",
    refreshToken: "refresh-0",
    expiresAt: Date.now() - 60_000,
    accountId: null,
    clientId: "oaiapp_test",
  } as const;
  writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", expired));
  const bearers: string[] = [];
  const server = createServer((req, res) => {
    bearers.push(String(req.headers.authorization ?? ""));
    jsonFixture(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = globalThis.fetch;
  const refreshForms: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      refreshForms.push(String(init?.body));
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-1", expires_in: 3600, scope: "openid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { port } = server.address() as { port: number };
    const resolved = {
      connection: { id: "openai:oauth" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: "openai-chat",
      keyHeader: "bearer",
      credential: expired,
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    const call = () => completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
      body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
      sessionId: randomUUID(),
      callerId: "desktop",
      signal: new AbortController().signal,
      resolved,
    });
    const [one, two] = await Promise.all([call(), call()]);
    assert.equal(one.response.status, 200);
    assert.equal(two.response.status, 200);
    assert.equal(refreshForms.length, 1, "one refresh request for two parallel calls");
    assert.equal(new URLSearchParams(refreshForms[0]).get("refresh_token"), "refresh-0");
    assert.deepEqual(bearers, ["Bearer new-access", "Bearer new-access"]);
    const stored = readProviderStore().connections["openai:oauth"]?.credential;
    assert.ok(stored && stored.kind === "oauth");
    assert.equal(stored.accessToken, "new-access");
    assert.equal(stored.refreshToken, "refresh-1");
    // A later call still holding the old credential reads the stored one instead of spending a spent token.
    const third = await call();
    assert.equal(third.response.status, 200);
    assert.equal(refreshForms.length, 1);
    assert.equal(bearers.at(-1), "Bearer new-access");
    await Promise.all([one, two, third].map((out) => out.response.body?.cancel()));
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
});

// Sign in with ChatGPT through completeUpstream: a local server stands in for
// api.openai.com/v1, and a stubbed global fetch for the auth server.
async function chatgptRun(options: {
  upstream?: { status: number; body: string };
  held?: Record<string, unknown>;
  stored?: Record<string, unknown>;
  token?: { status: number; body: Record<string, unknown> };
  /** The connection is gone from the store (disconnected while the call ran). */
  noStore?: boolean;
  /** Runs while the refresh request is in flight, before the auth server answers. */
  onToken?: () => void;
  /** Runs while the upstream request is in flight, before the plan route answers. */
  onUpstream?: (call: number) => void;
  /** The answer to the first upstream request only; later ones use `upstream`. */
  first?: { status: number; body: string };
  /** The model the turn runs on; default gpt-6.1-sol, which the static fallback list does not name. */
  model?: string;
  /** Ask for a streamed answer and return its text. */
  stream?: boolean;
  /** Rows of the cached openai:oauth list. Absent: no cache file at all. */
  cached?: Array<{ id: string; unlisted?: boolean }>;
  /** The account the cached list was fetched for; default the held account. Null: none recorded. */
  cacheAccount?: string | null;
  /** Extra stored state, e.g. models an account already had dropped. */
  storeEdit?: (store: ReturnType<typeof emptyProviderStore>) => ReturnType<typeof emptyProviderStore>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-run-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  const savedCache = process.env.UB_MODELS_CACHE_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  process.env.UB_MODELS_CACHE_PATH = join(dir, "models-cache.json");
  if (options.cached) {
    const account = options.cacheAccount === undefined
      ? ((options.held as { clientId?: string } | undefined)?.clientId ?? "oaiapp_test")
      : options.cacheAccount;
    writeModelsCache({
      schemaVersion: 3,
      providers: { "openai:oauth": { fetchedAt: Date.now(), ...(account ? { account } : {}), models: options.cached.map((row) => ({ ...hydrateModel("openai:oauth", row.id), ...(row.unlisted ? { unlisted: true } : {}) })) } },
    });
  }
  const base = { kind: "oauth", accessToken: "tok-12345678", refreshToken: "refresh-0", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_test" };
  const held = { ...base, ...(options.held ?? {}) } as never;
  if (!options.noStore) {
    const first = setOAuthCredential(emptyProviderStore(), "openai", { ...base, ...(options.held ?? {}), ...(options.stored ?? {}) } as never);
    writeProviderStore(options.storeEdit ? options.storeEdit(first) : first);
  }
  const bearers: string[] = [];
  const server = createServer((req, res) => {
    const call = bearers.length;
    bearers.push(String(req.headers.authorization ?? ""));
    options.onUpstream?.(call);
    const answer = call === 0 && options.first ? options.first : options.upstream;
    res.writeHead(answer?.status ?? 200, { "content-type": "application/json" });
    res.end(answer?.body ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = globalThis.fetch;
  let refreshes = 0;
  const revoked: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/revoke") {
      revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      return new Response("", { status: 200 });
    }
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      refreshes += 1;
      options.onToken?.();
      const answer = options.token ?? { status: 200, body: { access_token: "new-access", refresh_token: "refresh-1", expires_in: 3600 } };
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { port } = server.address() as { port: number };
    const resolved = {
      connection: { id: "openai:oauth" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: options.model ?? "gpt-6.1-sol",
      model: options.model ?? "gpt-6.1-sol",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: "openai-responses",
      keyHeader: "bearer",
      credential: held,
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    let error: unknown = null;
    let text = "";
    try {
      const out = await completeUpstream({
        entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
        body: { model: "workhorse", messages: [{ role: "user", content: "hi" }], ...(options.stream ? { stream: true } : {}) },
        sessionId: randomUUID(),
        callerId: "desktop",
        signal: new AbortController().signal,
        resolved,
      });
      if (options.stream) text = await out.response.text();
      else await out.response.body?.cancel();
    } catch (err) {
      error = err;
    }
    return { error: error as RouterError | null, refreshes, bearers, revoked, text, store: readProviderStore().connections["openai:oauth"], dropped: readProviderStore().unavailableModels ?? {} };
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
    if (savedCache === undefined) delete process.env.UB_MODELS_CACHE_PATH;
    else process.env.UB_MODELS_CACHE_PATH = savedCache;
  }
}

const SSE_OK = { status: 200, body: "data: [DONE]\n\n" };

test("a ChatGPT 403 names why: not eligible, other plan-sharing codes, and a bare admission 403", async () => {
  // A listed model: the unlisted-model drop (UB-016) has its own tests below.
  const eligible = await chatgptRun({ model: "gpt-5.6-sol", upstream: { status: 403, body: JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }) } });
  assert.equal(eligible.error?.code, "upstream_chatgpt_not_eligible");
  assert.equal(eligible.error?.status, 403);
  assert.equal(eligible.error?.retryable, false);
  assert.equal(eligible.store?.lastError, null, "not an auth failure on the connection");
  for (const body of [
    { error: { code: "subscription_sharing_route_not_supported" } },
    { error: { code: "chatpass_v2_scope_not_authorized" } },
    { detail: "subscription_sharing_unsupported_capability" },
  ]) {
    const other = await chatgptRun({ upstream: { status: 403, body: JSON.stringify(body) } });
    assert.equal(other.error?.code, "upstream_chatgpt_not_permitted", JSON.stringify(body));
    assert.equal(other.error?.retryable, false);
    assert.equal(other.store?.lastError, null);
  }
  // Every other 403 on this route is a policy refusal, never "sign-in expired".
  const bare = await chatgptRun({ upstream: { status: 403, body: JSON.stringify({ detail: "Region not permitted" }) } });
  assert.equal(bare.error?.code, "upstream_chatgpt_not_permitted");
  assert.equal(bare.store?.lastError, null);
  const notJson = await chatgptRun({ upstream: { status: 403, body: "<html>no</html>" } });
  assert.equal(notJson.error?.code, "upstream_chatgpt_not_permitted");
  assert.equal(notJson.store?.lastError, null);
  // A 401 is still the auth path.
  const unauthorized = await chatgptRun({ upstream: { status: 401, body: "{}" }, token: { status: 400, body: { error: "invalid_grant" } } });
  assert.equal(unauthorized.error?.code, "upstream_auth_failed");
});

// One issued client id per saved workspace: the refusal list is keyed by it.
const ACCOUNT_A = { subject: "sub-account-a", clientId: "client-a" };
const ACCOUNT_B = { subject: "sub-account-b", clientId: "client-b" };
const NOT_ELIGIBLE = JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } });
const unsupported = (param?: string) => JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", ...(param ? { param } : {}) } });
const UNLISTED_ROW = [{ id: "gpt-6.1-sol", unlisted: true }, { id: "gpt-6-astra" }];

test("UB-016: a refused unlisted model is dropped for that account only, with the plan code", async () => {
  // 400 naming the model, and 400 with no param: both are about the model.
  for (const body of [unsupported("model"), unsupported()]) {
    const out = await chatgptRun({ held: ACCOUNT_A, cached: UNLISTED_ROW, upstream: { status: 400, body } });
    assert.equal(out.error?.code, "upstream_chatgpt_model_not_in_plan", body);
    assert.equal(out.error?.retryable, false);
    assert.deepEqual(out.dropped, { "client-a": ["gpt-6.1-sol"] }, body);
    assert.equal(out.store?.lastError, null);
  }
  // 403 not eligible drops it too.
  const eligible = await chatgptRun({ held: ACCOUNT_A, cached: UNLISTED_ROW, upstream: { status: 403, body: NOT_ELIGIBLE } });
  assert.equal(eligible.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.equal(eligible.error?.status, 403);
  assert.deepEqual(eligible.dropped, { "client-a": ["gpt-6.1-sol"] });
  // No cache file at all: the model is not a listed row either.
  const bare = await chatgptRun({ held: ACCOUNT_A, upstream: { status: 400, body: unsupported("model") } });
  assert.equal(bare.error?.code, "upstream_chatgpt_model_not_in_plan");
  // Another account's earlier drop stays and this one is added beside it.
  const second = await chatgptRun({
    held: ACCOUNT_B,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
    storeEdit: (store) => ({ ...store, unavailableModels: { "client-a": ["gpt-6-luna"] } }),
  });
  assert.deepEqual(second.dropped, { "client-a": ["gpt-6-luna"], "client-b": ["gpt-6.1-sol"] });
  // The same login in another workspace (same subject, other client id) is another account.
  const sameLogin = await chatgptRun({
    held: { subject: "sub-account-a", clientId: "client-a2" },
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
    storeEdit: (store) => ({ ...store, unavailableModels: { "client-a": ["gpt-6.1-sol"] } }),
  });
  assert.deepEqual(sameLogin.dropped, { "client-a": ["gpt-6.1-sol"], "client-a2": ["gpt-6.1-sol"] });
});

test("UB-016: refusals that are not about an unlisted model drop nothing", async () => {
  // A tool or input type the plan lacks (param is not the model): the usual protocol error.
  const tools = await chatgptRun({ held: ACCOUNT_A, cached: UNLISTED_ROW, upstream: { status: 400, body: unsupported("tools") } });
  assert.equal(tools.error?.code, "upstream_protocol_error");
  assert.deepEqual(tools.dropped, {});
  // A model the vendor's own list names is never dropped, whatever the refusal.
  for (const upstream of [{ status: 400, body: unsupported("model") }, { status: 403, body: NOT_ELIGIBLE }]) {
    const listed = await chatgptRun({ held: ACCOUNT_A, model: "gpt-6-astra", cached: UNLISTED_ROW, upstream });
    assert.notEqual(listed.error?.code, "upstream_chatgpt_model_not_in_plan");
    assert.deepEqual(listed.dropped, {});
  }
  // An unlisted id that OpenAI now lists is a listed row: the listed row wins.
  const nowListed = await chatgptRun({ held: ACCOUNT_A, cached: [{ id: "gpt-6.1-sol" }], upstream: { status: 400, body: unsupported("model") } });
  assert.deepEqual(nowListed.dropped, {});
  // A model that is not one of the merged ids is never dropped.
  const other = await chatgptRun({ held: ACCOUNT_A, model: "gpt-9-made-up", upstream: { status: 400, body: unsupported("model") } });
  assert.deepEqual(other.dropped, {});
  // The 403 that is not the eligibility code keeps its own code.
  const notPermitted = await chatgptRun({ held: ACCOUNT_A, cached: UNLISTED_ROW, upstream: { status: 403, body: JSON.stringify({ detail: "subscription_sharing_unsupported_capability" }) } });
  assert.equal(notPermitted.error?.code, "upstream_chatgpt_not_permitted");
  assert.deepEqual(notPermitted.dropped, {});
});

test("UB-016: a refusal is recorded for the account that sent the request, not the one stored now, and never for a signed-out connection", async () => {
  // A switched to B while the call ran: the refusal is A's, and B's list is not touched.
  const switched = await chatgptRun({
    held: ACCOUNT_A,
    stored: ACCOUNT_B,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
  });
  assert.equal(switched.error?.code, "upstream_chatgpt_model_not_in_plan", "the owner is still told the plan message");
  assert.deepEqual(switched.dropped, { "client-a": ["gpt-6.1-sol"] }, "recorded for A, so switching back does not offer it again");
  assert.equal(switched.store?.credential.kind === "oauth" ? switched.store.credential.clientId : null, "client-b", "B stays the stored account");
  // Signed out while the call ran: no entry is brought back for an account nobody has any more.
  const signedOut = await chatgptRun({
    held: ACCOUNT_A,
    noStore: true,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
  });
  assert.equal(signedOut.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(signedOut.dropped, {});
});

const cacheRows = (rows: Array<{ id: string; unlisted?: boolean }>, account = "client-a") => writeModelsCache({
  schemaVersion: 3,
  providers: { "openai:oauth": { fetchedAt: Date.now(), account, models: rows.map((row) => ({ ...hydrateModel("openai:oauth", row.id), ...(row.unlisted ? { unlisted: true } : {}) })) } },
});

// The unlisted/listed call is made when the request is dispatched, not when the refusal comes back.
test("UB-016: a model unlisted at dispatch is dropped even if another account's refresh lists it before the refusal", async () => {
  const out = await chatgptRun({
    held: ACCOUNT_A,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
    onUpstream: () => cacheRows([{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }]),
  });
  assert.equal(out.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(out.dropped, { "client-a": ["gpt-6.1-sol"] });
});

// A sent as account A, got a 401, and the retry ran as B (the owner switched accounts meanwhile).
// The listed snapshot has to be B's, read when B takes over.
test("UB-016: after a 401 renews into another account, the refusal uses that account's listed snapshot", async () => {
  const asB = { ...ACCOUNT_B, accessToken: "tok-b-87654321" };
  const unlistedForA = await chatgptRun({
    held: ACCOUNT_A,
    stored: asB,
    cached: UNLISTED_ROW,
    first: { status: 401, body: "{}" },
    upstream: { status: 403, body: NOT_ELIGIBLE },
    onUpstream: (call) => { if (call === 0) cacheRows([{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }], "client-b"); },
  });
  assert.equal(unlistedForA.error?.code, "upstream_chatgpt_not_eligible", "B lists the model, so the refusal is not a plan drop");
  assert.deepEqual(unlistedForA.dropped, {}, "nothing is recorded for B");
  const listedForA = await chatgptRun({
    held: ACCOUNT_A,
    stored: asB,
    cached: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    first: { status: 401, body: "{}" },
    upstream: { status: 403, body: NOT_ELIGIBLE },
    onUpstream: (call) => { if (call === 0) cacheRows(UNLISTED_ROW, "client-b"); },
  });
  assert.equal(listedForA.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(listedForA.dropped, { "client-b": ["gpt-6.1-sol"] }, "B does not list it, so it is recorded for B");
});

// The cache is per connection, not per account. After A switches to B and B's refresh has not landed
// (pending, timed out, failed), it still holds A's list.
test("UB-016: a cache fetched for another account never counts as listed for the account that sends", async () => {
  const asB = { ...ACCOUNT_B, accessToken: "tok-b-87654321" };
  const aList = [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }];
  // B sends, A's cache lists the id, B refuses: dropped for B.
  const sent = await chatgptRun({ held: asB, cached: aList, cacheAccount: "client-a", upstream: { status: 400, body: unsupported("model") } });
  assert.equal(sent.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(sent.dropped, { "client-b": ["gpt-6.1-sol"] });
  // A cache with no account recorded is no better.
  const unrecorded = await chatgptRun({ held: asB, cached: aList, cacheAccount: null, upstream: { status: 400, body: unsupported("model") } });
  assert.deepEqual(unrecorded.dropped, { "client-b": ["gpt-6.1-sol"] });
  // Only the merged ids are ever dropped, whatever cache is there.
  const other = await chatgptRun({ held: asB, model: "gpt-9-made-up", cached: [{ id: "gpt-9-made-up" }], cacheAccount: "client-a", upstream: { status: 400, body: unsupported("model") } });
  assert.deepEqual(other.dropped, {});
  // The same account's cache still keeps a listed model.
  const same = await chatgptRun({ held: asB, cached: aList, cacheAccount: "client-b", upstream: { status: 400, body: unsupported("model") } });
  assert.deepEqual(same.dropped, {});
});

test("UB-016: a 401 that renews into B while only A's cache exists drops the refused model for B", async () => {
  const asB = { ...ACCOUNT_B, accessToken: "tok-b-87654321" };
  const out = await chatgptRun({
    held: ACCOUNT_A,
    stored: asB,
    cached: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    cacheAccount: "client-a",
    first: { status: 401, body: "{}" },
    upstream: { status: 403, body: NOT_ELIGIBLE },
  });
  assert.equal(out.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(out.dropped, { "client-b": ["gpt-6.1-sol"] }, "B's refresh never landed, A's list is not B's");
});

test("UB-016: a model listed at dispatch is not dropped even if the cache loses the row before the refusal", async () => {
  const out = await chatgptRun({
    held: ACCOUNT_A,
    cached: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    upstream: { status: 400, body: unsupported("model") },
    onUpstream: () => cacheRows(UNLISTED_ROW),
  });
  assert.notEqual(out.error?.code, "upstream_chatgpt_model_not_in_plan");
  assert.deepEqual(out.dropped, {});
});

// A sent gpt-6.1-sol, A signed out (its entry was cleared), B signed in, then A's request came back
// refused. Recording it would bring back an entry for an account nobody has any more.
test("UB-016: a late refusal for an account that signed out is not recorded, even with another account signed in", async () => {
  const base = { kind: "oauth", accessToken: "tok-12345678", refreshToken: "refresh-0", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_test" };
  const signOutThenSignIn = (store: ReturnType<typeof emptyProviderStore>) => {
    const a = setOAuthCredential(emptyProviderStore(), "openai", { ...base, ...ACCOUNT_A } as never);
    const out = clearConnection(a, "openai:oauth");
    return setOAuthCredential(out, "openai", store.connections["openai:oauth"]!.credential);
  };
  const late = await chatgptRun({
    held: ACCOUNT_A,
    stored: ACCOUNT_B,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
    storeEdit: signOutThenSignIn,
  });
  assert.equal(late.error?.code, "upstream_chatgpt_model_not_in_plan", "the owner is still told the plan message");
  assert.deepEqual(late.dropped, {}, "A signed out, so nothing is recorded for A or for B");
  // A signed back in before the late answer: it is a saved account again.
  const back = await chatgptRun({
    held: ACCOUNT_A,
    stored: ACCOUNT_A,
    cached: UNLISTED_ROW,
    upstream: { status: 400, body: unsupported("model") },
    storeEdit: (store) => setOAuthCredential(clearConnection(store, "openai:oauth"), "openai", store.connections["openai:oauth"]!.credential),
  });
  assert.deepEqual(back.dropped, { "client-a": ["gpt-6.1-sol"] });
});

test("UB-016: a refusal that arrives mid-stream is handled the same way", async () => {
  const frame = (error: Record<string, unknown>) => ({ status: 200, body: `data: ${JSON.stringify({ type: "error", error })}\n\n` });
  const model = await chatgptRun({
    held: ACCOUNT_A, cached: UNLISTED_ROW, stream: true,
    upstream: frame({ code: "subscription_sharing_unsupported_capability", param: "model", message: "no" }),
  });
  assert.match(model.text, /"code":"upstream_chatgpt_model_not_in_plan"/);
  assert.deepEqual(model.dropped, { "client-a": ["gpt-6.1-sol"] });
  const eligible = await chatgptRun({
    held: ACCOUNT_A, cached: UNLISTED_ROW, stream: true,
    upstream: frame({ code: "subscription_sharing_user_not_eligible", message: "no" }),
  });
  assert.match(eligible.text, /"code":"upstream_chatgpt_model_not_in_plan"/);
  assert.deepEqual(eligible.dropped, { "client-a": ["gpt-6.1-sol"] });
  const tools = await chatgptRun({
    held: ACCOUNT_A, cached: UNLISTED_ROW, stream: true,
    upstream: frame({ code: "subscription_sharing_unsupported_capability", param: "tools", message: "no" }),
  });
  assert.doesNotMatch(tools.text, /model_not_in_plan/);
  assert.deepEqual(tools.dropped, {});
  const listed = await chatgptRun({
    held: ACCOUNT_A, cached: UNLISTED_ROW, stream: true, model: "gpt-6-astra",
    upstream: frame({ code: "subscription_sharing_user_not_eligible", message: "no" }),
  });
  assert.match(listed.text, /"code":"upstream_chatgpt_not_eligible"/);
  assert.deepEqual(listed.dropped, {});
});

test("a ChatGPT 503 plan-sharing code is the retryable upstream_unavailable and records nothing", async () => {
  for (const code of ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"]) {
    const out = await chatgptRun({ upstream: { status: 503, body: JSON.stringify({ error: { code } }) } });
    assert.equal(out.error?.code, "upstream_unavailable", code);
    assert.equal(out.error?.status, 503);
    assert.equal(out.error?.retryable, true);
    assert.equal(out.store?.lastError, null);
  }
});

test("a rejected client (invalid_client) on refresh is an auth failure that keeps the tokens", async () => {
  const out = await chatgptRun({
    held: { expiresAt: Date.now() - 60_000 },
    token: { status: 401, body: { error: "invalid_client" } },
  });
  assert.equal(out.error?.code, "upstream_auth_failed");
  assert.equal(out.refreshes, 1);
  const cred = out.store?.credential;
  assert.ok(cred && cred.kind === "oauth");
  assert.equal(cred.refreshToken, "refresh-0");
  assert.ok((cred.expiresAt ?? 0) < Date.now(), "left as it was, still expired");
  assert.equal(out.store?.lastError?.code, "upstream_auth_failed");
});

test("a rotated token whose store write failed is kept in memory and used instead of spending the spent token again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-unstored-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  const expired = { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-0", expiresAt: Date.now() - 60_000, accountId: null, clientId: "oaiapp_test" } as const;
  writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", expired));
  const bearers: string[] = [];
  const server = createServer((req, res) => {
    bearers.push(String(req.headers.authorization ?? ""));
    jsonFixture(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = globalThis.fetch;
  const realError = console.error;
  console.error = () => undefined;
  let refreshes = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      refreshes += 1;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { port } = server.address() as { port: number };
    const resolved = {
      connection: { id: "openai:oauth" }, providerId: "openai", mode: { headers: {} }, modelId: "gpt-6.1-sol", model: "gpt-6.1-sol",
      effort: null, speed: "standard", baseUrl: `http://127.0.0.1:${port}`, protocol: "openai-chat", keyHeader: "bearer",
      credential: expired, opencodeSession: false, fallback: false,
    } as unknown as ResolvedUpstream;
    const call = () => completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
      body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
      sessionId: randomUUID(), callerId: "desktop", signal: new AbortController().signal, resolved,
    });
    chmodSync(dir, 0o500); // every store write fails
    const first = await call();
    assert.equal(first.response.status, 200);
    assert.equal(refreshes, 1);
    const stuck = readProviderStore().connections["openai:oauth"]?.credential;
    assert.ok(stuck && stuck.kind === "oauth" && stuck.refreshToken === "refresh-0", "the store still holds the spent token");
    chmodSync(dir, 0o700); // the disk comes back
    const second = await call();
    assert.equal(second.response.status, 200);
    assert.equal(refreshes, 1, "the spent token was not used again");
    assert.deepEqual(bearers, ["Bearer new-access", "Bearer new-access"]);
    const healed = readProviderStore().connections["openai:oauth"]?.credential;
    assert.ok(healed && healed.kind === "oauth");
    assert.equal(healed.refreshToken, "refresh-1", "the retried write stored the rotated token");
    await Promise.all([first, second].map((out) => out.response.body?.cancel()));
  } finally {
    chmodSync(dir, 0o700);
    console.error = realError;
    globalThis.fetch = realFetch;
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
});

test("a refresh that lands after the connection was removed revokes its own new refresh token", async () => {
  const out = await chatgptRun({ upstream: SSE_OK, noStore: true, held: { expiresAt: Date.now() - 60_000 } });
  assert.equal(out.refreshes, 1);
  assert.deepEqual(out.revoked, ["refresh-1"]);
  assert.equal(out.store, undefined, "the connection stays gone");
  // A different refresh token in a store that still has the connection is not a removal: nothing is revoked.
  const rotated = await chatgptRun({ upstream: SSE_OK, held: { expiresAt: Date.now() - 60_000 } });
  assert.deepEqual(rotated.revoked, []);
});

test("a refresh whose slot was taken by another registration meanwhile revokes its new token; plain rotation elsewhere does not", async () => {
  const other = { kind: "oauth", accessToken: "other-access", refreshToken: "refresh-other", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_other" } as const;
  const switched = await chatgptRun({
    upstream: SSE_OK,
    held: { expiresAt: Date.now() - 60_000 },
    onToken: () => writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", other)),
  });
  assert.deepEqual(switched.revoked, ["refresh-1"]);
  const kept = switched.store?.credential;
  assert.ok(kept && kept.kind === "oauth");
  assert.equal(kept.refreshToken, "refresh-other", "the other registration's sign-in is untouched");
  const rotated = await chatgptRun({
    upstream: SSE_OK,
    held: { expiresAt: Date.now() - 60_000 },
    onToken: () => writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", {
      kind: "oauth", accessToken: "x", refreshToken: "refresh-elsewhere", expiresAt: Date.now() + 3_600_000, accountId: null, clientId: "oaiapp_test",
    })),
  });
  assert.deepEqual(rotated.revoked, []);
});

test("a ChatGPT 503 with another body still reaches the generic path with its body", async () => {
  const out = await chatgptRun({ upstream: { status: 503, body: JSON.stringify({ error: { type: "server_error", code: "overloaded_now" } }) } });
  assert.equal(out.error?.code, "upstream_protocol_error");
  assert.ok(out.error?.upstream?.includes("overloaded_now"), out.error?.upstream);
});

test("a kept credential written back but already expired is refreshed with the stored guard and the rotated token lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-chatgpt-kept-expired-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  const expired = { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-0", expiresAt: Date.now() - 60_000, accountId: null, clientId: "oaiapp_test" } as const;
  writeProviderStore(setOAuthCredential(emptyProviderStore(), "openai", expired));
  const server = createServer((req, res) => jsonFixture(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const realFetch = globalThis.fetch;
  const realError = console.error;
  console.error = () => undefined;
  const forms: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      forms.push(String(init?.body));
      // The first rotated token is good for one second only, so it is expired by the next call.
      const body = forms.length === 1
        ? { access_token: "short-access", refresh_token: "refresh-1", expires_in: 1 }
        : { access_token: "long-access", refresh_token: "refresh-2", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { port } = server.address() as { port: number };
    const resolved = {
      connection: { id: "openai:oauth" }, providerId: "openai", mode: { headers: {} }, modelId: "gpt-6.1-sol", model: "gpt-6.1-sol",
      effort: null, speed: "standard", baseUrl: `http://127.0.0.1:${port}`, protocol: "openai-chat", keyHeader: "bearer",
      credential: expired, opencodeSession: false, fallback: false,
    } as unknown as ResolvedUpstream;
    const call = () => completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: 1024 } as never,
      body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
      sessionId: randomUUID(), callerId: "desktop", signal: new AbortController().signal, resolved,
    });
    chmodSync(dir, 0o500);
    await (await call()).response.body?.cancel();
    chmodSync(dir, 0o700);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // the kept credential is now expired
    await (await call()).response.body?.cancel();
    assert.equal(forms.length, 2);
    assert.equal(new URLSearchParams(forms[1]).get("refresh_token"), "refresh-1", "the second refresh spends the kept token");
    const stored = readProviderStore().connections["openai:oauth"]?.credential;
    assert.ok(stored && stored.kind === "oauth");
    assert.equal(stored.refreshToken, "refresh-2", "the rotated token is stored, not skipped by a stale guard");
  } finally {
    chmodSync(dir, 0o700);
    console.error = realError;
    globalThis.fetch = realFetch;
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
});

test("a ChatGPT 429 usage limit answers upstream_chatgpt_usage_limit", async () => {
  const out = await chatgptRun({ upstream: { status: 429, body: JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "used up" } }) } });
  assert.equal(out.error?.code, "upstream_chatgpt_usage_limit");
  assert.equal(out.error?.status, 402);
  assert.equal(out.error?.retryable, false);
});

test("a token another process already rotated is used without a refresh request", async () => {
  const out = await chatgptRun({
    upstream: SSE_OK,
    held: { accessToken: "stale-access", expiresAt: Date.now() - 60_000 },
    stored: { accessToken: "rotated-access", refreshToken: "refresh-rotated", expiresAt: Date.now() + 3_600_000 },
  });
  assert.equal(out.refreshes, 0);
  assert.deepEqual(out.bearers, ["Bearer rotated-access"]);
});

test("a refresh the auth server refuses for good clears the sign-in and is an auth failure", async () => {
  const out = await chatgptRun({
    held: { expiresAt: Date.now() - 60_000 },
    token: { status: 400, body: { error: "invalid_grant", error_description: "revoked" } },
  });
  assert.equal(out.error?.code, "upstream_auth_failed");
  assert.equal(out.refreshes, 1);
  assert.equal(out.bearers.length, 0);
  const cred = out.store?.credential;
  assert.ok(cred && cred.kind === "oauth");
  assert.equal(cred.refreshToken, null);
  assert.equal(cred.expiresAt, 0);
  assert.equal(out.store?.lastError?.code, "upstream_auth_failed");
});

test("a transient refresh failure is a retryable 503 and records nothing against the connection", async () => {
  const out = await chatgptRun({
    held: { expiresAt: Date.now() - 60_000 },
    token: { status: 500, body: { error: "server_error" } },
  });
  assert.equal(out.error?.code, "upstream_unavailable");
  assert.equal(out.error?.status, 503);
  assert.equal(out.error?.retryable, true);
  assert.equal(out.bearers.length, 0);
  assert.equal(out.store?.lastError, null);
  const cred = out.store?.credential;
  assert.ok(cred && cred.kind === "oauth");
  assert.equal(cred.refreshToken, "refresh-0", "the refresh token is kept for the next try");
});

// A request the adapter cannot build (never sent) is not a dispatch, and a model
// with no catalog window sizes its output cap from the agent's unknown window.
async function runCompleteUpstream(options: {
  protocol: "openai-chat" | "anthropic-messages";
  body: Record<string, unknown>;
  maxOutputTokens: number;
  expectReject: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ub-dispatch-build-"));
  const saved = process.env.UB_PROVIDERS_PATH;
  process.env.UB_PROVIDERS_PATH = join(dir, "providers.json");
  let reached = 0;
  let forwarded: Record<string, unknown> | null = null;
  const server = createServer((req, res) => {
    reached += 1;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl_test",
        object: "chat.completion",
        model: "mystery-1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const credential = { kind: "oauth", accessToken: "tok-12345678", refreshToken: null, expiresAt: null, accountId: null, clientId: "oaiapp_test" } as const;
    const resolved = {
      connection: { id: "custom:no-catalog" },
      providerId: "openai",
      mode: { headers: {} },
      modelId: "mystery-1",
      model: "mystery-1",
      effort: null,
      speed: "standard",
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: options.protocol,
      keyHeader: "bearer",
      credential,
      opencodeSession: false,
      fallback: false,
    } as unknown as ResolvedUpstream;
    let dispatches = 0;
    const run = completeUpstream({
      entry: { alias: "workhorse", maxOutputTokens: options.maxOutputTokens } as never,
      body: options.body,
      sessionId: randomUUID(),
      callerId: "desktop",
      signal: new AbortController().signal,
      resolved,
      onDispatch: () => { dispatches += 1; },
    });
    if (options.expectReject) await assert.rejects(run);
    else await run;
    return { reached, dispatches, forwarded: forwarded as Record<string, unknown> | null };
  } finally {
    server.close();
    if (saved === undefined) delete process.env.UB_PROVIDERS_PATH;
    else process.env.UB_PROVIDERS_PATH = saved;
  }
}

test("malformed Anthropic tool arguments throw before any fetch and report zero dispatches", async () => {
  const out = await runCompleteUpstream({
    protocol: "anthropic-messages",
    maxOutputTokens: 1024,
    expectReject: true,
    body: {
      model: "workhorse",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{not json" } }] },
      ],
    },
  });
  assert.deepEqual({ reached: out.reached, dispatches: out.dispatches }, { reached: 0, dispatches: 0 });
});

test("a model with no catalog window caps its output at a tenth of 32768, not of 131072", async () => {
  const out = await runCompleteUpstream({
    protocol: "openai-chat",
    maxOutputTokens: 32_768,
    expectReject: false,
    body: { model: "workhorse", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(out.dispatches, 1);
  assert.equal(out.forwarded?.max_tokens, 3_276);
});

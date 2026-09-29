// Probe the ChatGPT Codex inference endpoint with the stored sign-in.
//
//   node --experimental-strip-types scripts/probe-chatgpt.mjs [--model gpt-5.5] [--variant name]
//
// Sends one tiny turn in several request shapes and prints the status and the
// first bytes of each answer, so a change in what the backend accepts shows up
// as a status, not as a bot that "did not answer". The access token and the
// account id never reach stdout.
import { readProviderStore } from "../shared/providers.ts";
import { accessTokenFor } from "../shared/provider-oauth.ts";
import { providerMode } from "../shared/provider-catalog.ts";
import { buildResponsesBody } from "../router/src/upstreams/openai-responses.ts";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const store = readProviderStore();
const conn = store.connections["openai:oauth"];
if (!conn || conn.credential.kind !== "oauth") {
  console.error("no ChatGPT sign-in stored (openai:oauth)");
  process.exit(2);
}
const auth = accessTokenFor("openai", conn.credential);
const secrets = [auth.token, conn.credential.accountId ?? ""].filter(Boolean);
const redact = (text) => secrets.reduce((acc, s) => acc.split(s).join("<redacted>"), text);

console.log(`token expired: ${auth.expired}; expiresAt: ${conn.credential.expiresAt ? new Date(conn.credential.expiresAt).toISOString() : "null"}; accountId present: ${Boolean(conn.credential.accountId)}`);

const mode = providerMode("openai", "oauth");
const picked = store.activeConnectionId === "openai:oauth" ? store.selectedModel : null;
const model = flag("--model") ?? picked ?? mode.defaults.workhorse;
const url = `${mode.baseUrl}/responses`;
console.log(`model: ${model}; url: ${url}`);

const chatBody = {
  model,
  stream: true,
  max_tokens: 4096,
  reasoning_effort: "low",
  messages: [
    { role: "system", content: "You are Test Bot. Answer in one short sentence." },
    { role: "user", content: "Say hello." },
  ],
};

// What the router sends since the fix.
const router = buildResponsesBody(chatBody, { model, chatgpt: true });
const variants = {
  // The shape the router sends now (post-fix).
  router,
  // The shape the router sent before the fix: no instructions, max_output_tokens set.
  "old-router": (() => { const b = { ...router, max_output_tokens: 4096 }; delete b.instructions; return b; })(),
  // One change each, to pin down which field the backend refuses.
  "no-instructions": (() => { const b = { ...router }; delete b.instructions; return b; })(),
  "with-max-output-tokens": { ...router, max_output_tokens: 4096 },
  "non-stream": { ...router, stream: false },
  "system-row-in-input": { ...router, input: [{ role: "system", content: "You are Test Bot." }, ...router.input] },
};

const only = flag("--variant");
for (const [name, body] of Object.entries(variants)) {
  if (only && only !== name) continue;
  const headers = {
    "content-type": "application/json",
    "user-agent": "useful-bot/1.0",
    authorization: `Bearer ${auth.token}`,
    ...auth.headers,
  };
  const started = Date.now();
  let status = "n/a";
  let text = "";
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    status = String(res.status);
    if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (text.length < 1200) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
        if (/response\.completed|response\.failed|"type":\s*"error"/.test(text)) break;
      }
      await reader.cancel().catch(() => undefined);
    } else {
      text = await res.text();
    }
  } catch (error) {
    text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const summary = redact(text).replace(/\s+/g, " ").slice(0, 600);
  console.log(`\n[${name}] status ${status} in ${Date.now() - started}ms\n  body keys: ${Object.keys(body).sort().join(", ")}\n  answer: ${summary}`);
}

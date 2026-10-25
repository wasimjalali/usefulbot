#!/usr/bin/env node
// Builds the request bodies Pi's `openai-completions` client sends to the
// router and writes them to router/test/fixtures/pi-request.json, where the
// router's contract tests replay them.
//
// Dev only: it loads `@earendil-works/pi-ai` from the globally installed Pi
// (not an app dependency). Override the location with PI_AI_DIR.
//
//   node scripts/dev/pi-golden-payload.mjs          write the fixture
//   node scripts/dev/pi-golden-payload.mjs --check  exit 1 if the installed Pi
//                                                   would send something else
//
// Run --check after every Pi upgrade: the contract tests replay the fixture,
// not Pi, so a new Pi shape only shows up here.
//
// Two requests come out of one conversation:
// - `specCompat`: the compat flags SPEC 5.3 gives the `useful-router`
//   provider. This is what the engine will send.
// - `defaultCompat`: no compat at all, so Pi auto-detects a custom URL and
//   sends `developer`, `max_completion_tokens`, `store`, `reasoning_effort`
//   and the prompt cache keys. The router accepts these as insurance against
//   a compat flag set wrong.
// The conversation has an earlier turn with a reply and reasoning, an image,
// and a current turn with reasoning, two tool calls and their results (one
// with an image), so the request sits mid-turn, where the router splits
// earlier reasoning from the current turn's.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piAiDir = process.env.PI_AI_DIR
  ?? join(process.env.HOME ?? "", ".local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai");
const piAiVersion = JSON.parse(readFileSync(join(piAiDir, "package.json"), "utf8")).version;
const { stream } = await import(pathToFileURL(join(piAiDir, "dist/api/openai-completions.js")).href);
const { normalizeContext } = await import(pathToFileURL(join(piAiDir, "dist/utils/transcript.js")).href);

// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const SPEC_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  supportsLongCacheRetention: false,
  sendSessionAffinityHeaders: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
};

function model(compat, reasoning) {
  return {
    id: "workhorse",
    name: "Useful router",
    api: "openai-completions",
    provider: "useful-router",
    baseUrl: "http://127.0.0.1:4419/v1",
    reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    // Pi asks for the model's whole maxTokens; the router clamps it.
    maxTokens: 16_384,
    ...(compat ? { compat } : {}),
  };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const from = { api: "openai-completions", provider: "useful-router", model: "workhorse", usage };
const t = 1_761_350_400_000;

const readTool = {
  name: "read_file",
  description: "Read a file from the workspace.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const screenshotTool = {
  name: "screenshot",
  description: "Take a screenshot of a page.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

const context = normalizeContext({
  systemPrompt: "You are Useful Bot.",
  tools: [readTool, screenshotTool],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this picture?" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
      timestamp: t,
    },
    {
      ...from,
      role: "assistant",
      content: [
        // Echoed back under `reasoning`, the field this delta came in.
        { type: "thinking", thinking: "A single transparent pixel.", thinkingSignature: "reasoning" },
        { type: "text", text: "It is a single transparent pixel." },
      ],
      stopReason: "stop",
      timestamp: t + 1,
    },
    {
      ...from,
      role: "assistant",
      content: [
        // OpenRouter's structured reasoning, echoed back as reasoning_details.
        { type: "thinking", thinking: "Nothing more to add.", thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: "Nothing more to add.", format: "unknown", index: 0 }]) },
        { type: "text", text: "Anything else?" },
      ],
      stopReason: "stop",
      timestamp: t + 2,
    },
    { role: "user", content: "Read notes.md and screenshot example.com.", timestamp: t + 3 },
    {
      ...from,
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Two tools, one after the other.", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call_read_1", name: "read_file", arguments: { path: "notes.md" } },
        { type: "toolCall", id: "call_shot_2", name: "screenshot", arguments: { url: "https://example.com" } },
      ],
      stopReason: "toolUse",
      timestamp: t + 4,
    },
    {
      role: "toolResult",
      toolCallId: "call_read_1",
      toolName: "read_file",
      content: [{ type: "text", text: "# Notes\nBuy milk." }],
      isError: false,
      timestamp: t + 5,
    },
    {
      role: "toolResult",
      toolCallId: "call_shot_2",
      toolName: "screenshot",
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      isError: false,
      timestamp: t + 6,
    },
  ],
});

/** Runs Pi's client against a fetch that records the body and refuses the call. */
async function capture(piModel, options) {
  let body = null;
  const fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ error: { message: "captured" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const events = stream(piModel, context, { apiKey: "golden", fetch, ...options });
  for await (const event of events) {
    if (event.type === "done" || event.type === "error") break;
  }
  if (!body) throw new Error("Pi sent no request");
  return body;
}

const specCompat = await capture(model(SPEC_COMPAT, false), { maxTokens: 16_384, sessionId: "golden-session" });
const defaultCompat = await capture(model(undefined, true), {
  maxTokens: 16_384,
  sessionId: "golden-session",
  cacheRetention: "long",
  reasoningEffort: "high",
});

const out = join(repo, "router/test/fixtures/pi-request.json");
const text = `${JSON.stringify({
  generatedBy: "scripts/dev/pi-golden-payload.mjs",
  piAiVersion,
  specCompat,
  defaultCompat,
}, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (existsSync(out) && readFileSync(out, "utf8") === text) {
    console.log(`fixture matches pi-ai ${piAiVersion}`);
  } else {
    console.error(`router/test/fixtures/pi-request.json differs from what pi-ai ${piAiVersion} sends: rerun without --check, then run the router contract tests`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out} (pi-ai ${piAiVersion})`);
}

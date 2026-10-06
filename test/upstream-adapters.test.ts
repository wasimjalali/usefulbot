import assert from "node:assert/strict";
import test from "node:test";
import { usageFromSseBlock } from "../shared/usage-parse.ts";
import { postChatCompletions } from "../router/src/upstreams/openai-chat.ts";
import {
  DEFAULT_INSTRUCTIONS,
  buildResponsesBody,
  postResponses,
  splitChatGptInstructions,
  translateResponsesJson,
} from "../router/src/upstreams/openai-responses.ts";
import {
  buildMessagesBody,
  postMessages,
  translateMessagesJson,
} from "../router/src/upstreams/anthropic-messages.ts";
import { settleCompletion, settleStreamBlock } from "../router/src/tool-finish.ts";

function sse(frames: Array<{ event?: string; data: unknown }>): string {
  return frames.map((frame) => {
    const data = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
    return `${frame.event ? `event: ${frame.event}\n` : ""}data: ${data}\n\n`;
  }).join("");
}

async function readTranslated(res: Response): Promise<{ chunks: Array<Record<string, unknown>>; done: boolean; error: Record<string, unknown> | null; text: string }> {
  const text = await res.text();
  const chunks: Array<Record<string, unknown>> = [];
  let done = false;
  let error: Record<string, unknown> | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.trim().split("\n").find((entry) => entry.trim().startsWith("data:"));
    if (!line) continue;
    const data = line.trim().slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.error && typeof parsed.error === "object") error = parsed.error as Record<string, unknown>;
    else chunks.push(parsed);
  }
  return { chunks, done, error, text };
}

function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
  const choices = chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
  return choices[0]?.delta ?? {};
}

function finishOf(chunk: Record<string, unknown>): string | null {
  const choices = chunk.choices as Array<{ finish_reason: string | null }>;
  return choices[0]?.finish_reason ?? null;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const CHAT_BODY = {
  model: "gpt-5.4-mini",
  stream: true,
  max_tokens: 512,
  reasoning_effort: "low",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "What is the weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Berlin\"}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "{\"temp\":21}" },
    {
      role: "user",
      content: [
        { type: "text", text: "And a picture" },
        { type: "image_url", image_url: { url: PNG } },
      ],
    },
  ],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { location: { type: "string" } } },
    },
  }],
  tool_choice: { type: "function", function: { name: "get_weather" } },
};

test("responses request maps chat fields, tools and images", () => {
  const out = buildResponsesBody({ ...CHAT_BODY }, { model: "gpt-5.4-mini", chatgpt: true });
  assert.equal(out.model, "gpt-5.4-mini");
  assert.equal(out.stream, true);
  assert.equal(out.store, false);
  assert.deepEqual(out.include, ["reasoning.encrypted_content"]);
  // The ChatGPT route refuses max_output_tokens and wants the system
  // prompt as instructions, not as a system row.
  assert.equal(out.max_output_tokens, undefined);
  assert.equal(out.instructions, "You are helpful.");
  assert.deepEqual(out.reasoning, { effort: "low" });
  assert.deepEqual(out.tool_choice, { type: "function", name: "get_weather" });
  const input = out.input as Array<Record<string, unknown>>;
  assert.equal(input.length, 4);
  assert.deepEqual(input[0], { role: "user", content: "What is the weather?" });
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_1",
    namespace: "useful_bot",
    name: "get_weather",
    arguments: "{\"location\":\"Berlin\"}",
  });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_1", output: "{\"temp\":21}" });
  assert.deepEqual(input[3], {
    role: "user",
    content: [
      { type: "input_text", text: "And a picture" },
      { type: "input_image", image_url: PNG },
    ],
  });
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], {
    type: "namespace",
    name: "useful_bot",
    description: "Useful Bot tools.",
    tools: [{
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { location: { type: "string" } } },
      strict: false,
    }],
  });
  const plain = buildResponsesBody({ ...CHAT_BODY }, { model: "gpt-5.4-mini", chatgpt: false });
  assert.equal(plain.include, undefined);
  // The Responses API on api.openai.com keeps the old shape.
  assert.equal(plain.instructions, undefined);
  assert.equal(plain.max_output_tokens, 512);
  assert.deepEqual((plain.input as Array<Record<string, unknown>>)[0], { role: "system", content: "You are helpful." });
  // Outside the ChatGPT route tools stay flat and replayed calls carry no namespace.
  assert.deepEqual((plain.tools as Array<Record<string, unknown>>)[0], {
    type: "function",
    name: "get_weather",
    description: "Get the weather",
    parameters: { type: "object", properties: { location: { type: "string" } } },
    strict: false,
  });
  assert.equal((plain.input as Array<Record<string, unknown>>)[2].namespace, undefined);
});

test("a ChatGPT 503 plan-sharing code mid-stream becomes the retryable upstream_unavailable", async () => {
  for (const code of ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"]) {
    const stub: typeof fetch = async () => new Response(sse([
      { event: "response.failed", data: { type: "response.failed", response: { error: { code, message: "try later" } } } },
    ]), { headers: { "content-type": "text/event-stream" } });
    const { error } = await readTranslated(await postResponses({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6.1-sol",
      chatgpt: true,
      body: { ...CHAT_BODY },
      headers: {},
      signal: AbortSignal.timeout(5000),
      fetchImpl: stub,
    }));
    assert.deepEqual(error, { message: "upstream_unavailable", code: "upstream_unavailable" }, code);
  }
});

test("chatgpt route: no tool_choice without tools", () => {
  const empty = buildResponsesBody({ ...CHAT_BODY, tools: [] }, { model: "gpt-6.1-sol", chatgpt: true });
  assert.equal("tools" in empty, false);
  assert.equal("tool_choice" in empty, false);
  const full = buildResponsesBody({ ...CHAT_BODY }, { model: "gpt-6.1-sol", chatgpt: true });
  assert.deepEqual(full.tool_choice, { type: "function", name: "get_weather" });
});

test("chatgpt route: an empty tools list sets no tools and no empty namespace", () => {
  const out = buildResponsesBody({ ...CHAT_BODY, tools: [], tool_choice: undefined }, { model: "gpt-6.1-sol", chatgpt: true });
  assert.equal("tools" in out, false);
  assert.equal(JSON.stringify(out).includes("namespace\":\"useful_bot\",\"description"), false);
});

test("chatgpt route: many tools share one namespace, service_tier is dropped, a named tool_choice stays a function", () => {
  const body = {
    ...CHAT_BODY,
    service_tier: "priority",
    tools: [
      ...CHAT_BODY.tools,
      { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
    ],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a" },
      { role: "tool", tool_call_id: "c2", content: "b" },
    ],
  };
  const chatgpt = buildResponsesBody(body, { model: "gpt-6.1-sol", chatgpt: true });
  const tools = chatgpt.tools as Array<{ type: string; name: string; tools: Array<{ name: string }> }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "namespace");
  assert.deepEqual(tools[0].tools.map((tool) => tool.name), ["get_weather", "read_file"]);
  const calls = (chatgpt.input as Array<Record<string, unknown>>).filter((item) => item.type === "function_call");
  assert.deepEqual(calls.map((call) => [call.name, call.namespace]), [["get_weather", "useful_bot"], ["read_file", "useful_bot"]]);
  assert.equal("service_tier" in chatgpt, false);
  assert.deepEqual(chatgpt.tool_choice, { type: "function", name: "get_weather" });
  // The plain Responses API still forwards service_tier.
  assert.equal(buildResponsesBody(body, { model: "gpt-6.1-sol", chatgpt: false }).service_tier, "priority");
});

test("chatgpt request shape: instructions always present, streaming forced, system rows lifted", () => {
  // No system message at all: the backend still gets a non-empty instructions
  // string, the way the Codex CLI always sends one.
  const bare = buildResponsesBody({ model: "gpt-5.5", stream: false, messages: [{ role: "user", content: "hi" }], max_tokens: 4096 }, { model: "gpt-5.5", chatgpt: true });
  assert.equal(bare.instructions, DEFAULT_INSTRUCTIONS);
  assert.equal(bare.stream, true);
  assert.equal(bare.store, false);
  assert.equal(bare.max_output_tokens, undefined);
  assert.deepEqual(bare.input, [{ role: "user", content: "hi" }]);
  // Two leading system rows join; a system row after the first user turn
  // stays in place as a developer row, the role the Codex CLI uses there.
  const split = splitChatGptInstructions([
    { role: "system", content: "You are Test Bot." },
    { role: "system", content: [{ type: "text", text: "Standing instructions: help." }] },
    { role: "user", content: "hello" },
    { role: "system", content: "Reminder: be brief." },
    { role: "assistant", content: "ok" },
  ]);
  assert.equal(split.instructions, "You are Test Bot.\n\nStanding instructions: help.");
  assert.deepEqual(split.messages, [
    { role: "user", content: "hello" },
    { role: "developer", content: "Reminder: be brief." },
    { role: "assistant", content: "ok" },
  ]);
  // A leading system row with an image is not folded into instructions, so
  // the image is not lost; it goes on as a developer row.
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AA" } };
  const withImage = splitChatGptInstructions([
    { role: "system", content: "You are Test Bot." },
    { role: "system", content: [{ type: "text", text: "See this." }, image] },
    { role: "user", content: "hello" },
  ]);
  assert.equal(withImage.instructions, "You are Test Bot.");
  assert.deepEqual(withImage.messages, [
    { role: "developer", content: [{ type: "text", text: "See this." }, image] },
    { role: "user", content: "hello" },
  ]);
  // A malformed body fails before any upstream call, as it did before the split.
  assert.throws(() => splitChatGptInstructions("not a list"), /upstream_protocol_error/);
  const wired = JSON.parse(JSON.stringify(buildResponsesBody(
    { model: "gpt-5.5", stream: true, messages: [{ role: "system", content: "S" }, { role: "user", content: "u" }] },
    { model: "gpt-5.5", chatgpt: true },
  ))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wired).sort(), ["include", "input", "instructions", "model", "store", "stream"]);
});

test("chatgpt non-stream caller is sent streaming and gets one chat completion back", async () => {
  let sent: Record<string, unknown> | null = null;
  const stub: typeof fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(RESPONSES_STREAM, { headers: { "content-type": "text/event-stream" } });
  };
  const res = await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.5",
    chatgpt: true,
    body: { ...CHAT_BODY, stream: false },
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  assert.equal(sent!.stream, true);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.object, "chat.completion");
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  assert.equal(message.content, "Hello, world");
  assert.equal(message.reasoning_content, "Thinking it over");
  assert.deepEqual(message.tool_calls, [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Berlin\"}" } }]);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
});

test("responses non-stream json becomes a chat completion", async () => {
  const stub: typeof fetch = async () => new Response(JSON.stringify({
    id: "resp_1",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hi there" }] },
      { type: "function_call", id: "fc_9", call_id: "call_z", name: "lookup", arguments: "{}" },
    ],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
  }), { headers: { "content-type": "application/json" } });
  const res = await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4-mini",
    // api.openai.com Responses: a non-stream call stays non-stream. (The
    // ChatGPT backend always streams; see the chatgpt non-stream test.)
    chatgpt: false,
    body: { ...CHAT_BODY, stream: false },
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gpt-5.4-mini");
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual((choice.message as Record<string, unknown>).content, "Hi there");
  assert.deepEqual((choice.message as Record<string, unknown>).tool_calls, [{
    id: "call_z",
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  }]);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
});

test("responses incomplete maps to length", () => {
  const body = translateResponsesJson({
    id: "resp_2",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "cut" }] }],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
  }, "gpt-5.4-mini");
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(choice.finish_reason, "length");
});

const RESPONSES_STREAM = sse([
  { event: "response.created", data: { type: "response.created", response: { id: "resp_abc" } } },
  { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "Hello," } },
  { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: " world" } },
  { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking it over" } },
  { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "get_weather", arguments: "" } } },
  { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "{\"loc" } },
  { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "ation\":\"Berlin\"}" } },
  { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "get_weather", arguments: "{\"location\":\"Berlin\"}" } } },
  { event: "response.completed", data: { type: "response.completed", response: { id: "resp_abc", status: "completed", usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } } } },
]);

test("responses stream becomes chat chunks, tool calls, usage and done", async () => {
  let seenUrl = "";
  const stub: typeof fetch = async (input) => {
    seenUrl = String(input);
    return new Response(RESPONSES_STREAM, { headers: { "content-type": "text/event-stream" } });
  };
  const res = await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex/",
    model: "gpt-5.4-mini",
    chatgpt: true,
    body: { ...CHAT_BODY },
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  assert.equal(seenUrl, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const { chunks, done, error, text } = await readTranslated(res);
  assert.equal(error, null);
  assert.equal(done, true);
  assert.equal(text.trimEnd().endsWith("data: [DONE]"), true);
  // The router reads usage off the translated stream untouched.
  assert.deepEqual(usageFromSseBlock(text), { inputTokens: 12, outputTokens: 34 });
  const contents = chunks.map((chunk) => deltaOf(chunk).content).filter(Boolean).join("");
  assert.equal(contents, "Hello, world");
  assert.equal(chunks[0] ? deltaOf(chunks[0]).role : null, "assistant");
  const reasoned = chunks.map((chunk) => deltaOf(chunk).reasoning_content).filter(Boolean).join("");
  assert.equal(reasoned, "Thinking it over");
  const toolDeltas = chunks.flatMap((chunk) => {
    const calls = deltaOf(chunk).tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
    return calls ?? [];
  });
  assert.equal(toolDeltas[0]?.index, 0);
  assert.equal(toolDeltas[0]?.id, "call_abc");
  assert.equal(toolDeltas[0]?.function?.name, "get_weather");
  assert.equal(toolDeltas.map((call) => call.function?.arguments ?? "").join(""), "{\"location\":\"Berlin\"}");
  const last = chunks[chunks.length - 1]!;
  assert.equal(finishOf(last), "tool_calls");
  assert.deepEqual(last.usage, { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
  assert.equal(last.id, "resp_abc");
});

test("responses error after headers becomes an error event with no done", async () => {
  const stub: typeof fetch = async () => new Response(sse([
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "hi" } },
    { event: "error", data: { type: "error", error: { message: "bad key", code: "invalid_api_key" } } },
  ]), { headers: { "content-type": "text/event-stream" } });
  const res = await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4-mini",
    chatgpt: true,
    body: { ...CHAT_BODY },
    headers: {},
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  const { chunks, done, error } = await readTranslated(res);
  assert.equal(chunks.length, 1);
  assert.equal(done, false);
  assert.deepEqual(error, { message: "bad key", code: "invalid_api_key" });
});

test("a plan that runs out mid-stream gets the router's limit code", async () => {
  const stub: typeof fetch = async () => new Response(sse([
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "hi" } },
    { event: "response.failed", data: { type: "response.failed", response: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } } } },
  ]), { headers: { "content-type": "text/event-stream" } });
  const res = await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4-mini",
    chatgpt: true,
    body: { ...CHAT_BODY },
    headers: {},
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  const { error } = await readTranslated(res);
  assert.deepEqual(error, { message: "upstream_quota_exhausted", code: "upstream_quota_exhausted" });

  // A used-up plan mid-stream carries its reset, like one refused up front.
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  const planStub: typeof fetch = async () => new Response(sse([
    { event: "response.failed", data: { type: "response.failed", response: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: resetsAt } } } },
  ]), { headers: { "content-type": "text/event-stream" } });
  const plan = await readTranslated(await postResponses({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4-mini",
    chatgpt: true,
    body: { ...CHAT_BODY },
    headers: {},
    signal: AbortSignal.timeout(5000),
    fetchImpl: planStub,
  }));
  assert.deepEqual(plan.error, { message: `upstream_usage_limit resets_at=${resetsAt}`, code: "upstream_usage_limit", type: "usage_limit_reached" });
});

test("messages request maps system, tools, images and thinking", () => {
  const out = buildMessagesBody({
    ...CHAT_BODY,
    thinking: { type: "enabled", budget_tokens: 16384 },
  }, { model: "claude-sonnet-4-5" });
  assert.equal(out.model, "claude-sonnet-4-5");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 512);
  assert.equal(out.system, "You are helpful.");
  assert.deepEqual(out.tool_choice, { type: "tool", name: "get_weather" });
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "high" });
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools[0], {
    name: "get_weather",
    description: "Get the weather",
    input_schema: { type: "object", properties: { location: { type: "string" } } },
  });
  const messages = out.messages as Array<Record<string, unknown>>;
  // Messages rejects two user turns in a row, so the tool result and the
  // user text that follows it travel as one user message.
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { location: "Berlin" } }],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_1", content: "{\"temp\":21}" },
      { type: "text", text: "And a picture" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ],
  });
});

test("messages non-stream json becomes a chat completion", () => {
  const body = translateMessagesJson({
    id: "msg_2",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Hello" }],
    usage: { input_tokens: 3, output_tokens: 4 },
  }, "claude-sonnet-4-5");
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal((choice.message as Record<string, unknown>).content, "Hello");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

  const long = translateMessagesJson({
    id: "msg_3",
    stop_reason: "max_tokens",
    content: [{ type: "text", text: "cut" }],
    usage: { input_tokens: 3, output_tokens: 4 },
  }, "claude-sonnet-4-5");
  assert.equal((long.choices as Array<Record<string, unknown>>)[0]?.finish_reason, "length");
});

const MESSAGES_STREAM = sse([
  { event: "message_start", data: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "thinking" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Let me think" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "search" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"q\":" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"hello\"}" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);

test("messages stream becomes chat chunks, tool calls, usage and done", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const stub: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenHeaders = { ...(init?.headers as Record<string, string>) };
    return new Response(MESSAGES_STREAM, { headers: { "content-type": "text/event-stream" } });
  };
  const res = await postMessages({
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    body: { ...CHAT_BODY },
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  assert.equal(seenUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
  assert.equal(seenHeaders["x-api-key"], "sk-ant-test");
  const { chunks, done, error, text } = await readTranslated(res);
  assert.equal(error, null);
  assert.equal(done, true);
  assert.deepEqual(usageFromSseBlock(text), { inputTokens: 10, outputTokens: 25 });
  assert.equal(chunks.map((chunk) => deltaOf(chunk).content).filter(Boolean).join(""), "Hi there");
  assert.equal(chunks.map((chunk) => deltaOf(chunk).reasoning_content).filter(Boolean).join(""), "Let me think");
  const toolDeltas = chunks.flatMap((chunk) => {
    const calls = deltaOf(chunk).tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
    return calls ?? [];
  });
  assert.equal(toolDeltas[0]?.index, 0);
  assert.equal(toolDeltas[0]?.id, "toolu_1");
  assert.equal(toolDeltas[0]?.function?.name, "search");
  assert.equal(toolDeltas.map((call) => call.function?.arguments ?? "").join(""), "{\"q\":\"hello\"}");
  const last = chunks[chunks.length - 1]!;
  assert.equal(finishOf(last), "tool_calls");
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 });
  assert.equal(last.id, "msg_1");
});

test("messages error after headers becomes an error event with no done", async () => {
  const stub: typeof fetch = async () => new Response(sse([
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    { event: "error", data: { type: "error", error: { type: "authentication_error", message: "bad key" } } },
  ]), { headers: { "content-type": "text/event-stream" } });
  const res = await postMessages({
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    body: { ...CHAT_BODY },
    headers: {},
    signal: AbortSignal.timeout(5000),
    fetchImpl: stub,
  });
  const { done, error } = await readTranslated(res);
  assert.equal(done, false);
  assert.deepEqual(error, { message: "bad key", type: "authentication_error" });
});

test("chat completions post through url, body and headers unchanged", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  let seenHeaders: Record<string, string> = {};
  const stub: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body));
    seenHeaders = { ...(init?.headers as Record<string, string>) };
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const body = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] };
  const headers = { authorization: "Bearer k", "content-type": "application/json", "user-agent": "useful-bot/1.0" };
  await postChatCompletions({ baseUrl: "https://opencode.ai/zen/go/v1/", body, headers, signal: AbortSignal.timeout(5000), fetchImpl: stub });
  assert.equal(seenUrl, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.deepEqual(seenBody, body);
  assert.deepEqual(seenHeaders, headers);
});

test("a length stop after a tool call becomes a tool step; plain text keeps length", () => {
  const seen = { toolCall: false };
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "long answer" } }] })}`;
  assert.equal(settleStreamBlock(text, seen), text);
  const cut = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`;
  // No tool call yet: a text-only cut is eve's to continue, unchanged.
  assert.equal(settleStreamBlock(cut, seen), cut);
  const call = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{" } }] } }] })}`;
  assert.equal(settleStreamBlock(call, seen), call);
  assert.equal(seen.toolCall, true);
  assert.match(settleStreamBlock(cut, seen), /"finish_reason":"tool_calls"/);
  assert.equal(settleStreamBlock("data: [DONE]", seen), "data: [DONE]");

  const json = { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] }, finish_reason: "length" }] };
  settleCompletion(json);
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  const plain = { choices: [{ index: 0, message: { role: "assistant", content: "cut" }, finish_reason: "length" }] };
  settleCompletion(plain);
  assert.equal(plain.choices[0].finish_reason, "length");
});

test("responses tools stay non-strict unless the chat tool says strict", () => {
  // Responses attempts strict mode when `strict` is missing, which forces
  // every optional argument; a chat tool without it must arrive non-strict.
  const strictTool = { type: "function", function: { name: "pick", parameters: { type: "object", properties: {} }, strict: true } };
  const out = buildResponsesBody({ ...CHAT_BODY, tools: [...CHAT_BODY.tools, strictTool] }, { model: "gpt-6-astra", chatgpt: true });
  const inner = ((out.tools as Array<Record<string, unknown>>)[0].tools) as Array<Record<string, unknown>>;
  assert.deepEqual(inner.map((tool) => [tool.name, tool.strict]), [["get_weather", false], ["pick", true]]);
});

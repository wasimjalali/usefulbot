import { RouterError } from "../errors.ts";
import { dumpUpstreamBody } from "../payload-probe.ts";
import { resetOf, usedLimitCode, usedLimitMessage, zaiResetOf } from "../retry-after.ts";

/**
 * openai-responses protocol (the public Responses API, also the Sign in with
 * ChatGPT route at https://api.openai.com/v1): translate the router's
 * chat-completions request into a Responses request at {baseUrl}/responses,
 * then translate the answer back to chat-completions shape so the rest of
 * the router (usage parsing, idle timers, [DONE] checks) keeps working.
 */

const DONE = "data: [DONE]\n\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contentString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function toResponsesContent(parts: unknown[]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (!isRecord(part)) throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
    if (part.type === "text" && typeof part.text === "string") return { type: "input_text", text: part.text };
    if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      return { type: "input_image", image_url: part.image_url.url };
    }
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  });
}

/**
 * The namespace every function tool goes into on the ChatGPT route (docs,
 * token-sharing-open-source/preview-limitations: "Group function/custom tools
 * in namespaces"). A replayed function_call names the same namespace.
 */
export const CHATGPT_TOOL_NAMESPACE = "useful_bot";

/** Chat messages (incl. system, tools, tool results) to Responses input. */
export function toResponsesInput(messages: unknown, namespace?: string): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of messages) {
    if (!isRecord(item) || typeof item.role !== "string") {
      throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
    }
    if (item.role === "tool") {
      if (typeof item.tool_call_id !== "string") {
        throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
      }
      out.push({ type: "function_call_output", call_id: item.tool_call_id, output: contentString(item.content) });
      continue;
    }
    if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
      const text = contentString(item.content);
      if (text) out.push({ role: "assistant", content: text });
      for (const call of item.tool_calls) {
        if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function) || typeof call.function.name !== "string") {
          throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
        }
        out.push({
          type: "function_call",
          call_id: call.id,
          ...(namespace ? { namespace } : {}),
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        });
      }
      continue;
    }
    if (Array.isArray(item.content)) {
      out.push({ role: item.role, content: toResponsesContent(item.content) });
    } else {
      out.push({ role: item.role, content: contentString(item.content) });
    }
  }
  return out;
}

function toResponsesTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  }
  return tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") {
      throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
    }
    const out: Record<string, unknown> = { type: "function", name: tool.function.name };
    if (typeof tool.function.description === "string") out.description = tool.function.description;
    if (tool.function.parameters !== undefined) out.parameters = tool.function.parameters;
    // A Chat Completions tool with no `strict` is non-strict, while the
    // Responses API attempts strict mode when `strict` is left out, which
    // makes every optional field required: the model then fills them with
    // filler (`list_bots` got botId " " and "*"). Keep the chat meaning.
    out.strict = typeof tool.function.strict === "boolean" ? tool.function.strict : false;
    return out;
  });
}

function toResponsesToolChoice(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { type: "function", name: choice.function.name };
  }
  throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
}

/**
 * The ChatGPT route takes the system prompt as `instructions`, so a turn with
 * no system message still carries one.
 */
export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** The text of a system row, or null when it carries anything but text. */
function textOnly(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null;
    if (part.text) texts.push(part.text);
  }
  return texts.join("\n");
}

/**
 * The ChatGPT route takes the system prompt as `instructions`, not as a system
 * row in `input` (explicit system items are rejected). The leading run of
 * system messages becomes `instructions`; a system message later in the
 * history keeps its place as a `developer` row.
 */
export function splitChatGptInstructions(messages: unknown): { instructions: string; messages: unknown[] } {
  if (!Array.isArray(messages)) {
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  }
  const lead: string[] = [];
  let index = 0;
  while (index < messages.length) {
    const item = messages[index];
    if (!isRecord(item) || item.role !== "system") break;
    // A system row with an image or other non-text part stays in the input
    // as a developer row, so that content still reaches the model.
    const text = textOnly(item.content);
    if (text === null) break;
    if (text) lead.push(text);
    index += 1;
  }
  const rest = messages.slice(index).map((item) => (
    isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item
  ));
  return { instructions: lead.join("\n\n") || DEFAULT_INSTRUCTIONS, messages: rest };
}

/**
 * The router's chat body (post applyReasoning) to a Responses request.
 *
 * `chatgpt` is the Sign in with ChatGPT route on api.openai.com. It is
 * stricter than a plain API-key call (docs: token-sharing-open-source/
 * preview-limitations): `store` must be false, the call must stream,
 * `instructions` must be present and non-empty, `max_output_tokens` and
 * `service_tier` are refused, and function tools go in one namespace.
 */
export function buildResponsesBody(
  chatBody: Record<string, unknown>,
  opts: { model: string; chatgpt: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: opts.model,
    stream: opts.chatgpt || chatBody.stream === true,
    store: false,
  };
  if (opts.chatgpt) {
    out.include = ["reasoning.encrypted_content"];
    const split = splitChatGptInstructions(chatBody.messages);
    out.instructions = split.instructions;
    out.input = toResponsesInput(split.messages, CHATGPT_TOOL_NAMESPACE);
  } else {
    out.input = toResponsesInput(chatBody.messages);
  }
  if (chatBody.tools !== undefined) {
    const tools = toResponsesTools(chatBody.tools);
    // The ChatGPT route takes no empty namespace: with no tools, none is set.
    if (!opts.chatgpt) out.tools = tools;
    else if (tools.length > 0) {
      out.tools = [{ type: "namespace", name: CHATGPT_TOOL_NAMESPACE, description: "Useful Bot tools.", tools }];
    }
  }
  // The ChatGPT route takes no tool_choice without tools.
  if (chatBody.tool_choice !== undefined && (!opts.chatgpt || out.tools !== undefined)) {
    out.tool_choice = toResponsesToolChoice(chatBody.tool_choice);
  }
  if (!opts.chatgpt && typeof chatBody.max_tokens === "number") out.max_output_tokens = chatBody.max_tokens;
  if (typeof chatBody.reasoning_effort === "string") out.reasoning = { effort: chatBody.reasoning_effort };
  if (!opts.chatgpt && typeof chatBody.service_tier === "string") out.service_tier = chatBody.service_tier;
  // Routes this chat's requests to the same cache. Set by the router per
  // caller, session, connection and model; never derived from a secret.
  if (typeof chatBody.prompt_cache_key === "string") out.prompt_cache_key = chatBody.prompt_cache_key;
  return out;
}

function responsesUsage(usage: unknown): Record<string, unknown> | null {
  if (!isRecord(usage)) return null;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  // Responses counts cached tokens inside input_tokens, the same as the chat shape.
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const cached = typeof details?.cached_tokens === "number" ? details.cached_tokens : null;
  const written = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : null;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : usage.input_tokens + usage.output_tokens,
    ...(cached !== null || written !== null
      ? { prompt_tokens_details: { ...(cached !== null ? { cached_tokens: cached } : {}), ...(written !== null ? { cache_write_tokens: written } : {}) } }
      : {}),
  };
}

function incompleteIsLength(details: unknown): boolean {
  return isRecord(details) && details.reason === "max_output_tokens";
}

function responsesFinish(status: unknown, details: unknown, hasTools: boolean): string {
  if (hasTools) return "tool_calls";
  if (status === "incomplete" || incompleteIsLength(details)) return "length";
  return "stop";
}

/** Non-stream Responses JSON to a chat.completion. */
export function translateResponsesJson(payload: unknown, model: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    if (item.type === "function_call") {
      const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : null;
      if (typeof item.name !== "string" || !id) continue;
      toolCalls.push({
        id,
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: texts.join("") || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = responsesFinish(payload.status, payload.incomplete_details, toolCalls.length > 0);
  const usage = responsesUsage(payload.usage);
  const out: Record<string, unknown> = {
    id: typeof payload.id === "string" ? payload.id : "chatcmpl-resp",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (usage) out.usage = usage;
  return out;
}

interface ResponsesStreamState {
  id: string;
  model: string;
  created: number;
  started: boolean;
  tools: Map<string, { index: number; id: string; name: string; headerSent: boolean }>;
  toolCount: number;
  errored: boolean;
  enqueue: (line: string) => void;
  onRefusal?: ModelRefusalHook;
}

/**
 * Called for a plan-sharing refusal that can be about the model
 * (subscription_sharing_unsupported_capability with `param` model or absent,
 * subscription_sharing_user_not_eligible). A string answer replaces the
 * error code the app sees; null leaves the usual mapping.
 */
export type ModelRefusalHook = (refusal: { code: string; param: string | null }) => string | null;

function chunk(state: ResponsesStreamState, delta: Record<string, unknown>): void {
  if (!state.started) {
    state.started = true;
    delta = { role: "assistant", ...delta };
  }
  state.enqueue(`data: ${JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function toolEntry(state: ResponsesStreamState, key: string, fallback: { id?: unknown; name?: unknown }): { index: number; id: string; name: string; headerSent: boolean } {
  let entry = state.tools.get(key);
  if (!entry) {
    entry = {
      index: state.toolCount++,
      id: typeof fallback.id === "string" ? fallback.id : key,
      name: typeof fallback.name === "string" ? fallback.name : "",
      headerSent: false,
    };
    state.tools.set(key, entry);
  }
  return entry;
}

function applyResponsesEvent(state: ResponsesStreamState, event: Record<string, unknown>): "done" | "error" | "open" {
  const type = event.type;
  if (typeof type !== "string") return "open";
  if (type === "response.created" && isRecord(event.response) && typeof event.response.id === "string") {
    state.id = event.response.id;
    return "open";
  }
  if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
    chunk(state, { content: event.delta });
    return "open";
  }
  if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string" && event.delta) {
    chunk(state, { reasoning_content: event.delta });
    return "open";
  }
  if (type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
    const key = typeof event.output_index === "number"
      ? `index:${event.output_index}`
      : typeof event.item.id === "string" ? event.item.id : null;
    if (key) {
      toolEntry(state, key, {
        id: typeof event.item.call_id === "string" ? event.item.call_id : event.item.id,
        name: event.item.name,
      });
    }
    return "open";
  }
  if (type === "response.function_call_arguments.delta" && typeof event.delta === "string" && event.delta) {
    const key = typeof event.output_index === "number"
      ? `index:${event.output_index}`
      : typeof event.item_id === "string" ? event.item_id : null;
    if (!key) return "open";
    const entry = toolEntry(state, key, {});
    if (!entry.headerSent) {
      entry.headerSent = true;
      chunk(state, { tool_calls: [{ index: entry.index, id: entry.id, function: { name: entry.name, arguments: event.delta } }] });
    } else {
      chunk(state, { tool_calls: [{ index: entry.index, function: { arguments: event.delta } }] });
    }
    return "open";
  }
  if (type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
    const key = typeof event.output_index === "number"
      ? `index:${event.output_index}`
      : typeof event.item.id === "string" ? event.item.id : null;
    if (key) {
      toolEntry(state, key, {
        id: typeof event.item.call_id === "string" ? event.item.call_id : event.item.id,
        name: event.item.name,
      });
    }
    return "open";
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const inner = isRecord(event.response) ? event.response : event;
    const usage = responsesUsage(inner.usage);
    const finish = responsesFinish(
      type === "response.incomplete" ? "incomplete" : inner.status,
      inner.incomplete_details,
      state.toolCount > 0,
    );
    state.enqueue(`data: ${JSON.stringify({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`);
    return "done";
  }
  if (type === "error" || type === "response.failed") {
    const inner = isRecord(event.error) ? event.error : isRecord(event.response) && isRecord(event.response.error) ? event.response.error : null;
    const error: Record<string, unknown> = {
      message: typeof inner?.message === "string" && inner.message ? inner.message : "upstream_protocol_error",
    };
    if (typeof inner?.code === "string") error.code = inner.code;
    if (typeof inner?.type === "string") error.type = inner.type;
    // A plan or credit that runs out mid-stream gets the same code as one
    // refused up front, so the app names it the same way.
    const code = typeof error.code === "string" ? error.code : "";
    const said = typeof inner?.message === "string" ? inner.message : "";
    const replaced = state.onRefusal && (code === "subscription_sharing_unsupported_capability" || code === "subscription_sharing_user_not_eligible")
      ? state.onRefusal({ code, param: typeof inner?.param === "string" ? inner.param : null })
      : null;
    const used = replaced ? null : usedLimitCode(typeof error.type === "string" ? error.type : "", code, said);
    if (replaced) {
      error.code = replaced;
      error.message = replaced;
    } else if (used) {
      error.code = used;
      error.message = usedLimitMessage(used, (inner ? resetOf(inner) : undefined) ?? zaiResetOf(code, said));
    } else if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable") {
      // Temporary on the plan-sharing side: the retryable code, same as one refused up front.
      error.code = "upstream_unavailable";
      error.message = "upstream_unavailable";
    }
    state.enqueue(`data: ${JSON.stringify({ error })}\n\n`);
    return "error";
  }
  return "open";
}

/** Vendor SSE to chat.completion.chunk SSE, ending in [DONE] or an error. */
export async function translateResponsesStream(upstream: Response, model: string, onRefusal?: ModelRefusalHook): Promise<Response> {
  const created = Math.floor(Date.now() / 1000);
  if (!upstream.body) return new Response(DONE, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let state: ResponsesStreamState | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      state = {
        id: "chatcmpl-resp",
        model,
        created,
        started: false,
        tools: new Map(),
        toolCount: 0,
        errored: false,
        onRefusal,
        enqueue: (line: string) => controller.enqueue(new TextEncoder().encode(line)),
      };
      let buffered = "";
      const settle = (kind: "done" | "error") => {
        if (kind === "done") controller.enqueue(new TextEncoder().encode(DONE));
        else if (state) state.errored = true;
        controller.close();
      };
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          const blocks = buffered.split(/\r?\n\r?\n/);
          buffered = blocks.pop() ?? "";
          for (const block of blocks) {
            for (const line of block.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let event: unknown = null;
              try {
                event = JSON.parse(data);
              } catch {
                continue;
              }
              if (!isRecord(event) || !state) continue;
              const outcome = applyResponsesEvent(state, event);
              if (outcome === "done") {
                await reader.cancel().catch(() => undefined);
                settle("done");
                return;
              }
              if (outcome === "error") {
                await reader.cancel().catch(() => undefined);
                settle("error");
                return;
              }
            }
          }
        }
        // The vendor closed without a completed event. Empty answers still
        // close the chat stream cleanly; anything half written is a cut.
        if (state && !state.errored) {
          if (!state.started && state.toolCount === 0) {
            settle("done");
          } else {
            state.enqueue(`data: ${JSON.stringify({ error: { message: "upstream_protocol_error" } })}\n\n`);
            settle("error");
          }
        } else {
          controller.close();
        }
      } catch {
        try {
          state?.enqueue(`data: ${JSON.stringify({ error: { message: "upstream_protocol_error" } })}\n\n`);
        } catch { /* controller already closed */ }
        try {
          controller.close();
        } catch { /* ignore */ }
      }
    },
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  });
  return new Response(stream, {
    status: upstream.status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/**
 * A caller that did not ask to stream (the reviewer) still has to stream on
 * the ChatGPT backend. The translated chunks fold back into the one
 * chat.completion the caller expects; an error event becomes the 502 the
 * non-stream path already raises for a malformed answer.
 */
export async function collectChatCompletion(translated: Response, model: string): Promise<Response> {
  const text = await translated.text();
  const texts: string[] = [];
  const reasoning: string[] = [];
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let usage: unknown = undefined;
  let id = "chatcmpl-resp";
  let errored: Record<string, unknown> | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: unknown = null;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      if (isRecord(event.error)) {
        errored = event.error;
        continue;
      }
      if (typeof event.id === "string") id = event.id;
      if (event.usage !== undefined) usage = event.usage;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string") texts.push(delta.content);
        if (typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!isRecord(call) || typeof call.index !== "number") continue;
            const fn = isRecord(call.function) ? call.function : {};
            const entry = tools.get(call.index) ?? { id: "", name: "", arguments: "" };
            if (typeof call.id === "string") entry.id = call.id;
            if (typeof fn.name === "string") entry.name = fn.name;
            if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
            tools.set(call.index, entry);
          }
        }
      }
    }
  }
  if (errored) {
    throw new RouterError({
      status: 502,
      type: "upstream_error",
      code: "upstream_protocol_error",
      message: typeof errored.message === "string" && errored.message ? errored.message : "upstream_protocol_error",
    });
  }
  const message: Record<string, unknown> = { role: "assistant", content: texts.join("") || null };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("");
  const toolCalls = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } }));
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const out: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop") }],
  };
  if (usage !== undefined) out.usage = usage;
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
}

export async function postResponses(input: {
  baseUrl: string;
  model: string;
  chatgpt: boolean;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  onRefusal?: ModelRefusalHook;
}): Promise<Response> {
  const outgoing = buildResponsesBody(input.body, { model: input.model, chatgpt: input.chatgpt });
  dumpUpstreamBody("openai-responses", input.model, outgoing);
  const url = `${input.baseUrl.replace(/\/$/, "")}/responses`;
  const res = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(outgoing),
    redirect: "manual",
    signal: input.signal,
  });
  if (!res.ok) return res;
  if (outgoing.stream === true) {
    const translated = await translateResponsesStream(res, input.model, input.onRefusal);
    // The caller did not stream; the ChatGPT route made this call stream anyway.
    return input.body.stream === true ? translated : collectChatCompletion(translated, input.model);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
  }
  const translated = translateResponsesJson(raw, input.model);
  return new Response(JSON.stringify(translated), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

import { RouterError } from "../errors.ts";

/**
 * anthropic-messages protocol: translate the router's chat-completions
 * request into a Messages request at {baseUrl}/messages, then translate
 * the answer back to chat-completions shape so the rest of the router
 * (usage parsing, idle timers, [DONE] checks) keeps working.
 */

const DONE = "data: [DONE]\n\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolError(): RouterError {
  return new RouterError({ status: 502, type: "upstream_error", code: "upstream_protocol_error", message: "upstream_protocol_error" });
}

function contentString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

function toAnthropicImage(url: string): Record<string, unknown> {
  const match = DATA_URL.exec(url);
  const data = match?.[3];
  if (!match || match[2] !== ";base64" || !data) throw protocolError();
  return { type: "image", source: { type: "base64", media_type: match[1] || "image/png", data } };
}

function toAnthropicContent(parts: unknown[]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (!isRecord(part)) throw protocolError();
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      return toAnthropicImage(part.image_url.url);
    }
    throw protocolError();
  });
}

function toolInput(args: unknown): Record<string, unknown> {
  if (typeof args !== "string" || !args) return {};
  try {
    const parsed = JSON.parse(args) as unknown;
    if (isRecord(parsed)) return parsed;
    throw new RouterError({ status: 400, type: "invalid_request_error", code: "invalid_request", message: "invalid_request" });
  } catch (error) {
    if (error instanceof RouterError) throw error;
    throw new RouterError({ status: 400, type: "invalid_request_error", code: "invalid_request", message: "invalid_request" });
  }
}

/**
 * Reasoning budgets are the catalogue tiers from shared/models.ts
 * THINKING_BUDGET, reversed: the router applied effort before this adapter
 * runs, so map the budget back to the effort name for output_config.
 * Provisional per the research digest; unknown budgets keep adaptive
 * thinking with no effort pinned.
 */
const BUDGET_TO_EFFORT: Record<number, string> = {
  1024: "low",
  4096: "medium",
  16384: "high",
  32768: "xhigh",
  65536: "max",
};

function toAnthropicTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) throw protocolError();
  return tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") throw protocolError();
    const out: Record<string, unknown> = {
      name: tool.function.name,
      input_schema: isRecord(tool.function.parameters) ? tool.function.parameters : { type: "object" },
    };
    if (typeof tool.function.description === "string") out.description = tool.function.description;
    return out;
  });
}

function toAnthropicToolChoice(choice: unknown): Record<string, unknown> {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { type: "tool", name: choice.function.name };
  }
  throw protocolError();
}

/** The router's chat body (post applyReasoning) to a Messages request. */

/**
 * Messages rejects two user turns in a row. Tool results are user content,
 * so a tool result followed by user text (a turn that ended mid tool loop)
 * merges into one user message instead.
 */
function pushUser(messages: Array<Record<string, unknown>>, content: Array<Record<string, unknown>>): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    last.content = [...(last.content as Array<Record<string, unknown>>), ...content];
    return;
  }
  messages.push({ role: "user", content });
}

export function buildMessagesBody(
  chatBody: Record<string, unknown>,
  opts: { model: string },
): Record<string, unknown> {
  if (!Array.isArray(chatBody.messages)) throw protocolError();
  if (typeof chatBody.max_tokens !== "number") throw protocolError();
  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let toolResults: Array<Record<string, unknown>> = [];
  const flushTools = () => {
    if (toolResults.length > 0) {
      pushUser(messages, toolResults);
      toolResults = [];
    }
  };
  for (const item of chatBody.messages) {
    if (!isRecord(item) || typeof item.role !== "string") throw protocolError();
    if (item.role === "system") {
      const text = contentString(item.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (item.role === "tool") {
      if (typeof item.tool_call_id !== "string") throw protocolError();
      toolResults.push({ type: "tool_result", tool_use_id: item.tool_call_id, content: contentString(item.content) });
      continue;
    }
    flushTools();
    if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
      const content: Array<Record<string, unknown>> = [];
      const text = contentString(item.content);
      if (text) content.push({ type: "text", text });
      for (const call of item.tool_calls) {
        if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function) || typeof call.function.name !== "string") {
          throw protocolError();
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (Array.isArray(item.content)) {
      if (item.role !== "user") throw protocolError();
      pushUser(messages, toAnthropicContent(item.content));
    } else if (item.role === "user") {
      pushUser(messages, [{ type: "text", text: contentString(item.content) }]);
    } else if (item.role === "assistant") {
      messages.push({ role: "assistant", content: contentString(item.content) });
    } else {
      throw protocolError();
    }
  }
  flushTools();
  const out: Record<string, unknown> = {
    model: opts.model,
    stream: chatBody.stream === true,
    max_tokens: chatBody.max_tokens,
    messages,
  };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  if (chatBody.tools !== undefined) out.tools = toAnthropicTools(chatBody.tools);
  if (chatBody.tool_choice !== undefined) out.tool_choice = toAnthropicToolChoice(chatBody.tool_choice);
  if (isRecord(chatBody.thinking) && typeof chatBody.thinking.budget_tokens === "number") {
    out.thinking = { type: "adaptive" };
    const effort = BUDGET_TO_EFFORT[chatBody.thinking.budget_tokens];
    if (effort) out.output_config = { effort };
  }
  return out;
}

function anthropicFinish(stopReason: unknown, hasTools: boolean): string {
  if (hasTools || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function anthropicUsage(input: unknown, output: unknown): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/** Non-stream Messages JSON to a chat.completion. */
export function translateMessagesJson(payload: unknown, model: string): Record<string, unknown> {
  if (!isRecord(payload)) throw protocolError();
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const texts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: isRecord(block.input) ? JSON.stringify(block.input) : "{}" },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: texts.join("") || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = anthropicUsage(
    isRecord(payload.usage) ? payload.usage.input_tokens : null,
    isRecord(payload.usage) ? payload.usage.output_tokens : null,
  );
  const out: Record<string, unknown> = {
    id: typeof payload.id === "string" ? payload.id : "chatcmpl-msg",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: anthropicFinish(payload.stop_reason, toolCalls.length > 0) }],
  };
  if (usage) out.usage = usage;
  return out;
}

interface MessagesStreamState {
  id: string;
  model: string;
  created: number;
  started: boolean;
  blocks: Map<number, { kind: "text" | "thinking" | "tool" | "ignore"; id: string; name: string; toolIndex: number; headerSent: boolean }>;
  toolCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: unknown;
  errored: boolean;
  enqueue: (line: string) => void;
}

function mchunk(state: MessagesStreamState, delta: Record<string, unknown>): void {
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

function applyMessagesEvent(state: MessagesStreamState, event: Record<string, unknown>): "done" | "error" | "open" {
  const type = event.type;
  if (typeof type !== "string") return "open";
  if (type === "message_start" && isRecord(event.message)) {
    if (typeof event.message.id === "string") state.id = event.message.id;
    const usage = event.message.usage;
    if (isRecord(usage) && typeof usage.input_tokens === "number") state.inputTokens = usage.input_tokens;
    return "open";
  }
  if (type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
    const block = event.content_block;
    if (block.type === "text") {
      state.blocks.set(event.index, { kind: "text", id: "", name: "", toolIndex: -1, headerSent: false });
    } else if (block.type === "thinking") {
      state.blocks.set(event.index, { kind: "thinking", id: "", name: "", toolIndex: -1, headerSent: false });
    } else if (block.type === "tool_use") {
      state.blocks.set(event.index, {
        kind: "tool",
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        toolIndex: state.toolCount++,
        headerSent: false,
      });
    } else {
      state.blocks.set(event.index, { kind: "ignore", id: "", name: "", toolIndex: -1, headerSent: false });
    }
    return "open";
  }
  if (type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
    const block = state.blocks.get(event.index);
    if (!block) return "open";
    const delta = event.delta;
    if (block.kind === "text" && delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      mchunk(state, { content: delta.text });
    } else if (block.kind === "thinking" && delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      mchunk(state, { reasoning_content: delta.thinking });
    } else if (block.kind === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
      if (!block.headerSent) {
        block.headerSent = true;
        mchunk(state, {
          tool_calls: [{ index: block.toolIndex, id: block.id, function: { name: block.name, arguments: delta.partial_json } }],
        });
      } else {
        mchunk(state, { tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] });
      }
    }
    return "open";
  }
  if (type === "message_delta" && isRecord(event.delta)) {
    state.stopReason = event.delta.stop_reason;
    if (isRecord(event.usage) && typeof event.usage.output_tokens === "number") state.outputTokens = event.usage.output_tokens;
    return "open";
  }
  if (type === "message_stop") {
    const usage = anthropicUsage(state.inputTokens, state.outputTokens);
    state.enqueue(`data: ${JSON.stringify({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: anthropicFinish(state.stopReason, state.toolCount > 0) }],
      ...(usage ? { usage } : {}),
    })}\n\n`);
    return "done";
  }
  if (type === "error") {
    const inner = isRecord(event.error) ? event.error : null;
    const error: Record<string, unknown> = {
      message: typeof inner?.message === "string" && inner.message ? inner.message : "upstream_protocol_error",
    };
    if (typeof inner?.code === "string") error.code = inner.code;
    if (typeof inner?.type === "string") error.type = inner.type;
    state.enqueue(`data: ${JSON.stringify({ error })}\n\n`);
    return "error";
  }
  return "open";
}

/** Vendor SSE to chat.completion.chunk SSE, ending in [DONE] or an error. */
export async function translateMessagesStream(upstream: Response, model: string): Promise<Response> {
  const created = Math.floor(Date.now() / 1000);
  if (!upstream.body) {
    return new Response(DONE, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let state: MessagesStreamState | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      state = {
        id: "chatcmpl-msg",
        model,
        created,
        started: false,
        blocks: new Map(),
        toolCount: 0,
        inputTokens: null,
        outputTokens: null,
        stopReason: null,
        errored: false,
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
            let data: string | null = null;
            for (const line of block.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.startsWith("data:")) data = `${data ?? ""}${trimmed.slice(5).trim()}`;
            }
            if (!data || data === "[DONE]") continue;
            let event: unknown = null;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (!isRecord(event) || !state) continue;
            const outcome = applyMessagesEvent(state, event);
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

export async function postMessages(input: {
  baseUrl: string;
  model: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const outgoing = buildMessagesBody(input.body, { model: input.model });
  const url = `${input.baseUrl.replace(/\/$/, "")}/messages`;
  const res = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { ...input.headers, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(outgoing),
    redirect: "manual",
    signal: input.signal,
  });
  if (!res.ok) return res;
  if (outgoing.stream === true) return translateMessagesStream(res, input.model);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw protocolError();
  }
  const translated = translateMessagesJson(raw, input.model);
  return new Response(JSON.stringify(translated), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

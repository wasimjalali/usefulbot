import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An OpenAI-compatible /v1/chat/completions server on a random loopback port,
 * scripted per test. It stands in for the Useful Bot router: the engine under
 * test talks to it exactly as it talks to the real one, and every request is
 * recorded (headers and parsed body) so a test can assert on what Pi sent.
 */

export type FakeUsage = { prompt_tokens: number; completion_tokens: number; total_tokens?: number };

export type FakeToolCall = { id?: string; name: string; args: unknown };

export type FakeReply =
  /** A plain answer, streamed in `chunks` pieces. */
  | { kind: "text"; text: string; chunks?: number; usage?: FakeUsage; delayMs?: number }
  /** One assistant message that calls tools (optionally with text before them). */
  | { kind: "tools"; calls: FakeToolCall[]; text?: string; usage?: FakeUsage }
  /** The model ran out of output tokens mid-call (`finish_reason: "length"`). */
  | { kind: "length"; text?: string; partialCall?: { name: string; argsPrefix: string }; usage?: FakeUsage }
  /** An HTTP error in the router's error shape. */
  | { kind: "error"; status: number; code?: string; message?: string; retryAfterMs?: number; headers?: Record<string, string> }
  /** Streams `text`, then waits until the client goes away or `release()` is called. */
  | { kind: "stall"; text: string }
  /** Streams `text`, then drops the connection mid-answer. */
  | { kind: "cut"; text: string }
  /** Never answers until the client goes away. */
  | { kind: "hang" };

export type RecordedRequest = {
  n: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  at: number;
};

type Message = { role?: string; tool_calls?: { id?: string }[]; tool_call_id?: string };

/**
 * The router's pairing rules for a transcript: every tool call is answered by
 * its tool message right after it, and a tool message answers a call that was
 * made. Returns the first problem, or null.
 */
export function checkMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return "messages_not_array";
  let open = new Set<string>();
  for (const [at, message] of (messages as Message[]).entries()) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !open.has(message.tool_call_id)) return `orphan_tool_result_at_${at}`;
      open.delete(message.tool_call_id);
      continue;
    }
    if (open.size > 0) return `unanswered_tool_call_before_${at}`;
    open = new Set((message.tool_calls ?? []).map((call) => String(call.id)));
  }
  if (open.size > 0) return "unanswered_tool_call_at_end";
  return null;
}

export type FakeRouter = {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  /** Requests refused because they broke the pairing rules or hit a busy session. */
  refused: { n: number; code: string; problem: string }[];
  /** Queue replies in order. When the queue is empty the fallback answers. */
  enqueue(...replies: FakeReply[]): void;
  /** Replaces the fallback used when the queue is empty (default: a short text answer). */
  fallback(reply: FakeReply | ((request: RecordedRequest) => FakeReply)): void;
  /** Lets every stalled response finish. */
  release(): void;
  close(): Promise<void>;
};

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usageChunk(usage: FakeUsage): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [],
    usage: { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens },
  };
}

function pieces(text: string, count: number): string[] {
  if (count <= 1 || text.length <= 1) return [text];
  const size = Math.ceil(text.length / count);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startFakeRouter(): Promise<FakeRouter> {
  const queue: FakeReply[] = [];
  let fallbackReply: FakeReply | ((request: RecordedRequest) => FakeReply) = { kind: "text", text: "ok" };
  const requests: RecordedRequest[] = [];
  const refused: FakeRouter["refused"] = [];
  const active = new Set<string>();
  const stalled = new Set<() => void>();
  const sockets = new Set<ServerResponse>();

  async function reply(res: ServerResponse, request: RecordedRequest, next: FakeReply): Promise<void> {
    if (next.kind === "error") {
      const headers: Record<string, string> = { "content-type": "application/json", ...(next.headers ?? {}) };
      if (next.retryAfterMs !== undefined && !headers["retry-after"]) headers["retry-after"] = String(Math.ceil(next.retryAfterMs / 1000));
      res.writeHead(next.status, headers);
      res.end(JSON.stringify({
        error: {
          type: next.status === 429 ? "rate_limit_error" : "upstream_error",
          code: next.code ?? "upstream_unavailable",
          message: next.message ?? "The provider didn't answer.",
          request_id: String(request.headers["x-useful-request-id"] ?? ""),
          retryable: true,
          ...(next.retryAfterMs !== undefined ? { retry_after_ms: next.retryAfterMs } : {}),
        },
      }));
      return;
    }
    if (next.kind === "hang") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      await new Promise<void>((resolve) => res.on("close", resolve));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    sse(res, chunk({ role: "assistant", content: "" }));
    if (next.kind === "cut") {
      sse(res, chunk({ content: next.text }));
      await sleep(30);
      res.destroy();
      return;
    }
    if (next.kind === "text" || next.kind === "stall") {
      const parts = pieces(next.text, next.kind === "text" ? next.chunks ?? 1 : 2);
      for (const part of parts) {
        sse(res, chunk({ content: part }));
        if (next.kind === "text" && next.delayMs) await sleep(next.delayMs);
      }
      if (next.kind === "stall") {
        await new Promise<void>((resolve) => {
          const done = () => { stalled.delete(done); resolve(); };
          stalled.add(done);
          res.on("close", done);
        });
        if (res.destroyed) return;
      }
      sse(res, chunk({}, "stop"));
      sse(res, usageChunk(next.kind === "text" && next.usage ? next.usage : { prompt_tokens: 20, completion_tokens: Math.max(1, Math.ceil(next.text.length / 4)) }));
    } else if (next.kind === "tools") {
      if (next.text) sse(res, chunk({ content: next.text }));
      next.calls.forEach((call, index) => {
        const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
        sse(res, chunk({
          tool_calls: [{ index, id: call.id ?? `call_${request.n}_${index}`, type: "function", function: { name: call.name, arguments: "" } }],
        }));
        const half = Math.ceil(args.length / 2);
        for (const part of [args.slice(0, half), args.slice(half)]) {
          if (part) sse(res, chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
        }
      });
      sse(res, chunk({}, "tool_calls"));
      sse(res, usageChunk(next.usage ?? { prompt_tokens: 30, completion_tokens: 12 }));
    } else if (next.kind === "length") {
      if (next.text) sse(res, chunk({ content: next.text }));
      if (next.partialCall) {
        sse(res, chunk({
          tool_calls: [{ index: 0, id: `call_${request.n}_cut`, type: "function", function: { name: next.partialCall.name, arguments: next.partialCall.argsPrefix } }],
        }));
      }
      sse(res, chunk({}, "length"));
      sse(res, usageChunk(next.usage ?? { prompt_tokens: 30, completion_tokens: 4096 }));
    }
    sse(res, "[DONE]");
    res.end();
  }

  function refuseReason(request: RecordedRequest): { code: string; problem: string } | null {
    const problem = checkMessages(request.body.messages);
    if (problem) return { code: "invalid_request", problem };
    const session = request.headers["x-useful-session-id"];
    if (session && active.has(session)) return { code: "session_busy", problem: "one model call per session" };
    return null;
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (piece: Buffer) => chunks.push(piece));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: req.url } }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // A malformed body is recorded as empty; the test that cares asserts on it.
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value.join(",") : String(value ?? "");
      const request: RecordedRequest = { n: requests.length, headers, body, at: Date.now() };
      requests.push(request);
      const refusal = refuseReason(request);
      if (refusal) {
        refused.push({ n: request.n, ...refusal });
        res.writeHead(refusal.code === "session_busy" ? 409 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: refusal.code, message: refusal.problem } }));
        return;
      }
      const next = queue.shift() ?? (typeof fallbackReply === "function" ? fallbackReply(request) : fallbackReply);
      const sessionKey = request.headers["x-useful-session-id"];
      if (sessionKey) {
        active.add(sessionKey);
        res.on("finish", () => active.delete(sessionKey));
        res.on("close", () => active.delete(sessionKey));
      }
      sockets.add(res);
      res.on("close", () => sockets.delete(res));
      void reply(res, request, next).catch(() => {
        if (!res.destroyed) res.destroy();
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    refused,
    enqueue: (...replies) => { queue.push(...replies); },
    fallback: (next) => { fallbackReply = next; },
    release: () => { for (const done of [...stalled]) done(); },
    close: () => new Promise<void>((resolve) => {
      for (const res of sockets) res.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

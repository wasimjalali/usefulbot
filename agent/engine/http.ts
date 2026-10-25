import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Engine } from "./engine.ts";
import { EngineError, type EngineEvent } from "./protocol.ts";
import { PI_VERSION_STRING } from "./pi-host.ts";

/**
 * The engine's HTTP surface (SPEC 5.1, 6): loopback only, a bearer token on
 * everything but /health, a Host check, no browser origin. The web service
 * proxies the chat routes here; the /internal routes are the web service's own.
 */

export const TURN_BODY_MAX = 8 * 1024 * 1024;
export const BODY_MAX = 64 * 1024;
const PING_MS = 15_000;
/** A client that cannot keep up with its stream is dropped and reconnects with `after`. */
const STREAM_BACKLOG_MAX = 4 * 1024 * 1024;

export type HttpOptions = {
  token: string;
  port: number;
  stack: string;
  /** Null until boot finishes: every route but /health answers 503 `engine_starting`. */
  engine: () => Engine | null;
  pingMs?: number;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof EngineError) {
    send(res, error.status, { ok: false, error: error.code, ...error.fields });
    return;
  }
  // The stack stays in the log; the caller gets the code only.
  console.error(JSON.stringify({ event: "route_failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
  send(res, 500, { ok: false, error: "engine_error" });
}

/**
 * Reads a JSON body up to `max` bytes. A body over the cap is read to its end
 * and thrown away, so the client can finish sending and read the 413 instead of
 * meeting a reset.
 */
function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size > max) {
        reject(new EngineError(413, "body_too_large"));
        return;
      }
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new EngineError(400, "invalid_json"));
      }
    });
  });
}

function int(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new EngineError(400, "invalid_query");
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EngineError(400, "invalid_body");
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== "string" || value === "" || value.length > max) throw new EngineError(400, "invalid_body", { field });
  return value;
}

const ROW_KINDS = {
  note: ["text"],
  image: ["imageId"],
  page: ["mediaId", "title", "path"],
  // The engine knows which connection and tool the call was; the web service names only the call.
  widget: ["widgetId", "callId"],
  card: ["proposalId"],
} as const;

/** A row the web service files (connect notes, widget rows, cards), validated by kind. */
function internalRow(body: Record<string, unknown>) {
  const key = str(body.key, "key", 200);
  const kind = body.kind;
  if (typeof kind !== "string" || !(kind in ROW_KINDS)) throw new EngineError(400, "invalid_body", { field: "kind" });
  const row: Record<string, unknown> = { key, kind };
  for (const field of ROW_KINDS[kind as keyof typeof ROW_KINDS]) row[field] = str(body[field], field);
  if (kind === "image" && typeof body.prompt === "string") row.prompt = body.prompt.slice(0, 32_000);
  if (kind === "note") {
    const source = body.source;
    row.source = source === "routine" || source === "system" ? source : "connect";
  }
  return row;
}

export function createEngineServer(options: HttpOptions): Server {
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, "127.0.0.1"]);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (!allowedHosts.has(req.headers.host ?? "")) {
      send(res, 421, { ok: false, error: "misdirected_request" });
      return;
    }
    if (req.headers.origin !== undefined) {
      send(res, 403, { ok: false, error: "origin_refused" });
      return;
    }
    const engine = options.engine();
    if (method === "GET" && path === "/health") {
      send(res, 200, { ok: true, stack: options.stack, epoch: engine?.epoch ?? null, pi: PI_VERSION_STRING });
      return;
    }
    if (!tokenMatches(req.headers.authorization, options.token)) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!engine) {
      send(res, 503, { ok: false, error: "engine_starting" });
      return;
    }

    const parts = path.split("/").filter(Boolean);
    const [head, second, third, fourth] = parts;

    if (head === "status" && parts.length === 1 && method === "GET") {
      send(res, 200, engine.status());
      return;
    }

    if (head === "chats") {
      if (parts.length === 1 && method === "GET") {
        send(res, 200, engine.listChats({
          botId: url.searchParams.get("botId") ?? undefined,
          before: url.searchParams.get("before") ?? undefined,
          limit: int(url.searchParams.get("limit")),
          includeFixtures: url.searchParams.get("includeFixtures") === "1",
        }));
        return;
      }
      if (parts.length === 1 && method === "POST") {
        const body = record(await readBody(req, BODY_MAX));
        send(res, 200, engine.createChat(str(body.botId, "botId", 200)));
        return;
      }
      if (second === "search" && parts.length === 2 && method === "GET") {
        send(res, 200, engine.searchChats(url.searchParams.get("q") ?? "", int(url.searchParams.get("limit"))));
        return;
      }
      if (second && parts.length === 2 && method === "PATCH") {
        const body = record(await readBody(req, BODY_MAX));
        engine.renameChat(second, str(body.title, "title", 1_000));
        send(res, 200, { ok: true });
        return;
      }
      if (second && parts.length === 2 && method === "DELETE") {
        send(res, 200, { ok: true, ...engine.deleteChat(second) });
        return;
      }
      if (second && third === "open" && parts.length === 3 && method === "POST") {
        engine.openChat(second);
        send(res, 200, { ok: true });
        return;
      }
      if (second && third === "rows" && parts.length === 3 && method === "GET") {
        send(res, 200, engine.rows(second, { before: url.searchParams.get("before") ?? undefined, limit: int(url.searchParams.get("limit")) }));
        return;
      }
      if (second && third === "turns" && parts.length === 3 && method === "POST") {
        const body = await readBody(req, TURN_BODY_MAX);
        const result = engine.submitTurn(second, body);
        send(res, 202, result);
        return;
      }
      if (second && third === "cancel" && parts.length === 3 && method === "POST") {
        engine.cancel(second);
        send(res, 202, { ok: true });
        return;
      }
      if (second && third === "events" && parts.length === 3 && method === "GET") {
        streamEvents(engine, second, url, req, res);
        return;
      }
    }

    if (head === "internal") {
      if (second === "bots" && third && fourth === "rows" && parts.length === 4 && method === "POST") {
        const body = record(await readBody(req, BODY_MAX));
        const chatId = typeof body.chatId === "string" ? body.chatId : null;
        send(res, 200, engine.fileRow(third, chatId, internalRow(body) as never));
        return;
      }
      if (second === "bots" && third && fourth === "system-turn" && parts.length === 4 && method === "POST") {
        const body = record(await readBody(req, BODY_MAX));
        const note = typeof body.note === "string" && body.note !== "" ? body.note.slice(0, 500) : undefined;
        send(res, 200, engine.systemTurn(third, str(body.key, "key", 200), str(body.text, "text", 20_000), note));
        return;
      }
      if (second === "bots" && third && fourth === "context" && parts.length === 4 && method === "GET") {
        send(res, 200, engine.botContext(third));
        return;
      }
      if (second === "routines" && third && fourth === "run" && parts.length === 4 && method === "POST") {
        send(res, 200, engine.routines.runNow(third));
        return;
      }
    }

    send(res, 404, { ok: false, error: "not_found" });
  }

  function streamEvents(engine: Engine, chatId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw === null || afterRaw === "" ? undefined : int(afterRaw);
    const epoch = url.searchParams.get("epoch") ?? undefined;
    // An unknown chat is a 404 before any stream starts.
    const chat = engine.host.chat(chatId);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.flushHeaders();
    const write = (event: EngineEvent): void => {
      if (res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (res.writableLength > STREAM_BACKLOG_MAX) res.destroy();
    };
    const subscription = engine.subscribe(chatId, write, { after, epoch });
    for (const event of subscription.initial) write(event);
    const ping = setInterval(() => write(chat.bus.ping()), options.pingMs ?? PING_MS);
    const close = (): void => {
      clearInterval(ping);
      subscription.unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      fail(res, error);
    });
  });
}

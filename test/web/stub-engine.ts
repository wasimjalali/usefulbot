import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback stand-in for the engine's HTTP surface (SPEC 5.1, 6.1, 6.5), for
 * the web routes' tests. It answers the routes of seams.md with the protocol
 * fixtures, enforces what the real engine enforces on every call (the bearer
 * token, a loopback Host, no Origin) and records each request so a test can
 * assert what the web relayed. It is not the engine: it holds no chats.
 */

const FIXTURES = new URL("../fixtures/chat-protocol/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
};

export type StubEngine = {
  port: number;
  token: string;
  requests: RecordedRequest[];
  /** Event streams currently open, and how many were closed by the client going away. */
  streams: { open: number; closedByClient: number };
  /** Answers every call to `method path` with this instead (status, JSON body) until `clear`. */
  answer(method: string, path: string, status: number, body: unknown): void;
  /** Goes back to the fixture answer for `method path`. */
  clear(method: string, path: string): void;
  /** Stops listening and drops open event streams. */
  close(): Promise<void>;
};

type Canned = { status: number; body: unknown };

export async function startStubEngine(token = "stub-engine-token"): Promise<StubEngine> {
  const requests: RecordedRequest[] = [];
  const canned = new Map<string, Canned>();
  const streams = { open: 0, closedByClient: 0 };
  const sockets = new Set<ServerResponse>();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      requests.push({ method, path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, stack: "daily", epoch: "e-stub", pi: "stub" });
      }
      // What the engine does with every other call.
      if (req.headers.origin !== undefined) return json(res, 403, { ok: false, error: "origin_refused" });
      if (!/^127\.0\.0\.1(:\d+)?$/.test(req.headers.host ?? "")) return json(res, 403, { ok: false, error: "host_refused" });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: "unauthorized" });
      const override = canned.get(`${method} ${url.pathname}`);
      if (override) return json(res, override.status, override.body);

      const chat = /^\/chats\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
      if (method === "GET" && url.pathname === "/chats") return json(res, 200, JSON.parse(fixture("chats-list.json")));
      if (method === "POST" && url.pathname === "/chats") return json(res, 200, { ok: true, chatId: "c4a7f00d-3333-4333-8333-333333333333" });
      if (method === "GET" && url.pathname === "/chats/search") return json(res, 200, JSON.parse(fixture("chats-search.json")));
      if (method === "GET" && url.pathname === "/status") return json(res, 200, JSON.parse(fixture("engine-status.json")));
      if (chat && !chat[2]) {
        if (method === "PATCH") return json(res, 200, { ok: true });
        if (method === "DELETE") return json(res, 200, { ok: true, current: null });
      }
      if (chat && method === "POST" && chat[2] === "open") return json(res, 200, { ok: true });
      if (chat && method === "POST" && chat[2] === "cancel") return json(res, 202, { ok: true });
      if (chat && method === "POST" && chat[2] === "turns") return json(res, 202, { ok: true, turnId: "7a1e0001-0000-4000-8000-00000000a009" });
      if (chat && method === "GET" && chat[2] === "rows") {
        return json(res, 200, JSON.parse(fixture(url.searchParams.has("before") ? "rows-page-older.json" : "rows-page.json")));
      }
      if (chat && method === "GET" && chat[2] === "events") {
        // The first line at once, then the rest a beat apart, and the stream stays open.
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const lines = fixture("events-turn.ndjson").split("\n").filter((line) => line.trim() !== "");
        streams.open += 1;
        sockets.add(res);
        let index = 0;
        const timer = setInterval(() => {
          if (index < lines.length) res.write(`${lines[index++]}\n`);
        }, 20);
        res.on("close", () => {
          clearInterval(timer);
          streams.open -= 1;
          sockets.delete(res);
          if (!res.writableEnded) streams.closedByClient += 1;
        });
        return;
      }
      if (/^\/internal\/bots\/[^/]+\/rows$/.test(url.pathname) && method === "POST") return json(res, 200, { ok: true, chatId: "c4a7f00d-1111-4111-8111-111111111111", rowId: "row" });
      if (/^\/internal\/bots\/[^/]+\/system-turn$/.test(url.pathname) && method === "POST") return json(res, 202, { ok: true, chatId: "c4a7f00d-1111-4111-8111-111111111111", turnId: null, queued: true });
      if (/^\/internal\/bots\/[^/]+\/context$/.test(url.pathname) && method === "GET") return json(res, 200, { ok: true, windowTokens: 32768, instructionTokens: 900, envelopeTokens: 9000 });
      if (/^\/internal\/routines\/[^/]+\/run$/.test(url.pathname) && method === "POST") return json(res, 202, { ok: true, chatId: "c4a7f00d-2222-4222-8222-222222222222", turnId: null, queued: false });
      return json(res, 404, { ok: false, error: "not_found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    token,
    requests,
    streams,
    answer: (method, path, status, body) => { canned.set(`${method} ${path}`, { status, body }); },
    clear: (method, path) => { canned.delete(`${method} ${path}`); },
    close: () => new Promise<void>((resolve) => {
      for (const res of sockets) res.destroy();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Points the web service's engine client at a stub (or at a port nothing listens on) for one test run. */
export async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

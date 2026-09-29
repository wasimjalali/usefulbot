import { assertConnectionUrl, assertResolvedPublic } from "./connection-url.ts";
import { measureOpenApiSpecText, type SpecSize } from "./tool-wire-size.ts";
import { mountedSchemaBytes } from "./json-schema-zod.ts";

/**
 * Tiny Streamable HTTP JSON-RPC client for listing tools and reading UI
 * resources. Tool execution stays in eve. Tests inject fetch.
 */

export type McpToolInfo = {
  name: string;
  description: string;
  visibility: Array<"model" | "app">;
  /** The server listed "app" itself. A tool with no visibility is not one. */
  appCallable: boolean;
  resourceUri: string | null;
  /**
   * The server's own JSON Schema for the tool's arguments, or null when it
   * sent none or one too big to keep. A tool mounted on demand is presented
   * to the model from this, so a listing that dropped it left the model
   * guessing at argument names.
   */
  inputSchema: Record<string, unknown> | null;
  /**
   * What this tool's arguments weigh when this app mounts it: zod's emission
   * of the schema it kept, which is what goes on the wire.
   */
  inputSchemaBytes: number;
};

/**
 * How much of one tool's argument schema is worth keeping. A server is free
 * to send a schema of any size and the index holds one per tool; past this
 * the wrapper falls back to a passthrough object and puts the shape in its
 * description instead.
 */
export const MAX_TOOL_INPUT_SCHEMA_BYTES = 4 * 1024;

function toolInputSchema(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(rec), "utf8");
  } catch {
    return null;
  }
  if (bytes <= MAX_TOOL_INPUT_SCHEMA_BYTES) return rec;
  // Too big to keep whole. Dropping it outright left the model a tool with
  // no argument contract at all: it guessed, the server refused, and the
  // step was spent. What is kept is the shape without the prose: property
  // names, their types and which are required.
  return trimSchema(rec);
}

function trimSchema(rec: Record<string, unknown>): Record<string, unknown> | null {
  const properties = asRecord(rec.properties);
  if (!properties) return null;
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const field = asRecord(value);
    const type = field?.type;
    trimmed[key] = typeof type === "string" || Array.isArray(type) ? { type } : {};
    // Room for the object and `required` that wrap this map.
    if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") > MAX_TOOL_INPUT_SCHEMA_BYTES - 512) {
      delete trimmed[key];
      break;
    }
  }
  if (Object.keys(trimmed).length === 0) return null;
  const required = Array.isArray(rec.required)
    ? rec.required.filter((item): item is string => typeof item === "string" && item in trimmed)
    : [];
  return { type: "object", properties: trimmed, ...(required.length ? { required } : {}) };
}

export type McpResource = {
  uri: string;
  mimeType: string;
  text: string;
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
    baseUriDomains: string[];
  } | null;
};

type FetchFn = typeof fetch;

let injectedFetch: FetchFn | null = null;

export function setMcpFetch(next: FetchFn | null): void {
  injectedFetch = next;
}

function activeFetch(): FetchFn {
  return injectedFetch ?? fetch;
}

/**
 * How much of a response this side will take. `res.text()` reads whatever
 * arrives before anything can look at it, so a server that answers with a
 * gigabyte takes the app down before the size check it was heading for. The
 * limit is enforced while reading, not after.
 */
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SPEC_BODY_BYTES = 1024 * 1024;

async function boundedText(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = await res.text();
    if (Buffer.byteLength(whole, "utf8") > max) throw new Error("mcp_body_too_large");
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new Error("mcp_body_too_large");
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already done */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSseData(body: string): unknown {
  const lines = body.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) {
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("mcp_parse");
    }
  }
  return JSON.parse(data.join("\n"));
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  id: number,
  signal?: AbortSignal,
): Promise<{ result: unknown; sessionId: string | null }> {
  const target = await assertResolvedPublic(url);
  const res = await activeFetch()(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    // Never follow one. `assertResolvedPublic` pinned this host, and a
    // redirect takes the request, its credential header and the SSRF check
    // somewhere it never looked. Only `authorization` is stripped on a
    // cross-origin hop; an `X-Api-Key` would go with it.
    redirect: "error",
    signal,
  });
  if (!res.ok) throw new Error(`mcp_http_${res.status}`);
  const sessionId = res.headers.get("mcp-session-id");
  const body = await boundedText(res, MAX_RPC_BODY_BYTES);
  const parsed = parseSseData(body);
  const rec = asRecord(parsed);
  if (!rec) throw new Error("mcp_parse");
  if (rec.error) {
    const err = asRecord(rec.error);
    throw new Error(typeof err?.message === "string" ? err.message.slice(0, 200) : "mcp_error");
  }
  return { result: rec.result, sessionId };
}

function toolVisibility(meta: unknown): Array<"model" | "app"> {
  const rec = asRecord(meta);
  const ui = asRecord(rec?.ui);
  const raw = ui?.visibility;
  if (!Array.isArray(raw) || raw.length === 0) return ["model", "app"];
  const out: Array<"model" | "app"> = [];
  for (const item of raw) {
    if (item === "model" || item === "app") out.push(item);
  }
  return out.length ? out : ["model", "app"];
}

function toolAppCallable(meta: unknown): boolean {
  const raw = asRecord(asRecord(meta)?.ui)?.visibility;
  return Array.isArray(raw) && raw.includes("app");
}

function toolResourceUri(meta: unknown): string | null {
  const rec = asRecord(meta);
  const ui = asRecord(rec?.ui);
  if (typeof ui?.resourceUri === "string" && ui.resourceUri.startsWith("ui://")) return ui.resourceUri;
  if (typeof rec?.["ui/resourceUri"] === "string" && rec["ui/resourceUri"].startsWith("ui://")) {
    return rec["ui/resourceUri"];
  }
  return null;
}

/**
 * How long a listing or a resource read may take, end to end. Both make two
 * round trips, so the deadline is shared across them rather than restarted
 * per call: a server that answers `initialize` and then stops still ends.
 * Without it an unresponsive server held the connect card, the widget host
 * and the turn that asked open for as long as the socket stayed up.
 */
export const MCP_READ_TIMEOUT_MS = 15_000;

export async function listMcpTools(
  url: string,
  headers: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(MCP_READ_TIMEOUT_MS),
): Promise<McpToolInfo[]> {
  const init = await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "useful-bot", version: "0.0.0" },
  }, headers, 1, signal);
  const sessionHeaders = init.sessionId
    ? { ...headers, "mcp-session-id": init.sessionId }
    : headers;
  const listed = await rpc(url, "tools/list", {}, sessionHeaders, 2, signal);
  const rec = asRecord(listed.result);
  const tools = Array.isArray(rec?.tools) ? rec.tools : [];
  const out: McpToolInfo[] = [];
  for (const item of tools) {
    const row = asRecord(item);
    // Skipped rather than clipped: a clipped name is one the server never
    // published, and calling it fails at the server instead of here.
    if (!row || typeof row.name !== "string" || row.name.length > 80) continue;
    out.push({
      name: row.name,
      description: typeof row.description === "string" ? row.description.slice(0, 400) : "",
      visibility: toolVisibility(row._meta),
      appCallable: toolAppCallable(row._meta),
      resourceUri: toolResourceUri(row._meta),
      inputSchema: toolInputSchema(row.inputSchema),
      inputSchemaBytes: mountedSchemaBytes(toolInputSchema(row.inputSchema)),
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function modelToolNames(tools: McpToolInfo[]): string[] {
  return tools.filter((tool) => tool.visibility.includes("model")).map((tool) => tool.name);
}

export async function readMcpResource(
  url: string,
  uri: string,
  headers: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(MCP_READ_TIMEOUT_MS),
): Promise<McpResource> {
  if (!uri.startsWith("ui://") && !uri.startsWith("https://")) throw new Error("mcp_resource_uri");
  const init = await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "useful-bot", version: "0.0.0" },
  }, headers, 1, signal);
  const sessionHeaders = init.sessionId
    ? { ...headers, "mcp-session-id": init.sessionId }
    : headers;
  const read = await rpc(url, "resources/read", { uri }, sessionHeaders, 3, signal);
  const rec = asRecord(read.result);
  const contents = Array.isArray(rec?.contents) ? rec.contents : [];
  const first = asRecord(contents[0]);
  if (!first) throw new Error("mcp_resource");
  const text = typeof first.text === "string"
    ? first.text
    : typeof first.blob === "string"
      ? Buffer.from(first.blob, "base64").toString("utf8")
      : "";
  if (!text) throw new Error("mcp_resource");
  const meta = asRecord(first._meta);
  const ui = asRecord(meta?.ui);
  const csp = asRecord(ui?.csp);
  return {
    uri: typeof first.uri === "string" ? first.uri : uri,
    mimeType: typeof first.mimeType === "string" ? first.mimeType : "text/html",
    text,
    csp: csp ? {
      connectDomains: Array.isArray(csp.connectDomains) ? csp.connectDomains.filter((d): d is string => typeof d === "string") : [],
      resourceDomains: Array.isArray(csp.resourceDomains) ? csp.resourceDomains.filter((d): d is string => typeof d === "string") : [],
      frameDomains: Array.isArray(csp.frameDomains) ? csp.frameDomains.filter((d): d is string => typeof d === "string") : [],
      baseUriDomains: Array.isArray(csp.baseUriDomains) ? csp.baseUriDomains.filter((d): d is string => typeof d === "string") : [],
    } : null,
  };
}

const TOOL_RESULT_MAX = 256 * 1024;
export const TOOL_CALL_TIMEOUT_MS = 25_000;

/**
 * Run one tool for an MCP App's own frame (the app's `tools/call`). The
 * caller decides which tools the app may reach; this only runs and bounds it.
 */
export async function callMcpTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  // A server that never answers must not hold the request (and the app's
  // spinner) open. A caller with more steps passes one shared deadline.
  signal: AbortSignal = AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
): Promise<Record<string, unknown>> {
  const init = await rpc(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "useful-bot", version: "0.0.0" },
  }, headers, 1, signal);
  const sessionHeaders = init.sessionId
    ? { ...headers, "mcp-session-id": init.sessionId }
    : headers;
  const called = await rpc(url, "tools/call", { name, arguments: args }, sessionHeaders, 4, signal);
  const rec = asRecord(called.result);
  if (!rec) throw new Error("mcp_tool_result");
  if (JSON.stringify(rec).length > TOOL_RESULT_MAX) throw new Error("mcp_tool_result_too_large");
  return rec;
}

/**
 * How big an OpenAPI connection is: its operation count and the argument
 * schema bytes eve will build from it, resolved the way eve resolves them.
 * Null when the spec could not be read or is not one.
 */
export async function measureOpenApiConnection(
  specUrl: string,
  headers: Record<string, string> = {},
): Promise<SpecSize | null> {
  const target = await assertResolvedPublic(specUrl);
  try {
    const res = await activeFetch()(target, {
      headers: { accept: "application/json", ...headers },
      // Same reason as the JSON-RPC call above.
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    // Bounded while reading: the old check ran after the whole thing was
    // already in memory, which is the part that hurts.
    const body = await boundedText(res, MAX_SPEC_BODY_BYTES);
    return measureOpenApiSpecText(body);
  } catch {
    return null;
  }
}



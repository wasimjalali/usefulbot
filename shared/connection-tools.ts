import { connectionHeaders } from "./connection-auth.ts";
import {
  connectionIndex,
  indexIsStale,
  indexedToolBytes,
  isMountableToolName,
  mountedToolName,
  putConnectionIndex,
  putConnectionListingFailed,
  putConnectionOperations,
  type IndexedTool,
} from "./connection-tools-store.ts";
import { readConnectionsStore, type ConnectionEntry } from "./connections-store.ts";
import { listMcpTools, measureOpenApiConnection, modelToolNames } from "./mcp-http.ts";
import { specWireBytes, type SpecSize } from "./tool-wire-size.ts";
import { MOUNTED_TOOL_BUDGET, MOUNTED_TOOL_BYTE_BUDGET } from "./policy.ts";

/**
 * Which connections are mounted for every turn, and how a bot finds the tools
 * of the ones that are not.
 *
 * What the budgets are and are not. eve mounts an OpenAPI connection by
 * fetching the spec itself, so what this side measured and what eve puts on
 * the wire are two fetches of the same endpoint and need not agree: that
 * charge is a deliberate over-estimate of a snapshot. A tool taken on demand
 * is built here, from this index, so its charge is exact.
 *
 * Neither is a defence against a server that deliberately answers one thing
 * to a measurement and another to a mount. The owner approved that server on
 * a card; the budgets are here so an honest one cannot walk a bot into a wall
 * that kills the chat.
 *
 * eve owns OpenAPI spec parsing, and those connections are few, so they stay
 * mounted. So does a small MCP server whose own allow-list is short: two
 * tools cost nothing against the budget and making the bot look them up first
 * would put a round trip in front of every drawing. Everything else waits to
 * be asked for by name.
 */

/**
 * Only an OpenAPI connection is mounted for every turn, and only because eve
 * owns spec parsing and there is no other way to reach one.
 *
 * A pinned MCP server used to be mounted too, on the grounds that two tools
 * cost nothing and a bot should not have to look them up before it can draw.
 * There was no honest number to charge it. eve mounts an MCP connection by
 * asking the server itself and passes its names, descriptions and schemas
 * through with no cap, so nothing measured here bounds what goes on the wire:
 * a server pinned to eight tools could put a hundred kilobytes in front of
 * the model and be charged thirty-seven. A tool taken on demand is built
 * here, from this index, so its size is known before it is mounted. That is
 * the whole reason to prefer it, and it applies to two tools as much as two
 * hundred.
 */
export function isEagerConnection(entry: ConnectionEntry): boolean {
  return entry.kind === "openapi";
}

/**
 * The connections mounted for this turn, in the order they were connected,
 * stopping at the budget.
 *
 * The connect-time check is not enough on its own: rows connected before that
 * check existed, or written by any path that does not go through it, would
 * still put a list in front of the model that the router refuses with a
 * non-retryable error. Clamping here means the model never sees one, whatever
 * is in the store. A connection left out is not lost; it comes back as soon
 * as the ones ahead of it are disconnected.
 */
export function eagerConnections(path?: string, storePath?: string): ConnectionEntry[] {
  const all = readConnectionsStore(path).connections.filter(isEagerConnection);
  const out: ConnectionEntry[] = [];
  let tools = 0;
  let bytes = 0;
  for (const entry of all) {
    const count = mountedToolCount(entry, storePath);
    const size = mountedToolBytes(entry, storePath);
    // A size nobody knows is not a small one.
    if (count === null || size === null) continue;
    // Nor is a name nobody has checked a short one.
    if (!specNamesFit(entry.id, connectionIndex(entry.id, storePath)?.longestName)) continue;
    if (tools + count > MOUNTED_TOOL_BUDGET || bytes + size > MOUNTED_TOOL_BYTE_BUDGET) continue;
    tools += count;
    bytes += size;
    out.push(entry);
  }
  return out;
}

export function onDemandConnections(path?: string): ConnectionEntry[] {
  return readConnectionsStore(path).connections.filter((entry) => !isEagerConnection(entry));
}

/**
 * Whether every tool name eve builds from a spec still fits the provider's
 * sixty-four once `<connectionId>__` is in front of it. An unknown length does
 * not fit.
 */
export function specNamesFit(connectionId: string, longestName: number | undefined): boolean {
  return longestName !== undefined && connectionId.length + 2 + longestName <= 64;
}

/**
 * How many tools an OpenAPI connection mounts, or null when nothing has
 * counted it. A row that predates the count, or one written by a path that
 * skipped it, is unknown, and guessing a modest figure would admit it into a
 * wall it can clear. `ensureMeasured` fills the gap in.
 */
export function mountedToolCount(entry: ConnectionEntry, path?: string): number | null {
  return connectionIndex(entry.id, path)?.operations ?? null;
}

/**
 * Measure the OpenAPI connections whose figures are missing or old, and write
 * them down. Called from the turn resolver, so a connection that predates the
 * count is measured on the next turn instead of staying unmountable.
 */
export async function ensureMeasured(entries: ConnectionEntry[], path?: string): Promise<void> {
  const due = entries.filter((entry) => {
    if (entry.kind !== "openapi") return false;
    const index = connectionIndex(entry.id, path);
    // Missing or old: measure it.
    if (indexIsStale(index)) return true;
    // A recent attempt that failed backs off until the index goes stale, or a
    // spec that cannot be read would be refetched at every turn boundary,
    // eight seconds a time, for a row that stays unmounted either way.
    if (index?.failed) return false;
    // Fresh but incomplete, such as an index written before a figure existed:
    // measure it now rather than leave it unmounted for six hours.
    return mountedToolCount(entry, path) === null
      || mountedToolBytes(entry, path) === null
      || index?.longestName === undefined;
  });
  // Together, not one after another. This runs at a turn boundary and holds
  // the first model call of the turn for as long as it takes.
  await Promise.all(due.map(async (entry) => {
    let size: SpecSize | null = null;
    try {
      size = await measureOpenApiConnection(entry.url, await headersFor(entry));
    } catch {
      size = null;
    }
    try {
      putConnectionOperations(entry.id, size, path);
    } catch {
      // The index is a cache; a write that failed costs one fetch later.
    }
  }));
}

/** Never throws: a measurement is not worth failing a turn boundary over. */
async function headersFor(entry: ConnectionEntry): Promise<Record<string, string>> {
  try {
    return await connectionHeaders(entry);
  } catch {
    return {};
  }
}

/**
 * What one connection weighs on the wire, or null when nothing has measured
 * it. For an MCP server that is its listing, each tool weighed the way the
 * router weighs it. For an OpenAPI spec it is the argument-schema bytes eve
 * builds from that spec, resolved and written down when it was counted, plus
 * a function envelope and a description an operation for each.
 */
export function mountedToolBytes(entry: ConnectionEntry, path?: string): number | null {
  const index = connectionIndex(entry.id, path);
  if (index?.schemaBytes === undefined || index.operations === undefined) return null;
  // An index written before the operation text was measured has no figure
  // for it, and a missing figure is not a zero.
  if (index.textBytes === undefined) return null;
  return specWireBytes({
    operations: index.operations,
    schemaBytes: index.schemaBytes,
    textBytes: index.textBytes,
  });
}

export type ToolHit = {
  connectionId: string;
  connectionName: string;
  /** `<connectionId>__<toolName>`: what eve mounts and the app parses. */
  name: string;
  tool: string;
  description: string;
};

/**
 * Refresh one connection's listing from the server. Only tools the server
 * shows the model are kept, and an allow-list still applies: a tool the owner
 * did not allow is not one this bot may pick up later either.
 */
export async function refreshConnectionIndex(
  entry: ConnectionEntry,
  storePath?: string,
): Promise<IndexedTool[]> {
  const headers = await connectionHeaders(entry);
  const listed = await listMcpTools(entry.url, headers);
  const visible = new Set(modelToolNames(listed));
  const allow = entry.toolsAllow ? new Set(entry.toolsAllow) : null;
  const tools: IndexedTool[] = listed
    // Screened before it is kept or returned, not only when the store is next
    // read: a name the upstream would refuse was handed to the model as
    // callable, activated, and then silently never mounted.
    .filter((tool) => isMountableToolName(entry.id, tool.name))
    .filter((tool) => visible.has(tool.name) && (!allow || allow.has(tool.name)))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      inputSchemaBytes: tool.inputSchemaBytes,
    }));
  putConnectionIndex(entry.id, tools, storePath);
  return tools;
}

/** The listing, refetched when it is missing or too old to trust. */
export async function ensureConnectionIndex(
  entry: ConnectionEntry,
  storePath?: string,
): Promise<IndexedTool[]> {
  const current = connectionIndex(entry.id, storePath);
  if (!indexIsStale(current)) return current?.tools ?? [];
  try {
    return await refreshConnectionIndex(entry, storePath);
  } catch {
    // A server that is down must not take the search down with it: what was
    // listed last time is still the best answer available. The attempt is
    // recorded so the next search does not wait fifteen seconds for the same
    // silence, and the stale listing is kept beside it.
    try { putConnectionListingFailed(entry.id, storePath); } catch { /* a cache */ }
    return current?.tools ?? [];
  }
}

/**
 * Word overlap between a query and a tool's name and description. Whole-word
 * matches in the name count most: a query of "send email" should put
 * `send_email` above a tool that merely mentions email in its prose.
 */
export function scoreTool(query: string, tool: IndexedTool, connectionName: string): number {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (words.length === 0) return 0;
  const name = tool.name.toLowerCase();
  const nameWords = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  const prose = `${tool.description} ${connectionName}`.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (nameWords.has(word)) score += 10;
    else if (name.includes(word)) score += 6;
    if (prose.includes(word)) score += 2;
  }
  // A tool that matched every word beats one that matched most of them.
  const matched = words.filter((word) => name.includes(word) || prose.includes(word)).length;
  if (matched === words.length) score += 5;
  return score;
}

/**
 * The best matches for a query across the connections that are not mounted.
 * Reads each one's cached listing, refreshing a stale one, and never throws
 * for a single server being unreachable.
 */
export async function searchConnectionTools(
  query: string,
  limit: number,
  connectionsPath?: string,
  storePath?: string,
): Promise<ToolHit[]> {
  const entries = onDemandConnections(connectionsPath);
  // Together, not one after another: each refresh is bounded at fifteen
  // seconds, and an owner with several servers that have gone quiet was
  // waiting that long for each of them before the search answered.
  const listings = await Promise.all(
    entries.map(async (entry) => [entry, await ensureConnectionIndex(entry, storePath)] as const),
  );
  const hits: Array<ToolHit & { score: number }> = [];
  for (const [entry, tools] of listings) {
    // The listing can be hours old; an allow-list the owner narrowed since
    // applies now, or the tool is found, charged and then never mounted.
    const allow = entry.toolsAllow ? new Set(entry.toolsAllow) : null;
    for (const tool of tools) {
      if (allow && !allow.has(tool.name)) continue;
      const score = scoreTool(query, tool, entry.name);
      if (score <= 0) continue;
      hits.push({
        score,
        connectionId: entry.id,
        connectionName: entry.name,
        name: mountedToolName(entry.id, tool.name),
        tool: tool.name,
        description: tool.description,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

/** Split a mounted name back into the connection and the tool it names. */
export function splitMountedName(name: string): { connectionId: string; tool: string } | null {
  const at = name.indexOf("__");
  if (at <= 0 || at + 2 >= name.length) return null;
  return { connectionId: name.slice(0, at), tool: name.slice(at + 2) };
}

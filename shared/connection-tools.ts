import { connectionHeaders, OAuthExpiredError, OAuthRefreshBusyError } from "./connection-auth.ts";
import { ConnectionUrlError } from "./connection-url.ts";
import {
  connectionIndex,
  connectionStatus,
  indexedToolBytes,
  isMountableToolName,
  listingIsDue,
  mountedToolName,
  nextStamp,
  checkedThisRuntimeFor,
  putConnectionDiscovery,
  putConnectionPending,
  type ConnectionState,
  type ConnectionStatus,
  type IndexedTool,
} from "./connection-tools-store.ts";
import { findConnectionById, readConnectionsStore, type ConnectionEntry } from "./connections-store.ts";
import { listMcpToolsWithStats, MCP_READ_TIMEOUT_MS, McpError, modelToolNames } from "./mcp-http.ts";
import { MAX_SESSION_TOOL_BYTES, MAX_SESSION_TOOLS } from "./policy.ts";

/**
 * How a bot finds the tools of the connected MCP servers. None sits in context
 * on its own: a server may publish hundreds, so `find_tools` searches the
 * cached listings and the chat picks up what it asked for. A tool taken on
 * demand is built here, from this index, so what it weighs on the wire is
 * known before it is registered.
 *
 * The budgets are not a defence against a server that deliberately answers one
 * thing to a measurement and another to a call. The owner approved that server
 * on a card; the budgets are here so an honest one cannot walk a bot into a
 * wall that kills the chat.
 */

/** Every connection: they are all MCP servers, and all of them are searched on demand. */
export function onDemandConnections(path?: string): ConnectionEntry[] {
  return readConnectionsStore(path).connections;
}

export type ToolHit = {
  connectionId: string;
  connectionName: string;
  /** `<connectionId>__<toolName>`: what the engine registers and the app parses. */
  name: string;
  tool: string;
  description: string;
};

let discoveryLog: (line: string) => void = (line) => console.warn(line);

/** Where the one-line discovery outcome goes. Tests capture it. */
export function setDiscoveryLogger(next: ((line: string) => void) | null): void {
  discoveryLog = next ?? ((line) => console.warn(line));
}

type Failure = { state: ConnectionState; code: string; message: string };

/**
 * Why a listing failed, in words this app wrote. Nothing from the server's own
 * answer or from a header goes in: a server can echo the credential it was
 * sent, and a stored status is read by the app and, through find_tools, the
 * model.
 */
export function classifyDiscoveryError(err: unknown): Failure {
  if (err instanceof OAuthExpiredError) {
    return { state: "expired", code: "oauth_expired", message: "The sign-in expired. Reconnect to continue." };
  }
  if (err instanceof McpError) {
    if (err.kind === "auth") {
      return { state: "auth_failed", code: `http_${err.status ?? 401}`, message: "The server refused the credential." };
    }
    if (err.kind === "unreachable") {
      return { state: "unreachable", code: err.status ? `http_${err.status}` : "network", message: "The server could not be reached." };
    }
    if (err.kind === "parse") {
      return { state: "discovery_failed", code: "parse", message: "The server's answer was not JSON-RPC." };
    }
    return {
      state: "discovery_failed",
      code: err.status ? `http_${err.status}` : "protocol",
      message: err.message === "mcp_unsupported_version"
        ? "The server speaks a protocol version this app does not."
        : "The server did not answer like an MCP server.",
    };
  }
  if (err instanceof ConnectionUrlError) {
    return err.message === "url_resolve"
      ? { state: "unreachable", code: "dns", message: "The server's address could not be resolved." }
      : { state: "discovery_failed", code: err.message, message: "The server's address is not one this app will call." };
  }
  if (err instanceof Error && err.message.startsWith("connection_secret_missing")) {
    return { state: "auth_failed", code: "credential_missing", message: "The saved credential is missing." };
  }
  return { state: "discovery_failed", code: "unknown", message: "Listing the tools failed." };
}

function logOutcome(entry: ConnectionEntry, status: ConnectionStatus): void {
  discoveryLog(
    `[useful-bot] connection ${entry.id} discovery ${status.state}`
      + `${status.lastError ? ` (${status.lastError.code})` : ""}`
      + ` tools=${status.toolCount ?? "-"}${status.dropped ? ` dropped=${status.dropped}` : ""}`,
  );
}

export type Discovery = { status: ConnectionStatus; tools: IndexedTool[] };

const stamp = nextStamp;

type Run = { startedAt: string; controller: AbortController; promise: Promise<Discovery> };

/**
 * The attempts now running for each connection, oldest first. One process-wide
 * map, so a search past its TTL, the Connectors list, a Refresh and the connect
 * flow all share an attempt instead of racing each other to write the answer.
 * A set, not a single run: an attempt that a credential-bearing one supersedes
 * is still out there until it finishes, and removal has to stop it too.
 */
const running = new Map<string, Set<Run>>();

/** The newest attempt for this connection, or undefined. */
function latestRun(connectionId: string): Run | undefined {
  const runs = running.get(connectionId);
  if (!runs) return undefined;
  let latest: Run | undefined;
  for (const run of runs) latest = run;
  return latest;
}

/** Whether a discovery of this connection is in progress now. */
export function discoveryRunning(connectionId: string): boolean {
  return (running.get(connectionId)?.size ?? 0) > 0;
}

/** Resolves when every discovery now running has finished. */
export async function settleAllDiscoveries(): Promise<void> {
  await Promise.all([...running.values()].flatMap((runs) => [...runs].map((run) => run.promise)));
}

/**
 * Stop every discovery of this connection that is running, the superseded
 * ones included, and wait for them to end, so removing the connection does not
 * race a write for it.
 */
export async function cancelDiscovery(connectionId: string): Promise<void> {
  const runs = [...(running.get(connectionId) ?? [])];
  if (runs.length === 0) return;
  for (const run of runs) run.controller.abort();
  await Promise.all(runs.map((run) => run.promise));
}

/**
 * Ask a connection what it offers, and write down what came of it: the
 * listing for `find_tools` to search and a status that says why when there is
 * none. The one place a listing is attempted for an MCP server (the connect
 * flow, a search past its TTL and the Connectors page all come through here),
 * and it never throws, so a server that is down cannot take a caller with it.
 *
 * One attempt per connection at a time. A caller with no credential of its own
 * joins the one already running. A caller that holds a credential (a sign-in
 * that just completed, a connect) starts its own, because what is running may
 * be using the one it replaces; the attempt it supersedes finishes without
 * writing, and reports what is current.
 *
 * Only tools the server shows the model are kept, and an allow-list still
 * applies: a tool the owner did not allow is not one a bot may pick up later.
 * `headers` is for a caller that holds the credential already, such as a
 * connect whose row has not been read back.
 */
export function discoverConnection(
  entry: ConnectionEntry,
  opts: { headers?: Record<string, string>; storePath?: string } = {},
): Promise<Discovery> {
  const current = latestRun(entry.id);
  if (current && opts.headers === undefined) return current.promise;
  const startedAt = stamp();
  const controller = new AbortController();
  const run: Run = {
    startedAt,
    controller,
    promise: attempt(entry, opts, startedAt, controller.signal).finally(() => {
      const runs = running.get(entry.id);
      runs?.delete(run);
      if (runs && runs.size === 0) running.delete(entry.id);
    }),
  };
  const runs = running.get(entry.id) ?? new Set<Run>();
  runs.add(run);
  running.set(entry.id, runs);
  return run.promise;
}

async function attempt(
  entry: ConnectionEntry,
  opts: { headers?: Record<string, string>; storePath?: string },
  startedAt: string,
  cancel: AbortSignal,
): Promise<Discovery> {
  const checkedAt = startedAt;
  const store = opts.storePath;
  /**
   * Progress only: the outcome is written, and checked, below. Called once the
   * credential has resolved, not before: an attempt that ends waiting on the
   * refresh lock must leave no stamp newer than the holder's, which would
   * block the holder's own `ready`.
   */
  const markStarted = () => {
    try {
      putConnectionPending(entry.id, startedAt, store);
    } catch (err) {
      discoveryLog(`[useful-bot] connection ${entry.id} discovery could not record its start: ${errorName(err)}`);
    }
  };
  /**
   * Writes the outcome, unless a newer attempt has already written. A write
   * that fails is a failed discovery: reporting ready for tools nobody can
   * read back would settle a card as connected with an empty search behind it.
   */
  const done = async (status: ConnectionStatus, tools: IndexedTool[] | null): Promise<Discovery> => {
    let written: boolean;
    try {
      written = putConnectionDiscovery(entry.id, { tools, status, unlessNewer: true }, store);
    } catch (err) {
      discoveryLog(`[useful-bot] connection ${entry.id} discovery result could not be written: ${errorName(err)}`);
      return { status: storeFailure(checkedAt), tools: [] };
    }
    if (!written) return superseded(entry.id, startedAt, store);
    logOutcome(entry, status);
    return { status, tools: tools ?? connectionIndex(entry.id, store)?.tools ?? [] };
  };
  try {
    const headers = opts.headers ?? await connectionHeaders(entry);
    markStarted();
    const listed = await listMcpToolsWithStats(
      entry.url,
      headers,
      AbortSignal.any([AbortSignal.timeout(MCP_READ_TIMEOUT_MS), cancel]),
    );
    // Screened before it is kept or returned, not only when the store is next
    // read: a name the upstream would refuse was handed to the model as
    // callable, activated, and then silently never mounted.
    const valid = listed.tools.filter((tool) => isMountableToolName(entry.id, tool.name));
    const dropped = listed.dropped + (listed.tools.length - valid.length);
    if (listed.total > 0 && valid.length === 0) {
      return done({
        state: "malformed",
        lastError: { code: "all_tools_invalid", message: `The server listed ${listed.total} tools and none could be used.` },
        checkedAt,
        toolCount: 0,
        dropped,
      }, []);
    }
    const visible = new Set(modelToolNames(valid));
    const allow = entry.toolsAllow ? new Set(entry.toolsAllow) : null;
    const tools: IndexedTool[] = valid
      .filter((tool) => visible.has(tool.name) && (!allow || allow.has(tool.name)))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        inputSchemaBytes: tool.inputSchemaBytes,
      }));
    return done({
      state: tools.length > 0 ? "ready" : "zero_tools",
      lastError: null,
      checkedAt,
      toolCount: tools.length,
      ...(dropped ? { dropped } : {}),
    }, tools);
  } catch (err) {
    // The refresh lock stayed busy: what the sign-in is now is not known yet,
    // and a status written for it could supersede the ready the lock holder is
    // writing. Nothing is recorded; the next discovery retries.
    if (err instanceof OAuthRefreshBusyError) return notKnownYet(entry.id, startedAt, store);
    const failure = classifyDiscoveryError(err);
    // A server that went quiet keeps the listing it gave last time. One that
    // answered and refused, or answered nonsense, does not: that listing is
    // no longer something it will honour.
    return done({
      state: failure.state,
      lastError: { code: failure.code, message: failure.message },
      checkedAt,
      toolCount: null,
    }, failure.state === "unreachable" ? null : []);
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

function storeFailure(checkedAt: string): ConnectionStatus {
  return {
    state: "discovery_failed",
    lastError: { code: "store_write_failed", message: "The result could not be saved." },
    checkedAt,
    toolCount: null,
  };
}

/** What an attempt that could not find out reports, having written nothing: what is stored now. */
function notKnownYet(connectionId: string, startedAt: string, store: string | undefined): Promise<Discovery> {
  return superseded(connectionId, startedAt, store);
}

/** What an attempt that lost to a newer one reports: the newer one's outcome. */
async function superseded(connectionId: string, startedAt: string, store: string | undefined): Promise<Discovery> {
  const newer = latestRun(connectionId);
  if (newer && newer.startedAt !== startedAt) return newer.promise;
  const status = connectionStatus(connectionId, store);
  const index = connectionIndex(connectionId, store);
  return {
    status: status ?? storeFailure(startedAt),
    tools: index?.tools ?? [],
  };
}

/**
 * Write what a failed tool call found: the status says so, and the listing is
 * emptied, so the connection stops being offered as working until the owner
 * signs in again. Skipped for a connection that is no longer there, and yields
 * to anything already written with a later stamp. `startedAt` is the stamp the
 * call took when it began (`nextStamp()`): a refusal that comes back after a
 * reconnect succeeded is about the old credential, and must not overwrite it.
 */
function markConnectionFailed(connectionId: string, failure: Failure, startedAt: string | undefined, storePath?: string): void {
  if (!findConnectionById(connectionId)) return;
  putConnectionDiscovery(connectionId, {
    tools: [],
    status: {
      state: failure.state,
      lastError: { code: failure.code, message: failure.message },
      checkedAt: startedAt ?? stamp(),
      toolCount: null,
    },
    unlessNewer: true,
  }, storePath);
}

/** A tool call found the sign-in expired. */
export function markConnectionExpired(connectionId: string, startedAt?: string, storePath?: string): void {
  markConnectionFailed(connectionId, classifyDiscoveryError(new OAuthExpiredError()), startedAt, storePath);
}

/** A tool call, or its handshake, was refused by the server with a 401 or 403. */
export function markConnectionAuthFailed(connectionId: string, status: number | null, startedAt?: string, storePath?: string): void {
  markConnectionFailed(connectionId, classifyDiscoveryError(new McpError("auth", `mcp_http_${status ?? 401}`, { status: status ?? 401 })), startedAt, storePath);
}

/**
 * The listing, refetched when it is missing, too old to trust, or when the
 * last attempt did not work and enough time has passed to try again. The
 * status comes back with it so a search can say why a server has nothing.
 */
export async function ensureConnectionListing(
  entry: ConnectionEntry,
  storePath?: string,
): Promise<Discovery> {
  const current = connectionIndex(entry.id, storePath);
  const status = connectionStatus(entry.id, storePath);
  if (!listingIsDue(current, status, Date.now(), entry.id)) {
    return {
      tools: current?.tools ?? [],
      status: status ?? {
        state: current && current.tools.length > 0 ? "ready" : "zero_tools",
        lastError: null,
        checkedAt: current?.fetchedAt ?? new Date(0).toISOString(),
        toolCount: current?.tools.length ?? null,
      },
    };
  }
  return discoverConnection(entry, { storePath });
}

/** The listing, refetched when it is due. */
export async function ensureConnectionIndex(
  entry: ConnectionEntry,
  storePath?: string,
): Promise<IndexedTool[]> {
  return (await ensureConnectionListing(entry, storePath)).tools;
}

/**
 * Before a chat's picked tools are registered: make sure each connection's
 * latest status in this process is `ready` (or `zero_tools`). The saved listing
 * may be from before a restart (a tool the server dropped, a schema it changed,
 * an access that was revoked), and a chat that reopens would register it
 * without ever asking. A connection nothing has listed yet is listed now; one a
 * discovery is already working on is waited for; one whose latest outcome was a
 * failure (whoever ran it: this check, the Connectors page, `find_tools`) is
 * given its retry chance by the usual schedule. Returns the connections whose
 * tools must not be mounted now: the check did not finish inside the read
 * timeout, or the status is still not `ready`. Never throws.
 */
export async function refreshBeforeMount(connectionIds: Iterable<string>, storePath?: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  // A listing written before statuses were kept has none, and is judged as it always was.
  const working = (state: ConnectionState | undefined) => state === undefined || state === "ready" || state === "zero_tools";
  await Promise.all([...new Set(connectionIds)].map(async (id) => {
    const entry = findConnectionById(id);
    if (!entry) return;
    // Checked in this process is not the same as fresh: a chat that lives
    // for hours would otherwise keep mounting a listing the server dropped.
    if (
      checkedThisRuntimeFor(id)
      && working(connectionStatus(id, storePath)?.state)
      && !listingIsDue(connectionIndex(id, storePath), connectionStatus(id, storePath), Date.now(), id)
    ) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        discoveryRunning(id) ? discoverConnection(entry, { storePath }) : ensureConnectionListing(entry, storePath),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("check_timeout")), MCP_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      discoveryLog(`[useful-bot] connection ${id} could not be checked before mounting: ${errorName(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!checkedThisRuntimeFor(id) || !working(connectionStatus(id, storePath)?.state)) blocked.add(id);
    // A check that ran out of time, or a joined one that ended without reaching
    // the server (a busy refresh lock), leaves the old ready status in place; a
    // listing that is still due is not mounted on its word.
    else if (listingIsDue(connectionIndex(id, storePath), connectionStatus(id, storePath), Date.now(), id)) blocked.add(id);
  }));
  return blocked;
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
  // A query that names the server ("tella", "send a slack message") is asking
  // for that server's tools, whatever else the words matched elsewhere.
  const serverWords = connectionName.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (serverWords.some((word) => words.includes(word))) score += 20;
  // A tool that matched every word beats one that matched most of them.
  const matched = words.filter((word) => name.includes(word) || prose.includes(word)).length;
  if (matched === words.length) score += 5;
  return score;
}

/** A connected server a search could not use, and why. */
export type UnavailableServer = {
  connectionId: string;
  server: string;
  state: ConnectionState;
  hint: string;
};

function oneLineName(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
}

/** What a bot should do about a server in this state, in words this app wrote. */
function unavailableHint(state: ConnectionState, name: string): string {
  switch (state) {
    case "auth_failed":
    case "expired":
      return `Ask the owner to reconnect ${name} in Connectors.`;
    case "unreachable":
      return `${name} could not be reached. Try again in a couple of minutes.`;
    case "malformed":
      return `${name} answered, but none of its tools could be used. Tell the owner.`;
    case "pending":
      return `${name} is still being set up. Try again shortly.`;
    default:
      return `${name} did not answer like an MCP server. Ask the owner to check it in Connectors.`;
  }
}

/**
 * The best matches for a query across the connections that are not mounted,
 * and the servers that could not be searched. Reads each one's cached
 * listing, refreshing one that is due, and never throws for a single server
 * being unreachable.
 */
export async function findConnectionTools(
  query: string,
  limit: number,
  connectionsPath?: string,
  storePath?: string,
): Promise<{ hits: ToolHit[]; unavailable: UnavailableServer[] }> {
  const entries = onDemandConnections(connectionsPath);
  // Together, not one after another: each refresh is bounded at fifteen
  // seconds, and an owner with several servers that have gone quiet was
  // waiting that long for each of them before the search answered.
  const listings = await Promise.all(
    entries.map(async (entry) => [entry, await ensureConnectionListing(entry, storePath)] as const),
  );
  const hits: Array<ToolHit & { score: number }> = [];
  const unavailable: UnavailableServer[] = [];
  for (const [entry, { tools, status }] of listings) {
    const working = status.state === "ready" || status.state === "zero_tools";
    // The same rule as the mount guard (`refreshBeforeMount`): a server whose
    // latest status is not working offers nothing a bot could pick up, since
    // the pick-up would be refused. Its cached listing stays on disk for when
    // it recovers; it is just not searched.
    if (!working) {
      unavailable.push({
        connectionId: entry.id,
        server: oneLineName(entry.name),
        state: status.state,
        hint: unavailableHint(status.state, oneLineName(entry.name)),
      });
      continue;
    }
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
  return { hits: hits.slice(0, limit).map(({ score: _score, ...hit }) => hit), unavailable };
}

export async function searchConnectionTools(
  query: string,
  limit: number,
  connectionsPath?: string,
  storePath?: string,
): Promise<ToolHit[]> {
  return (await findConnectionTools(query, limit, connectionsPath, storePath)).hits;
}

/** Split a mounted name back into the connection and the tool it names. */
export function splitMountedName(name: string): { connectionId: string; tool: string } | null {
  const at = name.indexOf("__");
  if (at <= 0 || at + 2 >= name.length) return null;
  return { connectionId: name.slice(0, at), tool: name.slice(at + 2) };
}

export type MountedPick = {
  split: { connectionId: string; tool: string };
  entry: ConnectionEntry;
  indexed: IndexedTool;
  /** What the tool is charged, the way it is mounted. */
  weight: number;
};

/**
 * Which of a chat's picked tools actually register, in the order the chat
 * took them. The one selection the engine registers with
 * (agent/tools/picked.ts) and admission weighs
 * (web/lib/agent-exec.ts `mountedToolChars`): inside the
 * owner's allow-list as it is now, with an indexed listing, and clamped by the
 * cumulative count (MAX_SESSION_TOOLS) and byte (MAX_SESSION_TOOL_BYTES)
 * limits. A tool that would not mount is skipped, and so is not charged.
 */
export function selectMountedTools(
  names: Iterable<string>,
  lookup: {
    connection: (connectionId: string) => ConnectionEntry | null | undefined;
    indexed: (connectionId: string, tool: string) => IndexedTool | undefined;
  },
): MountedPick[] {
  const picks: MountedPick[] = [];
  let bytes = 0;
  for (const name of names) {
    const split = splitMountedName(name);
    if (!split) continue;
    const entry = lookup.connection(split.connectionId);
    if (!entry) continue;
    // The owner can narrow a server's allow-list after a chat picked a tool up.
    if (entry.toolsAllow && !entry.toolsAllow.includes(split.tool)) continue;
    const indexed = lookup.indexed(split.connectionId, split.tool);
    if (!indexed) continue;
    const weight = indexedToolBytes(indexed, entry.id, entry.name);
    if (picks.length + 1 > MAX_SESSION_TOOLS || bytes + weight > MAX_SESSION_TOOL_BYTES) continue;
    bytes += weight;
    picks.push({ split, entry, indexed, weight });
  }
  return picks;
}

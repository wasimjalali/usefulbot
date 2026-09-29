import {
  agentStorePath,
  appendAgentEvent,
  listProposalsOfKind,
  readProposal,
  updateProposal,
  type Proposal,
} from "./agent-store.ts";
import { assertConnectionUrl } from "./connection-url.ts";
import {
  allocateConnectionId,
  findConnectionByUrl,
  isAuthHeaderName,
  readConnectionsStore,
  upsertConnection,
  type ConnectionAuthKind,
  type ConnectionEntry,
} from "./connections-store.ts";
import { connectionSecretService, keychainSet } from "./keychain.ts";
import { listHandoffs, queueHandoff } from "./handoffs.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { listMcpTools, measureOpenApiConnection, modelToolNames } from "./mcp-http.ts";
import {
  completeMcpOAuth,
  dropOauthPending,
  dropOauthPendingForProposal,
  findOauthPending,
  startMcpOAuth,
} from "./mcp-oauth.ts";
import { readShell } from "./shell-io.ts";
import { DEFAULT_BOT_ID } from "./shell-store.ts";
import { putConnectionIndex, putConnectionOperations } from "./connection-tools-store.ts";
import { specWireBytes } from "./tool-wire-size.ts";
import {
  eagerConnections,
  isEagerConnection,
  mountedToolBytes,
  mountedToolCount,
  specNamesFit,
} from "./connection-tools.ts";
import { MOUNTED_TOOL_BUDGET, MOUNTED_TOOL_BYTE_BUDGET } from "./policy.ts";

/**
 * Connect-server card. Confirm writes the registry (and Keychain, and OAuth).
 * The tick's pump expires waiting cards and retries a resume that failed to
 * queue. Mirror of connect-flow.ts; do not share mutable memo with it.
 */

export const SERVER_WAIT_MS = 10 * 60 * 1000;
export const SERVER_LINGER_MS = 10 * 60 * 1000;

const authorizing = new Set<string>();

export function resetConnectionMemo(): void {
  authorizing.clear();
}

type Stored = Extract<Proposal, { kind: "connectServer" }>;

function isServer(proposal: Proposal | null): proposal is Stored {
  return proposal?.kind === "connectServer";
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function resumeMessage(card: Stored, connectionId: string): string {
  return `The owner connected the server ${connectionId}. Continue the original task.\n${wrapUntrusted("connect-purpose", oneLine(card.purpose, 120))}`;
}

/**
 * `connectionId` is the row the bot can actually reach, which is not always
 * the card's own id: a card for a URL another card already connected settles
 * against that row and keeps its own id, and naming that id would send the bot
 * looking for a connection that does not exist.
 */
function queueResume(card: Stored, storePath: string, connectionId = card.connectionId): boolean {
  const targetId = card.sourceBotId ?? card.threadId;
  let targetName = "Useful Bot";
  try {
    targetName = readShell().bots.find((bot) => bot.id === targetId)?.name ?? targetName;
  } catch {
    /* the name is cosmetic */
  }
  const message = resumeMessage(card, connectionId);
  let handoffId: string;
  try {
    const flippedAt = Date.parse(card.waitingSince ?? "");
    const existing = listHandoffs().find(
      (record) => record.targetBotId === targetId
        && record.message === message
        && record.sourceBotId === DEFAULT_BOT_ID
        && record.status !== "failed"
        && Number.isFinite(flippedAt)
        && Date.parse(record.createdAt) >= flippedAt - 1_000,
    );
    handoffId = existing?.id ?? queueHandoff({
      sourceBotId: DEFAULT_BOT_ID,
      sourceName: "Useful Bot",
      targetBotId: targetId,
      targetName,
      message,
      depth: 0,
    }).id;
  } catch {
    return false;
  }
  try {
    updateProposal(card.id, (item) => {
      if (item.kind !== "connectServer" || item.handoffId) return;
      item.handoffId = handoffId;
    }, storePath);
  } catch {
    return false;
  }
  return true;
}

/**
 * How many tools a connection has, for the card. For an MCP server this also
 * writes the listing to the index `find_tools` searches, so the first search
 * after a connect answers from disk instead of going back to the server.
 */
async function probeToolCount(entry: ConnectionEntry, headers: Record<string, string> = {}): Promise<number | null> {
  try {
    if (entry.kind === "openapi") {
      const size = await measureOpenApiConnection(entry.url, headers);
      // Written down because eve builds this connection's tools from the spec
      // and never hands them back: this is the only figure the mount-time
      // clamp has to weigh it by.
      if (size !== null) {
        try { putConnectionOperations(entry.id, size); } catch { /* a cache */ }
      }
      return size?.operations ?? null;
    }
    const tools = await listMcpTools(entry.url, headers);
    const visible = new Set(modelToolNames(tools));
    const allow = entry.toolsAllow ? new Set(entry.toolsAllow) : null;
    try {
      putConnectionIndex(
        entry.id,
        tools
          .filter((tool) => visible.has(tool.name) && (!allow || allow.has(tool.name)))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            inputSchemaBytes: tool.inputSchemaBytes,
                })),
      );
    } catch {
      // The index is a cache; a write that failed costs one listing later.
    }
    const names = entry.toolsAllow ?? [...visible];
    return names.length;
  } catch {
    return null;
  }
}

/**
 * Refuse a connect that would take the tools mounted on every turn past the
 * budget, before any row or credential is written.
 *
 * The router refuses a turn carrying more than `MAX_TOOL_SCHEMAS` with a
 * non-retryable `unsupported_parameter`, and eve retires a session that gets
 * one, so the chat is dead for good. Nothing used to look: the count on the
 * card was for the owner to read, and a connect that doubled a bot's tools
 * went through in silence. An MCP server costs nothing here, because its
 * tools wait to be asked for; an OpenAPI spec is what this counts.
 */
/**
 * @param headers what the caller legitimately holds for this connect, which
 * for a spec behind a key is the difference between countable and not. Passed
 * in rather than read from the Keychain: this runs before the row exists, so
 * the id it would read under may still belong to a different connection, and
 * that connection's credential must not be sent to this proposal's host.
 */
async function assertToolBudget(
  entry: ConnectionEntry,
  headers: Record<string, string> = {},
): Promise<void> {
  if (!isEagerConnection(entry)) return;
  // What is actually mounted, which is what reaches the wall. A row nobody
  // has measured is not mounted, so it costs nothing here: charging it the
  // ceiling made one unmeasurable row refuse every connect that followed,
  // for good, with no way to remove it.
  // A URL holds one row, so the one sharing this URL is the row this connect
  // becomes or settles onto, and is not additional. A row sharing only the
  // id is a different server that stays mounted: two cards for same-named
  // servers are handed the same id before either connects, and excluding it
  // admitted a connect while the real total was already over.
  const others = eagerConnections().filter((item) => item.url !== entry.url);
  const mounted = others.reduce((total, item) => total + (mountedToolCount(item) ?? 0), 0);
  const mountedBytes = others.reduce((total, item) => total + (mountedToolBytes(item) ?? 0), 0);
  let adding: number | null;
  let addingBytes: number;
  if (entry.kind === "openapi") {
    // A spec this app could not read is not a spec with no operations in it.
    // Counting it as zero let an unreachable or oversized one through, and
    // eve then mounted its whole operation list on every later turn: the
    // wall this check exists to keep out of reach. Measured, not rated: an
    // ordinary operation carries kilobytes of schema, so a flat rate per
    // operation cleared this budget and the router's by a factor of five.
    const size = await measureOpenApiConnection(entry.url, headers).catch(() => null);
    if (size === null) throw new Error("tool_count_unknown");
    // A name the provider refuses retires every session it is mounted in.
    // Checked against the longest id the store could give this row: an id
    // another server holds is reassigned `<first sixty>-<n>`, up to three
    // longer, and a check against the shorter one admitted a row the mount
    // then skipped for good.
    const longestId = "x".repeat(Math.max(entry.id.length, Math.min(entry.id.length, 60) + 3));
    if (!specNamesFit(longestId, size.longestName)) throw new Error("tool_name_too_long");
    adding = size.operations;
    // The same weighing the clamp uses, so the two cannot disagree.
    addingBytes = specWireBytes(size);
    // Not written here. This runs before the row exists, and two cards for
    // same-named servers are handed the same id before either connects, so a
    // measurement stamped now can land on another connection's index and sit
    // there for the six hours before anything re-measures it. `probeToolCount`
    // writes it afterwards, under the id the store actually gave this row.
  } else {
    // Unreachable while only OpenAPI is eager, and kept as a refusal rather
    // than a zero so a future eager kind cannot pass this check uncounted.
    throw new Error("tool_count_unknown");
  }
  if (mounted + adding > MOUNTED_TOOL_BUDGET || mountedBytes + addingBytes > MOUNTED_TOOL_BYTE_BUDGET) {
    throw new Error("tool_budget_exceeded");
  }
}

function authHeaders(authKind: ConnectionAuthKind, secret: string | null, authHeader: string | null): Record<string, string> {
  if (!secret) return {};
  if (authKind === "bearer") return { authorization: `Bearer ${secret}` };
  if (authKind === "apiKey") {
    const name = isAuthHeaderName(authHeader) ? authHeader : "X-Api-Key";
    return { [name]: secret };
  }
  return {};
}

function writeSecret(connectionId: string, secret: string): void {
  keychainSet(connectionSecretService(connectionId), secret);
}

function markConnected(
  proposalId: string,
  entry: ConnectionEntry,
  toolCount: number | null,
  now: number,
  storePath: string,
): Stored | null {
  updateProposal(proposalId, (item) => {
    if (item.kind !== "connectServer" || item.status !== "pending") return;
    item.phase = "connected";
    item.toolCount = toolCount;
    item.waitingSince = new Date(now).toISOString();
    item.redirectHost = null;
  }, storePath);
  const flipped = readProposal(proposalId, storePath);
  if (!isServer(flipped) || flipped.phase !== "connected") return null;
  try {
    appendAgentEvent(flipped.threadId, { kind: "note", text: `${entry.name} connected`, connectedName: entry.name }, storePath);
  } catch {
    /* the resume still tells the owner */
  }
  if (queueResume(flipped, storePath, entry.id)) {
    updateProposal(proposalId, (item) => {
      if (item.status === "pending") item.status = "confirmed";
    }, storePath);
  }
  return flipped;
}

export async function startConnectionConfirm(
  proposalId: string,
  opts: {
    secret?: string;
    callbackUrl: string;
    storePath?: string;
    now?: number;
  },
): Promise<{ redirectUrl?: string; redirectHost?: string }> {
  const storePath = opts.storePath ?? agentStorePath();
  const proposal = readProposal(proposalId, storePath);
  if (!isServer(proposal)) throw new Error("proposal_missing");
  if (proposal.status !== "pending") throw new Error("proposal_settled");
  if (proposal.phase === "connected") throw new Error("already_connected");
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (opts.now ?? Date.now())) throw new Error("proposal_expired");
  if (authorizing.has(proposalId)) throw new Error("authorize_in_flight");
  authorizing.add(proposalId);
  try {
    const url = assertConnectionUrl(proposal.url);
    const existing = findConnectionByUrl(url);
    if (existing && existing.id !== proposal.connectionId) {
      // The owner already approved this exact URL under another id. Settle
      // this card against the row that is there and let the bot resume.
      //
      // Not a second row: eve would mount the server twice, so the model would
      // see every one of its tools twice and both copies would count against
      // the tool cap. And not this card's id either: keychainSet writes with
      // `security add-generic-password -U`, so writing this card's secret
      // under the live row's id would overwrite the credential that row is
      // using, and an API key landing on an OAuth row destroys its refresh
      // token with nothing left to re-mint it.
      //
      // The tool count is left null, which is the same thing the card says
      // when the count call fails: reading it would mean holding the other
      // connection's credential, which is the thing this branch exists to
      // avoid.
      // Reopen on a waiting card reaches here, and its first Authorize wrote
      // a pending sign-in. Nothing else would ever reap it: the card is
      // connected now, so it can never start a fresh one, and a callback with
      // that state is refused before the completion drops it.
      dropOauthPendingForProposal(proposalId);
      markConnected(proposalId, existing, null, opts.now ?? Date.now(), storePath);
      return {};
    }
    if (proposal.authKind === "oauth") {
      const { authorizeUrl, redirectHost } = await startMcpOAuth({
        mcpUrl: url,
        name: proposal.name,
        proposalId,
        connectionId: proposal.connectionId,
        redirectUri: opts.callbackUrl,
      });
      const now = new Date(opts.now ?? Date.now()).toISOString();
      updateProposal(proposalId, (item) => {
        if (item.kind !== "connectServer" || item.status !== "pending" || item.phase === "connected") return;
        item.phase = "waiting";
        item.redirectHost = redirectHost;
        item.waitingSince = now;
      }, storePath);
      return { redirectUrl: authorizeUrl, redirectHost };
    }
    // Checked here, stored after the row is won. A secret written for a card
    // that lost the race has no row pointing at it and nothing ever deletes it.
    const needsSecret = proposal.authKind === "apiKey" || proposal.authKind === "bearer";
    const secret = needsSecret ? (opts.secret ?? "").trim() : "";
    if (needsSecret && (secret.length < 8 || secret.length > 4096)) throw new Error("secret_invalid");
    const toolsAllow = proposal.connectionId === "excalidraw" ? ["read_me", "create_view"] : null;
    const entry: ConnectionEntry = {
      id: proposal.connectionId || allocateConnectionId(proposal.name),
      kind: proposal.connectionKind,
      name: proposal.name,
      url,
      description: proposal.description || `${proposal.name} MCP server`,
      authKind: proposal.authKind,
      authHeader: proposal.authKind === "apiKey" ? (proposal.authHeader ?? "X-Api-Key") : null,
      toolsAllow,
      createdAt: new Date(opts.now ?? Date.now()).toISOString(),
    };
    // The store has the last word on which row a URL gets: another confirm can
    // land between the lookup above and this write, and only the lock can see
    // that. `stored` is the row that is live, this one or the one that won.
    // The store has the last word. It may hand back another card's row for
    // this URL, or the same row under a free id when this card's id turned out
    // to be a different server's. Everything below reads `stored`, never the
    // entry that went in.
    // Nothing is written until the budget says there is room: a row and a
    // credential for a connect that is about to be refused would have to be
    // unwound, and the unwinding is what loses a credential. The secret the
    // owner just pasted goes with the check, so a spec behind a key can be
    // counted at all; it is this card's own, not a row's.
    await assertToolBudget(entry, authHeaders(proposal.authKind, secret || null, entry.authHeader));
    const outcome = upsertConnection(entry);
    if (!outcome.won) {
      // Another card holds this URL. Nothing of this card's is in the store,
      // so nothing of its own may be written: its secret would land on the
      // winner's Keychain item and replace the credential that row is using.
      markConnected(proposalId, outcome.entry, null, opts.now ?? Date.now(), storePath);
      return {};
    }
    const stored = outcome.entry;
    // This card owns the row now. Both calls are synchronous, so nothing can
    // read the row between the insert and its credential landing.
    if (secret) writeSecret(stored.id, secret);
    const headers = authHeaders(
      proposal.authKind,
      proposal.authKind === "none" ? null : (opts.secret ?? "").trim() || null,
      stored.authHeader,
    );
    const toolCount = await probeToolCount(stored, headers);
    markConnected(proposalId, stored, toolCount, opts.now ?? Date.now(), storePath);
    return {};
  } finally {
    authorizing.delete(proposalId);
  }
}

export async function completeConnectionOAuth(
  code: string,
  state: string,
  opts: { storePath?: string; now?: number } = {},
): Promise<{ proposalId: string }> {
  const pendingPeek = findOauthPending(state);
  if (!pendingPeek || !pendingPeek.proposalId.startsWith("prp_")) throw new Error("oauth_state");
  const storePath = opts.storePath ?? agentStorePath();
  const proposal = readProposal(pendingPeek.proposalId, storePath);
  if (!isServer(proposal) || proposal.status !== "pending") throw new Error("proposal_missing");
  if (proposal.phase !== "waiting") throw new Error("proposal_phase");
  if (proposal.connectionId !== pendingPeek.connectionId) throw new Error("proposal_mismatch");
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (opts.now ?? Date.now())) throw new Error("proposal_expired");
  // Another card may have connected this same server while this sign-in was
  // open in the browser, from a bearer or apiKey card or from a second OAuth
  // card. Settle against the row that is there before the code is exchanged:
  // a second row mounts the server twice, and storing this token under the
  // live row's id would overwrite the credential it is already using.
  const settled = findConnectionByUrl(assertConnectionUrl(proposal.url));
  if (settled && settled.id !== proposal.connectionId) {
    // completeMcpOAuth is the only other thing that drops the pending row, and
    // it is not being called: the verifier and the client secret would sit on
    // disk for good, because a retry with this state is refused above.
    dropOauthPending(state);
    markConnected(pendingPeek.proposalId, settled, null, opts.now ?? Date.now(), storePath);
    return { proposalId: pendingPeek.proposalId };
  }
  const provisional: ConnectionEntry = {
    id: proposal.connectionId,
    kind: proposal.connectionKind,
    name: proposal.name,
    url: assertConnectionUrl(proposal.url),
    description: proposal.description || `${proposal.name} MCP server`,
    authKind: "oauth",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
  };
  // Refuse before the exchange only when the refusal is certain without a
  // credential: an authorization code is single use, so a refusal after it is
  // spent costs the owner the whole sign-in. It cannot be the only check,
  // because an OpenAPI spec behind this very sign-in answers 401 until the
  // token exists, and refusing on that made such a server unconnectable.
  try {
    await assertToolBudget(provisional);
  } catch (err) {
    if ((err as Error).message !== "tool_count_unknown") {
      // Nothing of this sign-in is worth keeping: the verifier and the client
      // secret would otherwise sit on disk with nothing pointing at them.
      dropOauthPending(state);
      throw err;
    }
  }
  const { bundle, pending } = await completeMcpOAuth({ code, state });
  if (pending.proposalId !== pendingPeek.proposalId || pending.connectionId !== pendingPeek.connectionId) {
    throw new Error("oauth_state");
  }
  const url = assertConnectionUrl(proposal.url);
  const entry: ConnectionEntry = {
    id: pending.connectionId,
    kind: proposal.connectionKind,
    name: proposal.name,
    url,
    description: proposal.description || `${proposal.name} MCP server`,
    authKind: "oauth",
    authHeader: null,
    toolsAllow: null,
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
  };
  // Same last word as the confirm path: only the store's lock can see a row
  // that landed for this URL while the browser had the sign-in open.
  const bearer = { authorization: `Bearer ${bundle.accessToken}` };
  // After the exchange, because a spec behind this very sign-in cannot be
  // read without the token, but still before anything is written. Refusing
  // after the row and the credential were committed left a connection that
  // never mounts, that the owner is told is connected, and that nothing can
  // remove: a spec that became readable later would even mount itself.
  await assertToolBudget(entry, bearer);
  const outcome = upsertConnection(entry);
  if (!outcome.won) {
    // Another card connected this server between the check above and this
    // write. Storing the bundle would replace the credential that row is
    // using, and leave this access and refresh token with nothing pointing
    // at them.
    markConnected(pending.proposalId, outcome.entry, null, opts.now ?? Date.now(), storePath);
    return { proposalId: pending.proposalId };
  }
  const stored = outcome.entry;
  keychainSet(connectionSecretService(stored.id), JSON.stringify(bundle));
  const toolCount = await probeToolCount(stored, bearer);
  markConnected(pending.proposalId, stored, toolCount, opts.now ?? Date.now(), storePath);
  return { proposalId: pending.proposalId };
}

let pumpQueue: Promise<unknown> = Promise.resolve();

export function pumpConnections(
  opts: { now?: number; storePath?: string } = {},
): Promise<{ connected: string[]; expired: string[] }> {
  const run = pumpQueue.then(() => pumpOnce(opts), () => pumpOnce(opts));
  pumpQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function pumpOnce(
  opts: { now?: number; storePath?: string },
): Promise<{ connected: string[]; expired: string[] }> {
  const now = opts.now ?? Date.now();
  const storePath = opts.storePath ?? agentStorePath();
  const connected: string[] = [];
  const expired: string[] = [];
  const cards = listProposalsOfKind("connectServer", storePath).filter((item) => item.status === "pending");
  for (const card of cards.filter((item) => item.phase === "connected")) {
    const since = Date.parse(card.waitingSince ?? "");
    const lingered = !Number.isFinite(since) || now - since > SERVER_LINGER_MS;
    // A settled card keeps its own connectionId, which has no row. The live
    // one is whatever holds its URL.
    const queued = card.handoffId
      ? true
      : queueResume(card, storePath, findConnectionByUrl(card.url)?.id ?? card.connectionId);
    if (queued || lingered) {
      updateProposal(card.id, (item) => {
        if (item.status === "pending") item.status = "confirmed";
      }, storePath);
      if (queued) connected.push(card.id);
    }
  }
  for (const card of cards.filter((item) => item.phase === "waiting")) {
    const since = Date.parse(card.waitingSince ?? "");
    if (Number.isFinite(since) && now - since <= SERVER_WAIT_MS) continue;
    let didExpire = false;
    updateProposal(card.id, (item) => {
      if (item.kind === "connectServer" && item.phase === "waiting" && item.waitingSince === card.waitingSince) {
        item.phase = "expired";
        didExpire = true;
      }
    }, storePath);
    if (didExpire) expired.push(card.id);
  }
  return { connected, expired };
}

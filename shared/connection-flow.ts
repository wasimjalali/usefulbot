import {
  agentStorePath,
  appendAgentEvent,
  listProposalsOfKind,
  readProposal,
  updateProposal,
  type Proposal,
} from "./agent-store.ts";
import { withRefreshLock } from "./connection-auth.ts";
import { assertConnectionUrl } from "./connection-url.ts";
import {
  allocateConnectionId,
  findConnectionById,
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
import { measureOpenApiConnection } from "./mcp-http.ts";
import {
  completeMcpOAuth,
  dropOauthPending,
  dropOauthPendingForProposal,
  findOauthPending,
  oauthPendingExpired,
  findOauthPendingForProposal,
  OAuthTokenError,
  startMcpOAuth,
} from "./mcp-oauth.ts";
import { readShell } from "./shell-io.ts";
import { DEFAULT_BOT_ID, orchestratorId } from "./shell-store.ts";
import type { ConnectionState, ConnectionStatus } from "./connection-tools-store.ts";
import { specWireBytes } from "./tool-wire-size.ts";
import {
  discoverConnection,
  eagerConnections,
  ensureConnectionListing,
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

/**
 * Sign-in states whose callback is being finished in this process. A browser
 * that delivers the callback twice must not spend the code twice: the second
 * delivery would be refused by the server and read as a failed sign-in.
 */
const exchanging = new Set<string>();

export function resetConnectionMemo(): void {
  authorizing.clear();
  exchanging.clear();
}

type Stored = Extract<Proposal, { kind: "connectServer" }>;

function isServer(proposal: Proposal | null): proposal is Stored {
  return proposal?.kind === "connectServer";
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function resumeMessage(card: Stored, connectionId: string): string {
  // A connected server with nothing to offer is still connected, and a bot
  // told only "connected" would go looking for tools that are not there.
  const empty = card.toolCount === 0 ? " It offers no tools, so say so if the task needed one." : "";
  return `The owner connected the server ${connectionId}.${empty} Continue the original task.\n${wrapUntrusted("connect-purpose", oneLine(card.purpose, 120))}`;
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
  // The resume is sent by the orchestrator under its real name. The roster
  // not reading falls back to the default bot, as the name always did.
  let source = { id: DEFAULT_BOT_ID, name: "Useful Bot" };
  try {
    const shell = readShell();
    targetName = shell.bots.find((bot) => bot.id === targetId)?.name ?? targetName;
    const orchestrator = shell.bots.find((bot) => bot.id === orchestratorId(shell));
    if (orchestrator) source = { id: orchestrator.id, name: orchestrator.name };
  } catch {
    /* the names are cosmetic */
  }
  const message = resumeMessage(card, connectionId);
  let handoffId: string;
  try {
    const flippedAt = Date.parse(card.waitingSince ?? "");
    const existing = listHandoffs().find(
      (record) => record.targetBotId === targetId
        && record.message === message
        && record.sourceBotId === source.id
        && record.status !== "failed"
        && Number.isFinite(flippedAt)
        && Date.parse(record.createdAt) >= flippedAt - 1_000,
    );
    handoffId = existing?.id ?? queueHandoff({
      sourceBotId: source.id,
      sourceName: source.name,
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
 * What the connection offers, for the card. For an MCP server this also writes
 * the listing to the index `find_tools` searches, so the first search after a
 * connect answers from disk instead of going back to the server, and a status
 * that says why when nothing came back.
 */
async function probeConnection(entry: ConnectionEntry, headers: Record<string, string> = {}): Promise<ConnectionStatus> {
  return (await discoverConnection(entry, { headers })).status;
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
    // there for the six hours before anything re-measures it. `probeConnection`
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

/**
 * A card is honest about what it found: only a server that answered with its
 * tools, or answered that it has none, is connected. Anything else leaves the
 * row and its credential where they are, so the owner can reauthorize or
 * remove it, and puts the card in `failed` with the state as the reason. No
 * resume goes to the bot: nothing it could use was connected.
 */
function settleProbe(
  proposalId: string,
  entry: ConnectionEntry,
  status: ConnectionStatus,
  now: number,
  storePath: string,
): void {
  if (status.state === "ready" || status.state === "zero_tools") {
    markConnected(proposalId, entry, status.toolCount ?? 0, now, storePath);
    return;
  }
  failCard(proposalId, status.state, now, storePath);
}

/** Put a pending card in `failed` with a short reason this app wrote. */
function failCard(
  proposalId: string,
  reason: ConnectionState,
  now: number,
  storePath: string,
  /** Only a card still waiting for its sign-in: one already settled is not flipped back. */
  onlyWaiting = false,
): void {
  updateProposal(proposalId, (item) => {
    if (item.kind !== "connectServer" || item.status !== "pending") return;
    if (onlyWaiting && item.phase !== "waiting") return;
    item.phase = "failed";
    item.reason = reason;
    item.toolCount = null;
    item.waitingSince = new Date(now).toISOString();
    item.redirectHost = null;
  }, storePath);
}

/**
 * Why a token exchange failed, in the card's own vocabulary and nothing the
 * server said: a refusal (4xx, or an answer with no token) is the credential,
 * and a network error, a timeout, a 5xx or a 429 is the server.
 */
function exchangeFailure(err: unknown): ConnectionState {
  if (err instanceof OAuthTokenError && err.status < 500 && err.status !== 429) return "auth_failed";
  return "unreachable";
}

/**
 * Settle a card against a row that was there before it: the owner already
 * approved this server, so what the card says is what that row is doing. Its
 * status when it has a fresh one, a listing when it has none (or is being
 * listed now), and only a working row connects the card. Marking the card
 * connected on the row's mere existence told the bot a server that refuses its
 * credential, or is down, was ready.
 */
async function settleAgainstRow(
  proposalId: string,
  row: ConnectionEntry,
  now: number,
  storePath: string,
): Promise<ConnectionStatus> {
  const found = await ensureConnectionListing(row);
  const status = found.status.state === "pending" ? (await discoverConnection(row)).status : found.status;
  settleProbe(proposalId, row, status, now, storePath);
  return status;
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
    item.reason = null;
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
      // What the row offers is read with the row's own credential, by the row's
      // own id; this card's secret is never involved.
      // Reopen on a waiting card reaches here, and its first Authorize wrote
      // a pending sign-in. Nothing else would ever reap it: the card is
      // connected now, so it can never start a fresh one, and a callback with
      // that state is refused before the completion drops it.
      dropOauthPendingForProposal(proposalId);
      await settleAgainstRow(proposalId, existing, opts.now ?? Date.now(), storePath);
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
        item.reason = null;
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
      await settleAgainstRow(proposalId, outcome.entry, opts.now ?? Date.now(), storePath);
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
    settleProbe(proposalId, stored, await probeConnection(stored, headers), opts.now ?? Date.now(), storePath);
    return {};
  } finally {
    authorizing.delete(proposalId);
  }
}

/**
 * The pending sign-in of a connection that is already connected and being
 * signed in again, in place of a card's id. One per connection, so starting
 * another replaces it.
 */
export const REAUTH_PREFIX = "reauth_";

export function reauthorizeProposalId(connectionId: string): string {
  return `${REAUTH_PREFIX}${connectionId}`;
}

/**
 * Finish a sign-in for a connection that is already in the registry: the new
 * tokens replace the old ones under the same id, the row is not touched and no
 * card is involved. What the server then offers is listed again, so the
 * connection's status says whether the new sign-in worked.
 */
/** What a finished sign-in found when it listed the server's tools, for the callback page. */
export type OAuthOutcome = { proposalId: string; ready: boolean; state: ConnectionState };

function outcomeOf(proposalId: string, status: ConnectionStatus): OAuthOutcome {
  return { proposalId, ready: status.state === "ready" || status.state === "zero_tools", state: status.state };
}

async function completeReauthorize(
  code: string,
  state: string,
  peek: { proposalId: string; connectionId: string; resource?: string },
): Promise<OAuthOutcome> {
  const entry = findConnectionById(peek.connectionId);
  if (!entry || entry.authKind !== "oauth" || reauthorizeProposalId(entry.id) !== peek.proposalId) {
    dropOauthPending(state);
    throw new Error("connection_missing");
  }
  // The sign-in was asked for a resource; a token for any other origin than
  // this connection's would be stored over the one it holds. Checked before
  // the code is spent, and a sign-in that names none is refused too.
  let sameOrigin = false;
  try {
    sameOrigin = new URL(peek.resource as string).origin === new URL(entry.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    dropOauthPending(state);
    throw new Error("oauth_resource_origin");
  }
  let status: ConnectionStatus;
  try {
    const { bundle, pending } = await completeMcpOAuth({ code, state, keepPending: true });
    logTokenAudience(pending.connectionId, bundle.accessToken, pending.resource);
    if (pending.proposalId !== peek.proposalId || pending.connectionId !== entry.id) throw new Error("oauth_state");
    // The owner may have removed the connection while the browser was open; a
    // credential stored now would have no row pointing at it.
    // Written under the refresh lock: a refresh of the old sign-in that is out
    // now would otherwise land after this and put the old credential back.
    await withRefreshLock(entry.id, () => {
      if (!findConnectionById(entry.id)) throw new Error("connection_missing");
      // Starting the sign-in again replaced this attempt's pending row. An older
      // exchange that lands after a newer one began must not put its tokens
      // over the newer sign-in's.
      assertAttemptCurrent(state, peek.proposalId);
      keychainSet(connectionSecretService(entry.id), JSON.stringify(bundle));
    });
    status = (await discoverConnection(entry, { headers: { authorization: `Bearer ${bundle.accessToken}` } })).status;
    // A newer reauthorize began while the listing was read: it owns the
    // outcome, and this callback must not say Connected.
    assertAttemptCurrent(state, peek.proposalId);
  } finally {
    // The code is spent whatever happened: the verifier and the client secret
    // do not stay on disk.
    dropOauthPending(state);
  }
  return outcomeOf(peek.proposalId, status);
}

export async function completeConnectionOAuth(
  code: string,
  state: string,
  opts: { storePath?: string; now?: number } = {},
): Promise<OAuthOutcome> {
  const pendingPeek = findOauthPending(state);
  const reauthorizing = pendingPeek?.proposalId.startsWith(REAUTH_PREFIX) === true;
  if (!pendingPeek || (!reauthorizing && !pendingPeek.proposalId.startsWith("prp_"))) throw new Error("oauth_state");
  // A second delivery of the same callback while the first is being finished
  // says nothing new: it neither spends the code again nor touches the card.
  // A second delivery of a callback already being exchanged doesn't know the
  // outcome yet: it says so rather than guessing Connected.
  if (exchanging.has(state)) return { proposalId: pendingPeek.proposalId, ready: false, state: "pending" };
  exchanging.add(state);
  try {
    return reauthorizing
      ? await completeReauthorize(code, state, pendingPeek)
      : await finishConnectionOAuth(code, state, pendingPeek, opts);
  } finally {
    exchanging.delete(state);
  }
}

async function finishConnectionOAuth(
  code: string,
  state: string,
  pendingPeek: NonNullable<ReturnType<typeof findOauthPending>>,
  opts: { storePath?: string; now?: number },
): Promise<OAuthOutcome> {
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
    const status = await settleAgainstRow(pendingPeek.proposalId, settled, opts.now ?? Date.now(), storePath);
    return outcomeOf(pendingPeek.proposalId, status);
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
  let exchanged: Awaited<ReturnType<typeof completeMcpOAuth>>;
  try {
    // The pending row stays until this attempt is done with the card: it is the
    // attempt's identity. Starting the sign-in again replaces it, and an attempt
    // whose row is gone is an older one that may no longer settle anything.
    exchanged = await completeMcpOAuth({ code, state, keepPending: true });
  } catch (err) {
    // The pending row vanished: there is no sign-in of ours to fail.
    if (err instanceof Error && err.message === "oauth_state") {
      // Replaced between the peek and the exchange: say so when a newer
      // sign-in for this card exists.
      if (newerAttemptExists(state, pendingPeek.proposalId)) throw new Error("oauth_superseded");
      throw err;
    }
    // The code is spent or refused either way, so the sign-in is over: the
    // card says why instead of waiting ten minutes to say it timed out, and the
    // verifier and client secret do not stay on disk. An older attempt, with a
    // newer sign-in started since (its row gone), is not what the card waits on.
    const latest = !isSuperseded(state, pendingPeek.proposalId);
    dropOauthPending(state);
    if (!latest) throw err;
    failCard(pendingPeek.proposalId, exchangeFailure(err), opts.now ?? Date.now(), storePath, true);
    throw err;
  }
  try {
    return await settleExchanged(exchanged, state, pendingPeek, proposal, opts.now ?? Date.now(), storePath);
  } finally {
    dropOauthPending(state);
  }
}

/**
 * Whether a newer sign-in replaced this attempt: its pending row is gone.
 * A row that is still on disk but past the 15-minute limit is an expired
 * attempt, not a superseded one.
 */
function isSuperseded(state: string, proposalId: string): boolean {
  return findOauthPending(state) === null && !oauthPendingExpired(state) && newerAttemptExists(state, proposalId);
}

/** A live pending row for the same card (or reauthorize) that is not this attempt's. */
function newerAttemptExists(state: string, proposalId: string): boolean {
  const row = findOauthPendingForProposal(proposalId);
  return row !== null && row.state !== state;
}

/**
 * Throws when this attempt may no longer settle anything: `oauth_superseded`
 * when a newer sign-in replaced it, `oauth_state` when its row went some other
 * way (settled against an existing row, a refused callback, expiry pruning).
 */
function assertAttemptCurrent(state: string, proposalId: string): void {
  if (findOauthPending(state) !== null || oauthPendingExpired(state)) return;
  throw new Error(newerAttemptExists(state, proposalId) ? "oauth_superseded" : "oauth_state");
}

async function settleExchanged(
  exchanged: Awaited<ReturnType<typeof completeMcpOAuth>>,
  state: string,
  pendingPeek: NonNullable<ReturnType<typeof findOauthPending>>,
  proposal: Stored,
  now: number,
  storePath: string,
): Promise<OAuthOutcome> {
  const { bundle, pending } = exchanged;
  if (pending.proposalId !== pendingPeek.proposalId || pending.connectionId !== pendingPeek.connectionId) {
    throw new Error("oauth_state");
  }
  // The exchange took a while: the owner may have started the sign-in again.
  // The newer attempt owns the card; this one stores, settles and starts
  // nothing.
  assertAttemptCurrent(state, pendingPeek.proposalId);
  logTokenAudience(pending.connectionId, bundle.accessToken, pending.resource);
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
    createdAt: new Date(now).toISOString(),
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
  assertAttemptCurrent(state, pendingPeek.proposalId);
  const outcome = upsertConnection(entry);
  if (!outcome.won) {
    // Another card connected this server between the check above and this
    // write. Storing the bundle would replace the credential that row is
    // using, and leave this access and refresh token with nothing pointing
    // at them.
    const lost = await settleAgainstRow(pending.proposalId, outcome.entry, now, storePath);
    return outcomeOf(pending.proposalId, lost);
  }
  const stored = outcome.entry;
  keychainSet(connectionSecretService(stored.id), JSON.stringify(bundle));
  const status = await probeConnection(stored, bearer);
  // A newer sign-in began while the listing was read: the card is waiting on
  // it, and this callback must not say Connected.
  assertAttemptCurrent(state, pendingPeek.proposalId);
  settleProbe(pending.proposalId, stored, status, now, storePath);
  return outcomeOf(pending.proposalId, status);
}

/**
 * The sign-in server sent the owner back with `error=` (access denied, or a
 * refusal): drop the pending sign-in so its verifier does not stay on disk, and
 * fail the card that was waiting for it, so it says so instead of timing out
 * ten minutes later. A reauthorize has no card. A state nothing holds is
 * ignored. Never throws.
 */
export function failConnectionOAuth(state: string, opts: { storePath?: string; now?: number } = {}): void {
  try {
    const pending = findOauthPending(state);
    if (!pending) return;
    dropOauthPending(state);
    if (!pending.proposalId.startsWith("prp_")) return;
    failCard(pending.proposalId, "auth_failed", opts.now ?? Date.now(), opts.storePath ?? agentStorePath(), true);
  } catch (err) {
    console.error(`[useful-bot] a refused sign-in could not be recorded: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`);
  }
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

/**
 * One line per sign-in naming the audience the sign-in server put in the
 * access token and the resource it was asked for. A server that ignores an
 * unknown resource mints a token its own API refuses (Tella, 2026-10-04), and
 * this is the line that shows it. Only the `aud` claim is read; the token and
 * its other claims never reach the log.
 */
function logTokenAudience(id: string, accessToken: string, resource: string | undefined): void {
  // A claim is the sign-in server's text and goes into a log line: control
  // characters (a newline would start a line of its own) are removed first.
  const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, 120);
  let aud = "opaque";
  const parts = accessToken.split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { aud?: unknown };
      const value = Array.isArray(claims.aud) ? claims.aud.join(" ") : claims.aud;
      aud = typeof value === "string" ? clean(value) : "none";
    } catch {
      aud = "unreadable";
    }
  }
  // The resource is a URL the server published; a key in its query is not
  // for the log, so only the origin and path are written.
  let where = "none";
  if (resource !== undefined) {
    try {
      const parsed = new URL(resource);
      where = clean(`${parsed.origin}${parsed.pathname}`);
    } catch {
      where = "invalid";
    }
  }
  console.error(`[useful-bot] connection ${id} token aud=${aud} resource=${where}`);
}

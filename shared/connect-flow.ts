import {
  agentStorePath,
  appendAgentEvent,
  listProposalsOfKind,
  readProposal,
  updateProposal,
  type Proposal,
} from "./agent-store.ts";
import { authorizeConnector, countToolkitTools, forgetConnected, listConnectorToolkits } from "./composio.ts";
import { connectorsPath as defaultConnectorsPath } from "./connectors-store.ts";
import { listHandoffs, queueHandoff } from "./handoffs.ts";
import { readShell } from "./shell-io.ts";
import { DEFAULT_BOT_ID, orchestratorId } from "./shell-store.ts";

/**
 * The connect card's server side. Confirm starts Composio OAuth and parks the
 * card in `waiting`; the tick calls pumpConnects, which asks Composio whether
 * the account is active and, once it is, queues the resume handoff for the
 * bot that asked. The redirect URL is returned to the caller once and never
 * stored.
 */

export const CONNECT_WAIT_MS = 10 * 60 * 1000;
export const CONNECT_CHECK_MS = 5_000;
/** How long a Connected card whose resume cannot be queued stays before it leaves anyway. */
export const CONNECT_LINGER_MS = 10 * 60 * 1000;

const lastCheck = new Map<string, number>();
/** Cards whose authorize call is in flight, so a double click mints one account, not two. */
const authorizing = new Set<string>();

export function resetConnectMemo(): void {
  lastCheck.clear();
  authorizing.clear();
}

type Stored = Extract<Proposal, { kind: "connectApp" }>;

function isConnect(proposal: Proposal | null): proposal is Stored {
  return proposal?.kind === "connectApp";
}

/** The bot's own purpose line, flattened: the resume is an instruction channel. */
function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * The resume turn. Only the validated slug names the app: the display name
 * comes from Composio's catalogue and is data, not an instruction.
 */
function resumeMessage(card: Stored): string {
  return `The owner connected the app ${card.slug}. Continue the task: ${oneLine(card.purpose, 120)}`;
}

export async function startConnectAuthorize(
  proposalId: string,
  callbackUrl: string,
  opts: { storePath?: string; connectorsPath?: string; now?: number } = {},
): Promise<{ redirectUrl: string }> {
  const storePath = opts.storePath ?? agentStorePath();
  const proposal = readProposal(proposalId, storePath);
  if (!isConnect(proposal)) throw new Error("proposal_missing");
  if (proposal.status !== "pending") throw new Error("proposal_settled");
  if (proposal.phase === "connected") throw new Error("already_connected");
  // Same rule as every other confirm: a card past its TTL is not confirmable.
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (opts.now ?? Date.now())) throw new Error("proposal_expired");
  if (authorizing.has(proposalId)) throw new Error("authorize_in_flight");
  authorizing.add(proposalId);
  try {
    const { redirectUrl, accountId } = await authorizeConnector(
      proposal.slug,
      callbackUrl,
      opts.connectorsPath ?? defaultConnectorsPath(),
    );
    const now = new Date(opts.now ?? Date.now()).toISOString();
    updateProposal(proposalId, (item) => {
      // Never rewind a card the pump connected while authorize was in flight.
      if (item.kind !== "connectApp" || item.status !== "pending" || item.phase === "connected") return;
      item.phase = "waiting";
      item.accountId = accountId;
      item.waitingSince = now;
    }, storePath);
    lastCheck.delete(proposalId);
    return { redirectUrl };
  } finally {
    authorizing.delete(proposalId);
  }
}

/**
 * Queue the bot's resume for a connected card and record its id. Returns
 * false when the record could not be written; the caller retries later.
 */
function queueResume(card: Stored, now: number, storePath: string): boolean {
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
  const message = resumeMessage(card);
  let handoffId: string;
  try {
    // Idempotent: a resume already queued for this card (the id write failed
    // last time) is adopted, never queued twice, whatever its status now,
    // since a delivered one already gave the bot its turn. Only this cycle's
    // record counts: waitingSince is stamped at the flip, so an older record
    // from an earlier connect of the same app is not this card's resume.
    const flippedAt = Date.parse(card.waitingSince ?? "");
    const existing = listHandoffs().find(
      (record) => record.targetBotId === targetId
        && record.message === message
        && record.sourceBotId === source.id
        // A resume that gave up never reached the bot: queue a fresh one.
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
      if (item.kind !== "connectApp" || item.handoffId) return;
      item.handoffId = handoffId;
    }, storePath);
  } catch {
    // The record exists; the next sweep finds it by message and records it.
    return false;
  }
  return true;
}

// Single-flight, like the handoff pump: the tick fires this on every poll and
// two overlapping runs could both read a card with no resume id and queue
// the resume twice. Callers queue behind the run in progress.
let pumpQueue: Promise<unknown> = Promise.resolve();

export function pumpConnects(
  opts: { now?: number; storePath?: string; connectorsPath?: string } = {},
): Promise<{ connected: string[]; expired: string[] }> {
  const run = pumpQueue.then(() => pumpConnectsOnce(opts), () => pumpConnectsOnce(opts));
  pumpQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function pumpConnectsOnce(
  opts: { now?: number; storePath?: string; connectorsPath?: string },
): Promise<{ connected: string[]; expired: string[] }> {
  const now = opts.now ?? Date.now();
  const storePath = opts.storePath ?? agentStorePath();
  const connectorsPath = opts.connectorsPath ?? defaultConnectorsPath();
  const connected: string[] = [];
  const expired: string[] = [];
  const cards = listProposalsOfKind("connectApp", storePath).filter((item) => item.status === "pending");
  // A Connected card still pending is one whose resume could not be queued
  // when it flipped: queue it now and let the card go, or give up after the
  // linger cap so the owner is not left with a stuck pill.
  for (const card of cards.filter((item) => item.phase === "connected")) {
    const since = Date.parse(card.waitingSince ?? "");
    const lingered = !Number.isFinite(since) || now - since > CONNECT_LINGER_MS;
    const queued = card.handoffId ? true : queueResume(card, now, storePath);
    if (queued || lingered) {
      // Only from pending: a dismiss that landed since the read above wins.
      updateProposal(card.id, (item) => {
        if (item.status === "pending") item.status = "confirmed";
      }, storePath);
    }
  }
  const waiting = cards.filter((item) => item.phase === "waiting");
  for (const card of waiting) {
    const since = Date.parse(card.waitingSince ?? "");
    const overdue = !Number.isFinite(since) || now - since > CONNECT_WAIT_MS;
    // An overdue card is asked about once more before it expires: a sign-in
    // that finished while no tick ran (app closed, Mac asleep) must still
    // connect, not time out.
    const checked = lastCheck.get(card.id) ?? 0;
    if (now - checked < CONNECT_CHECK_MS && !overdue) continue;
    lastCheck.set(card.id, now);
    let active = false;
    try {
      forgetConnected();
      const page = await listConnectorToolkits({ search: card.slug, limit: 20 }, connectorsPath);
      active = page.rows.some((row) => row.slug === card.slug && row.connected);
    } catch {
      continue;
    }
    if (!active) {
      if (!overdue) continue;
      // Only if still waiting on the same sign-in: a Reopen that landed
      // since the read above restamped waitingSince and must not expire.
      let didExpire = false;
      updateProposal(card.id, (item) => {
        if (item.kind === "connectApp" && item.phase === "waiting" && item.waitingSince === card.waitingSince) {
          item.phase = "expired";
          didExpire = true;
        }
      }, storePath);
      lastCheck.delete(card.id);
      if (didExpire) expired.push(card.id);
      continue;
    }
    const toolCount = await countToolkitTools(card.slug, connectorsPath);
    // Flip under the lock, and only from waiting: a dismiss that landed
    // between the check and here must win, and a pump that overlapped this
    // one must not flip (and resume) the same card twice.
    let didFlip = false;
    updateProposal(card.id, (item) => {
      if (item.kind !== "connectApp" || item.status !== "pending" || item.phase !== "waiting") return;
      item.phase = "connected";
      item.toolCount = toolCount;
      // From here waitingSince bounds how long the pill may wait for its resume.
      item.waitingSince = new Date(now).toISOString();
      didFlip = true;
    }, storePath);
    if (!didFlip) continue;
    try {
      appendAgentEvent(card.threadId, { kind: "note", text: `${card.name} connected`, connectedName: card.name, connectedLogo: card.logo }, storePath);
    } catch {
      /* the resume still tells the owner */
    }
    // The card leaves the dock the moment the resume is queued: the note row
    // and the bot's next turn tell the rest. A queue failure leaves it
    // Connected with no handoff id and the sweep above retries next tick.
    if (queueResume(card, now, storePath)) {
      updateProposal(card.id, (item) => {
        if (item.status === "pending") item.status = "confirmed";
      }, storePath);
    }
    lastCheck.delete(card.id);
    connected.push(card.id);
  }
  return { connected, expired };
}

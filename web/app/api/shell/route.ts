import { NextResponse } from "next/server";
import { lstatSync, realpathSync } from "node:fs";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { runtimeConfig } from "../../../lib/auth";
import {
  appendAgentEvent,
  claimProposal,
  clearThread,
  deleteThread,
  readProposal,
  reopenProposal,
  threadIdFor,
  type Proposal,
} from "../../../../shared/agent-store.ts";
import { deliverFirstBrief, fanOut, syncSessionWorkspace } from "../../../lib/agent-exec";
import { startConnectAuthorize } from "../../../../shared/connect-flow.ts";
import { startConnectionConfirm } from "../../../../shared/connection-flow.ts";
import { deleteRoutinesForBot } from "../../../../shared/routines-store.ts";
import { unbindBot } from "../../../../shared/session-bindings.ts";
import { applyShellAction, DESCRIPTION_MAX, isGrantableRootPath, profileCardIsCurrent, proposerMayConfirm, staleSessionIds, type ShellAction, type ShellStore } from "../../../../shared/shell-store.ts";
import { readShell, updateShell } from "../../../../shared/shell-io.ts";
import { readProviderStore } from "../../../../shared/providers.ts";
import { readSessionGrant, removeSessionGrant } from "../../../../shared/workspace-store.ts";
import { groupMembers, speakersFrom } from "../../../../shared/threads.ts";
import { webOrigin } from "../../../../shared/stack.ts";

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  try {
    return NextResponse.json({ ok: true, store: readShell() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "shell_unavailable") }, { status: 400 });
  }
}

/**
 * Side effects the UI asks for alongside a shell action:
 *  - a confirmed fan-out (a bot proposed a group post) queues one handoff per
 *    member bot and touches both sides of every transcript;
 *  - clearing a thread drops that bot's agent transcript with its eve session.
 *
 * Deleting a bot is not here: see `detachBot`, which runs after the roster
 * commit and reports its own failure rather than being swallowed.
 */
function applyFollowUp(action: ShellAction | undefined, shell: ShellStore): number {
  if (!action) return 0;
  if (action.type === "sendToBot") {
    const target = shell.bots.find((bot) => bot.id === action.botId);
    if (!target) return 0;
    const source = action.sourceBotId
      ? shell.bots.find((bot) => bot.id === action.sourceBotId) ?? null
      : null;
    const from = source ? { id: source.id, name: source.name } : null;
    if (target.kind === "group") {
      const members = groupMembers(speakersFrom(shell.bots), target.memberIds);
      return fanOut({
        source: from,
        targets: members.map((member) => ({ id: member.id, name: member.name })),
        message: action.message,
        group: { id: target.id, name: target.name },
      });
    }
    return fanOut({
      source: from,
      targets: [{ id: target.id, name: target.name }],
      message: action.message,
    });
  }
  if (action.type === "clearThread") {
    clearThread(action.botId);
  }
  return 0;
}

/**
 * Drop the filesystem capabilities an action just took away. `staleSessionIds`
 * works out which ones; this spends them.
 *
 * Best effort, like `detachBot`: the roster is the authority, and the stamp at
 * the next turn is the backstop. It must not turn a locked grants store into a
 * failed roster action the owner already saw succeed.
 */
function revokeGrantsFor(
  action: ShellAction | undefined,
  before: ShellStore,
  after: ShellStore,
): void {
  for (const id of staleSessionIds(action, before, after)) {
    try {
      removeSessionGrant(id);
    } catch {
      /* the next turn's stamp revokes it; a locked store is not this action's failure */
    }
  }
}

/**
 * What a bot owns outside the shell store: its routines and its transcript.
 *
 * This runs after the roster commit, not before it. Before means a commit that
 * throws (a contended shell lock, a guard inside `applyShellAction`) has
 * already destroyed the routines and the transcript of a bot that still
 * exists, which is worse than the orphan it was trying to avoid. Nothing here
 * can be atomic with the roster write anyway: three stores, three locks. So
 * the roster is the authority, this is best effort, and `sweepOrphanState` on the
 * tick is what makes a failure here temporary instead of permanent.
 *
 * Returns the error when it could not finish, so the caller can say so rather
 * than swallow it the way this path used to.
 */
function detachBot(botId: string): string | null {
  const errors: string[] = [];
  // Independently: a locked routines store is no reason to leave the
  // transcript behind as well, and the caller needs to hear about both.
  try {
    deleteRoutinesForBot(botId);
  } catch (err) {
    errors.push(`routines:${errorCode(err, "detach_failed")}`);
  }
  try {
    deleteThread(botId);
  } catch (err) {
    errors.push(`transcript:${errorCode(err, "detach_failed")}`);
  }
  // The deleted bot's session bindings go with it: the only way a row leaves
  // the identity store.
  try {
    unbindBot(botId);
  } catch (err) {
    errors.push(`sessions:${errorCode(err, "detach_failed")}`);
  }
  return errors.length > 0 ? errors.join(",") : null;
}

/**
 * Where Composio sends the browser back after the hosted sign-in (S6): a
 * phone session gets the configured tailnet origin so the return lands back
 * through Serve; desktop keeps the loopback origin. Never derived from the
 * request.
 */
function connectCallbackUrl(profile: string): string {
  const tailnet = profile === "phone" ? runtimeConfig()?.tailnet : null;
  const base = tailnet?.httpsOrigin || webOrigin();
  return new URL("/api/connectors/callback", base).toString();
}

function serverCallbackUrl(profile: string): string {
  const tailnet = profile === "phone" ? runtimeConfig()?.tailnet : null;
  const base = tailnet?.httpsOrigin || webOrigin();
  return new URL("/api/connections/callback", base).toString();
}

/** The action a card sends must match every field the proposal carried. */
function proposalMatchesAction(proposal: Proposal, action: ShellAction | undefined): boolean {
  if (!action) return false;
  const sameName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
  const sameSet = (left: string[], right: string[]) => {
    const a = [...new Set(left)].sort();
    const b = [...new Set(right)].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  };
  switch (proposal.kind) {
    case "createBot":
      // A group cannot ride a createBot card: applyShellAction rejects kind
      // "group" here, so the shape check must reject it too.
      return action.type === "createBot"
        && action.kind !== "group"
        && sameName(action.name, proposal.name)
        && (action.petname ?? "") === proposal.petname
        && (action.label ?? "") === proposal.title
        && (action.description ?? "") === proposal.description
        && (action.sectionId ?? null) === proposal.sectionId;
    case "createGroup":
      return action.type === "createGroup"
        && sameName(action.name, proposal.name)
        && sameSet(action.memberIds, proposal.memberIds)
        && (action.description ?? "") === proposal.description;
    case "updateBotProfile":
      return action.type === "updateBot"
        && action.botId === proposal.botId
        && (action.patch?.name ?? "") === proposal.patch.name
        && (action.patch?.label ?? "") === proposal.patch.title
        // An absent description means "unchanged" on both sides.
        && action.patch?.description === proposal.patch.description
        && (action.patch?.avatarShape ?? null) === proposal.patch.avatarShape
        && (action.patch?.avatarColor ?? null) === proposal.patch.avatarColor;
    case "fanout":
      return action.type === "sendToBot"
        && action.message === proposal.message
        && (action.botId === proposal.groupId || proposal.targetIds.includes(action.botId));
    case "connectApp":
      return (action as { type?: string }).type === "connectApp"
        && (action as { slug?: string }).slug === proposal.slug;
    case "connectServer":
      return (action as { type?: string }).type === "connectServer"
        && (action as { connectionId?: string }).connectionId === proposal.connectionId;
  }
}

/** Note that the proposal was answered, on the thread that raised it. */
function noteProposal(
  claimed: Proposal,
  action: ShellAction | undefined,
  queued: number,
  briefFailed = false,
): void {
  const fallback = action && "botId" in action && typeof action.botId === "string"
    ? threadIdFor(action.botId)
    : "";
  const threadId = claimed.threadId || fallback;
  if (!threadId) return;
  const label = claimed.status === "confirmed" ? "Confirmed" : "Dismissed";
  const extra = queued > 0 ? ` and queued ${queued} handoff${queued === 1 ? "" : "s"}` : "";
  // The teammate exists but never got the brief the card promised it, and the
  // card is spent, so the only way it reaches them now is a fresh message.
  const tail = briefFailed ? " The first brief was not handed over; send it again." : "";
  appendAgentEvent(threadId, {
    kind: "note",
    text: `${label} ${claimed.kind}${extra}.${tail}`,
    threadKind: claimed.kind === "fanout" && claimed.groupId ? "group" : "bot",
  });
}

export async function PUT(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`shell:${gate.session.callerId}`, 120)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let claimed: Proposal | null = null;
  try {
    const body = await readJson(request) as {
      action?: ShellAction;
      proposalId?: string;
      proposalStatus?: "confirmed" | "dismissed";
    };
    if (!body.action && !body.proposalId) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const current = readShell();

    // A connect card confirms by starting the hosted sign-in, not by claiming:
    // the card stays pending (phase waiting) until the tick sees the account
    // active and hands the bot its resume. The URL goes back once, to be
    // opened in the browser, and is never stored.
    const connectAction = body.action as { type?: string; slug?: string } | undefined;
    if (body.proposalId && body.proposalStatus !== "dismissed" && connectAction?.type === "connectApp") {
      const existing = readProposal(body.proposalId);
      if (!existing) return NextResponse.json({ ok: false, error: "proposal_missing" }, { status: 410 });
      if (existing.kind !== "connectApp" || !proposalMatchesAction(existing, body.action)) {
        return NextResponse.json({ ok: false, error: "proposal_mismatch" }, { status: 400 });
      }
      if (existing.status !== "pending") {
        return NextResponse.json({ ok: false, error: "proposal_conflict", status: existing.status }, { status: 409 });
      }
      if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
        return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
      }
      const { redirectUrl } = await startConnectAuthorize(body.proposalId, connectCallbackUrl(gate.session.profile));
      // Re-read after the network call: the snapshot from before it could
      // rewind a roster edit the app applied meanwhile.
      return NextResponse.json({ ok: true, store: readShell(), queued: 0, redirectUrl });
    }

    const serverAction = body.action as { type?: string; connectionId?: string; secret?: string } | undefined;
    if (body.proposalId && body.proposalStatus !== "dismissed" && serverAction?.type === "connectServer") {
      const existing = readProposal(body.proposalId);
      if (!existing) return NextResponse.json({ ok: false, error: "proposal_missing" }, { status: 410 });
      if (existing.kind !== "connectServer" || !proposalMatchesAction(existing, body.action)) {
        return NextResponse.json({ ok: false, error: "proposal_mismatch" }, { status: 400 });
      }
      if (existing.status !== "pending") {
        return NextResponse.json({ ok: false, error: "proposal_conflict", status: existing.status }, { status: 409 });
      }
      if (rateLimited(`connections:${gate.session.callerId}`, 60)) {
        return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
      }
      const secret = typeof serverAction.secret === "string" ? serverAction.secret : undefined;
      try {
        const { redirectUrl, redirectHost } = await startConnectionConfirm(body.proposalId, {
          secret,
          callbackUrl: serverCallbackUrl(gate.session.profile),
        });
        return NextResponse.json({ ok: true, store: readShell(), queued: 0, redirectUrl, redirectHost });
      } catch (err) {
        const code = err instanceof Error ? err.message : "connect_failed";
        const known = new Set([
          "proposal_missing", "proposal_settled", "already_connected", "proposal_expired",
          "authorize_in_flight", "secret_invalid", "oauth_no_as", "oauth_no_dcr",
          "oauth_register", "url_invalid", "url_http", "url_host", "url_protocol", "url_credentials",
          "url_resolved", "url_resolve", "tool_budget_exceeded", "tool_count_unknown",
          "tool_name_too_long",
        ]);
        return NextResponse.json({ ok: false, error: known.has(code) ? code : "connect_failed" }, { status: 400 });
      }
    }

    // Resolve fan-out recipients before anything is claimed or written, so an
    // empty or missing group cannot consume a proposal or leave a phantom card.
    if (body.action?.type === "sendToBot") {
      const action = body.action;
      const target = current.bots.find((bot) => bot.id === action.botId);
      if (!target) {
        return NextResponse.json({ ok: false, error: "target_missing" }, { status: 400 });
      }
      if (target.kind === "group") {
        const members = groupMembers(speakersFrom(current.bots), target.memberIds);
        if (members.length === 0) {
          return NextResponse.json({ ok: false, error: "fanout_empty" }, { status: 400 });
        }
      }
    }

    // The one server-side phone ban (decision F2/S5): a phone session may
    // read the workspace grant but never change it.
    if (body.action?.type === "setWorkspace" && gate.session.profile === "phone") {
      return NextResponse.json({ ok: false, error: "phone_forbidden_action" }, { status: 403 });
    }

    // A folder grant is an owner decision, but the path still has to be real
    // and grantable: an absolute path to an existing directory that is not
    // itself a symlink and whose own name is not a credential store.
    if (body.action?.type === "setWorkspace" && body.action.workspace) {
      const target = body.action.workspace.path;
      try {
        if (!isGrantableRootPath(target)) {
          return NextResponse.json({ ok: false, error: "workspace_path_forbidden" }, { status: 400 });
        }
        const stat = lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          return NextResponse.json({ ok: false, error: "workspace_not_directory" }, { status: 400 });
        }
        if (realpathSync(target) !== target) {
          return NextResponse.json({ ok: false, error: "workspace_path_symlink" }, { status: 400 });
        }
        // Store the canonical path: the agent re-verifies at tool time, and
        // a grant carrying a link path would fail there instead of working.
        body.action.workspace.path = realpathSync(target);
      } catch {
        return NextResponse.json({ ok: false, error: "workspace_path_missing" }, { status: 400 });
      }
    }

    // A proposal is confirmable once. claimProposal only returns to the caller
    // that flips it out of pending, so two concurrent confirms cannot both
    // apply the same createBot.
    if (body.proposalId) {
      const status = body.proposalStatus === "dismissed" ? "dismissed" : "confirmed";
      // A decision that lost the race is only a benign replay when the winner
      // matches it. If the other outcome won (dismiss vs confirm), report the
      // conflict instead of telling the owner their click succeeded. The store
      // is re-read so a race loser does not replay a pre-race snapshot.
      const settled = (existingStatus: Proposal["status"]) =>
        existingStatus === status
          ? NextResponse.json({ ok: true, store: readShell(), queued: 0, replay: true })
          : NextResponse.json({ ok: false, error: "proposal_conflict", status: existingStatus }, { status: 409 });
      if (status === "confirmed") {
        const existing = readProposal(body.proposalId);
        if (!existing) {
          return NextResponse.json({ ok: false, error: "proposal_missing" }, { status: 410 });
        }
        if (existing.status !== "pending") return settled(existing.status);
        // An unparsable expiry is expired, matching claimProposal: a corrupt
        // proposal must not stay confirmable while the pending list hides it.
        const expiresAt = Date.parse(existing.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          return NextResponse.json({ ok: false, error: "proposal_expired" }, { status: 410 });
        }
        if (!proposalMatchesAction(existing, body.action)) {
          return NextResponse.json({ ok: false, error: "proposal_mismatch" }, { status: 400 });
        }
        // A profile card is bound to the exact text it showed and to the
        // revision of the profile it was raised against. A profile that moved
        // on since is a stale card: confirming it would overwrite newer text.
        if (existing.kind === "updateBotProfile") {
          const target = current.bots.find((bot) => bot.id === existing.botId);
          if (!profileCardIsCurrent(target, existing.baseRevision)) {
            return NextResponse.json({ ok: false, error: "proposal_stale" }, { status: 409 });
          }
        }
        // The bot that raised the card must still be allowed to: a bot that
        // lost the orchestrator role, or was deleted, cannot have its card
        // applied after the fact.
        if (
          (existing.kind === "createBot" || existing.kind === "createGroup" || existing.kind === "updateBotProfile")
          && !proposerMayConfirm(current, existing)
        ) {
          return NextResponse.json({ ok: false, error: "proposal_stale" }, { status: 409 });
        }
      }
      claimed = claimProposal(body.proposalId, status);
      if (!claimed) {
        const existing = readProposal(body.proposalId);
        if (!existing) {
          return NextResponse.json({ ok: false, error: "proposal_missing" }, { status: 410 });
        }
        if (existing.status === "pending") {
          return NextResponse.json({ ok: false, error: "proposal_expired" }, { status: 410 });
        }
        return settled(existing.status);
      }
    }

    const action = body.action;
    // The roster commit is what assigns a new bot its id, and the brief below
    // has to reach that exact bot.
    let createdBotId: string | undefined;
    const profileCard = claimed?.kind === "updateBotProfile" && claimed.status === "confirmed" ? claimed : null;
    const proposedCard = claimed
      && claimed.status === "confirmed"
      && (claimed.kind === "createBot" || claimed.kind === "createGroup" || claimed.kind === "updateBotProfile")
      ? claimed
      : null;
    const next = action
      ? updateShell((shell) => {
        // The revision is checked again under the roster lock: the pre-check
        // above read an earlier snapshot.
        if (proposedCard && !proposerMayConfirm(shell, proposedCard)) throw new Error("proposal_stale");
        if (profileCard) {
          const target = shell.bots.find((bot) => bot.id === profileCard.botId);
          if (!profileCardIsCurrent(target, profileCard.baseRevision)) throw new Error("proposal_stale");
        }
        const applied = applyShellAction(shell, action);
        createdBotId = applied.createdId;
        return applied.store;
      })
      : current;
    // Revoking here, not only at the next turn stamp. `syncSessionWorkspace`
    // runs when a turn starts, so without this a detach leaves the capability
    // live for the rest of an in-flight turn and for any approval card still
    // open — the owner's decision has to take effect when they make it.
    // The selection the running turn was stamped with, read before the
    // revoke below can delete the grant: a permission or folder change must
    // not move an in-flight turn's model (see syncSessionWorkspace).
    const priorSelection = (action?.type === "setPermission" || action?.type === "setWorkspace")
      ? (() => {
        const sessionId = next.bots.find((item) => item.id === action.botId)?.sessionId;
        return sessionId ? readSessionGrant(sessionId)?.selection : undefined;
      })()
      : undefined;
    revokeGrantsFor(action, current, next);
    // A permission or folder change takes effect now, not at the next turn:
    // the tools re-read the grant before spending a card, so a card raised
    // under Auto must see the Read only the owner just picked.
    if (action?.type === "setPermission" || action?.type === "setWorkspace") {
      const bot = next.bots.find((item) => item.id === action.botId);
      if (bot?.sessionId) {
        try {
          // Providers store first, then the roster, the order the turn
          // freeze uses: a per-bot pick pins this bot before it moves the
          // default, so a store read first never pairs with an older roster.
          const store = readProviderStore();
          const fresh = readShell().bots.find((item) => item.id === bot.id);
          if (!fresh) {
            // Deleted in the gap: revoke rather than stamp the stale bot
            // (as syncSessionWorkspaceFresh does).
            removeSessionGrant(bot.sessionId);
          } else {
            syncSessionWorkspace(bot.sessionId, fresh, store, { keptSelection: priorSelection });
          }
        } catch {
          // The roster action stood but the grant still says the old
          // permission, and a card already open re-reads that grant before
          // it spends. No grant at all reads as Read only, so revoking is
          // the fail-closed answer; the next turn's stamp restores it.
          try {
            removeSessionGrant(bot.sessionId);
          } catch {
            /* a store locked twice in a row: the next turn's stamp settles it */
          }
        }
      }
    }
    // Only once the roster commit stood. A failure here is reported, not
    // swallowed, and the tick's sweep clears whatever was left behind.
    const detachError = action?.type === "deleteBot" ? detachBot(action.botId) : null;
    let queued = 0;
    if (action) {
      try {
        queued = applyFollowUp(action, next);
      } catch {
        /* the shell action already landed; the handoff pump reports the rest */
      }
    }
    // The card carried a first brief, so the owner approved that work too.
    // Without this the brief was only ever shown on the card: the new bot was
    // created idle and the brief stayed in the proposer's own chat.
    let briefFailed = false;
    if (claimed?.kind === "createBot" && claimed.status === "confirmed") {
      try {
        queued += deliverFirstBrief({
          brief: claimed.brief,
          createdBotId,
          sourceBotId: claimed.sourceBotId,
          bots: next.bots,
        });
      } catch {
        // The bot exists and the card is spent, so this cannot be retried
        // here. Say so on the thread rather than leaving a teammate that
        // looks briefed and is not.
        briefFailed = true;
      }
    }
    // `appendAgentEvent` upserts, so noting a confirmed delete on the deleted
    // bot's own thread rebuilds the row the teardown just removed. Only that
    // thread is skipped: a delete confirmed from another bot's chat still
    // gets its receipt, on a thread that survives.
    const notesDeletedThread = action?.type === "deleteBot"
      && (claimed?.threadId || threadIdFor(action.botId)) === threadIdFor(action.botId);
    if (claimed && !notesDeletedThread) {
      try {
        noteProposal(claimed, body.action, queued, briefFailed);
      } catch {
        /* the transcript note is best effort */
      }
    }
    return NextResponse.json({ ok: true, store: next, queued, detachError });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    // Applying the action failed after the claim; give the card back so the
    // owner can retry instead of losing the proposal to a 400.
    if (claimed) {
      try { reopenProposal(claimed.id); } catch { /* best effort */ }
    }
    const code = errorCode(err);
    // The client keeps the owner's draft and shows the cap.
    if (code === "shell_description_too_long") {
      return NextResponse.json({ ok: false, error: code, max: DESCRIPTION_MAX }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: code }, { status: 400 });
  }
}

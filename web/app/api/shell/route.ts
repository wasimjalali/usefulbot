import { NextResponse } from "next/server";
import { lstatSync, realpathSync } from "node:fs";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { runtimeConfig } from "../../../lib/auth";
import {
  claimProposal,
  readProposal,
  reopenProposal,
  threadIdFor,
  type Proposal,
} from "../../../../shared/agent-store.ts";
import { engineNoteRow } from "../../../../shared/engine-client.ts";
import { restampWorkspaceGrants } from "../../../lib/agent-exec";
import { startConnectAuthorize } from "../../../../shared/connect-flow.ts";
import { startConnectionConfirm } from "../../../../shared/connection-flow.ts";
import { applyShellAction, DESCRIPTION_MAX, isGrantableRootPath, isShellActionType, type ShellAction } from "../../../../shared/shell-store.ts";
import { readShell, updateShell } from "../../../../shared/shell-io.ts";
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
  switch (proposal.kind) {
    case "connectApp":
      return (action as { type?: string }).type === "connectApp"
        && (action as { slug?: string }).slug === proposal.slug;
    case "connectServer":
      return (action as { type?: string }).type === "connectServer"
        && (action as { connectionId?: string }).connectionId === proposal.connectionId;
  }
}

/** Note that the proposal was answered, in the bot's current chat. The key keeps a repeat from writing it twice. */
async function noteProposal(claimed: Proposal, action: ShellAction | undefined): Promise<void> {
  const fallback = action && "botId" in action && typeof action.botId === "string"
    ? threadIdFor(action.botId)
    : "";
  const botId = claimed.threadId || fallback;
  if (!botId) return;
  const label = claimed.status === "confirmed" ? "Confirmed" : "Dismissed";
  await engineNoteRow(botId, `proposal:${claimed.id}`, `${label} ${claimed.kind}.`);
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
    // An action this build does not know is refused before anything else runs.
    if (body.action && !isShellActionType((body.action as { type?: unknown }).type)) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
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
          "url_resolved", "url_resolve",
        ]);
        return NextResponse.json({ ok: false, error: known.has(code) ? code : "connect_failed" }, { status: 400 });
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
    // apply the same connect card.
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
    const next = action
      ? updateShell((shell) => applyShellAction(shell, action).store)
      : readShell();
    // A permission or folder change takes effect now, not at the next turn:
    // the tools re-read the grant before spending a card, so a card raised
    // under Auto must see the Read only the owner just picked. A detach is the
    // same write with no folder, so the capability follows the owner's decision
    // when they make it. The selection the running turn was stamped with is
    // kept, so the change cannot move an in-flight turn's model.
    if (action?.type === "setPermission" || action?.type === "setWorkspace") {
      restampWorkspaceGrants(action.botId);
    }
    if (claimed) {
      try {
        await noteProposal(claimed, body.action);
      } catch (err) {
        // The card is answered either way; only the line in the chat is missing.
        console.error("[useful-bot] proposal note not written", err instanceof Error ? err.message : err);
      }
    }
    return NextResponse.json({ ok: true, store: next, queued: 0, detachError: null });
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

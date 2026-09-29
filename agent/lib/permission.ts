import { readSessionGrant, type WorkspacePermission } from "../../shared/workspace-store.ts";
import type { ApprovalStore } from "./approvals.ts";
import { waitUntilNotPending } from "./approvals.ts";

/**
 * The bot's permission for this session. A session with no grant is one the
 * web server did not stamp, so it fails closed to Read only; a call with no
 * session at all (tests, evals) is Auto.
 */
export function sessionPermission(ctx?: { session?: { id?: string } }): WorkspacePermission {
  const id = ctx?.session?.id;
  if (!id) return "auto";
  return readSessionGrant(id)?.permission ?? "read_only";
}

export type Gate = "run" | "ask" | "refuse";

/**
 * What the permission says about an action inside the app itself: the rail,
 * routines, memory, chat history. Read only refuses every change. Auto runs
 * them without a card, except the two that erase things nothing can bring
 * back (deleting a bot, clearing a chat): those ask. Full access runs those
 * too. Reads never come here; they run in every mode.
 */
export function inAppGate(permission: WorkspacePermission, irreversible = false): Gate {
  if (permission === "read_only") return "refuse";
  if (permission === "full_access") return "run";
  return irreversible ? "ask" : "run";
}

/**
 * Settle a requested card the way the gate says: approve it on the spot, or
 * wait for the owner. Callers still go through `executeIfApproved`, so the
 * approval record binds the action either way and a replay is refused. A
 * card that waited was raised under one permission; if the owner narrowed
 * it while the card sat open, the approval must not spend on the old
 * posture, the way bash and write_file refuse a changed workspace.
 */
export async function settle(
  store: ApprovalStore,
  id: string,
  hash: string,
  gate: Exclude<Gate, "refuse">,
  ctx?: { session?: { id?: string } },
  permissionAtRequest?: WorkspacePermission,
): Promise<void> {
  if (gate === "run") {
    store.decide(id, "approve", hash);
    return;
  }
  await waitUntilNotPending(store, id);
  if (permissionAtRequest !== undefined && sessionPermission(ctx) !== permissionAtRequest) {
    throw new Error("permission_changed");
  }
}

/** The blocked result every gated tool returns when Read only refuses it. */
export const READ_ONLY_BLOCKED = { status: "blocked", error: "workspace_read_only" } as const;

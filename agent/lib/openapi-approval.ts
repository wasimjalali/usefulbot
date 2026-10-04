import { bearerFromKeychain, oauthToken } from "../../shared/connection-auth.ts";
import { findConnectionById, isAuthHeaderName, type ConnectionEntry } from "../../shared/connections-store.ts";
import type { WorkspacePermission } from "../../shared/workspace-store.ts";
import { actionSha256, approvalActor, executeIfApproved, waitUntilNotPending, type ApprovalStore } from "./approvals.ts";
import { sessionPermission } from "./permission.ts";
import { getApprovalStore } from "./write.ts";
import { markOutside } from "./outside-content.ts";

/**
 * The permission gate for an OpenAPI connection's operations (UB-009 PR A).
 *
 * eve mounts these itself and, without a policy, runs every operation with no
 * card. This is the `approval` policy it calls before each one (spike 3,
 * evals/results/2026-10-01-ub009-spikes/eve-spikes.md): Read only refuses, Full
 * access runs, Auto raises the app's own card and waits for the owner.
 *
 * Two rules the spike found. The policy runs inside the model stream, so the
 * wait is capped under the router's 180 s request limit and a timeout is a
 * refusal the model can read. And a throw here fails the step and retires the
 * session, so nothing escapes: every error becomes a denial.
 */

/** Router `REQUEST_TOTAL_MS` is 180 s and counts the model's own generation too; 120 s leaves room for it. */
export const OPENAPI_APPROVAL_WAIT_MS = 120_000;
/** The card shows every argument the hash binds, so a call too long to show is refused. */
const CARD_ARGS_MAX = 4000;

type PolicyContext = {
  session?: { id?: string; turn?: { id?: string } };
  callId?: string;
  toolName?: string;
  toolInput?: unknown;
};
type Decision = { type: "approved" | "denied"; reason?: string };

export type OpenApiApprovalDeps = {
  store: () => ApprovalStore;
  permission: (ctx: PolicyContext) => WorkspacePermission;
  find: (id: string) => ConnectionEntry | null;
  wait: typeof waitUntilNotPending;
  waitMs: number;
};

const defaultDeps: OpenApiApprovalDeps = {
  store: getApprovalStore,
  permission: sessionPermission,
  find: (id) => findConnectionById(id),
  wait: waitUntilNotPending,
  waitMs: OPENAPI_APPROVAL_WAIT_MS,
};

const denied = (reason: string): Decision => ({ type: "denied", reason });

export function openApiApproval(entry: ConnectionEntry, overrides: Partial<OpenApiApprovalDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  return async (ctx: PolicyContext): Promise<Decision> => {
    markOutside(ctx);
    try {
      const permission = deps.permission(ctx);
      if (permission === "read_only") {
        return denied("Read only: this needs Auto or Full access. Tell the owner to switch the permission.");
      }
      if (permission === "full_access") return { type: "approved" };

      const prefix = `${entry.id}__`;
      const toolName = ctx.toolName ?? "";
      const operation = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
      const args = ctx.toolInput && typeof ctx.toolInput === "object" && !Array.isArray(ctx.toolInput)
        ? ctx.toolInput as Record<string, unknown>
        : {};
      const argsText = JSON.stringify(args, null, 1);
      if (argsText.length > CARD_ARGS_MAX) {
        return denied(`The arguments are too long to show the owner on a card (over ${CARD_ARGS_MAX} characters). Shorten them and try again.`);
      }
      const hash = actionSha256({
        tool: "connection",
        canonicalArgs: JSON.stringify({ connection: entry.id, tool: operation, arguments: args }),
        cwd: "",
        targetRevision: null,
        backend: "openapi",
        toolVersion: "1",
      });
      const approvals = deps.store();
      const rec = approvals.request({
        ...approvalActor(ctx),
        tool: "connection",
        actionSha256: hash,
        preview: `${entry.name} · ${operation}` + (argsText === "{}" ? "" : `\n${argsText}`),
      });
      try {
        await deps.wait(approvals, rec.id, deps.waitMs);
      } catch (error) {
        if (error instanceof Error && error.message === "approval_expired") {
          // Retire the card, so an owner who answers late is not left holding
          // one that does nothing. Best effort: the record expires on its own.
          try { approvals.decide(rec.id, "deny", hash); } catch { /* already decided or expired */ }
          return denied(`The owner did not answer in time (${Math.round(deps.waitMs / 1000)} seconds). Ask them, then try again.`);
        }
        throw error;
      }
      // The card may have sat open for minutes. A narrowed permission, a
      // repointed connection or a narrowed operation list refuses.
      if (deps.permission(ctx) !== permission) return denied("The permission changed while the card was open. Try again.");
      const live = deps.find(entry.id);
      if (!live || live.url !== entry.url) return denied("The connection changed while the card was open. Try again.");
      if (live.toolsAllow && !live.toolsAllow.includes(operation)) return denied("The owner no longer allows this operation.");
      // Throws when the owner denied it, or it was already used.
      return await executeIfApproved(approvals, rec.id, hash, () => ({ type: "approved" as const }));
    } catch (error) {
      if (error instanceof Error && /approval_denied|approval_not_approved/.test(error.message)) {
        return denied("The owner did not approve it.");
      }
      if (error instanceof Error && error.message === "approval_expired") {
        return denied("The approval expired before it could be used. Ask the owner, then try again.");
      }
      return denied(`Could not get approval (${error instanceof Error ? error.constructor.name : typeof error}).`);
    }
  };
}

/**
 * What `defineOpenAPIConnection` gets besides the spec: the permission gate,
 * and, when the owner narrowed the connection, only the operations they allowed
 * (eve neither lists nor runs one outside `operations.allow`).
 */
export function openApiGate(entry: ConnectionEntry) {
  return {
    approval: openApiApproval(entry),
    ...(entry.toolsAllow ? { operations: { allow: entry.toolsAllow } } : {}),
  };
}

/**
 * Everything `defineOpenAPIConnection` gets for one entry, whatever its auth
 * kind. The gate is spread into every branch here, once, so a new auth kind
 * cannot be added without it (the bearer branch missed it in the first cut).
 */
export function openApiOptions(entry: ConnectionEntry) {
  const base = { spec: entry.url, description: entry.description, ...openApiGate(entry) };
  if (entry.authKind === "none") return base;
  if (entry.authKind === "apiKey") {
    const header = isAuthHeaderName(entry.authHeader) ? entry.authHeader : "X-Api-Key";
    return { ...base, headers: { [header]: async () => (await bearerFromKeychain(entry.id)).token } };
  }
  if (entry.authKind === "oauth") {
    return { ...base, instanceKey: entry.id, auth: { getToken: () => oauthToken(entry) } };
  }
  return { ...base, instanceKey: entry.id, auth: { getToken: () => bearerFromKeychain(entry.id) } };
}

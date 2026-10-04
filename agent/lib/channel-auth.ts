import { ForbiddenError, jwtHmac, type AuthFn } from "eve/channels/auth";
import { peekShell } from "../../shared/shell-io.ts";
import { resolveSessionBot } from "../../shared/session-bindings.ts";
import type { ShellStore } from "../../shared/shell-store.ts";
import { SessionOwners, defaultOwnerPath } from "./session-owners.ts";

type Principal = {
  authenticator: string;
  issuer?: string;
  subject?: string;
  principalId: string;
};

export type ChannelAuthDeps = {
  /** The secret the channel tokens are signed with. Missing means every call is refused. */
  secret?: string;
  /** The bot a session is bound to, or null (the durable binding, with its backfill). */
  readBot?: (sessionId: string) => string | null;
  /** The roster a create's claim must name a bot of. */
  roster?: () => ShellStore | null;
  owners?: Pick<SessionOwners, "claim">;
};

function principalKey(ctx: Principal): string {
  return `${ctx.authenticator}:${ctx.issuer ?? ""}:${ctx.subject ?? ctx.principalId}`;
}

type EveCall = { kind: "other" } | { kind: "create" } | { kind: "session"; sessionId: string; cancel: boolean };

function eveCall(request: Request): EveCall {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "eve" || parts[1] !== "v1" || parts[2] !== "session") return { kind: "other" };
  if (!parts[3]) return { kind: "create" };
  return { kind: "session", sessionId: parts[3], cancel: request.method === "POST" && parts[4] === "cancel" && parts.length === 5 };
}

/**
 * Who may call eve, and as which bot. The token proves the caller holds the
 * channel secret; its `botId` claim says which bot the call is for, and eve
 * holds the call to that:
 * - a create needs a claim naming a bot on the roster;
 * - a call on a session needs a claim equal to the bot the session is bound to;
 * - a session nobody bound is refused, except a cancel (stopping is always safe);
 * - health and info need no claim.
 * Eve projects only string claims, so a missing or non-string claim reads as
 * no claim and is refused. The check runs before eve accepts anything: a turn
 * eve accepts and then fails retires the session.
 */
export function channelAuth(deps: ChannelAuthDeps = {}): AuthFn<Request> {
  const secret = deps.secret ?? process.env.UB_CHANNEL_JWT_SECRET;
  if (!secret) {
    // Fail closed: without a secret every request would be anonymous yet able
    // to drive tool execution. Refuse instead of returning a null principal.
    return () => {
      throw new ForbiddenError({ message: "channel_auth_unconfigured" });
    };
  }
  const verify = jwtHmac({
    algorithm: "HS256",
    audiences: ["useful-bot"],
    issuer: "useful-bot",
    secret,
  });
  const readBot = deps.readBot ?? ((sessionId: string) => resolveSessionBot(sessionId));
  const roster = deps.roster ?? (() => peekShell());
  const owners = deps.owners ?? new SessionOwners(defaultOwnerPath());
  return async (request) => {
    const ctx = await verify(request);
    if (!ctx) return null;
    const call = eveCall(request);
    if (call.kind === "other") return ctx;
    const claim: unknown = ctx.attributes.botId;
    if (call.kind === "create") {
      if (typeof claim !== "string" || !claim) throw new ForbiddenError({ message: "bot_claim_missing" });
      let known: boolean;
      try {
        known = Boolean(roster()?.bots.some((bot) => bot.id === claim));
      } catch (err) {
        console.error("channel auth could not read the roster", err instanceof Error ? err.message : err);
        throw new ForbiddenError({ message: "bot_claim_unverifiable" });
      }
      if (!known) throw new ForbiddenError({ message: "bot_claim_unknown" });
      return ctx;
    }
    let bound: string | null;
    try {
      bound = readBot(call.sessionId);
    } catch (err) {
      console.error("channel auth could not read the session binding", err instanceof Error ? err.message : err);
      throw new ForbiddenError({ message: "session_binding_unavailable" });
    }
    if (bound === null) {
      if (!call.cancel) throw new ForbiddenError({ message: "session_unbound" });
    } else if (typeof claim !== "string" || claim !== bound) {
      throw new ForbiddenError({ message: "session_bot_mismatch" });
    }
    if (owners.claim(call.sessionId, principalKey(ctx)) === "forbidden") {
      throw new ForbiddenError({ message: "session_ownership" });
    }
    return ctx;
  };
}

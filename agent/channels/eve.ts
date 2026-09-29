import { eveChannel } from "eve/channels/eve";
import { ForbiddenError, jwtHmac, type AuthFn } from "eve/channels/auth";
import { SessionOwners, defaultOwnerPath } from "../lib/session-owners.ts";

function principalKey(ctx: {
  authenticator: string;
  issuer?: string;
  subject?: string;
  principalId: string;
}): string {
  return `${ctx.authenticator}:${ctx.issuer ?? ""}:${ctx.subject ?? ctx.principalId}`;
}

function sessionIdFrom(request: Request): string | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "eve" && parts[1] === "v1" && parts[2] === "session" && parts[3]) {
    return parts[3];
  }
  return null;
}

function channelAuth(): AuthFn<Request> {
  const secret = process.env.UB_CHANNEL_JWT_SECRET;
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
  const owners = new SessionOwners(defaultOwnerPath());
  return async (request) => {
    const ctx = await verify(request);
    if (!ctx) return null;
    const sessionId = sessionIdFrom(request);
    if (!sessionId) return ctx;
    const decision = owners.claim(sessionId, principalKey(ctx));
    if (decision === "forbidden") {
      throw new ForbiddenError({ message: "session_ownership" });
    }
    return ctx;
  };
}

export default eveChannel({
  auth: [channelAuth()],
  turnPolicy: "queue",
});

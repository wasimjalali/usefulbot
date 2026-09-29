import { NextResponse } from "next/server";
import { credentialById, phoneDisabled } from "./auth.ts";
import { readSession } from "./cookie-sessions.ts";
import { classifyIngress, originAllowed, type IngressClass } from "./ingress.ts";
import type { BrowserSession } from "../../shared/web-sessions.ts";

export { classifyIngress, originAllowed };
export type { IngressClass };

function gateError(error: string, status: number): { error: NextResponse } {
  return { error: NextResponse.json({ ok: false, error }, { status }) };
}

type GateOk = { session: BrowserSession; ingress: IngressClass };

/**
 * The shared gate body (spec S3): session, then ingress, then the profile
 * rule, then the bound credential re-resolution (S9), then origin.
 */
async function gate(
  request: Request,
  allowTailnet: boolean,
): Promise<{ error: NextResponse } | GateOk> {
  const session = await readSession();
  if (!session) return gateError("unauthorized", 401);
  const ingress = classifyIngress(request);
  if (ingress === "unknown") return gateError("ingress", 403);
  if (ingress === "tailnet") {
    if (!allowTailnet || session.profile === "desktop") {
      // A desktop session never legitimately crosses the tailnet (F3): the
      // cookie does not leave the Mac, so a presented one is refused.
      return gateError("forbidden", 403);
    }
  }
  if (session.profile !== "desktop" && session.profile !== "phone") {
    return gateError("forbidden", 403);
  }
  if (session.credentialId) {
    if (!credentialById(session.credentialId)) {
      return gateError("credential_invalid", 401);
    }
  }
  if (session.profile === "phone" && phoneDisabled()) {
    return gateError("credential_invalid", 401);
  }
  if (!originAllowed(request, ingress)) {
    return gateError("origin", 403);
  }
  return { session, ingress };
}

/**
 * Owner gate (spec S3): desktop and phone profiles, tailnet ingress accepted
 * for phone sessions only. Every §5.1 route uses this.
 */
export async function requireOwner(request: Request): Promise<{ error: NextResponse } | GateOk> {
  return gate(request, true);
}

/**
 * The pre-phone gate, kept for a future Mac-only route (none exist in v1).
 * Tailnet ingress is refused outright: a desktop surface never answers a
 * proxied request.
 */
export async function requireDesktop(request: Request): Promise<{ error: NextResponse } | GateOk> {
  return gate(request, false);
}

export function isGateError(
  result: { error: NextResponse } | GateOk,
): result is { error: NextResponse } {
  return "error" in result;
}

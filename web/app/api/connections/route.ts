import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { runtimeConfig } from "../../../lib/auth";
import {
  deleteConnection,
  listPublicConnections,
  startDueDiscoveries,
  startDueIconLookups,
  reauthorizeConnection,
  refreshConnection,
} from "../../../../shared/connections-admin.ts";
import { isConnectionId } from "../../../../shared/connections-store.ts";
import { webOrigin } from "../../../../shared/stack.ts";

export const runtime = "nodejs";

/**
 * Direct (MCP and OpenAPI) connections for the Connectors page. Same desktop
 * gate, CSRF header and rate limit as the connectors route. Nothing returned
 * carries a token, a header or a Keychain item: the app sees what a
 * connection is, how it is doing and what tools it listed.
 */

function csrfOk(request: Request, gate: { session: { csrf: string } }): boolean {
  const csrf = request.headers.get("x-ub-csrf");
  return Boolean(csrf && csrf === gate.session.csrf);
}

/**
 * Where the sign-in comes back to: the loopback origin the service binds, or
 * the configured tailnet one for a phone session. Never derived from the
 * request, so a crafted Host header cannot point it anywhere else.
 */
function callbackUrl(profile: string): string {
  const tailnet = profile === "phone" ? runtimeConfig()?.tailnet : null;
  return new URL("/api/connections/callback", tailnet?.httpsOrigin || webOrigin()).toString();
}

const KNOWN: Record<string, number> = {
  connection_missing: 404,
  connection_builtin: 403,
  not_oauth: 400,
  authorization_server_changed: 409,
  oauth_issuer_mismatch: 409,
  oauth_resource_origin: 409,
  credential_missing: 409,
};

function failure(err: unknown, fallback: string) {
  const guarded = apiError(err);
  if (guarded) return guarded;
  const code = errorCode(err, fallback);
  return NextResponse.json({ ok: false, error: code }, { status: KNOWN[code] ?? 400 });
}

async function readId(request: Request): Promise<{ id: string; body: Record<string, unknown> }> {
  const body = (await readJson(request)) as Record<string, unknown>;
  if (!isConnectionId(body.id)) throw new Error("id_required");
  return { id: body.id, body };
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (rateLimited(`connections:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  startDueDiscoveries();
  startDueIconLookups();
  return NextResponse.json({ ok: true, connections: listPublicConnections() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connections:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const { id, body } = await readId(request);
    if (body.action === "refresh") {
      return NextResponse.json({ ok: true, connection: await refreshConnection(id) });
    }
    if (body.action === "reauthorize") {
      const out = await reauthorizeConnection(id, callbackUrl(gate.session.profile));
      return NextResponse.json({ ok: true, ...out });
    }
    return NextResponse.json({ ok: false, error: "action_invalid" }, { status: 400 });
  } catch (err) {
    return failure(err, "connection_failed");
  }
}

export async function DELETE(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connections:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const { id } = await readId(request);
    await deleteConnection(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err, "disconnect_failed");
  }
}

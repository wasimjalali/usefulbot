import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { connectorsCallbackUrl } from "../../../lib/connectors-callback";
import {
  clearConnectorsKey,
  publicConnectors,
  readConnectorsStore,
  setConnectorsKey,
  updateConnectorsStore,
} from "../../../../shared/connectors-store.ts";
import { authorizeConnector, disconnectConnector, isKeyRejected, listConnectorToolkits } from "../../../../shared/composio.ts";

export const runtime = "nodejs";

/**
 * Connectors for the dialog. Same desktop gate, origin check, CSRF header and
 * rate limit as the routines route. The response never carries the Composio
 * key, the user id or the session id; the OAuth redirect URL goes back once,
 * to be opened in the browser.
 */

function csrfOk(request: Request, gate: { session: { csrf: string } }): boolean {
  const csrf = request.headers.get("x-ub-csrf");
  return Boolean(csrf && csrf === gate.session.csrf);
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  // The dialog polls this while an OAuth tab is open; every call is one or
  // two Composio requests, so it gets the same bucket as the writes.
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const store = readConnectorsStore();
  const pub = publicConnectors(store);
  if (!pub.hasKey) return NextResponse.json({ ok: true, ...pub, toolkits: [] });
  const params = new URL(request.url).searchParams;
  const search = params.get("search") ?? undefined;
  const offset = Number.parseInt(params.get("offset") ?? "0", 10);
  const limit = Number.parseInt(params.get("limit") ?? "30", 10);
  try {
    const page = await listConnectorToolkits({
      search,
      offset: Number.isFinite(offset) ? offset : 0,
      limit: Number.isFinite(limit) ? limit : 30,
    });
    return NextResponse.json({
      ok: true,
      ...publicConnectors(readConnectorsStore()),
      toolkits: page.rows,
      total: page.total,
      nextOffset: page.nextOffset,
    });
  } catch (err) {
    // Composio's own 401 is the one failure the owner can fix from the dialog.
    const error = isKeyRejected(err) ? "key_rejected" : errorCode(err, "connectors_unavailable");
    return NextResponse.json({ ok: false, error, ...pub, toolkits: [] }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = (await readJson(request)) as { apiKey?: unknown };
    if (body.apiKey === null) {
      updateConnectorsStore((store) => clearConnectorsKey(store));
    } else if (typeof body.apiKey === "string") {
      const key = body.apiKey;
      updateConnectorsStore((store) => setConnectorsKey(store, key));
    } else {
      return NextResponse.json({ ok: false, error: "api_key_required" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...publicConnectors(readConnectorsStore()) });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = (await readJson(request)) as { toolkit?: unknown };
    if (typeof body.toolkit !== "string" || !body.toolkit) {
      return NextResponse.json({ ok: false, error: "toolkit_required" }, { status: 400 });
    }
    const result = await authorizeConnector(body.toolkit, connectorsCallbackUrl(gate.session.profile));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err, "authorize_failed") }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (!csrfOk(request, gate)) return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  if (rateLimited(`connectors:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = (await readJson(request)) as { accountId?: unknown };
    if (typeof body.accountId !== "string" || !body.accountId) {
      return NextResponse.json({ ok: false, error: "account_required" }, { status: 400 });
    }
    await disconnectConnector(body.accountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err, "disconnect_failed") }, { status: 400 });
  }
}

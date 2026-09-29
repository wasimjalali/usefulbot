import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../../lib/desktop-gate";
import { errorCode, rateLimited, readJson } from "../../../../../../lib/api-guard";
import { findConnectionById } from "../../../../../../../shared/connections-store.ts";
import { callMcpTool, listMcpTools, TOOL_CALL_TIMEOUT_MS } from "../../../../../../../shared/mcp-http.ts";
import { readWidget } from "../../../../../../../shared/widgets-store.ts";

export const runtime = "nodejs";

/** An export carries the whole scene, embedded images included. */
const CALL_BODY_MAX = 2 * 1024 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * A drawing's own `tools/call` (Excalidraw's "Open in Excalidraw" export).
 * Only tools the server marked for its app are reachable here; anything the
 * model can call goes through eve and its permission checks instead.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`widget-call:${gate.session.callerId}`, 30)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const { id } = await context.params;
    const record = readWidget(id);
    if (!record) return NextResponse.json({ ok: false, error: "missing" }, { status: 404 });
    const body = await readJson(request, CALL_BODY_MAX) as { name?: unknown; arguments?: unknown };
    const args = body.arguments ?? {};
    if (
      typeof body.name !== "string" || !TOOL_NAME.test(body.name)
      || !args || typeof args !== "object" || Array.isArray(args)
    ) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    const entry = findConnectionById(record.connectionId);
    if (!entry || entry.kind !== "mcp") {
      return NextResponse.json({ ok: false, error: "widget_connection" }, { status: 400 });
    }
    // The widget page is read without credentials too; a signed-in server's
    // app gets a clear refusal here, not an anonymous call that fails upstream.
    if (entry.authKind !== "none") {
      return NextResponse.json({ ok: false, error: "widget_auth_unsupported" }, { status: 400 });
    }
    // One deadline for both steps, inside the app's 30 second request limit.
    const deadline = AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS);
    const tools = await listMcpTools(entry.url, {}, deadline);
    if (!tools.some((tool) => tool.name === body.name && tool.appCallable)) {
      return NextResponse.json({ ok: false, error: "tool_not_app" }, { status: 403 });
    }
    const result = await callMcpTool(entry.url, body.name, args as Record<string, unknown>, {}, deadline);
    return NextResponse.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "widget_call_failed") }, { status: 400 });
  }
}

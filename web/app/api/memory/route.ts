import { NextResponse } from "next/server";
import { MemoryStore } from "../../../../agent/lib/memory.ts";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";

export const runtime = "nodejs";

// The pane polls every few seconds, so one store per process: a fresh
// MemoryStore per request leaks its sqlite handle until GC and re-runs the
// migration each time. The store resolves its own root, so nothing here can
// drift from it.
let sharedStore: MemoryStore | null = null;
function memoryStore(): MemoryStore {
  if (!sharedStore) sharedStore = new MemoryStore();
  return sharedStore;
}

/** The store's refusals as HTTP answers; anything else is a real failure and is rethrown. */
function storeFailure(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "";
  if (message === "memory_not_found" || message === "memory_id_invalid") {
    return NextResponse.json({ ok: false, error: message }, { status: message === "memory_id_invalid" ? 400 : 404 });
  }
  // A note of another bot is reported as missing: its existence is not the caller's to learn.
  if (message === "memory_forbidden") return NextResponse.json({ ok: false, error: "memory_not_found" }, { status: 404 });
  if (message === "memory_revision_conflict") return NextResponse.json({ ok: false, error: message }, { status: 409 });
  throw err;
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const params = new URL(request.url).searchParams;
  const botId = params.get("botId")?.trim() ?? "";
  const id = params.get("id")?.trim() ?? "";
  if (!botId) return NextResponse.json({ ok: true, notes: [] });
  if (id) {
    try {
      return NextResponse.json({ ok: true, note: memoryStore().readCard(id, botId) });
    } catch (err) {
      return storeFailure(err);
    }
  }
  const notes = memoryStore().list(botId, 100);
  return NextResponse.json({ ok: true, notes });
}

/** Delete one of a bot's notes. Same owner gate and CSRF check as the other writes. */
export async function DELETE(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  let body: { botId?: unknown; id?: unknown; revision?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const botId = typeof body.botId === "string" ? body.botId.trim() : "";
  if (!botId || typeof body.id !== "string" || typeof body.revision !== "number" || !Number.isInteger(body.revision)) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    const result = memoryStore().archive(body.id, botId, body.revision);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return storeFailure(err);
  }
}

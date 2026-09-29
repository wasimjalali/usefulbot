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

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const botId = new URL(request.url).searchParams.get("botId")?.trim() ?? "";
  if (!botId) return NextResponse.json({ ok: true, notes: [] });
  const notes = memoryStore().list("desktop", 100, botId);
  return NextResponse.json({ ok: true, notes });
}

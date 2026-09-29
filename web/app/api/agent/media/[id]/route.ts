import { lstatSync } from "node:fs";
import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { apiError, errorCode, readJson } from "../../../../../lib/api-guard";
import { findMedia, forgetMedia, relinkMedia } from "../../../../../../shared/media-store.ts";

export const runtime = "nodejs";

async function ownerWithCsrf(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return { error: gate.error };
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return { error: NextResponse.json({ ok: false, error: "csrf" }, { status: 403 }) };
  }
  return { error: null };
}

/** One item, for a chat row that names it: where its file is and whether it is there. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const { id } = await context.params;
  try {
    const item = findMedia(id);
    if (!item || item.forgotten) return NextResponse.json({ ok: false, error: "missing" }, { status: 404 });
    let exists = false;
    try {
      exists = lstatSync(item.path).isFile();
    } catch {
      exists = false;
    }
    return NextResponse.json({ ok: true, item: { ...item, exists } }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "media_read") }, { status: 500 });
  }
}

/** Point a moved item at the file the owner picked in Locate. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await ownerWithCsrf(request);
  if (checked.error) return checked.error;
  const { id } = await context.params;
  try {
    const body = await readJson(request) as { path?: unknown };
    if (typeof body.path !== "string") return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    return NextResponse.json({ ok: true, item: relinkMedia(id, body.path) });
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: errorCode(err, "relink_failed") }, { status: 400 });
  }
}

/** Forget an item. The app has already moved its file to the Trash; nothing here deletes a file. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await ownerWithCsrf(request);
  if (checked.error) return checked.error;
  const { id } = await context.params;
  try {
    return NextResponse.json({ ok: true, removed: forgetMedia(id) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "forget_failed") }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readFormData } from "../../../lib/api-guard";
import {
  ATTACH_MAX_BYTES,
  ATTACH_TEXT_MAX,
  imageMediaType,
  isTextAttachment,
  safeAttachName,
  sniffImageType,
} from "../../../../shared/attachments.ts";

// The multipart envelope plus headers ride above the file cap; a little slack
// keeps a legal upload from tripping the body gate.
const MULTIPART_OVERHEAD = 64 * 1024;

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  // Each file posts separately, so uploads get the same bucket as the other
  // writes.
  if (rateLimited(`attachments:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  // Bound the multipart body before it is buffered. A chunked upload carries
  // no content-length, so the gate has to read through a capped buffer rather
  // than trust the header.
  try {
    const form = await readFormData(request, ATTACH_MAX_BYTES + MULTIPART_OVERHEAD);
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("attachment_missing");
    if (file.size <= 0 || file.size > ATTACH_MAX_BYTES) throw new Error("attachment_size");
    const name = safeAttachName(file.name);
    const type = file.type || "application/octet-stream";
    const bytes = Buffer.from(await file.arrayBuffer());
    let text: string | undefined;
    if (isTextAttachment(name, type) && bytes.length <= ATTACH_TEXT_MAX) {
      text = bytes.toString("utf8");
      if (text.includes("\0")) text = undefined;
    }
    // An image goes back as a data URL so the turn can carry it as a file
    // part. The bytes decide the type, not the name: a `.jpg` that holds a
    // PNG is still a picture, and a `.png` that holds something else (a
    // HEIC, a truncated download) attaches as a plain file the way it did
    // before, rather than failing the attach over its name. Only bytes that
    // are an image become a URL a model provider receives.
    let mediaType: string | undefined;
    let dataUrl: string | undefined;
    if (imageMediaType(name, type)) {
      const sniffed = sniffImageType(bytes);
      if (sniffed) {
        mediaType = sniffed;
        dataUrl = `data:${sniffed};base64,${bytes.toString("base64")}`;
      }
    }
    return NextResponse.json({ ok: true, name, type, bytes: bytes.length, text, mediaType, dataUrl });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err, "attachment_invalid") }, { status: 400 });
  }
}

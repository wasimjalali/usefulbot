import {
  ATTACH_MAX_BYTES,
  ATTACH_MAX_FILES,
  ATTACH_TEXT_MAX,
  IMAGE_DATA_URL,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGE_PARTS,
  safeAttachName,
} from "./attachments.ts";

/**
 * The body of `POST /api/chats/:chatId/turns`, validated at the web boundary
 * before it is relayed to the engine (SPEC 6.1, seams.md "Turn body"). The app
 * puts what `POST /api/attachments` returned straight into `attachments`: text
 * files carry `text`, images carry `dataUrl`, any other file carries neither
 * and reaches the model as a name and a size. Text goes into the prompt inside
 * an untrusted fence; images become image content.
 */

/** A turn's own text, in characters. */
export const TURN_TEXT_MAX = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;

export type TurnAttachment = {
  name: string;
  mediaType: string;
  size: number;
  text?: string;
  dataUrl?: string;
};

export type TurnBody = {
  clientId: string;
  text: string;
  attachments: TurnAttachment[];
  retry: boolean;
};

/** A refused turn body. `code` is a short snake_case code the route answers with. */
export class TurnBodyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TurnBodyError";
    this.code = code;
  }
}

/**
 * An attachment's name goes verbatim into the model's context, so it takes the
 * same alphabet `/api/attachments` hands out: nothing that can split a line,
 * and no credential-looking names. First-party clients already send such names;
 * this is the check for anyone posting to the route directly.
 */
function safeName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return safeAttachName(value) === value ? value : null;
  } catch {
    return null;
  }
}

function parseAttachment(item: unknown): TurnAttachment {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new TurnBodyError("attachment_invalid");
  const rec = item as Record<string, unknown>;
  const name = safeName(rec.name);
  if (name === null) throw new TurnBodyError("attachment_invalid");
  if (typeof rec.mediaType !== "string" || !MEDIA_TYPE.test(rec.mediaType)) throw new TurnBodyError("attachment_invalid");
  if (!Number.isInteger(rec.size) || (rec.size as number) < 0 || (rec.size as number) > ATTACH_MAX_BYTES) {
    throw new TurnBodyError("attachment_invalid");
  }
  const out: TurnAttachment = { name, mediaType: rec.mediaType, size: rec.size as number };
  if (rec.text !== undefined) {
    if (typeof rec.text !== "string" || rec.text.length > ATTACH_TEXT_MAX) throw new TurnBodyError("attachment_invalid");
    out.text = rec.text;
  }
  if (rec.dataUrl !== undefined) {
    // The data URL reaches a third-party model provider, so it has to be an
    // image whose declared type is the one it carries.
    if (typeof rec.dataUrl !== "string" || rec.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) throw new TurnBodyError("attachment_invalid");
    if (!IMAGE_DATA_URL.test(rec.dataUrl)) throw new TurnBodyError("attachment_invalid");
    if (rec.mediaType !== rec.dataUrl.slice("data:".length, rec.dataUrl.indexOf(";"))) throw new TurnBodyError("attachment_invalid");
    out.dataUrl = rec.dataUrl;
  }
  if (out.text !== undefined && out.dataUrl !== undefined) throw new TurnBodyError("attachment_invalid");
  return out;
}

/**
 * Validate a turn body (a JSON string or an already parsed value) and return
 * it rebuilt from the validated fields alone, so nothing else a caller put on
 * it is relayed. Throws `TurnBodyError` with the code to answer with.
 */
export function parseTurnBody(raw: unknown): TurnBody {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new TurnBodyError("invalid_json");
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new TurnBodyError("turn_invalid");
  const rec = json as Record<string, unknown>;
  if (typeof rec.clientId !== "string" || !UUID.test(rec.clientId)) throw new TurnBodyError("client_id_invalid");
  if (typeof rec.text !== "string" || rec.text.length > TURN_TEXT_MAX) throw new TurnBodyError("turn_text_invalid");
  // `retry: false` is what this function itself returns, and the web relays
  // that to the engine, which parses it again.
  if (rec.retry !== undefined && typeof rec.retry !== "boolean") throw new TurnBodyError("turn_invalid");
  const items = rec.attachments === undefined ? [] : rec.attachments;
  if (!Array.isArray(items) || items.length > ATTACH_MAX_FILES) throw new TurnBodyError("attachment_invalid");
  const attachments = items.map(parseAttachment);
  if (attachments.filter((item) => item.dataUrl !== undefined).length > MAX_IMAGE_PARTS) {
    throw new TurnBodyError("attachment_invalid");
  }
  // A retry resends the failed message, which the engine already holds.
  if (rec.retry !== true && rec.text.trim() === "" && attachments.length === 0) throw new TurnBodyError("turn_empty");
  return { clientId: rec.clientId, text: rec.text, attachments, retry: rec.retry === true };
}

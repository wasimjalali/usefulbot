import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { statePath } from "./stack.ts";

/**
 * Legacy generated images, one JSON record each under ~/.useful-bot/images/.
 * New images are files under the media folder (shared/media-store.ts); this
 * store only reads the old records until they are migrated. The event
 * carries the id either way and the app fetches through /api/agent/image.
 */
export type ImageRecord = {
  id: string;
  /** "image/png" etc. The route sends it back as the content type. */
  mime: string;
  /** Base64 image bytes, the shape the upstream answered in. */
  b64: string;
  /** The prompt the model drew from, clipped for the record. */
  prompt: string;
  provider: string;
  model: string;
  createdAt: string;
};

const ID = /^[a-zA-Z0-9_-]{8,80}$/;
export const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

/**
 * The router refuses decoded image bytes past this, so the base64 body below
 * (x4/3 plus the record's fields) always fits inside RECORD_MAX.
 */
export const IMAGE_BYTES_MAX = 12 * 1024 * 1024;
/** A 4k PNG lands around 12 MB base64; anything past this is not one of ours. */
const RECORD_MAX = 20_000_000;
const PROMPT_MAX = 2_000;

export function imagesDir(root = process.env.UB_IMAGES_DIR): string {
  if (root) return root;
  // Migration deletes from here, so a test must never reach the real folder.
  if (process.env.NODE_TEST_CONTEXT) throw new Error("images under test needs UB_IMAGES_DIR");
  return statePath("images");
}

function pathFor(id: string, dir = imagesDir()): string {
  if (!ID.test(id)) throw new Error("image_id");
  return join(dir, `${id}.json`);
}

export function writeImage(
  input: { id: string; mime: string; b64: string; prompt: string; provider: string; model: string },
  dir = imagesDir(),
): void {
  if (!ID.test(input.id)) throw new Error("image_id");
  if (!IMAGE_MIME.test(input.mime)) throw new Error("image_type");
  const decoded = Math.floor(input.b64.length / 4) * 3 - (input.b64.endsWith("==") ? 2 : input.b64.endsWith("=") ? 1 : 0);
  if (decoded > IMAGE_BYTES_MAX) throw new Error("image_too_large");
  const record: ImageRecord = {
    id: input.id,
    mime: input.mime,
    b64: input.b64,
    prompt: input.prompt.slice(0, PROMPT_MAX),
    provider: input.provider.slice(0, 80),
    model: input.model.slice(0, 120),
    createdAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body, "utf8") > RECORD_MAX) throw new Error("image_too_large");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = pathFor(input.id, dir);
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readImage(id: string, dir = imagesDir()): ImageRecord | null {
  let path: string;
  try {
    path = pathFor(id, dir);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ImageRecord;
    if (!raw || raw.id !== id || !IMAGE_MIME.test(raw.mime) || typeof raw.b64 !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function deleteImage(id: string, dir = imagesDir()): void {
  try { unlinkSync(pathFor(id, dir)); } catch { /* ignore */ }
}

/**
 * Ids of the records still in the legacy folder. Images now live as files
 * under the media folder (shared/media-store.ts); these are migrated there
 * and never swept: what the agent made is the owner's to delete.
 */
export function legacyImageIds(dir = imagesDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => ID.test(id));
}

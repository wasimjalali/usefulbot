export const ATTACH_MAX_BYTES = 1_048_576;
export const ATTACH_TEXT_MAX = 64 * 1024;
export const ATTACH_MAX_FILES = 5;

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/xml",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
]);

const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".swift",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
  ".log",
]);

/**
 * Image types a bot can look at. Everything the composer accepts still goes
 * through `/api/attachments`; only these come back with a data URL that the
 * turn carries as a file part, so a vision model sees the pixels instead of a
 * "not readable as text" note.
 */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** How many image parts one turn may carry; matches the attachment cap. */
export const MAX_IMAGE_PARTS = ATTACH_MAX_FILES;
/** A 1 MiB file is ~1.4 MB of base64 plus the data URL header. */
export const MAX_IMAGE_DATA_URL_CHARS = 1_500_000;

export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** The image media type for a name and declared type, or null when it is not an image. */
export function imageMediaType(name: string, type: string): string | null {
  const declared = type.toLowerCase();
  if (IMAGE_TYPES.has(declared)) return declared;
  return IMAGE_EXT[attachmentExt(name)] ?? null;
}

/**
 * The bytes have to agree with the type they claim: the data URL reaches a
 * third-party model provider, so a renamed binary must not travel as an image.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function attachmentExt(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function safeAttachName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "_");
  const clipped = base.slice(0, 80) || "file";
  const lower = clipped.toLowerCase();
  if (lower.includes(".env") || lower.endsWith(".pem") || lower.endsWith(".key")) {
    throw new Error("attachment_forbidden");
  }
  return clipped;
}

export function isTextAttachment(name: string, type: string): boolean {
  if (TEXT_TYPES.has(type.toLowerCase())) return true;
  return TEXT_EXT.has(attachmentExt(name));
}

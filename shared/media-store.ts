import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * What the agent makes belongs to the owner, like the chats: every generated
 * image and drawing is a real file under ~/Documents/Useful Bot, filed by bot
 * and month, and nothing here ever deletes one. The index next to the other
 * app state (~/.useful-bot/media.json) carries what the file cannot: the
 * prompt, the model, the bot, and where the file is now if the owner moved it.
 */

/**
 * A page is an HTML file a bot wrote in its workspace. Unlike an image or a
 * drawing it is not copied into the media folder: the entry points at the
 * file where the bot keeps working on it, next to the assets it links.
 */
export type MediaKind = "image" | "drawing" | "page";

export type MediaItem = {
  id: string;
  kind: MediaKind;
  /** Absolute path of the file on disk. */
  path: string;
  botId: string;
  botName: string;
  title: string;
  prompt: string;
  model: string;
  provider: string;
  mime: string;
  createdAt: string;
  /**
   * The owner removed it from the Library. The entry stays as a tombstone so
   * a replayed chat that posts the same drawing again does not bring it back.
   */
  forgotten?: boolean;
};

/**
 * `extra` holds entries this version cannot read (malformed, or from a newer
 * build). They are written back untouched, so a save never drops what it
 * does not understand.
 */
type MediaIndex = { schemaVersion: 1; items: MediaItem[]; extra: unknown[] };

const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".excalidraw": "application/vnd.excalidraw+json",
  ".html": "text/html",
  ".htm": "text/html",
};
const PAGE_MIME = "text/html";
const DRAWING_MIME = "application/vnd.excalidraw+json";
// The critical section is a read, a small edit and an fsynced write: a
// holder is done in milliseconds. A lock older than a few seconds belongs to
// a process that died holding it, and a waiter gives up quickly rather than
// stall the service it runs in.
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const TITLE_MAX = 60;
const PROMPT_MAX = 2_000;

/** Under the test runner a write must name temp folders: a default here is the owner's real Documents. */
function assertNotRealUnderTest(value: string | undefined, name: string): void {
  if (!value && process.env.NODE_TEST_CONTEXT) throw new Error(`media under test needs ${name}`);
}

export function mediaRoot(root = process.env.UB_MEDIA_DIR): string {
  if (root) return root;
  assertNotRealUnderTest(root, "UB_MEDIA_DIR");
  return join(process.env.HOME ?? "/tmp", "Documents", "Useful Bot");
}

export function mediaIndexPath(path = process.env.UB_MEDIA_INDEX_PATH): string {
  if (path) return path;
  assertNotRealUnderTest(path, "UB_MEDIA_INDEX_PATH");
  return join(process.env.HOME ?? "/tmp", ".useful-bot", "media.json");
}

function emptyIndex(): MediaIndex {
  return { schemaVersion: 1, items: [], extra: [] };
}

function isItem(value: unknown): value is MediaItem {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === "string" && ID.test(rec.id)
    && (rec.kind === "image" || rec.kind === "drawing" || rec.kind === "page")
    && typeof rec.path === "string" && isAbsolute(rec.path)
    && (rec.kind !== "page" || isPagePath(rec.path))
    && typeof rec.botId === "string" && typeof rec.botName === "string"
    && typeof rec.title === "string" && typeof rec.prompt === "string"
    && typeof rec.model === "string" && typeof rec.provider === "string"
    && typeof rec.mime === "string" && typeof rec.createdAt === "string"
    && (rec.forgotten === undefined || typeof rec.forgotten === "boolean");
}

/**
 * The index, or null when the file exists but will not parse. Callers that
 * write treat null as a refusal: rewriting an unreadable index would drop
 * every entry the owner has.
 */
function readIndexOrNull(path: string): MediaIndex | null {
  if (!existsSync(path)) return emptyIndex();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; items?: unknown };
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.items)) return null;
    return {
      schemaVersion: 1,
      items: raw.items.filter(isItem),
      extra: raw.items.filter((row) => !isItem(row)),
    };
  } catch {
    return null;
  }
}

export function readMediaIndex(path = mediaIndexPath()): MediaItem[] {
  return readIndexOrNull(path)?.items ?? [];
}

/** Drawing ids the Library holds, or null when the index will not parse (a sweep must then stand down). */
export function libraryDrawingIds(path = mediaIndexPath()): Set<string> | null {
  const index = readIndexOrNull(path);
  if (!index) return null;
  return new Set(index.items.filter((item) => item.kind === "drawing" && !item.forgotten).map((item) => item.id));
}

function writeIndex(index: MediaIndex, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const body = { schemaVersion: 1, items: [...index.items, ...index.extra] };
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function lockOwner(lock: string): string | null {
  try {
    return readFileSync(join(lock, "owner"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Cross-process read/merge/write: eve saves images, the web service saves
 * drawings. The lock is a directory holding its owner's token. A lock left by
 * a process that died is moved aside whole (a rename, so two waiters cannot
 * both take it) and removed. A holder checks the token is still its own just
 * before it commits, and removes only its own lock, so a lock taken from a
 * live but stalled holder makes that holder's save fail loudly instead of
 * two writers each dropping the other's entry.
 */
function withIndex<T>(fn: (index: MediaIndex) => T, path = mediaIndexPath()): T {
  const lock = `${path}.lock`;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), token, { mode: 0o600 });
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const aside = `${lock}.stale.${randomUUID().slice(0, 8)}`;
          renameSync(lock, aside);
          rmSync(aside, { recursive: true, force: true });
        }
      } catch { /* lock vanished or another waiter moved it; retry */ }
      if (Date.now() > deadline) break;
      Atomics.wait(SLEEP_SIGNAL, 0, 0, 15);
    }
  }
  if (!held) throw new Error("media_index_locked");
  try {
    const index = readIndexOrNull(path);
    if (!index) throw new Error("media_index_unreadable");
    const result = fn(index);
    if (lockOwner(lock) !== token) throw new Error("media_index_locked");
    writeIndex(index, path);
    return result;
  } finally {
    if (lockOwner(lock) === token) {
      try { rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/** A name Finder shows cleanly: no path separators, no leading dot, no control characters. */
function safeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .slice(0, TITLE_MAX)
    .trim();
  return cleaned || fallback;
}

/**
 * A short title from the prompt: its first clause, trimmed to a file name at
 * a word. A clause ends at punctuation followed by a space, so "16:9" or
 * "v2.5" stay whole.
 */
export function titleFromPrompt(prompt: string, fallback: string): string {
  const first = prompt.split(/[.:;!?](?:\s|$)|\n/)[0] ?? "";
  const words = first.trim().split(/\s+/);
  let title = "";
  for (const word of words) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > TITLE_MAX) break;
    title = next;
  }
  return safeName(title || first, fallback);
}

function stamp(date: Date): { month: string; prefix: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const month = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  return { month, prefix: `${month}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}` };
}

/** Writes the bytes to a fresh file; a name already taken gets " 2", " 3" and so on, never an overwrite. */
function writeNewFile(dir: string, base: string, ext: string, bytes: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (let n = 1; n < 1000; n += 1) {
    const path = join(dir, `${base}${n === 1 ? "" : ` ${n}`}.${ext}`);
    try {
      // Durable before the index names it: a crash must not leave an entry
      // pointing at a half-written file.
      const fd = openSync(path, "wx", 0o644);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } catch (err) {
        // A half-written file must not stay behind as a corrupt image.
        closeSync(fd);
        try { unlinkSync(path); } catch { /* ignore */ }
        throw err;
      }
      closeSync(fd);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("media_name_exhausted");
}

function saveFile(input: {
  id: string;
  kind: MediaKind;
  mime: string;
  ext: string;
  bytes: Buffer;
  botId: string;
  botName: string;
  title: string;
  prompt: string;
  model: string;
  provider: string;
  createdAt?: Date;
  /**
   * Regenerate: the id's file is gone, and a new one takes its place under
   * the same id (so the chat row that names it shows the new picture).
   */
  replace?: boolean;
  /** The entry was removed when the owner asked for it again: bring it back. */
  revive?: boolean;
}, root = mediaRoot(), indexPath = mediaIndexPath()): MediaItem {
  if (!ID.test(input.id)) throw new Error("media_id");
  // One file per id, ever, unless this is a replacement. The app posts a drawing again whenever a chat
  // replays it, and a second file per replay would fill the folder with
  // copies; an owner who moved or trashed the file keeps that choice too.
  const existing = findMedia(input.id, indexPath);
  if (existing && !input.replace) return existing;
  const when = input.createdAt ?? new Date();
  const { month, prefix } = stamp(when);
  const dir = join(root, safeName(input.botName, "Useful Bot"), month);
  const path = writeNewFile(dir, `${prefix} ${input.title}`, input.ext, input.bytes);
  const item: MediaItem = {
    id: input.id,
    kind: input.kind,
    path,
    botId: input.botId,
    botName: input.botName,
    title: input.title,
    prompt: input.prompt.slice(0, PROMPT_MAX),
    model: input.model.slice(0, 120),
    provider: input.provider.slice(0, 80),
    mime: input.mime,
    createdAt: when.toISOString(),
  };
  try {
    const kept = withIndex((index) => {
      const raced = index.items.find((row) => row.id === item.id);
      if (raced && input.replace) {
        // What the owner did while this was drawn wins: a Remove stays
        // removed (unless it was removed when they asked), and a file they
        // put back at its path stays the one the entry names.
        if (raced.forgotten && !input.revive) return raced;
        if (!raced.forgotten && raced.path !== item.path && readsAs(raced.path, raced.kind)) return raced;
        // The replacement keeps the entry's prompt and bot id, and takes the
        // new file and the folder name it was filed under.
        Object.assign(raced, {
          path: item.path,
          mime: item.mime,
          model: item.model || raced.model,
          provider: item.provider || raced.provider,
          botName: item.botName,
          createdAt: item.createdAt,
        });
        delete raced.forgotten;
        return null;
      }
      // A save racing this one for the same id won: keep its file, drop ours.
      if (raced) return raced;
      index.items.push(item);
      return null;
    }, indexPath);
    if (kept) {
      try { unlinkSync(path); } catch { /* a stray copy; the index names the winner */ }
      return kept;
    }
  } catch (err) {
    // A file the index cannot name would be invisible to the chat and the
    // Library, so the write is undone and the failure goes up.
    try { unlinkSync(path); } catch { /* ignore */ }
    throw err;
  }
  return item;
}

export function saveImage(input: {
  id: string;
  mime: string;
  bytes: Buffer;
  prompt: string;
  model: string;
  provider: string;
  botId: string;
  botName: string;
  createdAt?: Date;
  replace?: boolean;
  revive?: boolean;
}, root = mediaRoot(), indexPath = mediaIndexPath()): MediaItem {
  const ext = IMAGE_EXT[input.mime];
  if (!ext) throw new Error("image_type");
  return saveFile({
    ...input,
    kind: "image",
    ext,
    title: titleFromPrompt(input.prompt, "Image"),
  }, root, indexPath);
}

/**
 * An Excalidraw drawing as a .excalidraw file, the format excalidraw.com and
 * the desktop apps open. The widget carries its scene as an elements array,
 * sometimes JSON-encoded as a string.
 */
export function saveDrawing(input: {
  id: string;
  elements: unknown;
  /** Embedded images the scene's image elements point at, when the widget carries them. */
  files?: unknown;
  title: string;
  botId: string;
  botName: string;
  provider: string;
  createdAt?: Date;
}, root = mediaRoot(), indexPath = mediaIndexPath()): MediaItem {
  let elements = input.elements;
  if (typeof elements === "string") elements = JSON.parse(elements) as unknown;
  if (!Array.isArray(elements)) throw new Error("drawing_elements");
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "Useful Bot",
    elements: elements.filter((el) => el && typeof el === "object" && (el as { type?: unknown }).type !== "cameraUpdate"),
    appState: { viewBackgroundColor: "#ffffff" },
    files: input.files && typeof input.files === "object" && !Array.isArray(input.files) ? input.files : {},
  };
  return saveFile({
    id: input.id,
    kind: "drawing",
    mime: DRAWING_MIME,
    ext: "excalidraw",
    bytes: Buffer.from(`${JSON.stringify(scene, null, 2)}\n`, "utf8"),
    botId: input.botId,
    botName: input.botName,
    title: safeName(input.title, "Drawing"),
    prompt: "",
    model: "",
    provider: input.provider,
    createdAt: input.createdAt,
  }, root, indexPath);
}

export function isPagePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

/** The page's own <title>, else its file name. */
export function pageTitle(html: string, path: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 20_000));
  const text = match?.[1]
    ?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .trim();
  return safeName(text || basename(path, extname(path)), "Page");
}

/**
 * Index an HTML file a bot wrote, where it is. One entry per real path, so a
 * bot that rewrites its page keeps one Library item; `added` is true only the
 * first time, which is when the chat gets its card. A page the owner removed
 * stays removed.
 */
export function recordPage(input: {
  path: string;
  html: string;
  botId: string;
  botName: string;
  createdAt?: Date;
}, indexPath = mediaIndexPath()): { item: MediaItem; added: boolean } {
  if (!isAbsolute(input.path) || !isPagePath(input.path)) throw new Error("media_type");
  const real = realOrSelf(input.path);
  if (!isRegularFile(real)) throw new Error("media_type");
  const pageId = (seed: string) => `page${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
  let id = pageId(real);
  const item: MediaItem = {
    id,
    kind: "page",
    path: real,
    botId: input.botId,
    botName: input.botName,
    title: pageTitle(input.html, real),
    prompt: "",
    model: "",
    provider: "",
    mime: PAGE_MIME,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
  return withIndex((index) => {
    // By where the file is now first: a page relinked after a move keeps
    // the id it was first saved under.
    const existing = index.items.find((row) => row.kind === "page" && realOrSelf(row.path) === real);
    // The id is taken by a page relinked away from this path: this file is
    // a new page and gets an id of its own.
    if (!existing && index.items.some((row) => row.id === id)) {
      id = pageId(`${real}\n${item.createdAt}`);
      item.id = id;
    }
    if (existing) {
      // A rewrite can rename the page; the rest stays as first saved.
      if (!existing.forgotten) existing.title = item.title;
      return { item: { ...existing }, added: false };
    }
    index.items.push(item);
    return { item, added: true };
  }, indexPath);
}

/** Only a regular file counts as the item: a folder at that path is not it. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where a path really is, for comparing two paths that may go through a link. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The image type the bytes themselves say, never the file name. */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function isExcalidrawScene(bytes: Buffer): boolean {
  try {
    const scene = JSON.parse(bytes.toString("utf8")) as { type?: unknown; elements?: unknown };
    return scene?.type === "excalidraw" && Array.isArray(scene.elements);
  } catch {
    return false;
  }
}

/**
 * The bytes at a path, only when the path is a regular file (never a symlink)
 * whose content is the kind the entry says: a real image for an image, a real
 * Excalidraw scene for a drawing. The name alone proves nothing, so neither
 * Locate nor a file swapped in later can make the image route serve anything
 * else.
 */
/** Whether the file at `path` is a readable item of this kind, the test readMediaBytes calls "ok". */
function readsAs(path: string, kind: MediaKind): boolean {
  try {
    readVerified(path, kind);
    return true;
  } catch {
    return false;
  }
}

function readVerified(path: string, kind: MediaKind): { mime: string; bytes: Buffer } {
  if (!lstatSync(path).isFile()) throw new Error("media_type");
  if (kind === "page") {
    // Only the name says a page. Its bytes are never read here, so no route
    // can serve a bot's HTML from the app's origin; the app opens the file.
    if (!isPagePath(path)) throw new Error("media_type");
    return { mime: PAGE_MIME, bytes: Buffer.alloc(0) };
  }
  const bytes = readFileSync(path);
  if (kind === "drawing") {
    if (!isExcalidrawScene(bytes)) throw new Error("media_type");
    return { mime: DRAWING_MIME, bytes };
  }
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("media_type");
  return { mime, bytes };
}

export function findMedia(id: string, indexPath = mediaIndexPath()): MediaItem | null {
  return readMediaIndex(indexPath).find((item) => item.id === id) ?? null;
}

export type MediaBytes =
  | { status: "ok"; item: MediaItem; mime: string; bytes: Buffer }
  | { status: "moved"; item: MediaItem }
  | { status: "missing" }
  | { status: "error"; item: MediaItem; code: string };

/**
 * The file behind an id. "moved" only when nothing is at the path any more
 * (the owner moved or deleted it); a file that is there but unreadable, or is
 * not the kind it claims, is an error, which Locate could not fix.
 */
export function readMediaBytes(id: string, indexPath = mediaIndexPath()): MediaBytes {
  const item = findMedia(id, indexPath);
  if (!item || item.forgotten) return { status: "missing" };
  try {
    return { status: "ok", item, ...readVerified(item.path, item.kind) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Nothing there, or something that is not the item (a folder, a link, a
    // file of another kind): either way the item is not at its path, and
    // Locate is the way back.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { status: "moved", item };
    if (err instanceof Error && err.message === "media_type") return { status: "moved", item };
    return { status: "error", item, code: code ?? "media_read" };
  }
}

export function listMedia(
  filter: { kind?: MediaKind; botId?: string; query?: string } = {},
  indexPath = mediaIndexPath(),
): Array<MediaItem & { exists: boolean }> {
  const q = filter.query?.trim().toLowerCase();
  // An index that will not parse is an error the owner must see, never an
  // empty Library over files that are all still there.
  const index = readIndexOrNull(indexPath);
  if (!index) throw new Error("media_index_unreadable");
  return index.items
    .filter((item) => !item.forgotten)
    .filter((item) => !filter.kind || item.kind === filter.kind)
    .filter((item) => !filter.botId || item.botId === filter.botId)
    .filter((item) => !q || item.title.toLowerCase().includes(q) || item.prompt.toLowerCase().includes(q) || item.botName.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => ({ ...item, exists: isRegularFile(item.path) }));
}

/**
 * Point an entry at the file the owner found after moving it. The new file
 * must be the same kind (an image stays an image), so a relink cannot turn
 * the owner-gated image route into a reader of arbitrary files.
 */
export function relinkMedia(id: string, newPath: string, indexPath = mediaIndexPath()): MediaItem {
  if (!isAbsolute(newPath)) throw new Error("media_path");
  let path: string;
  try {
    // The real file, links followed once here and never again: the entry
    // stores where the bytes actually are.
    path = realpathSync(resolve(newPath));
  } catch {
    throw new Error("media_path");
  }
  if (!EXT_MIME[extname(path).toLowerCase()]) throw new Error("media_type");
  return withIndex((index) => {
    const item = index.items.find((row) => row.id === id);
    if (!item || item.forgotten) throw new Error("media_missing");
    const { mime } = readVerified(path, item.kind);
    if (index.items.some((row) => row.id !== id && !row.forgotten && realOrSelf(row.path) === path)) throw new Error("media_in_use");
    item.path = path;
    item.mime = mime;
    return { ...item };
  }, indexPath);
}

/**
 * Take an entry out of the Library. The file itself is the owner's: the app
 * moves it to the Trash first. The entry stays as a tombstone (see
 * `forgotten`), so the same id is never saved again.
 */
export function forgetMedia(id: string, indexPath = mediaIndexPath()): boolean {
  return withIndex((index) => {
    const item = index.items.find((row) => row.id === id);
    if (!item || item.forgotten) return false;
    item.forgotten = true;
    return true;
  }, indexPath);
}

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  findMedia,
  forgetMedia,
  listMedia,
  readMediaBytes,
  recordPage,
  relinkMedia,
  saveDrawing,
  saveImage,
  titleFromPrompt,
} from "../shared/media-store.ts";
import { readImage, writeImage } from "../shared/images-store.ts";
import { appendAgentEvent } from "../shared/agent-store.ts";
import { readShell, writeShell } from "../shared/shell-io.ts";
import { isExcalidrawWidget, migrateDrawings, migrateLegacyImages } from "../web/lib/media-migrate.ts";
import { writeWidget } from "../shared/widgets-store.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function box() {
  const dir = mkdtempSync(join(tmpdir(), "ub-media-"));
  return { root: join(dir, "Useful Bot"), index: join(dir, "media.json"), dir };
}

test("an image is a real file filed by bot and month, and reads back by id", () => {
  const { root, index } = box();
  const when = new Date(2026, 8, 23, 11, 5);
  const item = saveImage({
    id: "imgfox000001", mime: "image/png", bytes: PNG, prompt: "A red fox: in the snow", model: "flux", provider: "openrouter",
    botId: "bot-1", botName: "Test/Bot", createdAt: when,
  }, root, index);
  assert.equal(item.path, join(root, "Test Bot", "2026-09", "2026-09-23 11.05 A red fox.png"));
  assert.deepEqual(readFileSync(item.path), PNG);
  const read = readMediaBytes("imgfox000001", index);
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" ? read.mime : "", "image/png");

  // The same title in the same minute never overwrites.
  const second = saveImage({
    id: "imgfox000002", mime: "image/png", bytes: PNG, prompt: "A red fox", model: "", provider: "",
    botId: "bot-1", botName: "Test/Bot", createdAt: when,
  }, root, index);
  assert.equal(second.path, join(root, "Test Bot", "2026-09", "2026-09-23 11.05 A red fox 2.png"));
  assert.throws(() => saveImage({ id: "../escape", mime: "image/png", bytes: PNG, prompt: "", model: "", provider: "", botId: "", botName: "" }, root, index), /media_id/);
  assert.throws(() => saveImage({ id: "imghtml00001", mime: "text/html", bytes: PNG, prompt: "", model: "", provider: "", botId: "", botName: "" }, root, index), /image_type/);
});

test("a moved file reads as moved, Locate relinks it, and only to the same kind", () => {
  const { root, index, dir } = box();
  const item = saveImage({ id: "imgmove00001", mime: "image/png", bytes: PNG, prompt: "cat", model: "", provider: "", botId: "b", botName: "B" }, root, index);
  const moved = join(dir, "elsewhere.png");
  renameSync(item.path, moved);
  assert.equal(readMediaBytes("imgmove00001", index).status, "moved");
  assert.equal(listMedia({}, index)[0]?.exists, false);
  // A folder at the item's path is not the item: Move to Trash must not take it.
  mkdirSync(item.path);
  assert.equal(listMedia({}, index)[0]?.exists, false);
  renameSync(item.path, join(dir, "a-folder"));
  const drawingPath = join(dir, "scene.excalidraw");
  writeFileSync(drawingPath, "{}");
  assert.throws(() => relinkMedia("imgmove00001", drawingPath, index), /media_type/);
  assert.throws(() => relinkMedia("imgmove00001", "relative.png", index), /media_path/);
  // The name is not proof: a text file called .png, or a link to another
  // file, is refused.
  const fake = join(dir, "notes.png");
  writeFileSync(fake, "not an image");
  assert.throws(() => relinkMedia("imgmove00001", fake, index), /media_type/);
  relinkMedia("imgmove00001", moved, index);
  assert.equal(readMediaBytes("imgmove00001", index).status, "ok");
  // Two entries never share one file: trashing one would break the other.
  const other = saveImage({ id: "imgother0001", mime: "image/png", bytes: PNG, prompt: "dog", model: "", provider: "", botId: "b", botName: "B" }, root, index);
  renameSync(other.path, join(dir, "gone.png"));
  assert.throws(() => relinkMedia("imgother0001", moved, index), /media_in_use/);
  // A file swapped for a link, or for something that is not an image, stops
  // serving and reads as moved, so Locate can point it back.
  renameSync(moved, join(dir, "real.png"));
  symlinkSync(join(dir, "real.png"), moved);
  assert.equal(readMediaBytes("imgmove00001", index).status, "moved");
  assert.equal(readMediaBytes("imgnothing01", index).status, "missing");
});

test("a drawing saves as a .excalidraw scene without camera steps, and the Library filters", () => {
  const { root, index } = box();
  const drawing = saveDrawing({
    id: "call_drawing01",
    elements: JSON.stringify([{ type: "cameraUpdate", width: 400 }, { type: "rectangle", id: "a" }]),
    title: "Drawing - Flow",
    botId: "bot-2",
    botName: "Designer",
    provider: "excalidraw",
  }, root, index);
  assert.ok(drawing.path.endsWith(" Drawing - Flow.excalidraw"));
  // A replayed chat posts the same drawing again: no second file.
  const again = saveDrawing({ id: "call_drawing01", elements: "[]", title: "Drawing - Flow", botId: "bot-2", botName: "Designer", provider: "excalidraw" }, root, index);
  assert.equal(again.path, drawing.path);
  assert.deepEqual(readdirSync(dirname(drawing.path)).length, 1);
  const scene = JSON.parse(readFileSync(drawing.path, "utf8")) as { type: string; elements: Array<{ type: string }> };
  assert.equal(scene.type, "excalidraw");
  assert.deepEqual(scene.elements.map((el) => el.type), ["rectangle"]);
  saveImage({ id: "imglib000001", mime: "image/png", bytes: PNG, prompt: "a lighthouse at dusk", model: "", provider: "", botId: "bot-1", botName: "One" }, root, index);
  assert.deepEqual(listMedia({ kind: "drawing" }, index).map((row) => row.id), ["call_drawing01"]);
  assert.deepEqual(listMedia({ botId: "bot-1" }, index).map((row) => row.id), ["imglib000001"]);
  assert.deepEqual(listMedia({ query: "LIGHTHOUSE" }, index).map((row) => row.id), ["imglib000001"]);
  // Forget takes it out of the Library, never deletes the file, and a later
  // save of the same id (a replayed chat) does not bring it back.
  const kept = findMedia("imglib000001", index)!;
  assert.equal(forgetMedia("imglib000001", index), true);
  assert.equal(forgetMedia("imglib000001", index), false);
  assert.equal(listMedia({}, index).some((row) => row.id === "imglib000001"), false);
  assert.equal(readMediaBytes("imglib000001", index).status, "missing");
  assert.equal(existsSync(kept.path), true);
  saveImage({ id: "imglib000001", mime: "image/png", bytes: PNG, prompt: "a lighthouse at dusk", model: "", provider: "", botId: "bot-1", botName: "One" }, root, index);
  assert.equal(listMedia({}, index).some((row) => row.id === "imglib000001"), false);
});

test("an unreadable index refuses writes instead of dropping every entry", () => {
  const { root, index } = box();
  writeFileSync(index, "{ not json");
  assert.throws(() => saveImage({ id: "imgbad000001", mime: "image/png", bytes: PNG, prompt: "x", model: "", provider: "", botId: "b", botName: "B" }, root, index), /media_index_unreadable/);
  assert.equal(readFileSync(index, "utf8"), "{ not json");
  // And the Library says so instead of showing an empty grid over real files.
  assert.throws(() => listMedia({}, index), /media_index_unreadable/);
  // The file written before the index refused is undone.
  assert.deepEqual(readdirSync(join(root, "B"), { recursive: true }).filter((name) => String(name).endsWith(".png")), []);
});

test("entries this version cannot read survive a save", () => {
  const { root, index } = box();
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, items: [{ id: "future000001", kind: "video", path: "/x.mp4" }] }));
  saveImage({ id: "imgnow000001", mime: "image/png", bytes: PNG, prompt: "x", model: "", provider: "", botId: "b", botName: "B" }, root, index);
  const raw = JSON.parse(readFileSync(index, "utf8")) as { items: Array<{ id: string }> };
  assert.deepEqual(raw.items.map((row) => row.id).sort(), ["future000001", "imgnow000001"]);
});

test("titles come from the prompt's first clause", () => {
  assert.equal(titleFromPrompt("Design a wide infographic: AI deck", "Image"), "Design a wide infographic");
  assert.equal(titleFromPrompt("Make a polished wide 16:9 poster. More detail", "Image"), "Make a polished wide 16 9 poster");
  assert.equal(titleFromPrompt("Create a high-quality, polished wide 16:9 infographic titled YOUR PERSONAL AGENT", "Image"), "Create a high-quality, polished wide 16 9 infographic titled");
  assert.equal(titleFromPrompt("   ", "Image"), "Image");
  // Separators and leading dots never reach the file name.
  assert.equal(titleFromPrompt("../../etc/passwd", "Image"), "etc passwd");
  assert.equal(titleFromPrompt("...", "Image"), "Image");
});

test("legacy base64 records move into the media folder under their bot, keeping their ids", () => {
  const { root, index, dir } = box();
  const previous = {
    media: process.env.UB_MEDIA_DIR, index: process.env.UB_MEDIA_INDEX_PATH, images: process.env.UB_IMAGES_DIR,
    agents: process.env.UB_AGENT_STORE_PATH, shell: process.env.UB_SHELL_PATH,
  };
  process.env.UB_MEDIA_DIR = root;
  process.env.UB_MEDIA_INDEX_PATH = index;
  process.env.UB_IMAGES_DIR = join(dir, "legacy");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  try {
    const shell = readShell();
    const bot = shell.bots[0]!;
    writeShell(shell);
    writeImage({ id: "imglegacy001", mime: "image/png", b64: PNG.toString("base64"), prompt: "old sunset", provider: "openai", model: "gpt-image-1" });
    appendAgentEvent(bot.id, { kind: "image", text: "old sunset", imageId: "imglegacy001", id: "img_imglegacy001" });
    assert.deepEqual(migrateLegacyImages(), { moved: 1, failed: 0 });
    const item = findMedia("imglegacy001", index);
    assert.equal(item?.botId, bot.id);
    assert.ok(item?.path.startsWith(join(root, bot.name.replace(/[/\\:]/g, " "))));
    assert.deepEqual(readFileSync(item!.path), PNG);
    assert.equal(existsSync(join(dir, "legacy", "imglegacy001.json")), false);
    assert.deepEqual(migrateLegacyImages(), { moved: 0, failed: 0 });
  } finally {
    for (const [key, value] of Object.entries({
      UB_MEDIA_DIR: previous.media, UB_MEDIA_INDEX_PATH: previous.index, UB_IMAGES_DIR: previous.images,
      UB_AGENT_STORE_PATH: previous.agents, UB_SHELL_PATH: previous.shell,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("drawings still in a chat backfill into the Library, dated when first drawn, Excalidraw only", () => {
  const { root, index, dir } = box();
  const keys = ["UB_MEDIA_DIR", "UB_MEDIA_INDEX_PATH", "UB_WIDGETS_DIR", "UB_AGENT_STORE_PATH", "UB_SHELL_PATH"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.UB_MEDIA_DIR = root;
  process.env.UB_MEDIA_INDEX_PATH = index;
  process.env.UB_WIDGETS_DIR = join(dir, "widgets");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  try {
    const shell = readShell();
    const bot = shell.bots[0]!;
    writeShell(shell);
    const drawing = { connectionId: "excalidraw", toolName: "excalidraw__create_view", resourceUri: null, result: null, createdAt: new Date().toISOString() };
    writeWidget({ ...drawing, id: "call_old00001", arguments: { elements: JSON.stringify([{ type: "rectangle", label: { text: "Old" } }]) } });
    writeWidget({ ...drawing, id: "call_chart0001", connectionId: "charts", toolName: "charts__plot", arguments: { elements: [] } });
    appendAgentEvent(bot.id, { kind: "widget", text: "Drawing", widgetId: "call_old00001", id: "wgt_call_old00001" });
    appendAgentEvent(bot.id, { kind: "widget", text: "Drawing", widgetId: "call_chart0001", id: "wgt_call_chart0001" });
    assert.deepEqual(migrateDrawings(), { saved: 1, failed: 0 });
    const item = findMedia("call_old00001", index)!;
    assert.equal(item.title, "Drawing - Old");
    assert.equal(item.botId, bot.id);
    assert.equal(findMedia("call_chart0001", index), null);
    assert.deepEqual(migrateDrawings(), { saved: 0, failed: 0 });
    assert.equal(isExcalidrawWidget({ connectionId: "other", toolName: "other__x", arguments: { elements: [] } }), false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("Regenerate redraws a lost image from the stored prompt under the same id, and refuses one that is there", async () => {
  const { root, index, dir } = box();
  const keys = ["UB_MEDIA_DIR", "UB_MEDIA_INDEX_PATH", "UB_IMAGES_DIR", "UB_AGENT_STORE_PATH", "UB_SHELL_PATH", "UB_ROUTER_DESKTOP_TOKEN"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  process.env.UB_MEDIA_DIR = root;
  process.env.UB_MEDIA_INDEX_PATH = index;
  process.env.UB_IMAGES_DIR = join(dir, "legacy");
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_ROUTER_DESKTOP_TOKEN = "router-token-test";
  try {
    const shell = readShell();
    const bot = shell.bots[0]!;
    writeShell(shell);
    appendAgentEvent(bot.id, { kind: "image", text: "a red kite over dunes", imageId: "imglost00001", id: "img_imglost00001" });
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ model: "flux", provider: "openrouter", data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }));
    }) as typeof fetch;
    const { regenerateImage } = await import("../web/lib/image-regenerate.ts");
    await regenerateImage("imglost00001");
    assert.deepEqual(sent[0]?.body, { model: "image", prompt: "a red kite over dunes" });
    const read = readMediaBytes("imglost00001", index);
    assert.equal(read.status, "ok");
    assert.equal(findMedia("imglost00001", index)?.botId, bot.id);
    // It is there now: another click is refused before any paid call.
    await assert.rejects(() => regenerateImage("imglost00001"), /image_present/);
    assert.equal(sent.length, 1);
    // An unreadable file is still there, not lost.
    const kept = findMedia("imglost00001", index)!.path;
    chmodSync(kept, 0o000);
    try {
      await assert.rejects(() => regenerateImage("imglost00001"), /image_present/);
    } finally {
      chmodSync(kept, 0o644);
    }
    assert.equal(sent.length, 1);
    // A moved file is replaced under the same id and entry.
    renameSync(findMedia("imglost00001", index)!.path, join(dir, "gone.png"));
    await regenerateImage("imglost00001");
    assert.equal(readMediaBytes("imglost00001", index).status, "ok");
    assert.equal(listMedia({}, index).filter((row) => row.id === "imglost00001").length, 1);
    await assert.rejects(() => regenerateImage("imgnothing99"), /image_prompt_missing/);

    // Two clicks at once pay once: the second joins the first.
    renameSync(findMedia("imglost00001", index)!.path, join(dir, "gone2.png"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      await held;
      return new Response(JSON.stringify({ model: "flux", provider: "openrouter", data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }));
    }) as typeof fetch;
    const first = regenerateImage("imglost00001");
    const second = regenerateImage("imglost00001");
    release();
    assert.deepEqual(await second, await first);
    assert.equal(sent.length, 3);

    // A timeout says it may have been billed.
    renameSync(findMedia("imglost00001", index)!.path, join(dir, "gone3.png"));
    globalThis.fetch = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    await assert.rejects(() => regenerateImage("imglost00001"), /regenerate_timeout/);

    // The folder cannot take the file: the paid bytes land in the app's own
    // store under the same id, and the next migration puts them back.
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }))) as typeof fetch;
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a folder");
    process.env.UB_MEDIA_DIR = blocked;
    assert.deepEqual(await regenerateImage("imglost00001"), { path: "" });
    assert.equal(readImage("imglost00001")?.prompt, "a red kite over dunes");
    await assert.rejects(() => regenerateImage("imglost00001"), /image_present/);
    process.env.UB_MEDIA_DIR = root;
    assert.equal(migrateLegacyImages().moved, 1);
    assert.equal(readImage("imglost00001"), null);
    assert.equal(readMediaBytes("imglost00001", index).status, "ok");

    // What the owner does while it is drawn wins. A file put back at its
    // path (Locate) stays the one the entry names...
    const home = findMedia("imglost00001", index)!.path;
    renameSync(home, join(dir, "away.png"));
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    globalThis.fetch = (async () => {
      await paused;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }));
    }) as typeof fetch;
    const drawing = regenerateImage("imglost00001");
    renameSync(join(dir, "away.png"), home);
    resume();
    await drawing;
    assert.equal(findMedia("imglost00001", index)?.path, home);
    // ...and a Remove stays removed.
    renameSync(home, join(dir, "away2.png"));
    let resume2!: () => void;
    const paused2 = new Promise<void>((resolve) => { resume2 = resolve; });
    globalThis.fetch = (async () => {
      await paused2;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }));
    }) as typeof fetch;
    const drawing2 = regenerateImage("imglost00001");
    assert.equal(forgetMedia("imglost00001", index), true);
    resume2();
    await assert.rejects(() => drawing2, /image_removed/);
    assert.equal(findMedia("imglost00001", index)?.forgotten, true);
    // Asked for again after the Remove, it comes back.
    await regenerateImage("imglost00001");
    assert.equal(readMediaBytes("imglost00001", index).status, "ok");
    // Something that is not the image sitting at the old path does not
    // count as the owner putting it back.
    const junkHome = findMedia("imglost00001", index)!.path;
    renameSync(junkHome, join(dir, "away3.png"));
    writeFileSync(junkHome, "not an image");
    assert.equal(readMediaBytes("imglost00001", index).status, "moved");
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), mime: "image/png" }] }))) as typeof fetch;
    await regenerateImage("imglost00001");
    assert.equal(readMediaBytes("imglost00001", index).status, "ok");
    // Bytes that are not an image, whatever their label, are refused.
    renameSync(findMedia("imglost00001", index)!.path, join(dir, "away4.png"));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64"), mime: "image/png" }] }))) as typeof fetch;
    await assert.rejects(() => regenerateImage("imglost00001"), /image_unusable/);
    assert.equal(readMediaBytes("imglost00001", index).status, "moved");
  } finally {
    globalThis.fetch = realFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("an HTML page is indexed where the bot wrote it, once per file, and stays removed once removed", () => {
  const { index, dir } = box();
  const path = join(dir, "site", "report.html");
  mkdirSync(dirname(path), { recursive: true });
  const html = "<html><head><title>Q3 &amp; Q4 report</title></head><body>hi</body></html>";
  writeFileSync(path, html);
  const first = recordPage({ path, html, botId: "b", botName: "B" }, index);
  assert.equal(first.added, true);
  assert.equal(first.item.kind, "page");
  assert.equal(first.item.title, "Q3 & Q4 report");
  assert.equal(first.item.mime, "text/html");
  // Indexed in place, not copied into the media folder.
  assert.equal(first.item.path, realpathSync(path));
  assert.equal(readMediaBytes(first.item.id, index).status, "ok");
  assert.deepEqual(listMedia({ kind: "page" }, index).map((item) => item.id), [first.item.id]);
  // A rewrite keeps the one entry and takes the new title.
  const again = recordPage({ path, html: "<title>Final report</title>", botId: "b", botName: "B" }, index);
  assert.equal(again.added, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(findMedia(first.item.id, index)?.title, "Final report");
  // No <title>: the file name.
  const bare = join(dir, "site", "landing page.htm");
  writeFileSync(bare, "<p>x</p>");
  assert.equal(recordPage({ path: bare, html: "<p>x</p>", botId: "b", botName: "B" }, index).item.title, "landing page");
  // Only .html files, only real files.
  const text = join(dir, "notes.txt");
  writeFileSync(text, "x");
  assert.throws(() => recordPage({ path: text, html: "x", botId: "b", botName: "B" }, index), /media_type/);
  assert.throws(() => recordPage({ path: join(dir, "missing.html"), html: "x", botId: "b", botName: "B" }, index), /media_type/);
  // A page never relinks to an image, nor an image to a page.
  const png = join(dir, "pic.png");
  writeFileSync(png, PNG);
  renameSync(path, join(dir, "moved.html"));
  assert.throws(() => relinkMedia(first.item.id, png, index), /media_type/);
  relinkMedia(first.item.id, join(dir, "moved.html"), index);
  assert.equal(readMediaBytes(first.item.id, index).status, "ok");
  // Removed from the Library: a later write does not bring it back.
  assert.equal(forgetMedia(first.item.id, index), true);
  writeFileSync(path, html);
  const after = recordPage({ path: join(dir, "moved.html"), html, botId: "b", botName: "B" }, index);
  assert.equal(after.added, false);
  assert.equal(after.item.forgotten, true);
  // A new file at the path a relinked page left gets an entry of its own.
  const other = join(dir, "other.html");
  writeFileSync(other, "<title>Other</title>");
  const second = recordPage({ path: other, html: "<title>Other</title>", botId: "b", botName: "B" }, index);
  renameSync(other, join(dir, "other-moved.html"));
  relinkMedia(second.item.id, join(dir, "other-moved.html"), index);
  writeFileSync(other, "<title>Fresh</title>");
  const fresh = recordPage({ path: other, html: "<title>Fresh</title>", botId: "b", botName: "B" }, index);
  assert.equal(fresh.added, true);
  assert.notEqual(fresh.item.id, second.item.id);
  assert.equal(findMedia(second.item.id, index)?.title, "Other");
});

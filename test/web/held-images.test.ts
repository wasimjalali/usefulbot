import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyImageIds, writeImage } from "../../shared/images-store.ts";
import { findMedia, readMediaBytes } from "../../shared/media-store.ts";
import { drainHeldImages, resetHeldImagesClock } from "../../web/lib/held-images.ts";

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "binary"), Buffer.alloc(32, 1)]);

function withStores(fn: (dirs: { images: string; media: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-held-"));
  const keys = ["UB_IMAGES_DIR", "UB_MEDIA_DIR", "UB_MEDIA_INDEX_PATH", "UB_SHELL_PATH"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.UB_IMAGES_DIR = join(dir, "images");
  process.env.UB_MEDIA_DIR = join(dir, "media");
  process.env.UB_MEDIA_INDEX_PATH = join(dir, "media.json");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  resetHeldImagesClock();
  try {
    fn({ images: join(dir, "images"), media: join(dir, "media") });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetHeldImagesClock();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an image the folder refused earlier moves into the Library on the next load, under its own id", () => {
  withStores(() => {
    writeImage({ id: "img-held-1", mime: "image/png", b64: PNG.toString("base64"), prompt: "A lighthouse", provider: "openai", model: "gpt-image" });
    assert.deepEqual(drainHeldImages(), { moved: 1, failed: 0 });
    const entry = findMedia("img-held-1");
    assert.ok(entry);
    assert.equal(entry.botId, "bot-useful");
    assert.equal(entry.chatId, null);
    assert.equal(readMediaBytes("img-held-1").status, "ok");
    assert.deepEqual(legacyImageIds(), [], "the held record goes once the folder has the file");
  });
});

test("a held record whose bytes are not an image stays put and counts as a failure", () => {
  withStores(() => {
    writeImage({ id: "img-held-2", mime: "image/png", b64: Buffer.from("not an image at all").toString("base64"), prompt: "x", provider: "p", model: "m" });
    assert.deepEqual(drainHeldImages(), { moved: 0, failed: 1 });
    assert.deepEqual(legacyImageIds(), ["img-held-2"]);
  });
});

test("the drain runs at most once a minute", () => {
  withStores(() => {
    drainHeldImages(1_000_000);
    writeImage({ id: "img-held-3", mime: "image/png", b64: PNG.toString("base64"), prompt: "y", provider: "p", model: "m" });
    assert.deepEqual(drainHeldImages(1_030_000), { moved: 0, failed: 0 });
    assert.deepEqual(drainHeldImages(1_061_000), { moved: 1, failed: 0 });
  });
});

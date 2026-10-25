import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_DATA_URL,
  imageMediaType,
  isTextAttachment,
  safeAttachName,
  sniffImageType,
} from "../shared/attachments.ts";

test("safe attach names and text detection", () => {
  assert.equal(safeAttachName("notes.md"), "notes.md");
  assert.equal(isTextAttachment("notes.md", ""), true);
  assert.equal(isTextAttachment("shot.png", "image/png"), false);
  assert.throws(() => safeAttachName(".env"), /attachment_forbidden/);
});

test("images are told apart by bytes and by data URL shape", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(jpeg), "image/jpeg");
  assert.equal(sniffImageType(webp), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("#!/bin/sh\necho hi\n")), null);
  assert.equal(imageMediaType("shot.png", "application/octet-stream"), "image/png");
  assert.equal(imageMediaType("shot.JPG", ""), "image/jpeg");
  assert.equal(imageMediaType("notes.md", "text/markdown"), null);
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(IMAGE_DATA_URL.test(dataUrl), true);
  assert.equal(IMAGE_DATA_URL.test("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(IMAGE_DATA_URL.test("https://example.com/a.png"), false);
});

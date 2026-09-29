import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_COLORS,
  AVATAR_PALETTE,
  defaultFaceFor,
  isAvatarColor,
  isAvatarShape,
  randomFace,
} from "../shared/bot-face.ts";

test("avatar palette keeps legacy ids and tints only the approved mascot", () => {
  assert.deepEqual(Object.keys(AVATAR_PALETTE), [...AVATAR_COLORS]);
  assert.deepEqual(AVATAR_PALETTE.ink, { label: "Original", fill: "#FFFFFF" });
  for (const color of AVATAR_COLORS) {
    assert.match(AVATAR_PALETTE[color].fill, /^#[A-F0-9]{6}$/);
    assert.ok(AVATAR_PALETTE[color].label.length > 0);
  }
});

test("random faces always produce a known shape and color", () => {
  // The old signed-bitwise implementation produced negative indices for large
  // timestamps, which yielded undefined and made the Generate button a no-op.
  for (let index = 0; index < 500; index += 1) {
    const face = randomFace(Date.now() + index * 977);
    assert.ok(isAvatarShape(face.shape), `bad shape at ${index}: ${String(face.shape)}`);
    assert.ok(isAvatarColor(face.color), `bad color at ${index}: ${String(face.color)}`);
  }
});

test("faces match the native client's fixtures", () => {
  // Keep in step with macos FacePaletteTests.defaultFacesMatchTheWebImplementation.
  assert.deepEqual(defaultFaceFor("bot-scout"), { shape: "blob", color: "orange", image: null });
  assert.deepEqual(defaultFaceFor("bot-useful"), { shape: "drop", color: "ink", image: null });
  assert.deepEqual(defaultFaceFor("🙂".repeat(500)), { shape: "circle", color: "pink", image: null });
  assert.deepEqual(defaultFaceFor("~".repeat(1000)), { shape: "circle", color: "blue", image: null });
});

test("default faces derive from the bot id and stay valid", () => {
  // Long and non-BMP ids push the hash above 2^31, where the old signed shift
  // produced an undefined color.
  const ids = [
    "bot-useful",
    "0c2bf8f4-3979-4f5c-800a-c630eb4df4d5",
    "bot-🙂",
    "🙂".repeat(500),
    "~".repeat(1000),
    `bot-${"x".repeat(2000)}`,
  ];
  for (const id of ids) {
    const face = defaultFaceFor(id);
    assert.ok(isAvatarShape(face.shape), `bad shape for ${id.slice(0, 12)}`);
    assert.ok(isAvatarColor(face.color), `bad color for ${id.slice(0, 12)}`);
  }
});

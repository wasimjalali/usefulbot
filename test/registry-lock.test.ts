import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryFor, loadRegistry } from "../router/src/registry.ts";

test("registry package-lock hashes match the committed lockfile", () => {
  const entries = loadRegistry(join(process.cwd(), "package-lock.json"));
  assert.equal(entries.length, 2);
});

test("a lockfile whose hash does not match is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-registry-"));
  const lockPath = join(dir, "package-lock.json");
  writeFileSync(lockPath, "{}\n");
  assert.throws(() => loadRegistry(lockPath), /package-lock hash mismatch/);
});

test("unknown aliases are refused", () => {
  const entries = loadRegistry(join(process.cwd(), "package-lock.json"));
  assert.throws(() => entryFor(entries, "nope"), /unknown_alias/);
});

// Prints one sha256 over what a dev build is made from. macos/build-app.sh records it in
// the bundle when a dev build starts, and scripts/install-dev-app.sh refuses a bundle whose
// record is missing (the build failed) or differs from a fresh run (the tree moved on).
// package-lock.json is left out: eve restamps it on first boot (same rule as web-mode.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSymlink } from "./runtime-manifest.mjs";

const SOURCES = [
  "macos/Sources", "macos/Package.swift", "macos/Package.resolved", "macos/bundle", "macos/build-app.sh",
  "web/app", "web/lib", "web/next.config.ts", "web/tsconfig.json", "shared", "agent", "router/src", "router/package.json", "brand",
  "scripts", "package.json",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listed = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...SOURCES], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\0").filter(Boolean);

const files = [...new Set(listed)].filter((file) => lstatSync(path.join(root, file), { throwIfNoEntry: false })).sort();
const hash = createHash("sha256");
for (const file of files) {
  assertNoSymlink(root, file);
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(path.join(root, file)));
  hash.update("\0");
}
console.log(hash.digest("hex"));

#!/usr/bin/env node
// Writes sha256(package-lock.json) into every `evidence.packageLockHash` of
// shared/registry.json. The router refuses to serve when the two differ
// (router/src/registry.ts), so after every dependency change the order is:
// `npm install`, then this, then build.
//
//   node scripts/restamp-registry.mjs

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repo, "package-lock.json");
const registryPath = join(repo, "shared/registry.json");

const hash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
const before = readFileSync(registryPath, "utf8");
const entries = JSON.parse(before).entries;
if (!Array.isArray(entries) || entries.length === 0) throw new Error("shared/registry.json has no entries");

// The hash is replaced in place so the file keeps its own formatting.
const field = /("packageLockHash"\s*:\s*)"[0-9a-f]*"/g;
const found = before.match(field)?.length ?? 0;
if (found !== entries.length) {
  throw new Error(`expected ${entries.length} packageLockHash fields in shared/registry.json, found ${found}`);
}
const after = before.replace(field, `$1"${hash}"`);
const stamped = JSON.parse(after).entries;
if (!stamped.every((entry) => entry?.evidence?.packageLockHash === hash)) {
  throw new Error("restamp left an entry without the new hash");
}
if (after === before) {
  console.log(`shared/registry.json already carries ${hash}`);
} else {
  writeFileSync(registryPath, after);
  console.log(`shared/registry.json restamped: ${entries.length} entries now carry ${hash}`);
}

#!/usr/bin/env node
// The services a release app carries in Contents/Resources/runtime: the files
// router, web and eve read at runtime, their production dependencies and an
// official Node. The app copies this to ~/Library/Application Support/Useful
// Bot/app and runs it from there (macos/Sources/UsefulBotCore/RuntimeInstall.swift).
//
//   node scripts/build-runtime.mjs <out-dir> <version-stamp>
//
// Run after the web build (macos/build-app.sh does, when UB_RELEASE=1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.versions.node.split(".")[0] !== "24") {
  // npm builds native addons against the Node that runs it, and the runtime ships Node 24.
  process.stderr.write(`build-runtime needs Node 24, got ${process.versions.node}\n`);
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [out, stamp] = process.argv.slice(2);
if (!out || !stamp) {
  process.stderr.write("usage: build-runtime.mjs <out-dir> <version-stamp>\n");
  process.exit(2);
}

// The Node the services require (package.json engines), as nodejs.org ships it,
// and its tarball's SHA-256 from nodejs.org/dist/v24.11.1/SHASUMS256.txt. A
// pinned hash is authenticity, not only transit integrity: a changed download
// is refused even if the checksum file beside it changed too.
const NODE_VERSION = "24.11.1";
const NODE_DIST = `node-v${NODE_VERSION}-darwin-arm64`;
const NODE_SHA256 = "b05aa3a66efe680023f930bd5af3fdbbd542794da5644ca2ad711d68cbd4dc35";

// What the three services read at runtime. The web sources stay home: a
// release always serves its built web (scripts/web-mode.mjs), and the built
// server carries what it needs. Sources are copied from git's index only, so a
// stray untracked or ignored file (an `agent/.env`) can never ship.
const TRACKED = [
  "package.json",
  "package-lock.json",
  "scripts/service.mjs",
  "scripts/patch-eve.mjs",
  "scripts/setup-local.mjs",
  "scripts/web-mode.mjs",
  "shared",
  "agent",
  "router/src",
  "brand/source",
];
// Build output, not in git: copied whole, then scanned below.
const BUILT = "web/.next/standalone";
// Names that must never reach a published zip, outside third-party packages.
const SECRET = /^(\.env(\..*)?|.*\.env|\.envrc|\.netrc|\.pgpass|\.htpasswd|\.npmrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|p8|jks|keystore|token|gpg|asc|kubeconfig|tfvars|tfstate)|kubeconfig|terraform\.tfstate.*|secrets?(\..*)?|credentials?(\..*)?|client_secret.*|service-account.*\.json)$/i;

// Backup copies of a secret are secrets too: `prod.env.bak`, `id_rsa.orig`, `.tfstate~`,
// `key.pem.bak.1`, `prod.env.2026-09-29`. Stripped only for this test, never from a name.
const BACKUP_SUFFIX = /(\.(bak|backup|orig|old|save|swp|tmp)\d*|\.\d+|\.\d{4}-\d{2}-\d{2}|~)+$/i;
function looksSecret(name) {
  return SECRET.test(name) || SECRET.test(name.replace(BACKUP_SUFFIX, ""));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const target = path.resolve(out);
// The real path of the nearest folder that exists, so a symlink inside the
// checkout can't point the build (and its rmSync) somewhere outside it.
function realTarget(p) {
  let existing = p;
  while (!existsSync(existing)) existing = path.dirname(existing);
  return path.join(realpathSync(existing), path.relative(existing, p));
}
// A build stage lives in this checkout. Anywhere else (an installed runtime in
// Application Support, a home folder) is never cleared by a build.
if (!realTarget(target).startsWith(realpathSync(ROOT) + path.sep)) throw new Error(`${target} is outside the checkout; refusing to build a runtime there`);
// Only ever replace an earlier runtime, never an arbitrary folder given by mistake.
if (existsSync(target) && readdirSync(target).length > 0 && !existsSync(path.join(target, ".ub-runtime-version"))) {
  throw new Error(`${target} is not empty and is not an earlier runtime; refusing to delete it`);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const files = execFileSync("git", ["ls-files", "-z", "--", ...TRACKED], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
for (const item of TRACKED) {
  if (!files.some((file) => file === item || file.startsWith(`${item}/`))) throw new Error(`nothing tracked under ${item}`);
}
for (const file of files) {
  mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  cpSync(path.join(ROOT, file), path.join(target, file));
}
if (!existsSync(path.join(ROOT, BUILT))) throw new Error(`missing ${BUILT}: build the web first (npm run build:app)`);
cpSync(path.join(ROOT, BUILT), path.join(target, BUILT), { recursive: true, verbatimSymlinks: true });
// Next's standalone server.js is CommonJS. In the checkout the nearest
// package.json above it is Next's own `web/.next/package.json`, which says so;
// a runtime carries only the standalone folder, so the nearest one would be
// the root package.json ("type": "module") and the server would not start.
writeFileSync(path.join(target, BUILT, "web/package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);

function scanForSecrets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (looksSecret(entry.name)) throw new Error(`refusing to ship ${path.relative(target, full)}: it looks like a secret`);
    if (entry.isDirectory() && entry.name !== "node_modules") scanForSecrets(full);
  }
}
scanForSecrets(target);

// Production dependencies only, exactly as the lockfile pins them. The router
// refuses a lockfile whose hash changed, so the copy must stay byte-identical.
const lockBefore = sha256(path.join(target, "package-lock.json"));
execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: target,
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    // This Node's own npm, so native addons are built for Node 24.
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    npm_config_package_lock: "false",
    npm_config_save: "false",
  },
});
if (sha256(path.join(target, "package-lock.json")) !== lockBefore) throw new Error("npm ci changed package-lock.json");
// Next is only there for `next dev`, which a release never runs; the built web
// server carries its own copy. About 300 MB.
for (const dir of ["node_modules/next", "node_modules/@next"]) rmSync(path.join(target, dir), { recursive: true, force: true });
// Its bin link now points at nothing, and codesign refuses a dangling link.
// rmSync follows a link to decide, so a dangling one needs lstat and unlink.
const nextBin = path.join(target, "node_modules/.bin/next");
if (lstatSync(nextBin, { throwIfNoEntry: false })) unlinkSync(nextBin);

// The official Node, checked against the pinned hash.
const cache = path.join(ROOT, "macos/.build/node-dist");
mkdirSync(cache, { recursive: true });
const tarball = path.join(cache, `${NODE_DIST}.tar.gz`);
if (!existsSync(tarball)) execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", tarball, `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz`]);
if (sha256(tarball) !== NODE_SHA256) {
  rmSync(tarball, { force: true });
  throw new Error(`${NODE_DIST}.tar.gz does not match the pinned SHA-256`);
}
mkdirSync(path.join(target, "bin"), { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", path.join(target, "bin"), "--strip-components", "2", `${NODE_DIST}/bin/node`]);

writeFileSync(path.join(target, ".ub-runtime-version"), `${stamp}\n`);
process.stdout.write(`${JSON.stringify({ runtime: target, node: NODE_VERSION, stamp })}\n`);

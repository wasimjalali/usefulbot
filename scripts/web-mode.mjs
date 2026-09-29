import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything a web build is made from: the app, the shared code its routes
 * reach, and the brand palette `shared/bot-face.ts` imports.
 */
const SOURCE_DIRS = ["web/app", "web/lib", "shared", "agent", "router/src", "brand/source"];
// Not the lockfile: eve restamps it on its first boot, which would mark every
// build stale the moment the services started. package.json carries the
// versions a person chose.
const SOURCE_FILES = ["web/next.config.ts", "web/tsconfig.json", "package.json"];

export function standaloneServer(root) {
  return path.join(root, "web/.next/standalone/web/server.js");
}

function stampPath(root) {
  return path.join(root, "web/.next/ub-sources.sha256");
}

function filesUnder(target, out) {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) {
    out.push(target);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    // Symlinks are skipped, not followed: a link back up the tree would
    // never end, and nothing a route imports is reached through one.
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    filesUnder(path.join(target, entry.name), out);
  }
}

/**
 * A hash of the sources' contents and paths. Contents, not modified times: a
 * restored backup or a copy that keeps old times changes the code without
 * making any file look newer than the build.
 */
export function sourceFingerprint(root) {
  const files = [];
  for (const item of [...SOURCE_DIRS, ...SOURCE_FILES]) filesUnder(path.join(root, item), files);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Called by the app build once `next build` and the static copy have finished. */
export function stampBuild(root) {
  writeFileSync(stampPath(root), `${sourceFingerprint(root)}\n`);
}

/**
 * How the web service should run. This checkout is both where the code is
 * edited and what the installed app runs, so a production build is only served
 * while the sources still hash to what it was built from. Anything else runs
 * the dev server, which always reflects the files on disk, and says why.
 *
 * `next dev` costs about 270 MB and compiles each route on its first hit; the
 * built server is what `npm run build:app` leaves behind.
 */
export function webLaunch(root, env = process.env) {
  if (env.UB_WEB_MODE === "dev") return { mode: "dev", reason: "UB_WEB_MODE=dev" };
  const server = standaloneServer(root);
  const copied = ["web/.next/standalone/web/.next/static"];
  // A release runtime (scripts/build-runtime.mjs) carries only the built web
  // and no `next dev`, so there is nothing to compare and nothing to fall back
  // to: an incomplete one is a broken release, said loudly.
  if (existsSync(path.join(root, ".ub-runtime-version"))) {
    if (!existsSync(server) || !copied.every((item) => existsSync(path.join(root, item)))) {
      throw new Error("release runtime has no complete web build");
    }
    return { mode: "production", reason: "release_runtime", server };
  }
  if (!existsSync(server) || !existsSync(stampPath(root)) || !copied.every((item) => existsSync(path.join(root, item)))) {
    return { mode: "dev", reason: "web_build_missing" };
  }
  try {
    if (readFileSync(stampPath(root), "utf8").trim() !== sourceFingerprint(root)) {
      return { mode: "dev", reason: "web_build_stale" };
    }
  } catch (error) {
    // The dev server needs nothing from this check, so a tree that cannot be
    // read still gets a working service, with the reason in the log.
    return { mode: "dev", reason: `web_freshness_check_failed: ${error.message}` };
  }
  return { mode: "production", reason: "web_build_fresh", server };
}

// Real paths on both sides: a checkout reached through a symlink would
// otherwise never match, and the build would go unstamped without a word.
if (process.argv[2] === "--stamp" && process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  stampBuild(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}

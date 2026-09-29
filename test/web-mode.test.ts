import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error plain ESM launcher module, no types
import { stampBuild, webLaunch } from "../scripts/web-mode.mjs";

function put(root: string, file: string, body = "x"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "ub-web-mode-"));
  put(root, "web/app/route.ts");
  put(root, "shared/models.ts");
  put(root, "brand/source/avatar-palette.json", "{}");
  put(root, "package.json", "{}");
  put(root, "web/.next/standalone/web/server.js");
  put(root, "web/.next/standalone/web/.next/static/chunk.js");
  stampBuild(root);
  return root;
}

test("a build whose sources are unchanged is served", () => {
  const root = checkout();
  const launch = webLaunch(root, {});
  assert.equal(launch.mode, "production");
  assert.equal(launch.server, join(root, "web/.next/standalone/web/server.js"));
});

test("an edited source sends the service back to next dev, whatever its modified time says", () => {
  const root = checkout();
  put(root, "shared/models.ts", "changed");
  // A restored backup: new contents, a time older than the build.
  utimesSync(join(root, "shared/models.ts"), 1000, 1000);
  assert.deepEqual(webLaunch(root, {}), { mode: "dev", reason: "web_build_stale" });
});

test("the brand palette, package.json and a new file all count as sources", () => {
  for (const edit of ["brand/source/avatar-palette.json", "package.json", "web/lib/new.ts"]) {
    const root = checkout();
    put(root, edit, "changed");
    assert.equal(webLaunch(root, {}).reason, "web_build_stale", edit);
  }
});

test("touching a file without changing it keeps the build", () => {
  const root = checkout();
  utimesSync(join(root, "shared/models.ts"), 9_000_000_000, 9_000_000_000);
  assert.equal(webLaunch(root, {}).mode, "production");
});

test("no build, no stamp, or a build missing its copied folders runs next dev", () => {
  assert.deepEqual(webLaunch(mkdtempSync(join(tmpdir(), "ub-web-mode-")), {}), { mode: "dev", reason: "web_build_missing" });
  for (const gone of ["web/.next/ub-sources.sha256", "web/.next/standalone/web/.next/static"]) {
    const root = checkout();
    rmSync(join(root, gone), { recursive: true });
    assert.deepEqual(webLaunch(root, {}), { mode: "dev", reason: "web_build_missing" }, gone);
  }
});

test("a symlink that loops back up the tree is skipped, not followed", () => {
  const root = checkout();
  symlinkSync(root, join(root, "shared/loop"));
  assert.equal(webLaunch(root, {}).mode, "production");
});

test("UB_WEB_MODE=dev wins over a fresh build", () => {
  assert.deepEqual(webLaunch(checkout(), { UB_WEB_MODE: "dev" }), { mode: "dev", reason: "UB_WEB_MODE=dev" });
});

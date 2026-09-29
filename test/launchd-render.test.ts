import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lintPlist,
  renderLaunchdTemplates,
  renderPlist,
} from "../shared/launchd-render.ts";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

test("render substitutes roots and lints three plists", () => {
  const outDir = mkdtempSync(join(tmpdir(), "ub-launchd-"));
  const result = renderLaunchdTemplates({
    templatesDir: join(ROOT, "ops/launchd"),
    outDir,
    projectRoot: "/Users/wasim/useful-bot",
    stateRoot: "/Users/wasim/.useful-bot",
  });
  assert.equal(result.files.length, 3);
  const router = readFileSync(join(outDir, "com.usefulbot.router.plist"), "utf8");
  assert.match(router, /\/Users\/wasim\/useful-bot\/scripts\/service.mjs/);
  assert.match(router, /\/Users\/wasim\/\.useful-bot\/logs\/router.out.log/);
  assert.doesNotMatch(router, /@@/);
  assert.equal(lintPlist(router, "com.usefulbot.router").length, 0);
});

test("relative and home paths are refused", () => {
  assert.throws(() => renderPlist("@@PROJECT_ROOT@@", "relative", "/tmp/state"), /not_absolute/);
  assert.throws(() => renderPlist("@@PROJECT_ROOT@@", "/tmp/proj", "/tmp/~/state"), /unsafe/);
});

test("dot-dot segments are refused but dot-dot substrings are allowed", () => {
  assert.throws(() => renderPlist("@@PROJECT_ROOT@@", "/tmp/../etc", "/tmp/state"), /unsafe/);
  assert.doesNotThrow(() => renderPlist("@@PROJECT_ROOT@@", "/tmp/my..dir", "/tmp/state"));
});

test("XML-significant characters in roots are escaped", () => {
  const rendered = renderPlist("<string>@@PROJECT_ROOT@@</string>", "/tmp/R&D/<x>", "/tmp/state");
  assert.match(rendered, /\/tmp\/R&amp;D\/&lt;x&gt;/);
  assert.doesNotMatch(rendered, /<x>/);
});

test("symlinked roots are canonicalized to their real path", () => {
  const real = mkdtempSync(join(tmpdir(), "ub-launchd-real-"));
  const linkRoot = mkdtempSync(join(tmpdir(), "ub-launchd-link-"));
  const link = join(linkRoot, "link");
  symlinkSync(real, link);
  const canonical = realpathSync(real);
  const rendered = renderPlist("<string>@@PROJECT_ROOT@@</string>", link, join(linkRoot, "state"));
  assert.ok(rendered.includes(canonical), rendered);
  assert.ok(!rendered.includes(link), rendered);
});

test("rendered plists and their directory are owner-only", () => {
  const outDir = mkdtempSync(join(tmpdir(), "ub-launchd-mode-"));
  const result = renderLaunchdTemplates({
    templatesDir: join(ROOT, "ops/launchd"),
    outDir,
    projectRoot: "/Users/wasim/useful-bot",
    stateRoot: "/Users/wasim/.useful-bot",
  });
  assert.equal(statSync(outDir).mode & 0o777, 0o700);
  for (const file of result.files) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("unresolved placeholders fail", () => {
  assert.throws(
    () => renderPlist("<string>@@OTHER@@</string>", "/tmp/proj", "/tmp/state"),
    /unresolved/,
  );
});

test("lint catches a secret-like env key", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.usefulbot.web</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <string>/usr/local/bin/node</string>
  <string>/tmp/proj/scripts/service.mjs</string>
  <key>TOKEN</key><string>nope</string>
</dict></plist>`;
  const errors = lintPlist(xml, "com.usefulbot.web");
  assert.equal(errors.includes("secret_like"), true);
});

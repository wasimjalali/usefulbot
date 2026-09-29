#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE = "/usr/local/bin/node";
const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR !== 24 || NODE_MINOR < 11 || (NODE_MINOR === 11 && NODE_PATCH < 1)) {
  process.stderr.write(`verify-release refuses Node ${process.versions.node}, need >=24.11.1 <25\n`);
  process.exit(2);
}

function unitSuites() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const suites = (pkg.scripts?.test ?? "")
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => token.endsWith(".test.ts"));
  if (suites.length === 0) {
    throw new Error("unit_suites_unresolved");
  }
  return suites;
}

const TMP_ROOT = mkdtempSync(join(tmpdir(), "ub-release-"));
process.on("exit", () => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function tail(text) {
  if (!text) return "";
  return text.length > 4000 ? text.slice(-4000) : text;
}

function run(args, timeoutMs) {
  const result = spawnSync(NODE, args, {
    cwd: ROOT,
    env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

const steps = [];

function step(name, args, timeoutMs) {
  const result = run(args, timeoutMs);
  steps.push({ name, ...result });
  process.stderr.write(`${result.ok ? "PASS" : "FAIL"} ${name}\n`);
  if (!result.ok) {
    writeFileSync(join(ROOT, "release-verify.json"), `${JSON.stringify({ ok: false, steps, skipped: skipped() }, null, 2)}\n`);
    process.exit(1);
  }
}

function skipped() {
  return [
    "swift_macos_tests_linux",
    "live_glm_workhorse",
    "live_glm_reviewer",
    "launchctl_bootstrap",
    "seven_day_trial",
  ];
}

step("tsc", ["node_modules/typescript/bin/tsc", "--noEmit"], 60_000);
step("tsc_web", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "web/tsconfig.json"], 60_000);
step("tsc_router", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "router/tsconfig.json"], 60_000);
step("unit", [
  "--experimental-strip-types",
  "--test",
  "--test-timeout",
  "15000",
  ...unitSuites(),
], 360_000);
step("next_build", ["node_modules/next/dist/bin/next", "build", "web"], 180_000);
step("launchd_render", [
  "--experimental-strip-types",
  "scripts/render-launchd.mjs",
  "--project-root",
  ROOT,
  "--state-root",
  join(TMP_ROOT, "state"),
  "--out",
  join(TMP_ROOT, "launchd"),
], 15_000);

const report = {
  ok: true,
  node: process.versions.node,
  interpreter: process.execPath,
  steps,
  skipped: skipped(),
  sevenDayTrial: "not started; cannot complete on day one",
};
writeFileSync(join(ROOT, "release-verify.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, skipped: report.skipped })}\n`);

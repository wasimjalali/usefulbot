#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLaunchdTemplates } from "../shared/launchd-render.ts";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

if (process.argv.includes("--install")) {
  process.stderr.write("render-launchd refuses --install from this environment\n");
  process.exit(2);
}

const projectRoot = arg("project-root", ROOT);
const stateRoot = arg("state-root", join(homedir(), ".useful-bot"));
const outDir = arg("out", join(stateRoot, "launchd-rendered"));

const result = renderLaunchdTemplates({
  templatesDir: join(ROOT, "ops/launchd"),
  outDir,
  projectRoot,
  stateRoot,
});

const plutil = spawnSync("plutil", ["-lint", ...result.files], { encoding: "utf8" });
if (plutil.error?.code === "ENOENT") {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    linter: "node-fallback",
    warning: "plist_not_validated",
    detail: "plutil is unavailable; rendered plists passed node lint only",
    files: result.files,
  })}\n`);
  process.exit(0);
}
if (plutil.status !== 0) {
  process.stderr.write(`${plutil.stdout ?? ""}${plutil.stderr ?? ""}`);
  process.exit(plutil.status ?? 1);
}
process.stdout.write(`${JSON.stringify({ ok: true, linter: "plutil", files: result.files })}\n`);

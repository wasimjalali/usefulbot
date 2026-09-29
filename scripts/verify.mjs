#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR !== 24 || NODE_MINOR < 11 || (NODE_MINOR === 11 && NODE_PATCH < 1)) {
  process.stderr.write(`verify refuses to run: need Node >=24.11.1 <25, got ${process.versions.node}\n`);
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = "/usr/local/bin/node";
const require = createRequire(path.join(ROOT, "package.json"));

function log(message) {
  process.stderr.write(`${message}\n`);
}

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [file, ...args], {
      cwd: ROOT,
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: "inherit",
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function parseArgs(argv) {
  const options = { phase: argv[0], cases: [] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--case") options.cases.push(argv[++i]);
    else if (argv[i] === "--help") {
      process.stdout.write("Usage: verify.mjs phase0 [--case runtime|opencode|eve|sandbox]\n");
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (options.phase !== "phase0") {
    process.stderr.write(`verify.mjs in this PR only implements phase0, got ${options.phase}\n`);
    process.exit(2);
  }
  if (options.cases.length === 0) options.cases = ["runtime", "opencode", "eve", "sandbox"];
  return options;
}

function assert(condition, name, detail) {
  if (!condition) {
    throw new Error(`${name}: ${detail || "failed"}`);
  }
  log(`PASS ${name}`);
}

function caseRuntime() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert(process.execPath === NODE, "execPath", process.execPath);
  assert(Number(process.versions.node.split(".")[0]) === 24, "node-major", process.versions.node);
  assert(pkg.dependencies.eve === "0.54.3", "eve-pin", pkg.dependencies.eve);
  assert(pkg.dependencies.ai === "7.0.99", "ai-pin", pkg.dependencies.ai);
  assert(require("eve/package.json").version === "0.54.3", "eve-installed");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
  db.exec("INSERT INTO probe(body) VALUES ('fts5-ok')");
  const row = db.prepare("SELECT body FROM probe WHERE body MATCH 'fts5'").get();
  assert(row && row.body === "fts5-ok", "fts5");
  db.close();
  const startHelp = spawnHelp(["node_modules/eve/bin/eve.js", "start", "--help"]);
  return startHelp;
}

function spawnHelp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { cwd: ROOT, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`help exit ${code}`));
      else resolve(stdout);
    });
  });
}

function caseOpencode() {
  const resultsPath = path.join(ROOT, "spikes/s1/results.json");
  assert(existsSync(resultsPath), "s1-results-present");
  const data = JSON.parse(readFileSync(resultsPath, "utf8"));
  const records = data.records;
  assert(Array.isArray(records) && records.length === 12, "s1-record-count", String(records && records.length));
  const failed = records.filter((r) => r.status !== "PASS");
  assert(failed.length === 0, "s1-all-pass", JSON.stringify(failed));
  log("S1 certified live evidence accepted (12/12 PASS). Re-run spikes/s1/probe.mjs --live to refresh.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const name of options.cases) {
    log(`verify:phase0 --case ${name}`);
    if (name === "runtime") {
      const help = await caseRuntime();
      assert(help.includes("--host") && help.includes("--port"), "eve-start-bind-flags");
    } else if (name === "opencode") {
      caseOpencode();
    } else if (name === "eve") {
      const result = await run("spikes/s2/probe.mjs", []);
      if (result.code !== 0) process.exit(result.code ?? 1);
    } else if (name === "sandbox") {
      const result = await run("spikes/s3/probe.mjs", []);
      if (result.code !== 0) process.exit(result.code ?? 1);
    } else {
      process.stderr.write(`Unknown case: ${name}\n`);
      process.exit(2);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

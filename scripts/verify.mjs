#!/usr/bin/env node
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

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = { phase: argv[0], cases: [] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--case") options.cases.push(argv[++i]);
    else if (argv[i] === "--help") {
      process.stdout.write("Usage: verify.mjs phase0 [--case runtime|opencode]\n");
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
  if (options.cases.length === 0) options.cases = ["runtime", "opencode"];
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
  const pi = pkg.dependencies["@earendil-works/pi-coding-agent"];
  assert(/^\d+\.\d+\.\d+$/.test(pi ?? ""), "pi-pin", String(pi));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
  db.exec("INSERT INTO probe(body) VALUES ('fts5-ok')");
  const row = db.prepare("SELECT body FROM probe WHERE body MATCH 'fts5'").get();
  assert(row && row.body === "fts5-ok", "fts5");
  db.close();
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
      caseRuntime();
    } else if (name === "opencode") {
      caseOpencode();
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

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR !== 24) {
  process.stderr.write(`S3 probe refuses to run: Node 24 required, got ${process.versions.node}\n`);
  process.exit(2);
}

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPIKE_DIR, "..", "..");
const NODE = "/usr/local/bin/node";

function log(message) {
  process.stderr.write(`${message}\n`);
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { cwd: REPO_ROOT, env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function main() {
  mkdirSync(SPIKE_DIR, { recursive: true });
  const sandboxUrl = pathToFileURL(path.join(REPO_ROOT, "shared/sandbox.ts")).href;
  const { selectSandbox } = await import(sandboxUrl);
  const decision = selectSandbox();
  const tests = await run(["--experimental-strip-types", "--test", "spikes/s3/approvals.test.ts"]);
  const testsPass = tests.code === 0;
  const expectedNonVm = decision.backend === "just-bash" && decision.isolation === "non-vm" && decision.approvalRequired === true;
  const records = [
    {
      case: "backend-selection",
      status: expectedNonVm ? "PASS" : "FAIL",
      note: decision.reason,
      evidence: decision,
    },
    {
      case: "approval-enforcement",
      status: testsPass ? "PASS" : "FAIL",
      note: testsPass ? "deny, expiry, modified hash, replay and restart cases" : "see stderr",
      evidence: { code: tests.code, stdout: tests.stdout.slice(-1500), stderr: tests.stderr.slice(-1500) },
    },
    {
      case: "no-vm-claimed",
      status: decision.isolation === "non-vm" ? "PASS" : "UNVERIFIED",
      note: "in-memory just-bash is not a VM",
      evidence: { isolation: decision.isolation, backend: decision.backend },
    },
  ];
  const failures = records.filter((r) => r.status === "FAIL");
  const unverified = records.filter((r) => r.status === "UNVERIFIED");
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    records,
  };
  writeFileSync(path.join(SPIKE_DIR, "results.json"), `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(path.join(SPIKE_DIR, "REPORT.md"), [
    "# S3 spike report: sandbox backend and approval enforcement",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    "| Case | Status | Note |",
    "|---|---|---|",
    ...records.map((r) => `| ${r.case} | ${r.status} | ${r.note || ""} |`),
    "",
    "## Decision",
    "",
    "```json",
    JSON.stringify(decision, null, 2),
    "```",
    "",
    "just-bash is pinned with `autoInstall: false`. Production must not download a VM or a package as a silent fallback.",
    "",
  ].join("\n"));
  log(`S3 probe: ${records.length} records, ${records.length - failures.length - unverified.length} PASS, ${failures.length} FAIL, ${unverified.length} UNVERIFIED`);
  if (failures.length > 0) process.exitCode = 1;
}

main();

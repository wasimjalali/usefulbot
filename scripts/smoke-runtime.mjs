#!/usr/bin/env node
// Starts the router from a staged release runtime, copied under a path with a space
// like a user's "Application Support" folder, and fails unless /health/live answers.
// Usage: node scripts/smoke-runtime.mjs <stage-dir>
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!stage || !existsSync(path.join(stage, "bin/node"))) {
  process.stderr.write("usage: node scripts/smoke-runtime.mjs <stage-dir> (a staged runtime with bin/node)\n");
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const base = mkdtempSync(path.join(tmpdir(), "ub-smoke-"));
let child;
let output = "";
let failure = null;
try {
  const app = path.join(base, "Application Support", "app");
  const home = path.join(base, "home");
  const keychain = path.join(base, "keychain");
  mkdirSync(path.dirname(app), { recursive: true });
  mkdirSync(home);
  mkdirSync(keychain);
  cpSync(stage, app, { recursive: true, verbatimSymlinks: true });
  const node = path.join(app, "bin/node");

  // Seed a config with the staged setup script, its Keychain calls sent to a file stub.
  const seed = spawnSync(node, [
    "--import", path.join(ROOT, "test/fixtures/security-stub/hooks.mjs"),
    "scripts/setup-local.mjs",
  ], {
    cwd: app,
    env: {
      ...process.env,
      HOME: home,
      STUB_SECURITY_BIN: path.join(ROOT, "test/fixtures/security-stub/security.sh"),
      STUB_KEYCHAIN_DIR: keychain,
    },
    encoding: "utf8",
  });
  if (seed.status !== 0) throw new Error(`setup-local failed (exit ${seed.status}): ${seed.stderr}${seed.stdout}`);

  const port = await freePort();
  child = spawn(node, ["--experimental-strip-types", path.join(app, "router/src/index.ts")], {
    cwd: app,
    env: {
      ...process.env,
      HOME: home,
      UB_ROUTER_PORT: String(port),
      UB_ROUTER_CONFIG: path.join(home, ".useful-bot/config.json"),
      UB_ROUTER_DB: path.join(base, "usage.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const deadline = Date.now() + 15_000;
  let live = false;
  while (Date.now() < deadline && !live) {
    if (exited) throw new Error(`the router exited (${JSON.stringify(exited)}) before answering`);
    try {
      live = (await fetch(`http://127.0.0.1:${port}/health/live`)).status === 200;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!live) throw new Error("the router never answered /health/live within 15 s");
  process.stdout.write(`smoke ok: staged router answered /health/live from ${app}\n`);
} catch (error) {
  failure = error;
} finally {
  child?.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}
if (failure) {
  process.stderr.write(`smoke-runtime failed: ${failure.message}\n--- router output ---\n${output}\n`);
  process.exit(1);
}

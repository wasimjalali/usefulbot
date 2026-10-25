#!/usr/bin/env node
// Starts the router and the engine from a staged release runtime, copied under a path
// with a space like a user's "Application Support" folder, and fails unless the
// router's /health/live answers and the engine's /health reports its stack and Pi.
// Usage: node scripts/smoke-runtime.mjs <stage-dir>
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithSecrets } from "./service-secrets.mjs";

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
const children = [];
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

  // One service from the stage, its output kept for the failure report. `probe`
  // returns the answer once the service is up, or null while it is not.
  // Started the way service.mjs does: `secrets` go to its stdin for the staged preload to read, never into `env`.
  const start = async (name, entry, env, secrets, probe) => {
    const child = spawnWithSecrets(node, ["--experimental-strip-types", path.join(app, entry)], {
      cwd: app,
      env,
      secrets,
      preload: path.join(app, "scripts/secrets-preload.mjs"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    let exited = null;
    child.on("exit", (code, signal) => (exited = { code, signal }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`the ${name} exited (${JSON.stringify(exited)}) before answering`);
      try {
        const answer = await probe();
        if (answer !== null) return answer;
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`the ${name} never answered within 15 s`);
  };

  const port = await freePort();
  await start("router", "router/src/index.ts", {
    ...process.env,
    HOME: home,
    UB_ROUTER_PORT: String(port),
    UB_ROUTER_CONFIG: path.join(home, ".useful-bot/config.json"),
    UB_ROUTER_DB: path.join(base, "usage.sqlite"),
  }, {}, async () => ((await fetch(`http://127.0.0.1:${port}/health/live`)).status === 200 ? true : null));
  process.stdout.write(`smoke ok: staged router answered /health/live from ${app}\n`);

  // The engine the way service.mjs starts it: an explicit environment, never the caller's.
  const enginePort = await freePort();
  const health = await start("engine", "agent/server.ts", {
    PATH: process.env.PATH,
    HOME: home,
    UB_ROUTER_PORT: String(port),
    UB_ENGINE_PORT: String(enginePort),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: path.join(home, ".useful-bot/engine/pi"),
  }, {
    UB_ENGINE_TOKEN: "smoke-engine-token",
    UB_ROUTER_DESKTOP_TOKEN: "smoke-router-token",
  }, async () => {
    const res = await fetch(`http://127.0.0.1:${enginePort}/health`);
    return res.status === 200 ? await res.json() : null;
  });
  if (typeof health?.stack !== "string" || typeof health?.pi !== "string") {
    throw new Error(`the engine's /health lacks stack or pi: ${JSON.stringify(health)}`);
  }
  process.stdout.write(`smoke ok: staged engine answered /health (stack ${health.stack}, pi ${health.pi})\n`);
} catch (error) {
  failure = error;
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}
if (failure) {
  process.stderr.write(`smoke-runtime failed: ${failure.message}\n--- service output ---\n${output}\n`);
  process.exit(1);
}

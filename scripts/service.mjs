#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawnWithSecrets } from "./service-secrets.mjs";
import { webLaunch } from "./web-mode.mjs";
import { ownerPath } from "../shared/user-path.ts";
import { LOOPBACK, enforceStack, enginePort, keychainName, routerConfigPath, routerPort, stateRoot, webPort } from "../shared/stack.ts";

// The interpreter running this script, not a fixed path: the supervisor
// accepts more than one install location and launches this file with it.
const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
// Loaded first in every service; it reads the secrets run() writes to stdin.
const PRELOAD = path.join(ROOT, "scripts/secrets-preload.mjs");

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR !== 24 || NODE_MINOR < 11 || (NODE_MINOR === 11 && NODE_PATCH < 1)) {
  process.stderr.write(`service refuses Node ${process.versions.node}, need >=24.11.1 <25\n`);
  process.exit(2);
}

// Next reports usage to its vendor by default. The app promises no analytics
// (bot.usefulbuild.com/privacy), so every service and anything it spawns runs
// with it off. The engine sets Pi's own switches (SPEC 5.1).
process.env.NEXT_TELEMETRY_DISABLED = "1";

const KEYCHAIN_TIMEOUT_MS = 15_000;

// Read after the stack check in main(): a bad port or prefix is reported
// there, not thrown while the module loads.
const servicePorts = () => ({
  router: { host: LOOPBACK, port: routerPort() },
  engine: { host: LOOPBACK, port: enginePort() },
  web: { host: LOOPBACK, port: webPort() },
});

function fail(code, item) {
  process.stderr.write(`${JSON.stringify({ error: code, item })}\n`);
  process.exit(1);
}

function preflightPort(host, port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      reject(new Error(error && error.code === "EADDRINUSE" ? "port_in_use" : "port_check_failed"));
    });
    probe.listen(port, host, () => {
      probe.close(() => resolve());
    });
  });
}

function keychain(service) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out = "";
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timeout"));
    }, KEYCHAIN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(new Error("missing")));
    child.on("close", (status) => {
      const value = out.trim();
      // 44 is errSecItemNotFound: the item does not exist, as opposed to a
      // locked or refusing store, which callers must not mistake for "absent".
      if (status === 44) finish(new Error("not_found"));
      else if (status !== 0 || !value) finish(new Error("missing"));
      else finish(null, value);
    });
  });
}

/**
 * The environment the engine runs with, built key by key (SPEC 5.1): it holds
 * the owner's tools and credentials, so it never inherits `process.env`. Its
 * two tokens are not here: they reach it on stdin (`run`), because anything in
 * an exec environment is readable by every process of the same user. Pi's
 * switches keep it from reading `~/.pi`, checking for updates or reporting
 * usage, and `PI_CODING_AGENT_DIR` is the backstop for the one path Pi would
 * otherwise default to the home folder.
 */
const ENGINE_ENV_KEYS = [
  "HOME", "TMPDIR", "LANG", "TZ",
  "UB_STACK", "UB_STATE_ROOT", "UB_KEYCHAIN_PREFIX", "UB_MEDIA_DIR",
  "UB_ROUTER_PORT", "UB_WEB_PORT", "UB_ENGINE_PORT",
];

export function engineEnv() {
  const env = { PATH: ownerPath() };
  for (const key of ENGINE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: path.join(stateRoot(), "engine", "pi"),
  };
}

/** The router's environment and its secrets, kept apart: the secrets go to stdin (`run`). */
async function childEnv() {
  // launchd and the app bundle both hand this script the minimal system
  // PATH, so a service that shells out sees none of what the owner has
  // installed. `ownerPath` is the same answer the bash tool runs commands
  // with; resolving it here means one probe per service, not one per line.
  const env = {
    ...process.env,
    PATH: ownerPath(),
    NODE_ENV: process.env.NODE_ENV || "production",
  };
  const secrets = {};
  if (process.env.UB_SKIP_KEYCHAIN === "1") {
    return { env, secrets };
  }
  try {
    secrets.UB_OPENCODE_GO_KEY = await keychain(keychainName("opencode-go"));
  } catch (error) {
    // A fresh install has no OpenCode Go key: the owner connects a provider
    // in the app instead, and the router reports itself "limited" on
    // /health/live. Only a key that does not exist degrades; a locked or
    // refusing Keychain still stops the service.
    if (error.message !== "not_found") fail("credential_store_locked_or_missing", keychainName("opencode-go"));
    process.stderr.write(`${JSON.stringify({ service: mode, warning: "credential_missing", item: keychainName("opencode-go") })}\n`);
  }
  return { env, secrets };
}

// `env` is the child's exec environment and holds no secret; `secrets` is the
// one JSON object it reads from stdin before its first line runs.
function run(args, env, secrets) {
  const child = spawnWithSecrets(NODE, args, { cwd: ROOT, env, secrets, preload: PRELOAD });
  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => {
    // A long-running service that ends on its own is a failure even with
    // status 0: a no-op entry point once looked like a clean exit here, and
    // the supervisor restarted it every 15 s without a word.
    if (code === 0 && !stopping) {
      process.stderr.write(`${JSON.stringify({ error: "service_exited_unexpectedly", mode, args: args.at(-1) })}\n`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

async function waitReady(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail("dependency_unavailable", url);
}

async function main() {
  // The dev stack is refused before anything is read, bound or launched.
  enforceStack(mode ?? "service");
  if (!existsSync(NODE)) fail("interpreter_missing", NODE);
  const target = servicePorts()[mode];
  if (target) {
    try {
      await preflightPort(target.host, target.port);
    } catch (error) {
      fail(error.message, `${target.host}:${target.port}`);
    }
  }
  if (mode === "router") {
    const { env, secrets } = await childEnv();
    if (!env.UB_ROUTER_CONFIG) {
      env.UB_ROUTER_CONFIG = routerConfigPath();
    }
    run(["--experimental-strip-types", path.join(ROOT, "router/src/index.ts")], env, secrets);
    return;
  }
  if (mode === "engine") {
    await waitReady(`http://${LOOPBACK}:${routerPort()}/health/live`, 60_000);
    const secrets = {};
    try {
      secrets.UB_ENGINE_TOKEN = await keychain(keychainName("channel.desktop"));
    } catch {
      fail("credential_store_locked_or_missing", keychainName("channel.desktop"));
    }
    try {
      secrets.UB_ROUTER_DESKTOP_TOKEN = await keychain(keychainName("router.desktop"));
    } catch {
      fail("credential_store_locked_or_missing", keychainName("router.desktop"));
    }
    run(["--experimental-strip-types", path.join(ROOT, "agent/server.ts")], engineEnv(), secrets);
    return;
  }
  if (mode === "web") {
    const env = {
      ...process.env,
      PATH: ownerPath(),
      UB_ROUTER_CONFIG: routerConfigPath(),
    };
    const secrets = {};
    try {
      // The bearer the web service presents to the engine (the same item the
      // engine reads), for the chat routes and the internal calls.
      secrets.UB_ENGINE_TOKEN = await keychain(keychainName("channel.desktop"));
    } catch {
      fail("credential_store_locked_or_missing", keychainName("channel.desktop"));
    }
    // Regenerate on a lost image draws through the router's image alias,
    // the same credential the agent's generate_image uses. Without it only
    // that button fails (and says so); the rest of the app runs.
    try {
      secrets.UB_ROUTER_DESKTOP_TOKEN = await keychain(keychainName("router.desktop"));
    } catch {
      process.stderr.write(`${JSON.stringify({ service: "web", warning: "router_token_missing", item: keychainName("router.desktop") })}\n`);
    }
    const launch = webLaunch(ROOT);
    process.stderr.write(`${JSON.stringify({ service: "web", mode: launch.mode, reason: launch.reason })}\n`);
    if (launch.mode === "production") {
      // The standalone server reads its address from the environment.
      const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
      run([launch.server], {
        ...env,
        NODE_ENV: "production",
        HOSTNAME: LOOPBACK,
        PORT: String(webPort()),
        // Unset rather than "undefined" when package.json names no version.
        ...(typeof version === "string" && version ? { UB_APP_VERSION: version } : {}),
      }, secrets);
      return;
    }
    run([
      path.join(ROOT, "node_modules/next/dist/bin/next"),
      "dev",
      path.join(ROOT, "web"),
      "--hostname",
      LOOPBACK,
      "--port",
      String(webPort()),
    ], env, secrets);
    return;
  }
  process.stderr.write("usage: service.mjs router|engine|web\n");
  process.exit(2);
}

// Imported by a test, which must not start a service.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

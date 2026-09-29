#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { webLaunch } from "./web-mode.mjs";
import { ownerPath } from "../shared/user-path.ts";

// The interpreter running this script, not a fixed path: the supervisor
// accepts more than one install location and launches this file with it.
const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR !== 24 || NODE_MINOR < 11 || (NODE_MINOR === 11 && NODE_PATCH < 1)) {
  process.stderr.write(`service refuses Node ${process.versions.node}, need >=24.11.1 <25\n`);
  process.exit(2);
}

// eve's CLI and Next both report usage to their vendors by default. The app
// promises no analytics (bot.usefulbuild.com/privacy), so every service and
// anything it spawns (eve flushes from a detached child) runs with both off.
process.env.EVE_TELEMETRY_DISABLED = "1";
process.env.NEXT_TELEMETRY_DISABLED = "1";

const KEYCHAIN_TIMEOUT_MS = 15_000;

const SERVICE_PORTS = {
  router: { host: "127.0.0.1", port: 4319 },
  eve: { host: "127.0.0.1", port: 4321 },
  web: { host: "127.0.0.1", port: 4320 },
};

function fail(code, item) {
  process.stderr.write(`${JSON.stringify({ error: code, item })}\n`);
  process.exit(1);
}

// The reviewer credential arrived after the first installs. A service must
// still boot without it: the review tool and the reviewer subagent answer
// reviewer_unconfigured per call, so the miss is logged once here instead of
// taking chat down with it.
async function reviewerToken() {
  try {
    return await keychain("com.usefulbot.router.reviewer");
  } catch {
    process.stderr.write(`${JSON.stringify({
      warn: "reviewer_unconfigured",
      item: "com.usefulbot.router.reviewer",
      hint: "run scripts/setup-local.mjs --add-missing, then restart the services",
    })}\n`);
    return null;
  }
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

function signChannelJwt(secret, sub) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iss: "useful-bot",
    aud: "useful-bot",
    iat: now,
    exp: now + 12 * 60 * 60,
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

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
  if (process.env.UB_SKIP_KEYCHAIN === "1") {
    return env;
  }
  try {
    env.UB_OPENCODE_GO_KEY = await keychain("com.usefulbot.opencode-go");
  } catch (error) {
    // A fresh install has no OpenCode Go key: the owner connects a provider
    // in the app instead, and the router reports itself "limited" on
    // /health/live. Only a key that does not exist degrades; a locked or
    // refusing Keychain still stops the service.
    if (error.message !== "not_found") fail("credential_store_locked_or_missing", "com.usefulbot.opencode-go");
    delete env.UB_OPENCODE_GO_KEY;
    process.stderr.write(`${JSON.stringify({ service: mode, warning: "credential_missing", item: "com.usefulbot.opencode-go" })}\n`);
  }
  return env;
}

function run(args, env) {
  const child = spawn(NODE, args, { cwd: ROOT, env, stdio: "inherit" });
  const stop = () => {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => process.exit(code ?? 1));
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
  if (!existsSync(NODE)) fail("interpreter_missing", NODE);
  const target = SERVICE_PORTS[mode];
  if (target) {
    try {
      await preflightPort(target.host, target.port);
    } catch (error) {
      fail(error.message, `${target.host}:${target.port}`);
    }
  }
  if (mode === "router") {
    const env = await childEnv();
    if (!env.UB_ROUTER_CONFIG) {
      env.UB_ROUTER_CONFIG = path.join(process.env.HOME ?? "", ".useful-bot/config.json");
    }
    run(["--experimental-strip-types", path.join(ROOT, "router/src/index.ts")], env);
    return;
  }
  if (mode === "eve") {
    await waitReady("http://127.0.0.1:4319/health/live", 60_000);
    const env = {
      ...process.env,
      PATH: ownerPath(),
      NODE_ENV: process.env.NODE_ENV || "production",
    };
    try {
      env.UB_CHANNEL_JWT_SECRET = await keychain("com.usefulbot.channel.desktop");
    } catch {
      fail("credential_store_locked_or_missing", "com.usefulbot.channel.desktop");
    }
    try {
      env.UB_ROUTER_DESKTOP_TOKEN = await keychain("com.usefulbot.router.desktop");
    } catch {
      fail("credential_store_locked_or_missing", "com.usefulbot.router.desktop");
    }
    const reviewer = await reviewerToken();
    if (reviewer) env.UB_ROUTER_REVIEWER_TOKEN = reviewer;
    else delete env.UB_ROUTER_REVIEWER_TOKEN;
    // Lets an agent tool wake the handoff pump at once instead of waiting for
    // the next web poll. Best effort: the poll drains the same queue.
    env.UB_WEB_BASE_URL = process.env.UB_WEB_BASE_URL || "http://127.0.0.1:4320";
    run([path.join(ROOT, "node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--host", "127.0.0.1", "--port", "4321"], env);
    return;
  }
  if (mode === "web") {
    const env = {
      ...process.env,
      PATH: ownerPath(),
      UB_ROUTER_CONFIG: process.env.UB_ROUTER_CONFIG ?? path.join(process.env.HOME ?? "", ".useful-bot/config.json"),
    };
    try {
      const secret = await keychain("com.usefulbot.channel.desktop");
      env.UB_CHANNEL_JWT = signChannelJwt(secret, "desktop-app");
      // The agent tool wakes the handoff pump with the raw secret as its key
      // (see shared/agents-send.ts). Without it here every wake-up would 403
      // and only the UI poll would drain the queue.
      env.UB_CHANNEL_JWT_SECRET = secret;
    } catch {
      fail("credential_store_locked_or_missing", "com.usefulbot.channel.desktop");
    }
    // Regenerate on a lost image draws through the router's image alias,
    // the same credential the agent's generate_image uses. Without it only
    // that button fails (and says so); the rest of the app runs.
    try {
      env.UB_ROUTER_DESKTOP_TOKEN = await keychain("com.usefulbot.router.desktop");
    } catch {
      delete env.UB_ROUTER_DESKTOP_TOKEN;
      process.stderr.write(`${JSON.stringify({ service: "web", warning: "router_token_missing", item: "com.usefulbot.router.desktop" })}\n`);
    }
    // The web reviewer route runs the same alias as the agent's review tool.
    const reviewer = await reviewerToken();
    if (reviewer) env.UB_ROUTER_REVIEWER_TOKEN = reviewer;
    else delete env.UB_ROUTER_REVIEWER_TOKEN;
    const launch = webLaunch(ROOT);
    process.stderr.write(`${JSON.stringify({ service: "web", mode: launch.mode, reason: launch.reason })}\n`);
    if (launch.mode === "production") {
      // The standalone server reads its address from the environment.
      const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
      run([launch.server], {
        ...env,
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: "4320",
        // Unset rather than "undefined" when package.json names no version.
        ...(typeof version === "string" && version ? { UB_APP_VERSION: version } : {}),
      });
      return;
    }
    run([
      path.join(ROOT, "node_modules/next/dist/bin/next"),
      "dev",
      path.join(ROOT, "web"),
      "--hostname",
      "127.0.0.1",
      "--port",
      "4320",
    ], env);
    return;
  }
  process.stderr.write("usage: service.mjs router|eve|web\n");
  process.exit(2);
}

main();

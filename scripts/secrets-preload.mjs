// Loaded first in every service (`node --import scripts/secrets-preload.mjs ...`).
//
// When UB_SECRETS_ON_STDIN=1 is in the environment (set by
// scripts/service-secrets.mjs and by the fork wrapper below, and removed here
// once seen), reads one JSON object of secrets from stdin until EOF and puts
// them in `process.env`. Without the marker it does nothing and never touches
// stdin: a node descendant that merely inherits `--import <this file>` (Next
// builds its NODE_OPTIONS from process.execArgv) must not wait on a stdin its
// parent never closes. Values set at runtime are not in the kernel's copy of
// the exec environment, which any process of the same user can read on macOS
// (`ps -E`, KERN_PROCARGS2), so the service has its secrets and a shell line
// the bot runs cannot see them. Empty input is fine (no secrets).
//
// Then it keeps them out of the service's children. Every child_process call
// made here drops these names from the environment it hands on (the default
// is a copy of `process.env`, which now holds them). A forked node child, such
// as Next's dev server, gets them through its own stdin the same way instead.
// A worker_threads Worker gets an env without them, and one that shares the
// real environment is refused: `--import` does not run inside a worker, so its
// own child_process could not be wrapped.
//
// What this does not cover: assigning to `process.env` calls setenv(), so the
// process's C environ holds the secrets. A native spawner (process.execve, a
// native addon, Turbopack's Rust workers under `next dev`) hands that environ
// to its child, and the child's exec environment then has them. Only calls
// made through node's child_process are cleaned.
import childProcess from "node:child_process";
import { readSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isatty } from "node:tty";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import workerThreads from "node:worker_threads";

const MARKER = "UB_SECRETS_ON_STDIN";

function die(error) {
  process.stderr.write(`${JSON.stringify({ service: "secrets-preload", error })}\n`);
  process.exit(2);
}

// Synchronous, so the secrets are set before the first line of the service
// runs. A pipe can report EAGAIN while the writer has not written yet.
function readStdin() {
  if (isatty(0)) return "";
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  const deadline = Date.now() + 10_000;
  for (;;) {
    let count;
    try {
      count = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EOF") break;
      if (error.code === "EAGAIN" && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      die("secrets_unreadable");
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parse(text) {
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    die("secrets_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) die("secrets_invalid");
  for (const [key, secret] of Object.entries(value)) {
    if (!/^UB_[A-Z0-9_]+$/.test(key) || typeof secret !== "string") die("secrets_invalid");
  }
  return value;
}

// The marker is not a secret, but it must not outlive this read: a child that
// inherited it would wait on its stdin.
const handedSecrets = process.env[MARKER] === "1";
delete process.env[MARKER];
const secrets = handedSecrets ? parse(readStdin()) : {};
const names = Object.keys(secrets);
for (const name of names) process.env[name] = secrets[name];

const isOptions = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `env` (default: this process's) without the secret names, plus the secrets it held. */
function split(env) {
  const source = env ?? process.env;
  const held = {};
  for (const name of names) {
    if (name in source && source[name] !== undefined) held[name] = source[name];
  }
  if (Object.keys(held).length === 0) return { env, held };
  const rest = { ...source };
  for (const name of names) delete rest[name];
  return { env: rest, held };
}

/**
 * `args` with the options slot's env stripped. The slot is found by position:
 * after the command, and after the args array when the call has one (a null or
 * undefined args slot counts as that array). A slot that exists and holds
 * null or undefined is replaced, never shifted, so a callback after it stays
 * in place; a call with no slot at all gets the options added.
 */
function stripped(args, hasArgsArray) {
  const out = [...args];
  let at = 1;
  if (hasArgsArray && out.length > 1 && (Array.isArray(out[at]) || out[at] == null)) at += 1;
  const slot = out[at];
  const { env, held } = split(isOptions(slot) ? slot.env : undefined);
  if (Object.keys(held).length === 0) return out;
  if (isOptions(slot)) out[at] = { ...slot, env };
  else if (at < out.length && slot == null) out[at] = { env };
  else out.splice(Math.min(at, out.length), 0, { env });
  return out;
}

/** Writes `held` to the child's stdin and closes it. A child that cannot get its secrets must not run on without them. */
function handOver(child, held) {
  child.stdin.on("error", (error) => {
    if (error.code === "EPIPE") return; // the child is already gone; its exit says so
    process.stderr.write(`${JSON.stringify({ service: "secrets-preload", error: "secrets_handoff_failed", code: error.code })}\n`);
    child.kill("SIGKILL");
  });
  child.stdin.end(`${JSON.stringify(held)}\n`);
}

if (names.length > 0) {
  for (const [name, hasArgsArray] of [["spawn", true], ["spawnSync", true], ["execFile", true], ["execFileSync", true], ["exec", false], ["execSync", false]]) {
    const original = childProcess[name];
    const wrapped = (...args) => original(...stripped(args, hasArgsArray));
    if (original[promisify.custom]) {
      wrapped[promisify.custom] = (...args) => original[promisify.custom](...stripped(args, hasArgsArray));
    }
    childProcess[name] = wrapped;
  }

  const preload = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const originalFork = childProcess.fork;
  childProcess.fork = (modulePath, ...rest) => {
    const args = Array.isArray(rest[0]) ? rest.shift() : rest[0] == null && rest.length > 0 ? (rest.shift(), []) : [];
    const options = isOptions(rest[0]) ? rest[0] : {};
    const { env, held } = split(options.env);
    if (Object.keys(held).length === 0) return originalFork(modulePath, args, options);
    // The child gets what it held on its stdin, read by this same preload. A
    // caller that asked for a piped stdin wants to write to it: refuse, loudly.
    let stdio = options.stdio;
    const first = typeof stdio === "string" ? stdio : Array.isArray(stdio) ? stdio[0] : undefined;
    if (first !== undefined && first !== "inherit" && first !== "ignore") {
      throw new Error(`fork cannot hand secrets to a child whose stdin the caller owns (stdin: ${String(first)}); use "inherit", "ignore" or leave stdio unset`);
    }
    if (stdio === undefined) stdio = options.silent ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "inherit", "inherit", "ipc"];
    else if (typeof stdio === "string") stdio = ["pipe", stdio, stdio, "ipc"];
    else stdio = ["pipe", stdio[1] ?? "inherit", stdio[2] ?? "inherit", ...stdio.slice(3), ...(stdio.includes("ipc") ? [] : ["ipc"])];
    const execArgv = [...(options.execArgv ?? process.execArgv)];
    if (!execArgv.includes(preload)) execArgv.push("--import", preload);
    const child = originalFork(modulePath, args, { ...options, env: { ...env, [MARKER]: "1" }, stdio, execArgv });
    handOver(child, held);
    return child;
  };

  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class Worker extends OriginalWorker {
    constructor(filename, options) {
      if (options?.env === workerThreads.SHARE_ENV) {
        throw new Error("a Worker that shares the process environment would hold the secrets; give it its own env");
      }
      const { env, held } = split(options?.env);
      super(filename, Object.keys(held).length > 0 ? { ...options, env } : options);
    }
  };
  syncBuiltinESMExports();
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** The shipped entry, `node --experimental-strip-types agent/server.ts`, as the supervisor runs it. */

const ENTRY = fileURLToPath(new URL("../../agent/server.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

type Run = { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function run(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk) => { out += String(chunk); });
  child.stderr?.on("data", (chunk) => { err += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

async function healthy(port: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json() as Record<string, unknown>;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("engine did not come up");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("it comes up, answers /health with the Pi version and stops on SIGTERM", async () => {
  const state = mkdtempSync(join(tmpdir(), "ub-engine-proc-"));
  const port = await freePort();
  const engine = run({
    UB_STATE_ROOT: state,
    HOME: state,
    UB_ENGINE_PORT: String(port),
    UB_ROUTER_PORT: String(await freePort()),
    UB_ENGINE_TOKEN: "process-token",
    UB_ROUTER_DESKTOP_TOKEN: "process-router-token",
  });
  try {
    const health = await healthy(port, 20_000);
    assert.equal(health.ok, true);
    assert.equal(health.stack, "daily");
    assert.match(String(health.pi), /^\d+\.\d+\.\d+/);
    // /health answers at once; every other route is 503 `engine_starting` until boot has finished.
    let status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: "Bearer process-token" } });
    for (const deadline = Date.now() + 20_000; status.status === 503 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: "Bearer process-token" } });
    }
    assert.equal(status.status, 200);
    // /health may answer before boot has an engine (epoch null then); once /status
    // is up, both name the same epoch.
    const booted = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { epoch: string | null };
    assert.equal(typeof booted.epoch, "string");
    assert.equal((await status.json() as { epoch: string }).epoch, booted.epoch);
    assert.match(engine.stdout(), /"event":"listening"/);
    assert.equal(engine.stdout().includes("process-token"), false, "no token in the log");

    const started = Date.now();
    engine.child.kill("SIGTERM");
    const ended = await engine.exited;
    assert.equal(ended.code, 0);
    assert.ok(Date.now() - started < 10_000, "within the ten seconds the spec allows");
  } finally {
    if (engine.child.exitCode === null) engine.child.kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  }
});

test("without its tokens it exits 2 with one JSON line and never listens", async () => {
  const state = mkdtempSync(join(tmpdir(), "ub-engine-proc-"));
  const port = await freePort();
  const engine = run({ UB_STATE_ROOT: state, HOME: state, UB_ENGINE_PORT: String(port) });
  try {
    const ended = await engine.exited;
    assert.equal(ended.code, 2);
    const line = JSON.parse(engine.stderr().trim().split("\n").filter((text) => text.startsWith("{")).at(-1) as string) as Record<string, unknown>;
    assert.deepEqual(line, { service: "engine", error: "tokens_missing", missing: ["UB_ENGINE_TOKEN", "UB_ROUTER_DESKTOP_TOKEN"] });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), "nothing listened");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("a second engine on the same port refuses to start", async () => {
  const state = mkdtempSync(join(tmpdir(), "ub-engine-proc-"));
  const port = await freePort();
  const env = { UB_STATE_ROOT: state, HOME: state, UB_ENGINE_PORT: String(port), UB_ROUTER_PORT: String(await freePort()), UB_ENGINE_TOKEN: "t", UB_ROUTER_DESKTOP_TOKEN: "r" };
  const first = run(env);
  try {
    await healthy(port, 20_000);
    const second = run(env);
    const ended = await second.exited;
    assert.equal(ended.code, 1);
    assert.match(second.stderr(), /"error":"port_in_use"/);
    assert.equal((await healthy(port, 2_000)).ok, true, "the first is untouched");
  } finally {
    first.child.kill("SIGTERM");
    await first.exited;
    rmSync(state, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirLock } from "../shared/dir-lock.ts";

const LIB = join(process.cwd(), "shared/dir-lock.ts");
const opts = (timeoutMs: number) => ({ timeoutMs, errorCode: "test_locked" });
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-lock-"));
  return { dir, lock: join(dir, "x.lock") };
};

function child(dir: string, name: string, body: string) {
  const script = join(dir, `${name}.ts`);
  writeFileSync(script, `import { appendFileSync } from "node:fs";\nimport { acquireDirLock } from ${JSON.stringify(LIB)};\n${body}`);
  const proc = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, exited };
}

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(path); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(path), true, `${path} never appeared`);
}

test("two processes contending run their critical sections strictly one at a time", async () => {
  const { dir, lock } = fresh();
  const log = join(dir, "log.txt");
  const body = `
    for (let i = 0; i < 4; i += 1) {
      const release = acquireDirLock(${JSON.stringify(lock)}, { timeoutMs: 20000, errorCode: "locked" });
      appendFileSync(${JSON.stringify(log)}, "enter " + process.pid + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 60));
      appendFileSync(${JSON.stringify(log)}, "exit " + process.pid + "\\n");
      release();
    }
  `;
  const exits = await Promise.all([child(dir, "a", body).exited, child(dir, "b", body).exited, child(dir, "c", body).exited]);
  assert.deepEqual(exits, [0, 0, 0]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 24);
  lines.forEach((line, at) => assert.ok(line.startsWith(at % 2 === 0 ? "enter" : "exit"), lines.join(" | ")));
  for (let at = 0; at < lines.length; at += 2) assert.equal(lines[at].split(" ")[1], lines[at + 1].split(" ")[1]);
});

test("a holder killed with SIGKILL mid-section frees the lock at once, with no stale wait", async () => {
  const { dir, lock } = fresh();
  const held = join(dir, "held");
  const holder = child(dir, "holder", `
    acquireDirLock(${JSON.stringify(lock)}, { timeoutMs: 5000, errorCode: "locked" });
    appendFileSync(${JSON.stringify(held)}, "1");
    await new Promise((resolve) => setTimeout(resolve, 60000));
  `);
  await waitFor(held);
  holder.proc.kill("SIGKILL");
  await holder.exited;
  const started = Date.now();
  const release = acquireDirLock(lock, opts(5000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  release();
});

test("a live holder that never releases makes the waiter throw the locked error within the deadline", async () => {
  const { dir, lock } = fresh();
  const held = join(dir, "held");
  const holder = child(dir, "holder", `
    acquireDirLock(${JSON.stringify(lock)}, { timeoutMs: 5000, errorCode: "locked" });
    appendFileSync(${JSON.stringify(held)}, "1");
    await new Promise((resolve) => setTimeout(resolve, 60000));
  `);
  try {
    await waitFor(held);
    const started = Date.now();
    assert.throws(() => acquireDirLock(lock, opts(400)), /test_locked/);
    const took = Date.now() - started;
    assert.ok(took >= 300 && took < 2000, `took ${took} ms`);
  } finally {
    holder.proc.kill("SIGKILL");
    await holder.exited;
  }
});

test("re-entering a lock this process holds fails loudly instead of deadlocking", () => {
  const { lock } = fresh();
  const release = acquireDirLock(lock, opts(2000));
  const started = Date.now();
  assert.throws(() => acquireDirLock(lock, opts(2000)), /dir_lock_reentered/);
  assert.ok(Date.now() - started < 500);
  release();
  // Released: it can be taken again, and releasing twice is harmless.
  const again = acquireDirLock(lock, opts(2000));
  again();
  again();
});

test("a leftover directory from the old lock is ignored and does not block", () => {
  const { lock } = fresh();
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, token: "old" }));
  const started = Date.now();
  acquireDirLock(lock, opts(2000))();
  assert.ok(Date.now() - started < 500);
  assert.equal(existsSync(lock), true, "left alone");
});

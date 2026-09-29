import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

// The runtime lives under "Application Support" on a user's Mac, so the path has a space.
function stageApp(indexSource?: string) {
  const base = mkdtempSync(join(tmpdir(), "ub-entry-"));
  const app = join(base, "Application Support", "app");
  mkdirSync(app, { recursive: true });
  for (const name of ["router", "shared", "package-lock.json"]) cpSync(join(ROOT, name), join(app, name), { recursive: true });
  if (indexSource !== undefined) writeFileSync(join(app, "router/src/index.ts"), indexSource);
  const future = new Date(Date.now() + 86400_000).toISOString();
  const configPath = join(base, "config.json");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: false,
    tailnet: null,
    sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [
      { id: "d", kind: "router", sha256: createHash("sha256").update("entry-token").digest("hex"), callerId: "desktop", profile: "desktop", expiresAt: future, revokedAt: null },
    ],
  }));
  return { base, app, configPath };
}

async function runRouter(indexSource: string | undefined, waitMs: number) {
  const { base, app, configPath } = stageApp(indexSource);
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "router/src/index.ts"], {
    cwd: app,
    env: {
      ...process.env,
      HOME: base,
      UB_ROUTER_PORT: String(port),
      UB_ROUTER_CONFIG: configPath,
      UB_ROUTER_DB: join(base, "usage.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exit: number | null | undefined;
  child.on("exit", (code) => (exit = code));
  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (exit !== undefined) return { status: null as number | null, exit, output };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/live`);
        return { status: res.status, exit, output };
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { status: null, exit, output };
  } finally {
    child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
}

test("the router starts when run from a path with a space", async () => {
  const result = await runRouter(undefined, 10_000);
  assert.equal(result.status, 200, `router did not answer /health/live (exit ${result.exit}): ${result.output}`);
});

test("the old entry guard never starts under a path with a space (the test can fail)", async () => {
  // The entry guard as it shipped in 1.0.0 to 1.0.2 (d1c60e7^), kept as a
  // fixture: `main` has carried the fix since #165.
  const old = readFileSync(join(ROOT, "test/fixtures/router-index-pre-fix.ts.txt"), "utf8");
  const result = await runRouter(old, 5_000);
  assert.equal(result.status, null, "the old guard unexpectedly served");
  assert.equal(result.exit, 0, "the old guard should exit 0 without listening");
});

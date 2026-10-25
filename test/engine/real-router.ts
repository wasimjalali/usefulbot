import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRouter } from "../../router/src/index.ts";

/**
 * The real Useful Bot router, in this process, with a fake upstream behind it.
 * Used where the question is whether the router accepts what Pi sends.
 */

export type RealRouter = {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  token: string;
  close(): Promise<void>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function startRealRouter(upstreamBase: string): Promise<RealRouter> {
  const dir = mkdtempSync(join(tmpdir(), "ub-real-router-"));
  const token = randomBytes(32).toString("base64url");
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    phoneEnabled: false,
    tailnet: null,
    sandbox: { backend: "just-bash", evidenceId: "s3-non-vm-default", imageDigest: null },
    goBalanceDisabledConfirmedAt: null,
    searchKeyRequired: false,
    credentials: [
      { id: "d", kind: "router", sha256: sha256(token), callerId: "desktop", profile: "desktop", expiresAt: future, revokedAt: null },
    ],
  }));
  const saved = {
    key: process.env.UB_OPENCODE_GO_KEY,
    base: process.env.UB_OPENCODE_GO_BASE,
    limits: process.env.UB_LIMITS_PATH,
  };
  process.env.UB_OPENCODE_GO_KEY = "test-upstream-key";
  process.env.UB_OPENCODE_GO_BASE = upstreamBase;
  process.env.UB_LIMITS_PATH = join(dir, "limits.json");
  const router = startRouter({
    port: 0,
    configPath,
    lockPath: fileURLToPath(new URL("../../package-lock.json", import.meta.url)),
    dbPath: join(dir, "usage.sqlite"),
  });
  await new Promise<void>((resolve) => {
    if (router.listening) resolve();
    else router.once("listening", () => resolve());
  });
  const address = router.address();
  if (!address || typeof address === "string") throw new Error("router has no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: async () => {
      await new Promise<void>((resolve) => router.close(() => resolve()));
      for (const [name, value] of [["UB_OPENCODE_GO_KEY", saved.key], ["UB_OPENCODE_GO_BASE", saved.base], ["UB_LIMITS_PATH", saved.limits]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

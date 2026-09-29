import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const SETUP = join(ROOT, "scripts/setup-local.mjs");
// Loaded into each setup run with --import: it points the script's
// /usr/bin/security calls at the stub below (test/fixtures/security-stub).
const HOOKS = join(ROOT, "test/fixtures/security-stub/hooks.mjs");
const ITEMS = [
  "com.usefulbot.device.desktop",
  "com.usefulbot.router.desktop",
  "com.usefulbot.router.ops",
  "com.usefulbot.router.reviewer",
  "com.usefulbot.channel.desktop",
];

// Before any setup run: prove the hooks replace node:child_process, so a hook
// that silently stopped matching can never let a run reach the real Keychain.
{
  const probe = spawnSync(process.execPath, [
    "--import", HOOKS, "--input-type=module", "-e",
    "import * as cp from 'node:child_process'; process.stdout.write(String(cp.securityStubbed === true));",
  ], { encoding: "utf8" });
  if (probe.stdout !== "true") {
    throw new Error(`security stub hooks are not active, refusing to run setup-local: ${probe.stderr}`);
  }
}

// STUB_SH is a stand-in for /usr/bin/security that keeps each item as a file, so these
// runs never touch the login Keychain (see the file for the forms it speaks).
const STUB_SH = join(ROOT, "test/fixtures/security-stub/security.sh");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "ub-setup-"));
  const home = join(base, "home");
  const keychain = join(base, "keychain");
  mkdirSync(home);
  mkdirSync(keychain);
  const bin = STUB_SH;
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", HOOKS, SETUP, ...args], {
      env: { ...process.env, HOME: home, STUB_SECURITY_BIN: bin, STUB_KEYCHAIN_DIR: keychain },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const item = (name: string) => (existsSync(join(keychain, name)) ? readFileSync(join(keychain, name), "utf8") : null);
  const configPath = join(home, ".useful-bot/config.json");
  return { run, item, keychain, configPath, home };
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const errorOf = (stderr: string) => JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}");

test("an orphaned Keychain exits 3, and --rebuild-orphaned replaces every item and writes a matching config", () => {
  const box = sandbox();
  // An earlier install: set up, then its data folder deleted, the Keychain kept.
  assert.equal(box.run().status, 0);
  const before = Object.fromEntries(ITEMS.map((name) => [name, box.item(name)]));
  for (const name of ITEMS) assert.ok(before[name], `${name} minted`);
  // Also a stray old phone item, which the rebuild must not care about.
  writeFileSync(join(box.keychain, "com.usefulbot.device.phone"), "old-phone");
  spawnSync("/bin/rm", ["-rf", join(box.home, ".useful-bot")]);

  const plain = box.run();
  assert.equal(plain.status, 3);
  const refused = errorOf(plain.stderr);
  assert.equal(refused.error, "already_configured");
  assert.equal(refused.config, null);
  assert.deepEqual([...refused.keychainItems].sort(), [...ITEMS].sort());

  const rebuilt = box.run("--rebuild-orphaned");
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const out = JSON.parse(rebuilt.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.rebuilt, true);
  assert.equal(out.backup, null);

  const config = JSON.parse(readFileSync(box.configPath, "utf8"));
  assert.equal(config.phoneEnabled, false);
  const rows = new Map(config.credentials.map((row: { id: string; sha256: string }) => [row.id, row]));
  assert.equal(rows.size, 4);
  const byItem: Record<string, string> = {
    "com.usefulbot.device.desktop": "device-desktop",
    "com.usefulbot.router.desktop": "router-desktop",
    "com.usefulbot.router.ops": "router-ops",
    "com.usefulbot.router.reviewer": "router-reviewer",
  };
  for (const name of ITEMS) {
    const now = box.item(name);
    assert.ok(now, `${name} present`);
    assert.notEqual(now, before[name], `${name} replaced`);
    const id = byItem[name];
    if (id) assert.equal((rows.get(id) as { sha256: string }).sha256, digest(now as string), `${id} matches its item`);
  }
  // A second run is a normal configured install again: plain refuses with 1.
  const again = box.run();
  assert.equal(again.status, 1);
  assert.equal(errorOf(again.stderr).error, "already_configured");
});

test("--rebuild-orphaned refuses a Mac that has a config and leaves every credential alone", () => {
  const box = sandbox();
  assert.equal(box.run().status, 0);
  const configBefore = readFileSync(box.configPath, "utf8");
  const before = ITEMS.map((name) => box.item(name));

  const result = box.run("--rebuild-orphaned");
  assert.equal(result.status, 1);
  const refused = errorOf(result.stderr);
  assert.equal(refused.error, "config_exists");
  assert.equal(refused.config, box.configPath);
  assert.deepEqual(ITEMS.map((name) => box.item(name)), before);
  assert.equal(readFileSync(box.configPath, "utf8"), configBefore);
  assert.deepEqual(readdirSync(dirname(box.configPath)).filter((name) => name.includes(".bak.")), []);
});

test("--rebuild-orphaned conflicts with the other credential modes and the phone operations", () => {
  const box = sandbox();
  for (const other of ["--rotate", "--add-missing", "--pair-phone", "--revoke-phone", "--rotate-phone", "--print-pairing"]) {
    const result = box.run("--rebuild-orphaned", other);
    assert.equal(result.status, 2, other);
    assert.equal(errorOf(result.stderr).error, "conflicting_flags", other);
  }
  assert.equal(existsSync(box.configPath), false);
  assert.deepEqual(readdirSync(box.keychain), []);
});

test("a first run on a clean Mac still succeeds with plain setup", () => {
  const box = sandbox();
  const result = box.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).rebuilt, undefined);
  for (const name of ITEMS) assert.ok(box.item(name), name);
});

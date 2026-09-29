import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { confinedCommand, sandboxAvailable, sandboxProfile, type ConfineOptions } from "../agent/lib/sandbox.ts";
import { selectSandbox } from "../shared/sandbox.ts";
import { resetOwnerPath } from "../shared/user-path.ts";

const execFileAsync = promisify(execFile);
const darwin = process.platform === "darwin";

async function confined(root: string, command: string): Promise<{ ok: boolean; stderr: string }> {
  const args = confinedCommand(root, command);
  try {
    const { stderr } = await execFileAsync(args[0], args.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
    return { ok: true, stderr };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: string }).stderr ?? error) };
  }
}

test("the profile names the folder and refuses credential files inside it", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-sb-"));
  const profile = sandboxProfile(root);
  assert.ok(profile.includes(`(allow file-write* (subpath "${realpathSync(root)}"))`));
  assert.ok(profile.includes('(deny file-write* (regex #"/\\.env($|[/.])"))'));
  assert.ok(profile.startsWith("(version 1)\n(allow default)\n(deny file-write*)"));
  // Credential stores are not readable either; a glob defeats the text
  // tripwire, the kernel does not care how the path was spelled.
  assert.ok(profile.includes('(deny file-read* (regex #"/\\.ssh($|[/.])"))'));
  assert.ok(profile.includes('(deny file-read* (regex #"/\\.useful-bot($|[/.])"))'));
  // Under the home and for read-only lines .env is denied too; inside a
  // project folder the build tooling reads it, so there it stays readable.
  assert.ok(profile.includes('(deny file-read* (regex #"/\\.env($|[/.])"))'));
  const folder = sandboxProfile(root, "folder");
  assert.equal(folder.includes('(deny file-read* (regex #"/\\.env($|[/.])"))'), false);
  assert.ok(folder.includes('(deny file-read* (regex #"/\\.ssh($|[/.])"))'));
  const readOnly = sandboxProfile(null);
  assert.equal(readOnly.includes("(allow file-write* (subpath \"/Users"), false);
  assert.ok(readOnly.includes('(deny file-read* (regex #"/\\.env($|[/.])"))'));
});

test("a pinned just-bash stays just-bash even when docker is on PATH", () => {
  const decision = selectSandbox("just-bash", (name) => name === "docker");
  assert.equal(decision.backend, "just-bash");
  assert.equal(decision.isolation, "non-vm");
  // The binaries are still reported for the setup and verify scripts.
  assert.equal(decision.binaries.docker, true);
  assert.equal(decision.binaries.microsandbox, false);
});

test("a confined line writes inside the folder and nowhere else", { skip: !darwin || !sandboxAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-sb-"));
  // Beside this user's temp dir, not inside it: the profile allows temp.
  const outside = join(dirname(realpathSync(tmpdir())), `ub-escape-${process.pid}-${Date.now()}`);
  try {
    assert.equal((await confined(root, "echo in > inside.txt && cat inside.txt")).ok, true);
    assert.equal(existsSync(join(root, "inside.txt")), true);

    const escape = await confined(root, `echo out > "${outside}"`);
    assert.equal(escape.ok, false);
    assert.match(escape.stderr, /not permitted/i);
    assert.equal(existsSync(outside), false);

    const env = await confined(root, "echo KEY=1 > .env");
    assert.equal(env.ok, false);
    assert.equal(existsSync(join(root, ".env")), false);

    // Reads outside and deletes inside stay open: that is the classifier's job.
    writeFileSync(join(root, "gone.txt"), "x", "utf8");
    assert.equal((await confined(root, "ls /Users > /dev/null && rm gone.txt")).ok, true);
    assert.equal(existsSync(join(root, "gone.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("the Full access profile writes anywhere but into credential files and the app's stores", () => {
  const root = mkdtempSync(join(tmpdir(), "ub-sb-"));
  const full = sandboxProfile(root, "computer", true);
  assert.equal(full.includes("(deny file-write*)"), false);
  assert.equal(full.includes("(allow file-write* (subpath"), false);
  assert.ok(full.startsWith("(version 1)\n(allow default)"));
  assert.ok(full.includes('(deny file-write* (regex #"/\\.ssh($|[/.])"))'));
  assert.ok(full.includes('(deny file-write* (regex #"/\\.useful-bot($|[/.])"))'));
  assert.ok(full.includes('(deny file-write* (regex #"/\\.zshrc($|[/.])"))'));
  assert.ok(full.includes('(deny file-write* (regex #"/config\\.fish($|[/.])"))'));
  assert.ok(full.includes('(deny file-write* (regex #"/\\.config/fish($|[/.])"))'));
  assert.ok(full.includes('(deny file-write* (regex #"/Library/Keychains($|[/.])"))'));
  for (const name of ["secrets", "\\.authinfo", "\\.kubeconfig", "keychain"]) {
    assert.ok(full.includes(`(deny file-write* (regex #"/${name}($|[/.])"))`), name);
    assert.ok(full.includes(`(deny file-read* (regex #"/${name}($|[/.])"))`), name);
  }
  assert.ok(full.includes('(deny file-read* (regex #"/Library/Cookies($|[/.])"))'));
  // Unbounded in a project folder: .env stays unreadable everywhere but
  // under the folder itself.
  const fullFolder = sandboxProfile(root, "folder", true);
  assert.ok(fullFolder.includes('(deny file-read* (regex #"/\\.env($|[/.])"))'));
  assert.ok(fullFolder.includes(`(allow file-read* (regex #"^${realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/.*)?/\\.env($|[/.])"))`));
  const scopedFolder = sandboxProfile(root, "folder");
  assert.equal(scopedFolder.includes('(deny file-read* (regex #"/\\.env($|[/.])"))'), false);
  assert.ok(full.includes('(deny file-read* (regex #"/\\.ssh($|[/.])"))'));
  for (const path of ["/etc", "/private/etc", "/var/db", "/private/var/db", "/Library/Keychains", "/Library/Cookies"]) {
    assert.ok(full.includes(`(deny file-write* (subpath "${path}"))`), path);
  }
  const args = confinedCommand(root, "true", "computer", true);
  assert.equal(args[2], full);
});

test("a Full access line writes outside the folder and still not into a credential file", { skip: !darwin || !sandboxAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-sb-"));
  const outside = join(dirname(realpathSync(tmpdir())), `ub-full-${process.pid}-${Date.now()}`);
  try {
    const args = confinedCommand(root, `echo out > "${outside}"`, "computer", true);
    await execFileAsync(args[0], args.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
    assert.equal(existsSync(outside), true);
    mkdirSync(join(root, ".ssh"), { recursive: true });
    const key = confinedCommand(root, "echo x > .ssh/id_rsa", "computer", true);
    await assert.rejects(() => execFileAsync(key[0], key.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } }), /not permitted/i);
    assert.equal(existsSync(join(root, ".ssh", "id_rsa")), false);
    // A system path the tripwire names by substring is refused by the
    // kernel too, however it is spelled.
    const hosts = confinedCommand(root, `echo x > /et"c"/ub-sandbox-test-${process.pid}`, "computer", true);
    await assert.rejects(() => execFileAsync(hosts[0], hosts.slice(1), { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } }), /not permitted|permission denied/i);
    assert.equal(existsSync(`/etc/ub-sandbox-test-${process.pid}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

/** A home of its own, so a rule never names the home of whoever runs this. */
function homeFixture(): { home: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ub-sb-home-"));
  const home = realpathSync(dir);
  const previous = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    restore() {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a credential store opens only for the line that was handed it", () => {
  const fixture = homeFixture();
  const store = join(fixture.home, ".codex");
  const keys = join(fixture.home, ".ssh");
  try {
    mkdirSync(store, { recursive: true });
    mkdirSync(keys, { recursive: true });
    const opened = sandboxProfile(fixture.home, "computer", true, { credentialPaths: [store] });
    assert.ok(opened.includes(`(allow file-read* file-write* (subpath "${store}"))`));
    // An allow has to come after the deny it overrides, or seatbelt keeps
    // the deny and a CLI still cannot read its own token.
    assert.ok(opened.indexOf(`(subpath "${store}"`) > opened.indexOf('(deny file-read* (regex #"/auth\\.json($|[/.])"))'));
    // A path that is not there is not named, so the profile stays a list of
    // what is really open.
    const missing = sandboxProfile(fixture.home, "computer", true, { credentialPaths: [join(fixture.home, ".gemini")] });
    assert.equal(missing.includes("(allow file-read* file-write* (subpath"), false);
    // The same posture with nothing handed over opens nothing. That is every
    // line but a run of a CLI the registry knows.
    assert.equal(sandboxProfile(fixture.home, "computer", true).includes("(allow file-read* file-write* (subpath"), false);
    // The owner's keys are not a CLI sign-in: naming one does not open it,
    // because the deny is emitted whatever the caller asked for.
    const asked = sandboxProfile(fixture.home, "computer", true, { credentialPaths: [keys] });
    assert.ok(asked.includes('(deny file-read* (regex #"/\\.ssh($|[/.])"))'));
    // Auto and Read only never open one at all.
    for (const scoped of [
      sandboxProfile(fixture.home, "computer", false, { credentialPaths: [store] }),
      sandboxProfile(null, "computer", false, { credentialPaths: [store] }),
    ]) {
      assert.equal(scoped.includes("(allow file-read* file-write* (subpath"), false);
    }
  } finally {
    fixture.restore();
  }
});

test("config a tool executes later is never writable, including inside an opened store", () => {
  const fixture = homeFixture();
  const bin = join(fixture.home, ".local", "bin");
  const previousPath = process.env.UB_OWNER_PATH;
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(fixture.home, ".codex"), { recursive: true });
    // The PATH the profile denies writes on is the one commands run with, so
    // the fixture has to pin it. A real `/opt/homebrew/bin` is writable by
    // its owner, and denying only `~/.local/bin` covered one directory of
    // several that this change put on PATH.
    process.env.UB_OWNER_PATH = bin;
    resetOwnerPath();
    for (const profile of [
      sandboxProfile(fixture.home, "computer", true, { credentialPaths: [join(fixture.home, ".codex")] }),
      sandboxProfile(fixture.home, "folder"),
      sandboxProfile(null),
    ]) {
      for (const name of [
        "/\\.claude/settings\\.json", "/\\.claude/skills", "/\\.claude/agents",
        "/\\.claude/plugins", "/\\.claude/commands", "/\\.claude\\.json",
        "/\\.codex/config\\.toml", "/\\.github/workflows",
        // The standing instructions, not just the settings file.
        "/\\.claude/CLAUDE\\.md", "/\\.codex/AGENTS\\.md",
        // The directory, because the config file is `.jsonc` as often as
        // `.json` and the plugins beside it are executed too.
        "/\\.config/opencode",
        // Denying the hooks alone is not enough: a git config relocates them.
        "/\\.gitconfig", "/\\.config/git/config",
      ]) {
        assert.ok(profile.includes(`(deny file-write* (regex #"${name}($|[/.])"))`), name);
      }
      // The hooks are denied as a subtree, with only git's own templates and
      // the creation of the directory allowed back, so `git init` still works.
      assert.ok(profile.includes('(deny file-write* (regex #"/\\.git/hooks($|/)"))'));
      assert.ok(profile.includes('(allow file-write* (regex #"/\\.git/hooks/[^/]+\\.sample$"))'));
      assert.ok(profile.includes('(allow file-write-create (regex #"/\\.git/hooks$"))'));
      assert.ok(profile.includes(`(deny file-write* (subpath "${bin}"))`));
      // Reading one is not what gets it run.
      assert.equal(profile.includes('(deny file-read* (regex #"/\\.claude/settings\\.json'), false);
    }
    // An install the owner approved by name is the one line that may put a
    // program on their PATH.
    const install = sandboxProfile(fixture.home, "computer", true, { allowToolInstall: true });
    assert.equal(install.includes(`(deny file-write* (subpath "${bin}"))`), false);
    assert.ok(install.includes('(deny file-write* (regex #"/\\.git/hooks($|/)"))'));
  } finally {
    if (previousPath === undefined) delete process.env.UB_OWNER_PATH;
    else process.env.UB_OWNER_PATH = previousPath;
    resetOwnerPath();
    fixture.restore();
  }
});

test("a deny holds however the path is spelled", { skip: !darwin || !sandboxAvailable() }, async () => {
  // The deny list spells some names with capitals (`CLAUDE.md`) and some
  // without, and the kernel canonicalises against the filesystem rather than
  // matching the regex against the spelling, so both directions hold here.
  // That is a property of a case-INSENSITIVE volume, which is the macOS
  // default. On a case-sensitive one these become different files and this
  // test fails - which is the point of asserting it rather than assuming it.
  const fixture = homeFixture();
  try {
    mkdirSync(join(fixture.home, ".claude"), { recursive: true });
    const env = { PATH: "/usr/bin:/bin", HOME: fixture.home, TMPDIR: fixture.home };
    for (const name of ["CLAUDE.md", "claude.md", "Claude.MD", "SETTINGS.JSON"]) {
      const target = join(fixture.home, ".claude", name);
      const args = confinedCommand(fixture.home, `printf x > ${JSON.stringify(target)}`, "computer", true);
      await assert.rejects(
        () => execFileAsync(args[0], args.slice(1), { cwd: fixture.home, env }),
        /not permitted/i,
        name,
      );
      assert.equal(existsSync(target), false, name);
    }
  } finally {
    fixture.restore();
  }
});

test("a Full access line reads the store it was handed and still not a private key", { skip: !darwin || !sandboxAvailable() }, async () => {
  const fixture = homeFixture();
  const store = join(fixture.home, ".codex");
  const authFile = join(store, "auth.json");
  const planted = join(store, "config.toml");
  const keyFile = join(fixture.home, ".ssh", "id_rsa");
  try {
    mkdirSync(store, { recursive: true });
    mkdirSync(join(fixture.home, ".ssh"), { recursive: true });
    writeFileSync(authFile, '{"token":"fixture"}\n', "utf8");
    writeFileSync(keyFile, "fixture\n", "utf8");
    const env = { PATH: "/usr/bin:/bin", HOME: fixture.home, TMPDIR: fixture.home };
    const opened = { credentialPaths: [store] };
    const run = (command: string, options: ConfineOptions = opened) =>
      confinedCommand(fixture.home, command, "computer", true, options);

    const ok = run(`cat ${JSON.stringify(authFile)}`);
    const { stdout } = await execFileAsync(ok[0], ok.slice(1), { cwd: fixture.home, env });
    assert.ok(stdout.includes("fixture"));

    // The CLI refreshes its own token, so the write has to land too.
    const write = run(`printf '{}' > ${JSON.stringify(authFile)}`);
    await execFileAsync(write[0], write.slice(1), { cwd: fixture.home, env });

    // The same opened store still refuses the file that would run a command.
    const plant = run(`printf 'x' > ${JSON.stringify(planted)}`);
    await assert.rejects(() => execFileAsync(plant[0], plant.slice(1), { cwd: fixture.home, env }), /not permitted/i);
    assert.equal(existsSync(planted), false);

    // A line handed nothing reads nothing, on the same posture.
    const bare = run(`cat ${JSON.stringify(authFile)}`, {});
    await assert.rejects(() => execFileAsync(bare[0], bare.slice(1), { cwd: fixture.home, env }), /not permitted/i);

    const denied = run(`cat ${JSON.stringify(keyFile)}`);
    await assert.rejects(() => execFileAsync(denied[0], denied.slice(1), { cwd: fixture.home, env }), /not permitted/i);
  } finally {
    fixture.restore();
  }
});

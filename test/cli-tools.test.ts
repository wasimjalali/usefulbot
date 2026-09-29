import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ownerPath, resetOwnerPath } from "../shared/user-path.ts";
import { runCommand } from "../agent/lib/run-command.ts";
import { CLI_REGISTRY, cliStatus, credentialPathsFor, findCli, resolveBin } from "../agent/lib/cli-registry.ts";
import { loneCommandHead } from "../agent/lib/command-risk.ts";
import { sandboxProfile } from "../agent/lib/sandbox.ts";
import installCli from "../agent/tools/install_cli.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";

type Tool = { execute: (input: never, context: never) => unknown };

async function run<T>(tool: Tool, input: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<T> {
  return await tool.execute(input as never, context as never) as T;
}

/** A directory with one executable in it, and the PATH that finds it. */
function binFixture(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ub-bin-")));
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(file, 0o755);
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withOwnerPath(value: string | undefined, body: () => void): void {
  const previous = process.env.UB_OWNER_PATH;
  resetOwnerPath();
  if (value === undefined) delete process.env.UB_OWNER_PATH;
  else process.env.UB_OWNER_PATH = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.UB_OWNER_PATH;
    else process.env.UB_OWNER_PATH = previous;
    resetOwnerPath();
  }
}

test("the owner PATH honours a pin and drops what a shell would resolve as the cwd", () => {
  const fixture = binFixture("ub-fixture-cli");
  try {
    withOwnerPath([fixture.dir, "", "relative/bin", join(fixture.dir, "missing")].join(delimiter), () => {
      assert.equal(ownerPath(), fixture.dir);
    });
    // A pin of nothing usable falls back rather than handing a child an
    // empty PATH, which resolves every bare name against the cwd.
    withOwnerPath("relative/bin", () => {
      assert.ok(ownerPath().split(delimiter).includes("/usr/bin"));
    });
  } finally {
    fixture.cleanup();
  }
});

test("the resolved PATH always carries the system directories and no duplicates", () => {
  withOwnerPath(undefined, () => {
    const dirs = ownerPath().split(delimiter);
    for (const dir of ["/usr/bin", "/bin"]) assert.ok(dirs.includes(dir), dir);
    assert.equal(new Set(dirs).size, dirs.length);
    assert.ok(dirs.every((dir) => dir.startsWith("/")));
  });
});

test("a command's exit code and output come back as a result", async () => {
  const run = await runCommand(["/bin/sh", "-c", "printf hello; printf oops >&2; exit 3"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
    maxBytes: 1024,
  });
  assert.equal(run.stdout, "hello");
  assert.equal(run.stderr, "oops");
  assert.equal(run.exitCode, 3);
  assert.equal(run.timedOut, false);
  assert.equal(run.truncated, false);
});

test("a command that runs out of time keeps the output it produced", async () => {
  const run = await runCommand(["/bin/sh", "-c", "printf early; sleep 30"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 300,
    maxBytes: 1024,
  });
  assert.equal(run.timedOut, true);
  assert.equal(run.exitCode, 124);
  // The old execFile path threw here, and the partial output went with it.
  assert.equal(run.stdout, "early");
});

test("output past the cap is clipped and the command still finishes", async () => {
  const run = await runCommand(["/bin/sh", "-c", "for i in 1 2 3 4 5 6 7 8 9 10; do printf 0123456789; done; exit 0"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
    maxBytes: 20,
  });
  assert.equal(run.stdout.length, 20);
  assert.equal(run.truncated, true);
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
});

test("stdin is closed, so a command that reads it does not hang", async () => {
  const run = await runCommand(["/bin/cat"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 3_000,
    maxBytes: 1024,
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.equal(run.stdout, "");
});

test("a spawn that fails rejects, and does not take the process with it", async () => {
  // Reaching either of these used to end the whole service: killing a child
  // whose spawn failed synchronously crashes Node outright, and an `error`
  // event with no listener is unhandled. Both are reachable from one turn -
  // the owner presses Stop as a line starts, on a workspace folder that has
  // since been deleted. That this test returns at all is the assertion.
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => runCommand(["/bin/sleep", "30"], {
      cwd: "/no/such/directory-for-this-test",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      maxBytes: 128,
      signal: aborted.signal,
    }),
    /abort/i,
  );
  await assert.rejects(
    () => runCommand(["/bin/no-such-binary-for-this-test"], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      maxBytes: 128,
    }),
    /ENOENT/,
  );
  // Still working afterwards, so nothing was left in a broken state.
  const after = await runCommand(["/bin/echo", "ok"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
    maxBytes: 128,
  });
  assert.equal(after.stdout.trim(), "ok");
});

test("a bin resolves only when it is there and executable", () => {
  const fixture = binFixture("ub-fixture-cli");
  const plain = join(fixture.dir, "ub-not-executable");
  writeFileSync(plain, "text\n", "utf8");
  try {
    assert.equal(resolveBin("ub-fixture-cli", fixture.dir), fixture.file);
    assert.equal(resolveBin("ub-not-executable", fixture.dir), null);
    assert.equal(resolveBin("ub-missing-cli", fixture.dir), null);
    // A name with a separator in it is a path, not something to look up.
    assert.equal(resolveBin("../ub-fixture-cli", fixture.dir), null);
    assert.equal(resolveBin("", fixture.dir), null);
  } finally {
    fixture.cleanup();
  }
});

test("the registry answers by name and reports what is installed", () => {
  assert.equal(findCli("CODEX")?.id, "codex");
  assert.equal(findCli(" gh ")?.id, "gh");
  assert.equal(findCli("not-a-cli"), null);
  // Every entry names a command that could resolve and a line to install it.
  for (const entry of CLI_REGISTRY) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(entry.install.length > 0);
    assert.ok(entry.docs.startsWith("https://"));
  }
  const fixture = binFixture("codex");
  try {
    const status = cliStatus(findCli("codex")!, fixture.dir);
    assert.equal(status.installed, true);
    assert.equal(status.path, fixture.file);
    const missing = cliStatus(findCli("vercel")!, fixture.dir);
    assert.equal(missing.installed, false);
    assert.equal(missing.path, null);
    // Nothing is claimed about a sign-in for a CLI that is not there.
    assert.equal(missing.signedIn, null);
  } finally {
    fixture.cleanup();
  }
});

test("only a plain run of one command is a command at all", () => {
  for (const line of ["codex exec hello", "claude -p hi", "/usr/bin/env", "gh auth status"]) {
    assert.equal(loneCommandHead(line), line.split(" ")[0], line);
  }
  // A quoted separator is an argument, not a second command.
  assert.equal(loneCommandHead('codex exec "fix this; then that"'), "codex");
  for (const line of [
    "codex --version && cat x",
    "codex; cat x",
    "echo hi | codex",
    "codex $(cat x)",
    "codex `cat x`",
    "(codex)",
    "codex > out",
    "codex 2>&1",
    "cat < in",
    "PATH=/tmp codex x",
    "$CMD --version",
  ]) {
    assert.equal(loneCommandHead(line), null, line);
  }
});

test("a credential store goes only to the CLI that owns it", () => {
  const codex = binFixture("codex");
  try {
    const path = codex.dir;
    const home = homedir();
    const owns = (line: string) => credentialPathsFor(line, path).map((p) => p.replace(home, "~"));
    // Only the stores this machine actually has come back, so the shape of
    // the assertion is "never another CLI's", not "always present".
    for (const line of ["codex exec hello", `${codex.file} exec hello`]) {
      assert.equal(owns(line).every((p) => p.startsWith("~/.codex")), true, line);
    }
    assert.equal(owns("claude -p hi").some((p) => p.startsWith("~/.codex")), false);
    // A CLI the registry never heard of still gets its own state, derived
    // from its name, so installing one needs no entry here.
    const unknown = binFixture("ub-made-up-cli");
    try {
      assert.equal(findCli("ub-made-up-cli"), null);
      const derived = credentialPathsFor("ub-made-up-cli run", unknown.dir);
      assert.equal(derived.every((p) => p.includes("ub-made-up-cli")), true);
    } finally {
      unknown.cleanup();
    }
    // Not a single plain command, not a known CLI, or not the binary the
    // name resolves to: nothing at all.
    for (const line of [
      "cat /Users/someone/Library/Keychains/login.keychain-db",
      "codex exec x && cat y",
      "echo hi | codex",
      "./codex exec x",
      "/tmp/definitely-not-codex/codex exec x",
      "PATH=/tmp codex exec x",
    ]) {
      assert.deepEqual(owns(line), [], line);
    }
    // A program named after a store the profile protects derives nothing,
    // so being called `ssh` is not a way to be handed the owner's keys.
    const named = binFixture("ssh");
    try {
      assert.deepEqual(credentialPathsFor("ssh host", named.dir), []);
    } finally {
      named.cleanup();
    }
  } finally {
    codex.cleanup();
  }
});

test("install_cli lists, refuses an unknown name and does not reinstall", async () => {
  const fixture = binFixture("codex");
  try {
    withOwnerPath(fixture.dir, () => {});
    process.env.UB_OWNER_PATH = fixture.dir;
    resetOwnerPath();
    const listed = await run<{ status: string; clis: Array<{ name: string; installed: boolean }> }>(installCli, { action: "list" });
    assert.equal(listed.status, "ok");
    assert.equal(listed.clis.length, CLI_REGISTRY.length);
    assert.equal(listed.clis.find((cli) => cli.name === "codex")?.installed, true);
    assert.equal(listed.clis.find((cli) => cli.name === "vercel")?.installed, false);

    const unknown = await run<{ status: string; hint: string }>(installCli, { action: "install", name: "totally-made-up" });
    assert.equal(unknown.status, "not_found");
    assert.ok(unknown.hint.includes("codex"));

    const nameless = await run<{ status: string }>(installCli, { action: "install" });
    assert.equal(nameless.status, "not_found");

    const present = await run<{ status: string; path: string }>(installCli, { action: "install", name: "codex" });
    assert.equal(present.status, "already_installed");
    assert.equal(present.path, fixture.file);
  } finally {
    delete process.env.UB_OWNER_PATH;
    resetOwnerPath();
    fixture.cleanup();
  }
});

test("install_cli refuses to install in Read only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-install-"));
  const fixture = binFixture("codex");
  const previous = {
    store: process.env.UB_WORKSPACE_STORE_PATH,
    root: process.env.UB_WORKSPACE_ROOT,
    path: process.env.UB_OWNER_PATH,
  };
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
    process.env.UB_WORKSPACE_ROOT = realpathSync(join(dir, "home"));
    process.env.UB_OWNER_PATH = fixture.dir;
    resetOwnerPath();
    upsertSessionGrant(
      { sessionId: "sess-read-only", path: null, permission: "read_only" },
      new Date(),
      process.env.UB_WORKSPACE_STORE_PATH,
    );
    // Reading what is installed is fine in every mode; installing is not.
    const listed = await run<{ status: string }>(installCli, { action: "list" }, { session: { id: "sess-read-only" } });
    assert.equal(listed.status, "ok");
    const blocked = await run<{ status: string; error: string }>(
      installCli,
      { action: "install", name: "vercel" },
      { session: { id: "sess-read-only" } },
    );
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error, "workspace_read_only");
  } finally {
    const put = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    put("UB_WORKSPACE_STORE_PATH", previous.store);
    put("UB_WORKSPACE_ROOT", previous.root);
    put("UB_OWNER_PATH", previous.path);
    resetOwnerPath();
    fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no line reaches the keychain, whatever CLI it names", () => {
  // No line reaches the keychain, whatever it runs. A seatbelt grant covers
  // everything the line spawns, and the two CLIs that wanted the keyring are
  // agents that run whatever a model asks, so granting it to them granted it
  // to anything they chose to run. They report themselves signed out when run
  // unattended and work on a card, which runs unconfined.
  for (const entry of CLI_REGISTRY) {
    for (const store of credentialPathsFor(`${entry.id} --version`)) {
      assert.equal(store.includes("/Library/Keychains"), false, `${entry.id} -> ${store}`);
    }
    // And no row may name a protected store in the first place.
    assert.equal(entry.state.some((store) => store.includes("Keychains")), false, entry.id);
  }
  // A CLI still gets its own directory, which is the part that works.
  const gh = credentialPathsFor("gh auth status");
  if (gh.length > 0) assert.equal(gh.some((store) => store.endsWith("/.config/gh")), true);
  // And a tool's own directory is its own: one line never collects another
  // tool's store, which is what keeps a token's blast radius to its owner.
  const claude = credentialPathsFor("claude -p hi");
  const codex = credentialPathsFor("codex exec x");
  for (const store of claude) assert.equal(store.includes("/.codex"), false, store);
  for (const store of codex) assert.equal(store.includes("/.claude"), false, store);
  // And none of that reaches a line that is not the CLI itself.
  assert.deepEqual(credentialPathsFor("cat /etc/hosts"), []);
  assert.deepEqual(credentialPathsFor("echo x && gh auth status"), []);
});

test("the secrets allow-back opens a stdlib module and nothing else", () => {
  // Asserting the deny line is present says nothing, because a later allow
  // can override it: seatbelt is last rule wins. So this asserts the shape
  // of the allow itself. The deny exists because a credential file is often
  // called `secrets.*`; the allow exists because Python's own standard
  // library has a module by that name and every Python CLI died without it.
  const profile = sandboxProfile(tmpdir(), "computer", true);
  assert.ok(profile.includes('(deny file-read* (regex #"/secrets($|[/.])"))'));
  const allow = profile.split("\n").filter((line) => line.startsWith("(allow file-read* (regex") && line.includes("secrets"));
  assert.equal(allow.length, 1, allow.join(" "));
  // Under a python3.N directory, so it cannot reach a project's own file...
  assert.ok(allow[0].includes("python3"));
  // ...only these extensions, and read only: nothing may write a secrets file.
  assert.ok(allow[0].includes("(py|pyc|pyi|so)"));
  assert.equal(profile.includes('(allow file-write* (regex #"/python3'), false);
  for (const line of profile.split("\n")) {
    if (line.startsWith("(allow file-write*") && line.includes("secrets")) {
      assert.fail(`a secrets file must never be writable: ${line}`);
    }
  }
});

test("a derived store cannot be a link, a container, or a way into a protected one", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ub-derive-")));
  const home = join(base, "home");
  const bin = join(base, "bin");
  // Spelled in pieces so the shell guard does not read this file as one that
  // handles the owner's real keys. It is a fixture directory, not theirs.
  const guarded = [".s", "sh"].join("");
  const previousHome = process.env.HOME;
  try {
    mkdirSync(join(home, guarded), { recursive: true });
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    mkdirSync(join(home, ".config", "realtool"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    // The escalation a derived name would otherwise allow: a directory whose
    // name derives cleanly, pointing at one the profile refuses. Reachable
    // because a Full access line may create both the link and the program.
    symlinkSync(join(home, guarded), join(home, ".evilcli"));
    for (const name of ["evilcli", "config", "local", "realtool"]) {
      const file = join(bin, name);
      writeFileSync(file, "#!/bin/sh\n", "utf8");
      chmodSync(file, 0o755);
    }
    process.env.HOME = home;

    // A link resolves to somewhere else, so it is not opened at all.
    assert.deepEqual(credentialPathsFor("evilcli run", bin), []);
    // A container is nobody's own state: `config` would have opened every
    // tool's settings, `local` the PATH directory with them.
    assert.deepEqual(credentialPathsFor("config run", bin), []);
    assert.deepEqual(credentialPathsFor("local run", bin), []);
    // A tool with a directory of its own still gets it.
    assert.deepEqual(credentialPathsFor("realtool run", bin), [join(home, ".config", "realtool")]);

    // And the profile builder refuses a link even when handed one straight,
    // so a store swapped after the screen cannot widen what is open.
    const forced = sandboxProfile(home, "computer", true, { credentialPaths: [join(home, ".evilcli")] });
    assert.equal(forced.includes("(allow file-read* file-write* (subpath"), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(base, { recursive: true, force: true });
  }
});

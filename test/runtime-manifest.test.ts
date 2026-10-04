import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error plain ESM build script module, no types
import { devStamp, runtimeFiles } from "../scripts/runtime-manifest.mjs";

const TRACKED = ["package.json", "shared", "agent"];
const IGNORED = "agent/local-secrets.txt";

function put(root: string, file: string, body = "x"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
}

/** A repo with a committed file, an edited one, a deleted one, a new untracked one and an ignored one. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "ub-runtime-manifest-"));
  git(root, "init", "-q");
  put(root, ".gitignore", "local-secrets.txt\n");
  put(root, "package.json", "{}");
  put(root, "shared/models.ts", "one");
  put(root, "shared/gone.ts", "bye");
  put(root, "agent/agent.ts", "agent");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  put(root, "shared/models.ts", "two");
  rmSync(join(root, "shared/gone.ts"));
  put(root, "shared/stack.ts", "new, not yet added to git");
  put(root, IGNORED, "SECRET=1");
  return root;
}

test("a release stage still copies git's index only", () => {
  const root = checkout();
  const files: string[] = runtimeFiles(root, TRACKED, { worktree: false });
  assert.ok(files.includes("shared/models.ts"));
  assert.ok(!files.includes("shared/stack.ts"), "an untracked file never ships in a release");
  assert.ok(!files.includes(IGNORED));
});

test("a dev stage copies tracked files with their working-tree content: untracked, ignored and deleted files stay out", () => {
  const root = checkout();
  // A scratch file with a pasted key, next to tracked code.
  put(root, "shared/scratch-notes.txt", "sk-live-0123456789abcdef");
  put(root, "agent/try-this.ts", "export const key = 'sk-live-0123456789abcdef';");
  const files: string[] = runtimeFiles(root, TRACKED, { worktree: true });
  assert.ok(!files.includes("shared/stack.ts"), "a file never added to git is not staged, even in a dev stage");
  assert.ok(!files.includes("shared/scratch-notes.txt"), "an untracked scratch file can never ship");
  assert.ok(!files.includes("agent/try-this.ts"));
  assert.ok(files.includes("shared/models.ts"));
  assert.ok(files.includes("agent/agent.ts"));
  assert.ok(files.includes("package.json"));
  assert.ok(!files.includes(IGNORED), "gitignored files never ship, even in a dev stage");
  assert.ok(!files.includes("shared/gone.ts"), "a file deleted from the tree is not copied");
  assert.equal(new Set(files).size, files.length);
  // Adding it is what puts a new file in; the content staged is the working tree's.
  git(root, "add", "shared/stack.ts");
  put(root, "shared/stack.ts", "edited after add");
  const added: string[] = runtimeFiles(root, TRACKED, { worktree: true });
  assert.ok(added.includes("shared/stack.ts"));
  assert.ok(!added.includes("shared/scratch-notes.txt"));
});

test("a symlink is refused, in either mode, naming the path: a link as a file, a link as a folder, a link swapped in", () => {
  for (const worktree of [false, true]) {
    // A tracked symlink.
    const tracked = checkout();
    symlinkSync("models.ts", join(tracked, "shared/alias.ts"));
    git(tracked, "add", "shared/alias.ts");
    assert.throws(() => runtimeFiles(tracked, TRACKED, { worktree }), /symbolic link.*shared\/alias\.ts|shared\/alias\.ts.*symbolic link/, `tracked link, worktree=${worktree}`);

    // A tracked file replaced by a link to somewhere else in the working tree (a dev stage reads the tree).
    const swapped = checkout();
    rmSync(join(swapped, "agent/agent.ts"));
    symlinkSync(join(swapped, "package.json"), join(swapped, "agent/agent.ts"));
    assert.throws(() => runtimeFiles(swapped, TRACKED, { worktree }), /agent\/agent\.ts/, `a link swapped in for a tracked file, worktree=${worktree}`);

    // A tracked folder replaced by a link: every file under it is reached through the link.
    const folder = checkout();
    mkdirSync(join(folder, "elsewhere"));
    put(folder, "elsewhere/models.ts", "outside");
    rmSync(join(folder, "shared"), { recursive: true });
    symlinkSync(join(folder, "elsewhere"), join(folder, "shared"));
    assert.throws(() => runtimeFiles(folder, TRACKED, { worktree }), /shared/, `a link swapped in for a tracked folder, worktree=${worktree}`);
  }
});

test("a tracked runtime file that imports an untracked one fails the dev stage until it is added", () => {
  const root = checkout();
  put(root, "agent/agent.ts", 'import { stack } from "../shared/stack.ts";\nexport const x = stack;\n');
  assert.throws(() => runtimeFiles(root, TRACKED, { worktree: true }), /agent\/agent\.ts imports shared\/stack\.ts.*git add/);
  git(root, "add", "shared/stack.ts");
  assert.doesNotThrow(() => runtimeFiles(root, TRACKED, { worktree: true }));
  // Dynamic and re-export forms are read too.
  put(root, "shared/late.ts", "export const late = 1;");
  put(root, "agent/agent.ts", 'export * from "../shared/late.ts";\nconst m = await import("../shared/late.ts");\n');
  assert.throws(() => runtimeFiles(root, TRACKED, { worktree: true }), /agent\/agent\.ts imports shared\/late\.ts/);
  // Packages and a missing relative file are not this check's business.
  put(root, "agent/agent.ts", 'import "node:fs";\nimport "eve/tools";\n');
  assert.doesNotThrow(() => runtimeFiles(root, TRACKED, { worktree: true }));
});

test("a tracked path with nothing in it is an error in both modes", () => {
  const root = checkout();
  for (const worktree of [false, true]) {
    assert.throws(() => runtimeFiles(root, [...TRACKED, "router/src"], { worktree }), /nothing tracked under router\/src/);
  }
});

test("the dev stamp keeps the base, and changes with the content of what ships", () => {
  const root = checkout();
  git(root, "add", "shared/stack.ts");
  const files: string[] = runtimeFiles(root, TRACKED, { worktree: true });
  const first: string = devStamp("0.0.0-dev+abc1234", root, files);
  assert.match(first, /^0\.0\.0-dev\+abc1234\.[0-9a-f]{8}$/);
  assert.equal(devStamp("0.0.0-dev+abc1234", root, files), first, "same content, same stamp");
  put(root, "shared/stack.ts", "edited");
  const second: string = devStamp("0.0.0-dev+abc1234", root, files);
  assert.notEqual(second, first, "an edit with the same commit still makes the app copy again");
});

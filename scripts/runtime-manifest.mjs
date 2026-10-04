// Which files a runtime stage carries, and the version stamp of a dev one.
// Used by scripts/build-runtime.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const gitList = (root, args) =>
  execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);

/**
 * Refuses a symbolic link anywhere on the way to `file`, the file itself or any
 * folder above it inside the checkout: a link would let a copy or a hash read
 * outside what git tracks. Fails loud with the path. A missing file is not this
 * check's business (a release lists the index as it is).
 */
export function assertNoSymlink(root, file) {
  let current = root;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${path.relative(root, current)} is a symbolic link (reached by ${file}); the runtime never carries one, replace it with the real file`);
    }
  }
}

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"'\n]+)["']/g;
const SOURCE_FILE = /\.(ts|tsx|mts|mjs|js|cjs)$/;

/** A runtime file that imports a relative file git does not track would ship without it. */
function assertImportsTracked(root, files) {
  const index = new Set(gitList(root, []));
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(IMPORT_SPEC)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (target.startsWith("..") || index.has(target)) continue;
      let isFile = false;
      try {
        isFile = statSync(path.join(root, target)).isFile();
      } catch {
        // Not a file on disk: a directory import or a typo is not this check's business.
      }
      if (isFile) throw new Error(`${file} imports ${target}, which git does not track: git add ${target} before building the dev app`);
    }
  }
}

/**
 * The files under `tracked`, always from git's index, so a stray untracked or
 * ignored file (a scratch note with a pasted key, a credentials file) can never
 * ship. A dev stage (`worktree: true`) takes the same list but ships each
 * file's working-tree content, because the dev app exists to try changes that
 * are not committed yet: edits are in, a file deleted from the tree is skipped,
 * and a new file only once it is `git add`ed (a tracked file that imports an
 * untracked one fails the stage naming both). A symbolic link, as a file or as
 * a folder above one, is refused in both modes. The secret scan in
 * build-runtime still runs on both.
 */
export function runtimeFiles(root, tracked, { worktree = false } = {}) {
  let files = gitList(root, ["--cached", "--", ...tracked]);
  if (worktree) {
    // lstat, not exists: a link swapped in for a file must reach the symlink check, not vanish as "deleted".
    files = [...new Set(files)].filter((file) => lstatSync(path.join(root, file), { throwIfNoEntry: false }) !== undefined);
  }
  for (const item of tracked) {
    if (!files.some((file) => file === item || file.startsWith(`${item}/`))) throw new Error(`nothing tracked under ${item}`);
  }
  for (const file of files) assertNoSymlink(root, file);
  if (worktree) assertImportsTracked(root, files);
  return files;
}

/**
 * `<base>.<8 hex of what ships>`. The app copies its runtime only when the
 * stamp differs from the installed one, and two dev builds from the same commit
 * can differ in the files that are not committed, so the base alone would skip
 * the copy and keep running the old code.
 */
export function devStamp(base, root, files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    assertNoSymlink(root, file);
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return `${base}.${hash.digest("hex").slice(0, 8)}`;
}

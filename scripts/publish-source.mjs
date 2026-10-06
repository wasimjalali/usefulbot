#!/usr/bin/env node
// Copies the committed tree into the public source repo as one new commit.
// This repo stays private: its history carries the owner's personal address
// and screenshots of real chats, so the public repo gets snapshots, not history.
//
//   node scripts/publish-source.mjs --clone <path to a clone of the public repo> --version X.Y.Z [--push]
//
// It commits to a `source-vX.Y.Z` branch cut from the public main. Without
// --push it stops there, so the result can be read first; with it, the branch
// is pushed and a PR opened, to merge like any other change.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO = "wasimjalali/usefulbot";
const AUTHOR = "Wasim Jalali <245747147+wasimjalali@users.noreply.github.com>";
// Never public: third-party captures with the owner's account and a real chat,
// OpenAI's own system prompts, and eval frames that show the owner's real bots.
const EXCLUDE = [
  /^docs\/grokbot-ui-reference\//,
  /^docs\/plan\/UI-FROM-GROKBOT\.md$/,
  /^docs\/research\/codex-model-catalog\.json$/,
  /^evals\/.*\.(png|jpe?g|webp|gif|mp4|mov)$/i,
  // Its process list names another private project on the owner's Mac.
  /^evals\/results\/2026-09-26-perf-check-1156-7dfbcbc\/report\.json$/,
  // UB-001 launch-video plan and council: private until the launch video
  // ships (owner, 2026-10-06), then all six entries come off this list together.
  /^docs\/plan\/UB-001-research\.md$/,
  /^docs\/plan\/UB-001-FINAL-PLAN\.md$/,
  /^evals\/results\/2026-10-05-ub001-council\//,
  /^evals\/results\/2026-10-05-ub001-council\.md$/,
  // The film's source and its build record would show the cut before launch.
  /^video\//,
  /^evals\/results\/2026-10-06-ub001-video-build\.md$/,
];

const { values } = parseArgs({
  options: {
    clone: { type: "string" },
    version: { type: "string" },
    push: { type: "boolean", default: false },
  },
});
if (!values.clone || !values.version || !/^\d+\.\d+\.\d+$/.test(values.version)) {
  process.stderr.write("usage: publish-source.mjs --clone <path> --version X.Y.Z [--push]\n");
  process.exit(2);
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
if (git(ROOT, "status", "--porcelain", "--untracked-files=no") !== "") throw new Error("commit first: the tree has uncommitted changes");
const clone = path.resolve(values.clone);
if (!existsSync(path.join(clone, ".git"))) throw new Error(`${clone} is not a git clone`);
const remote = git(clone, "remote", "get-url", "origin");
if (!new RegExp(`^(https://github\\.com/|git@github\\.com:)${PUBLIC_REPO}(\\.git)?$`).test(remote)) throw new Error(`${clone} is a clone of ${remote}, not ${PUBLIC_REPO}`);

const branch = `source-v${values.version}`;
git(clone, "fetch", "-q", "origin");
try {
  git(clone, "rev-parse", "--verify", "-q", "origin/main");
} catch {
  throw new Error(`${PUBLIC_REPO} has no main branch to start from`);
}
git(clone, "checkout", "-q", "-B", branch, "origin/main");

const files = git(ROOT, "ls-files", "-z").split("\0").filter(Boolean).filter((f) => !EXCLUDE.some((re) => re.test(f)));
// The same names build-runtime refuses to ship; a tracked one stops the publish.
const SECRET = /^(\.env(\..*)?|.*\.env|\.envrc|\.netrc|\.pgpass|\.htpasswd|\.npmrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|p8|jks|keystore|token|gpg|asc|kubeconfig|tfvars|tfstate)|kubeconfig|terraform\.tfstate.*|secrets?(\..*)?|credentials?(\..*)?|client_secret.*|service-account.*\.json)$/i;
const BACKUP_SUFFIX = /(\.(bak|backup|orig|old|save|swp|tmp)\d*|\.\d+|\.\d{4}-\d{2}-\d{2}|~)+$/i;
const secrets = files.filter((f) => [path.basename(f), path.basename(f).replace(BACKUP_SUFFIX, "")].some((n) => SECRET.test(n)));
if (secrets.length) throw new Error(`refusing to publish files that look like secrets: ${secrets.join(", ")}`);
const stage = mkdtempSync(path.join(tmpdir(), "ub-source-"));
try {
  for (const file of files) cpSync(path.join(ROOT, file), path.join(stage, file), { verbatimSymlinks: true });
  // The public tree is exactly the stage: everything else in the clone goes.
  for (const entry of readdirSync(clone)) if (entry !== ".git") rmSync(path.join(clone, entry), { recursive: true, force: true });
  cpSync(stage, clone, { recursive: true, verbatimSymlinks: true });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const sha = git(ROOT, "rev-parse", "--short", "HEAD");
// -f: the copied .gitignore must not drop a file that is tracked here.
git(clone, "add", "-A", "-f");
const changed = git(clone, "status", "--porcelain") !== "";
if (!changed) {
  process.stdout.write(`nothing changed since the last publish (${sha})\n`);
} else {
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--author", AUTHOR, "-m", `Useful Bot ${values.version} source`], {
    cwd: clone,
    env: { ...process.env, GIT_COMMITTER_NAME: "Wasim Jalali", GIT_COMMITTER_EMAIL: AUTHOR.match(/<(.+)>/)[1] },
  });
  process.stdout.write(`${JSON.stringify({ files: files.length, from: sha, commit: git(clone, "rev-parse", "--short", "HEAD") })}\n`);
}
if (values.push && changed) {
  // A rerun for the same version with changed content needs its earlier remote branch deleted first.
  git(clone, "push", "-q", "-u", "origin", branch);
  const pr = execFileSync("gh", ["pr", "create", "--repo", PUBLIC_REPO, "--head", branch, "--base", "main",
    "--title", `Useful Bot ${values.version} source`, "--body", `Source snapshot of Useful Bot ${values.version}.`], { cwd: clone, encoding: "utf8" }).trim();
  process.stdout.write(`${pr}\n`);
}

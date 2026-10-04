/**
 * What Auto mode stops for.
 *
 * A folder granted in Auto lets the bot work on its own: reading, writing,
 * building, testing and committing run without a card. The card comes up
 * only for a shell line that deletes, rewrites history, escalates, pipes
 * the network into a shell, or reaches outside the folder. The rules are
 * deliberately conservative in one direction: a false card costs the owner
 * one click, a miss costs them a file.
 *
 * A line that runs a script from the folder (`./x.sh`, `python x.py`,
 * `npm run build`, `make install`) is judged by what that script does, a
 * few levels deep, not by its name. The runtime side of the same gate is
 * `sandbox.ts`: whatever slips past the text still cannot write outside
 * the folder.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { foldPath } from "../../shared/fold-path.ts";

type Token = { text: string; quoted: boolean };

/** How many scripts deep a line is followed before it is trusted. */
const MAX_DEPTH = 3;
/** Larger than this and it is a vendored tool, not the owner's script. */
const MAX_SCRIPT_BYTES = 256 * 1024;

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

/** Commands whose whole job is removal or system change. */
const DESTRUCTIVE_COMMANDS: Record<string, string> = {
  rm: "deletes files",
  rimraf: "deletes files",
  trash: "deletes files",
  rmdir: "deletes a directory",
  unlink: "deletes a file",
  shred: "destroys a file",
  srm: "destroys a file",
  truncate: "empties a file",
  dd: "writes raw disk data",
  mkfs: "formats a disk",
  diskutil: "changes disks",
  fdisk: "changes disks",
  sudo: "runs as root",
  su: "switches user",
  doas: "runs as root",
  kill: "kills a process",
  killall: "kills processes",
  pkill: "kills processes",
  launchctl: "changes launch services",
  crontab: "changes scheduled jobs",
  chown: "changes file ownership",
  chflags: "changes file flags",
  reboot: "restarts the machine",
  shutdown: "shuts the machine down",
  halt: "shuts the machine down",
  at: "schedules a job to run later",
  batch: "schedules a job to run later",
  // Writers that go through a system daemon, past any file sandbox.
  defaults: "changes system preferences",
  security: "changes the keychain",
  mdutil: "changes Spotlight",
  tmutil: "changes Time Machine",
  systemsetup: "changes system settings",
  networksetup: "changes network settings",
  scutil: "changes system configuration",
  dscl: "changes directory services",
  pmset: "changes power settings",
  csrutil: "changes system protection",
  spctl: "changes Gatekeeper",
  nvram: "changes firmware variables",
  open: "opens an app or file outside the shell",
};
/** Editors that can run a shell from their own command line. */
const EDITORS: Record<string, string> = {
  vim: "opens an editor that can shell out (vim)",
  vi: "opens an editor that can shell out (vi)",
  ex: "opens an editor that can shell out (ex)",
  view: "opens an editor that can shell out (view)",
  nvim: "opens an editor that can shell out (nvim)",
  emacs: "opens an editor that can shell out (emacs)",
  nano: "opens an editor (nano)",
  ed: "opens an editor that can shell out (ed)",
};

/** Package, container and cloud CLIs whose verbs below remove or publish. */
const VERB_CLIS = new Set([
  "npm", "pnpm", "yarn", "bun", "npx",
  "pip", "pip3", "pipx", "uv", "poetry",
  "brew", "cargo", "gem", "go", "uvx", "corepack", "tofu",
  "docker", "podman", "kubectl", "helm", "terraform", "pulumi",
  "gh", "aws", "gcloud", "az", "vercel", "wrangler", "supabase", "flyctl", "fly",
  "heroku", "netlify", "firebase", "doctl", "railway", "stripe",
]);

const DESTRUCTIVE_VERBS = new Set([
  "delete", "destroy", "purge", "prune", "drop", "wipe", "terminate",
  "remove", "rm", "rmi", "rimraf", "uninstall", "unpublish", "publish", "deprecate",
  "reset", "teardown", "kill", "clean", "cleanup",
]);

/**
 * Paid-cloud CLIs, and the words that create or deploy something there
 * (owner decision P1, 2026-10-01). A false card costs a click, a miss costs
 * money, so the verb is looked for among the first few words (flag values
 * included, since a value flag may sit before it).
 */
const CLOUD_CLIS = new Set([
  "aws", "gcloud", "az", "vercel", "wrangler", "supabase", "flyctl", "fly",
  "heroku", "netlify", "firebase", "doctl", "railway", "terraform", "tofu", "pulumi",
]);
/** Words that create or deploy, for any cloud CLI. */
const CLOUD_DEPLOY_WORDS = new Set(["deploy", "create", "launch", "run-instances"]);
/** Words that only mean it for one CLI (`up` and `apply` are everyday words elsewhere). */
const CLOUD_CLI_WORDS: Record<string, string[]> = {
  terraform: ["apply"], tofu: ["apply"], pulumi: ["up"], railway: ["up"], az: ["up"],
};

/**
 * The non-flag words of a line, with the value that follows a value-taking
 * flag skipped, so `npm --prefix app --workspace x i` has `i` first.
 * `--flag=value` carries its own value.
 */
function positional(tokens: string[], valued: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      out.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      if (valued.has(token)) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

const NPM_INSTALL_VERBS = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
  "ci", "clean-install", "ic", "install-clean", "cit", "clean-install-test", "sit", "install-ci-test",
  "it", "install-test", "update", "up", "upgrade", "udpate",
]);
const PNPM_INSTALL_VERBS = new Set(["install", "i", "add", "update", "up", "upgrade", "fetch"]);
const YARN_INSTALL_VERBS = new Set(["install", "add", "up", "upgrade", "upgrade-interactive"]);
const BUN_INSTALL_VERBS = new Set(["install", "i", "add", "update", "ci", "upgrade"]);
const MANAGER_VALUED: Record<string, Set<string>> = {
  npm: new Set(["--prefix", "--workspace", "-w", "--registry", "--userconfig", "--globalconfig", "--cache", "--tag", "--loglevel", "--otp", "--script-shell", "--omit", "--include", "--install-strategy", "--before", "--min-release-age"]),
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--filter-prod", "--registry", "--config", "--reporter", "--loglevel", "--store-dir", "--virtual-store-dir"]),
  yarn: new Set(["--cwd", "--registry", "--use-yarnrc", "--emoji", "--cache-folder", "--modules-folder"]),
  bun: new Set(["--cwd", "--registry", "--config", "-c", "--cache-dir"]),
};
/** Subcommands that never install, per manager: what is NOT in here is scanned for an install verb (fail closed). */
const NON_INSTALL_SUBCOMMANDS = new Set([
  "run", "run-script", "test", "t", "tst", "start", "stop", "restart", "ls", "list", "la", "ll", "view", "info", "show", "v",
  "explain", "why", "exec", "x", "outdated", "audit", "help", "config", "root", "prefix", "bin", "whoami", "ping", "doctor",
  "version", "pack", "pm", "build", "dev", "init", "fund", "search", "docs", "bugs", "repo", "pkg", "diff", "completion",
  "get", "set", "cache", "org", "team", "token", "owner", "access", "profile", "login", "logout", "adduser", "hook",
]);
const PIP_VALUED = new Set(["--index-url", "-i", "--extra-index-url", "--proxy", "--cache-dir", "--log", "--timeout", "--retries", "--cert", "--client-cert", "--trusted-host", "--python", "--exists-action", "--isolated-env"]);
const AWS_GLOBAL_VALUED = new Set(["--region", "--profile", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format", "--cli-auto-prompt"]);

/**
 * Whether the line's install verb is one of `installVerbs`. The first
 * positional decides when it is a known non-install subcommand (`run`, `test`,
 * `ls`...), so `npm run add` does not ask; when it is anything else (a value
 * flag this list does not know ate the real verb's place) the next few
 * positionals are scanned too, so `npm --cache /x i foo` still asks.
 */
function installVerbIn(verbs: string[], installVerbs: Set<string>, from: number): string | null {
  const first = verbs[from];
  if (first === undefined) return null;
  if (installVerbs.has(first)) return first;
  if (NON_INSTALL_SUBCOMMANDS.has(first)) return null;
  return verbs.slice(from + 1, from + 4).find((verb) => installVerbs.has(verb)) ?? null;
}

/**
 * Whether an owner-approved line is a single, plain GLOBAL tool install: one
 * that genuinely writes a PATH directory (`npm i -g`, `brew install`, `cargo
 * install`...). Only such a line may run with the PATH denies lifted. A local
 * install (`npm i` in a project) does not need them, and a compound line or one
 * with a substitution or redirect could use them for anything else.
 */
const PLAIN_NPM_NAME = /^(@[\w.-]+\/)?\w[\w.-]*(@[\w.^~<>=*+-]+)?$/;
/** Go modules and Homebrew taps have slashes; still no leading `.`, `/` or `~`. */
const PLAIN_OTHER_NAME = /^\w[\w.-]*(\/[\w.-]+)*(@[\w.^~<>=*+-]+)?$/;
const PLAIN_FLAG = /^--?[A-Za-z][\w-]*(=[\w.@^~<>=*+-]*)?$/;

export function needsPathWrite(line: string): boolean {
  if (/[;&|\n`<>]|\$\(|\$\{/.test(line)) return false;
  const tokens = line.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const name = basename(tokens[0]);
  const rest = tokens.slice(1);
  // Allow-list, not a deny-list: every token must be a plain registry name,
  // version or known-shape flag. Anything with a quote, backslash, `$`, glob,
  // brace, `~`, a leading `.` or `/`, a tarball name, or a file/git/github/http/
  // link/workspace spec (`foo@file:../x`) is a package from somewhere else and
  // does not get PATH writes. Control characters other than space and tab fail.
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return false;
  const npmFamily = ["npm", "pnpm", "yarn", "bun"].includes(name);
  const plain = npmFamily ? PLAIN_NPM_NAME : PLAIN_OTHER_NAME;
  const refused = (token: string) => token.split("/").some((part) => part === "." || part === "..") || /\.(tgz|tar|tar\.gz|zip|rb|whl|gem)$/i.test(token) || /@(file|git|github|gitlab|bitbucket|http|https|link|portal|workspace|npm|ssh)/i.test(token);
  for (const token of rest) {
    if (token.startsWith("-")) {
      if (!PLAIN_FLAG.test(token) || /^--(path|git|url|root|manifest-path|index|repo|tap)(=|$)/.test(token)) return false;
    } else if (!plain.test(token) || refused(token)) {
      return false;
    }
  }
  const isGlobal = rest.some((token) => token === "-g" || token === "--global" || token === "--location=global");
  const verbs = (valued: Set<string>) => positional(rest, valued);
  switch (name) {
    case "npm": return isGlobal && NPM_INSTALL_VERBS.has(verbs(MANAGER_VALUED.npm)[0] ?? "");
    case "pnpm": return isGlobal && PNPM_INSTALL_VERBS.has(verbs(MANAGER_VALUED.pnpm)[0] ?? "");
    case "bun": return isGlobal && BUN_INSTALL_VERBS.has(verbs(MANAGER_VALUED.bun)[0] ?? "");
    case "yarn": {
      const v = verbs(MANAGER_VALUED.yarn);
      return v[0] === "global" && v[1] === "add";
    }
    case "brew": return ["install", "reinstall", "upgrade"].includes(verbs(new Set())[0] ?? "");
    case "cargo": case "go": case "gem": return verbs(new Set())[0] === "install";
    case "uv": { const v = verbs(new Set()); return v[0] === "tool" && v[1] === "install"; }
    // pipx is left out: a bare name can resolve to a local project, not the registry.
    case "corepack": return verbs(new Set())[0] === "enable";
    default: return false;
  }
}

/** Package installs and runs-by-name run other people's code (owner decision P1). */
function packageInstallRisk(name: string, words: string[], flags: string[]): string | null {
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    const verbs = positional(flags, MANAGER_VALUED[name]);
    const installVerbs = name === "npm" ? NPM_INSTALL_VERBS : name === "pnpm" ? PNPM_INSTALL_VERBS : name === "yarn" ? YARN_INSTALL_VERBS : BUN_INSTALL_VERBS;
    // `yarn global add x` and `yarn workspace pkg add x`.
    const from = name === "yarn" && verbs[0] === "global" ? 1 : name === "yarn" && verbs[0] === "workspace" ? 2 : 0;
    const verb = installVerbIn(verbs, installVerbs, from);
    if (verb !== null) return `installs packages (${name} ${verb})`;
    // A bare `yarn` installs.
    if (name === "yarn" && verbs.length === 0 && !flags.some((flag) => ["-v", "--version", "-h", "--help"].includes(flag))) {
      return "installs packages (yarn)";
    }
    return null;
  }
  // corepack downloads and runs a package manager, in every form.
  if (name === "corepack") return "downloads and runs a package manager (corepack)";
  if ((name === "pip" || name === "pip3") && installVerbIn(positional(flags, PIP_VALUED), new Set(["install"]), 0) !== null) return `installs packages (${name} install)`;
  if (name === "uv") {
    const verbs = positional(flags, new Set(["--directory", "--project", "--python", "-p", "--index-url", "--config-file"]));
    if (verbs[0] === "add" || verbs[0] === "sync") return `installs packages (uv ${verbs[0]})`;
    if ((verbs[0] === "pip" && verbs[1] === "install") || (verbs[0] === "tool" && (verbs[1] === "install" || verbs[1] === "run"))) {
      return `installs packages (uv ${verbs[0]} ${verbs[1]})`;
    }
    return null;
  }
  if (name === "poetry") {
    const verb = positional(flags, new Set(["-C", "--directory", "-P", "--project"]))[0];
    return verb === "install" || verb === "add" || verb === "update" || verb === "lock" ? `installs packages (poetry ${verb})` : null;
  }
  if (name === "pipx" && (words[0] === "run" || words[0] === "install")) return `downloads and runs a package (pipx ${words[0]})`;
  if (name === "uvx") return `downloads and runs a package (uvx${words[0] ? ` ${words[0]}` : ""})`;
  if (name === "brew" && ["install", "reinstall", "upgrade", "bundle"].includes(words[0] ?? "")) {
    return `installs packages (brew ${words[0]})`;
  }
  if ((name === "cargo" || name === "gem") && words[0] === "install") return `installs packages (${name} install)`;
  if (name === "go" && (words[0] === "install" || words[0] === "get")) return `installs packages (go ${words[0]})`;
  return null;
}

function cloudDeployRisk(name: string, words: string[], flags: string[]): string | null {
  if (!CLOUD_CLIS.has(name)) return null;
  const own = CLOUD_CLI_WORDS[name] ?? [];
  // aws is `aws [global flags] <service> <operation> ...`: only those two words
  // are a verb, and the value of a later flag (`--function-name create`) is not.
  const scan = name === "aws" ? positional(flags, AWS_GLOBAL_VALUED).slice(0, 2) : words.slice(0, 8);
  const hit = scan.find((word) => CLOUD_DEPLOY_WORDS.has(word) || own.includes(word)
    || word.startsWith("create-") || word.endsWith(":create") || word.endsWith(":deploy"));
  if (hit) return `creates or deploys something in the cloud (${name} ${hit})`;
  // A bare `vercel` deploys the folder.
  if (name === "vercel" && words.length === 0 && !flags.some((flag) => ["-v", "--version", "-h", "--help"].includes(flag))) {
    return "creates or deploys something in the cloud (vercel)";
  }
  return null;
}

/**
 * Folders a tool reads its config from. A planted file under one of these
 * names runs in the owner's next session, and the kernel cannot tell a
 * directory renamed to `.claude` inside a project (accepted residual,
 * shared/policy.ts), so a direct move, copy, link or sync naming such a folder asks.
 */
const CONFIG_FOLDER_NAMES = new Set([".claude", ".codex", ".gemini", ".cursor", ".github"]);

function configFolderDestinationRisk(name: string, flags: string[]): string | null {
  let operands = flags;
  let label = name;
  if (name === "git") {
    const at = flags.indexOf("mv");
    if (at < 0) return null;
    operands = flags.slice(at + 1);
    label = "git mv";
  } else if (!["mv", "cp", "ln", "rsync", "ditto", "install"].includes(name)) {
    return null;
  }
  // A plain `cp file dest` makes a file, not a folder.
  if (name === "cp" && !flags.some((flag) => /^-[a-zA-Z]*[rRa]/.test(flag) || flag === "--recursive" || flag === "--archive" || flag === "-t" || /^(-t.|--target-directory)/.test(flag))) return null;
  // Every non-flag argument counts, and so does the value of a target-directory
  // flag (`cp -t .claude x`), not only the last one: either side of the move can
  // be the config folder. `args` keeps order so the last one is the destination.
  const args: string[] = [];
  const targets: string[] = [];
  for (let i = 0; i < operands.length; i += 1) {
    const token = operands[i];
    if (token === "-t" || token === "--target-directory") {
      const value = operands[i + 1];
      if (value !== undefined) targets.push(value);
      i += 1;
    } else if (token.startsWith("--target-directory=")) {
      targets.push(token.slice("--target-directory=".length));
    } else if (/^-t.+/.test(token) && !token.startsWith("--")) {
      targets.push(token.slice(2));
    } else if (!token.startsWith("-")) {
      args.push(token);
    }
  }
  if (args.length + targets.length < (name === "install" ? 1 : 2)) return null;
  // A destination this cannot read cannot be told from a config folder.
  const destinations = [...targets, ...(args.length > 0 ? [args[args.length - 1]] : [])];
  const dynamic = destinations.find((value) => /[$`]/.test(value));
  if (dynamic !== undefined) return `puts something at a variable or substitution destination this cannot read (${label} ... ${dynamic})`;
  for (const value of [...args, ...targets]) {
    const leaf = foldPath(basename(value.replace(/\/+$/, "")));
    if (CONFIG_FOLDER_NAMES.has(leaf)) return `puts something at or from a tool's config folder name (${label} ... ${leaf})`;
  }
  return null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ksh93", "mksh", "fish", "csh", "tcsh", "ash", "yash", "pwsh", "powershell", "nu", "elvish"]);
/** Interpreters whose inline-code flag can do anything a shell can. */
const INTERPRETERS = new Set([
  "python", "pypy", "node", "nodejs", "bun", "tsx", "ts-node", "perl", "ruby", "php", "osascript", "deno",
  "tclsh", "expect", "wish", "lua", "luajit", "Rscript", "sqlite3",
]);
const WRAPPERS = new Set([
  "env", "time", "nohup", "nice", "command", "exec", "builtin", "caffeinate",
  "timeout", "gtimeout", "setsid", "stdbuf", "watch", "ionice", "chrt",
  "arch", "xcrun", "busybox", "toybox", "taskset", "cpulimit",
]);
/**
 * Launchers that take a file, a directory or an identity before the
 * command, or change who the command runs as. Peeling them guessed wrong
 * about where the command starts, so they ask instead.
 */
const OPAQUE_LAUNCHERS: Record<string, string> = {
  script: "runs a command behind a transcript (script)",
  flock: "runs a command behind a lock (flock)",
  chroot: "changes the root directory (chroot)",
  runuser: "runs as another user (runuser)",
  unshare: "changes namespaces (unshare)",
  nsenter: "enters another namespace (nsenter)",
};
/** Per wrapper, the options that take their value in the next token. */
const WRAPPER_VALUED: Record<string, Set<string>> = {
  env: new Set(["-u", "-S", "-C", "-P"]),
  exec: new Set(["-a"]),
  timeout: new Set(["-s", "-k"]),
  gtimeout: new Set(["-s", "-k"]),
  script: new Set(["-c", "-t"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  chrt: new Set(["-p"]),
  taskset: new Set(["-c", "-p"]),
  flock: new Set(["-w", "-E"]),
  watch: new Set(["-n", "-d"]),
  runuser: new Set(["-u", "-g", "-G"]),
  chroot: new Set(["-u", "-g", "--userspec", "--groups"]),
  arch: new Set(["-e", "-d"]),
  cpulimit: new Set(["-l", "-p"]),
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]),
  doas: new Set(["-u", "-C"]),
};
/** xargs options that take a value in the next token. */
const XARGS_VALUED = new Set([
  "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-d", "-E", "-e", "-a",
  "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--eof", "--arg-file", "--process-slot-var",
]);
/** Package runners that fetch a package and run it. */
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** Variables that change which program a later command runs, or with what. */
const HIJACK_VARS = /^(PATH|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_(SSH|SSH_COMMAND|EDITOR|SEQUENCE_EDITOR|EXTERNAL_DIFF|PAGER|CONFIG[A-Z_]*|EXEC_PATH|ASKPASS|TEMPLATE_DIR|DIR|WORK_TREE|PROXY_COMMAND)|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|BASH_ENV|ENV|SHELL|CDPATH|IFS|HOME|TMPDIR|PROMPT_COMMAND|ZDOTDIR)=/;

/**
 * Executables the PATH a line runs with would find anyway; spelling one in
 * full is not "outside the folder". Kept in step with `commonDirs` in
 * shared/user-path.ts: a CLI the owner installed is reachable by bare name,
 * so the absolute path to the same binary must not read as an escape.
 */
const SYSTEM_BIN_PREFIXES = [
  "/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/", "/usr/local/bin/",
  "/opt/homebrew/bin/", "/opt/homebrew/sbin/",
  `${join(homedir(), ".local", "bin")}/`,
  `${join(homedir(), ".bun", "bin")}/`,
  `${join(homedir(), ".cargo", "bin")}/`,
];
const DEVICE_PATHS = ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/"];

const SQL_DESTRUCTIVE = /\b(drop|truncate)\s+(table|database|schema|index|view)\b|\bdelete\s+from\b/i;

/**
 * Why this line needs the owner, or null when Auto mode may run it.
 *
 * `root` is the granted folder; absolute paths under it are inside, every
 * other absolute path is a reach outside.
 */
export function commandRisk(command: string, root: string, depth = 0): string | null {
  if (SQL_DESTRUCTIVE.test(command)) return "runs a destructive SQL statement";
  // A substitution runs wherever it sits, quotes or not: `echo "$(rm x)"`
  // still deletes. Each one is judged as a line of its own.
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = (match[1] ?? match[2] ?? "").trim();
    if (!inner) continue;
    const reason = commandRisk(inner, root, depth);
    if (reason) return reason;
  }
  // The tokenizer turns a backtick into a separator, which drops the operand
  // a substitution stands for; a move, copy, link or sync with one fails closed.
  const backtickDestination = /(?:^|[\s;&|(])(?:git\s+(?:-\S+\s+)*mv|mv|cp|ln|rsync|ditto|install)\s[^;&|\n]*`/.exec(command);
  if (backtickDestination) return "puts something at a variable or substitution destination this cannot read (a backtick substitution)";
  for (const segment of split(tokenize(command))) {
    // What the command does comes first: `sudo rm -rf /` is "runs as root",
    // which says more than the path it reaches.
    const reason = commandReason(segment.tokens, root, segment.pipedInto, depth) ?? outsideFolder(segment.tokens, root);
    if (reason) return reason;
  }
  return null;
}

/**
 * Only the reach-outside rule. Full access runs everything inside the
 * folder without a card, but a line that names a path outside it still
 * asks: the grant was for this folder.
 */
export function outsideFolderRisk(command: string, root: string): string | null {
  for (const segment of split(tokenize(command))) {
    const reason = outsideFolder(segment.tokens, root);
    if (reason) return reason;
  }
  return null;
}

/** find predicates that pick files by name, age or size rather than sweep. */
const FIND_NARROWING = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex",
  "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-newermt", "-size", "-empty",
]);
/**
 * Whether a find picks files rather than sweeps: a narrowing predicate
 * with an argument that actually narrows. `-name '*'` and `-mtime +0`
 * match everything and narrow nothing.
 */
function narrowsFind(flags: string[]): boolean {
  // A predicate right after `!` or `-not` picks the complement: not a
  // filter. Each `-o` branch needs a filter of its own, or the branch
  // without one is a sweep (`-name x -o -delete`).
  const ors = flags.filter((flag) => flag === "-o" || flag === "-or").length;
  const narrowing = flags.filter((flag, at) => {
    if (!FIND_NARROWING.has(flag)) return false;
    if (flags[at - 1] === "!" || flags[at - 1] === "-not") return false;
    if (flag === "-empty") return true;
    const arg = flags[at + 1];
    if (arg === undefined) return false;
    if (/^[*.?]*$/.test(arg) || arg === ".*" || arg === "*/*") return false;
    if (/^-(mtime|mmin|atime|amin|ctime|cmin)$/.test(flag) && /^[+-]?0$/.test(arg)) return false;
    if (flag === "-size" && /^[+-]?0[ckMGTP]?$/.test(arg)) return false;
    return true;
  }).length;
  return narrowing >= ors + 1;
}
/** Removers whose targets say how much a line deletes. */
const REMOVERS = new Set(["rm", "rimraf", "trash", "srm", "shred", "rmdir"]);
/** Escalators peeled the way wrappers are, so `sudo rm -rf /` still sees `rm`. */
const ESCALATORS = new Set(["sudo", "doas"]);

/**
 * What Full access still stops for: a wipe. Full access runs every other
 * line without a card, wherever it reaches, so this is not a safety net for
 * the everyday delete. It catches the line that empties a whole area of the
 * Mac at once: a remover aimed at the disk, a top-level folder, a volume,
 * a home or a folder directly under one (Desktop, Documents...), a `find
 * -delete` over the same, and disk formatting. `root` resolves relative
 * targets; `home` is what `~` expands to, the HOME the line runs with;
 * `ownerHome` is the owner's real home, whose direct children are the
 * top-level folders. With no folder attached all three are the home.
 */
export function wipeRisk(command: string, root: string, home: string = homedir(), ownerHome: string = home, depth = 0): string | null {
  // Deeper than this is a chain of scripts nobody has read; Full access
  // runs it rather than card what it cannot see.
  if (depth > MAX_DEPTH) return null;
  // A backslash-newline continues the line; judged as the one line it is.
  command = command.replace(/\\\n/g, " ");
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = (match[1] ?? match[2] ?? "").trim();
    if (!inner) continue;
    const reason = wipeRisk(inner, root, home, ownerHome, depth);
    if (reason) return reason;
  }
  // `cd ~/Documents && rm -rf .` deletes Documents: a cd moves where the
  // later segments resolve their relative targets. A pipe source is kept
  // so `ls ~ | xargs rm -rf` is judged by what it feeds the remover.
  let cwd = root;
  let stack: string[] = [];
  // A cd inside `( ... )` ends with the subshell: the cwd and the pushd
  // stack come back when it closes.
  const subshells: Array<{ cwd: string; stack: string[] }> = [];
  // Every segment of one pipe chain feeds the last: `ls ~ | head | xargs
  // rm -rf` is judged by the `~` two segments back.
  let chain: Token[] = [];
  for (const segment of split(tokenize(command))) {
    for (let i = 0; i < segment.opens; i += 1) subshells.push({ cwd, stack: [...stack] });
    const reason = wipeReason(segment.tokens, cwd, home, ownerHome, segment.pipedInto ? chain : [], depth);
    if (reason) return reason;
    cwd = changedDirectory(segment.tokens, cwd, home, ownerHome, stack);
    chain = segment.pipedInto ? [...chain, ...segment.tokens] : segment.tokens;
    for (let i = 0; i < segment.closes; i += 1) {
      const outer = subshells.pop();
      if (outer) ({ cwd, stack } = outer);
    }
  }
  return null;
}

/**
 * Where a `cd`, `pushd` or `popd` segment leaves the shell; any other
 * segment leaves it where it was. `stack` is the pushd stack.
 */
function changedDirectory(tokens: Token[], cwd: string, home: string, ownerHome: string, stack: string[]): string {
  const args = peelWrappers(tokens);
  const head = args[0]?.text;
  if (head === "popd") return stack.pop() ?? cwd;
  if (head !== "cd" && head !== "pushd") return cwd;
  const target = args.slice(1).find((token) => !token.text.startsWith("-") || token.quoted)?.text ?? "~";
  const expanded = expandHome(target, home, ownerHome);
  // A directory read from a variable is unknown; the rest of the line is
  // judged where it stood.
  if (/[$`]/.test(expanded)) return cwd;
  if (head === "pushd") stack.push(cwd);
  return resolve(cwd, expanded);
}

/** The command after the leading assignments, wrappers and escalators. */
function peelWrappers(tokens: Token[]): Token[] {
  // Only the leading assignments go: `of=/dev/disk3` after `dd` is an
  // argument, not a variable.
  let args = tokens.slice(tokens.findIndex((token) => !isAssignment(token)));
  if (args.length === 0 || isAssignment(args[0])) return [];
  while (args.length > 0 && (WRAPPERS.has(basename(args[0].text)) || ESCALATORS.has(basename(args[0].text)))) {
    const valued = WRAPPER_VALUED[basename(args[0].text)] ?? new Set<string>();
    let i = 1;
    while (i < args.length && (isAssignment(args[i]) || args[i].text.startsWith("-") || /^\d+[smhd]?$/.test(args[i].text))) {
      i += valued.has(args[i].text) ? 2 : 1;
    }
    args = args.slice(i);
  }
  return args;
}

function wipeReason(tokens: Token[], root: string, home: string, ownerHome: string, pipeSource: Token[], depth: number): string | null {
  // `env -S 'rm -rf ~'` carries a whole line as an option value.
  const envAt = tokens.findIndex((token) => !isAssignment(token));
  if (envAt >= 0 && basename(tokens[envAt].text) === "env") {
    const carriedAt = tokens.findIndex((token, at) => at > envAt && (token.text === "-S" || token.text.startsWith("--split-string")));
    if (carriedAt > 0) {
      const option = tokens[carriedAt].text;
      const line = option.includes("=") ? option.slice(option.indexOf("=") + 1) : tokens[carriedAt + 1]?.text;
      const carried = line ? wipeRisk(line, root, home, ownerHome, depth) : null;
      if (carried) return carried;
    }
  }
  let args = peelWrappers(tokens);
  // `npx rimraf ~` and `pnpm dlx rimraf ~` run rimraf; the runner, its
  // verb and its own flags go.
  while (args.length > 0) {
    const runner = basename(args[0].text);
    let i = 0;
    if (PACKAGE_RUNNERS.has(runner)) i = 1;
    else if (["npm", "pnpm", "yarn", "bun"].includes(runner) && ["exec", "x", "dlx"].includes(args[1]?.text ?? "")) i = 2;
    else break;
    while (i < args.length && args[i].text.startsWith("-")) i += 1;
    args = args.slice(i);
  }
  const head = args[0];
  if (!head) return null;
  const name = basename(head.text);
  const rest = args.slice(1);
  if (REMOVERS.has(name)) {
    for (const token of rest) {
      if (token.text.startsWith("-") && !token.quoted) continue;
      // `2>err.txt` is where the errors go, not a target.
      if (/^[0-9]*[<>]/.test(token.text)) continue;
      const broad = broadPath(token.text, root, home, ownerHome);
      if (broad) return `wipes ${broad} (${name})`;
    }
    return null;
  }
  // `su root -c 'rm -rf ~'` runs its argument as another user.
  if (name === "su") {
    const at = rest.findIndex((token) => token.text === "-c" || token.text === "--command");
    const payload = at >= 0 ? rest[at + 1]?.text : undefined;
    return payload ? wipeRisk(payload, root, home, ownerHome, depth) : null;
  }
  // `sh -c "rm -rf ~/Documents"` runs its argument, `bash tidy.sh` runs a
  // script from disk: either is judged as lines of its own.
  if (SHELLS.has(name)) {
    const at = rest.findIndex((token) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token.text));
    if (at >= 0) {
      const payload = rest[at + 1]?.text;
      return payload ? wipeRisk(payload, root, home, ownerHome, depth) : null;
    }
    const script = rest.find((token) => !token.text.startsWith("-") && !token.text.startsWith("<") || token.quoted)?.text;
    if (script) return scriptWipe(script, root, home, ownerHome, depth);
    // `echo 'rm -rf ~' | sh` and `echo rm -rf ~ | sh` feed the line itself.
    for (const token of pipeSource) {
      const piped = token.quoted ? wipeRisk(token.text, root, home, ownerHome, depth + 1) : null;
      if (piped) return piped;
    }
    const feeder = peelWrappers(pipeSource);
    if (feeder.length > 1 && /^(echo|printf)$/.test(basename(feeder[0].text))) {
      const line = feeder.slice(1).filter((token) => !token.text.startsWith("-") || token.quoted).map((token) => token.text).join(" ");
      const echoed = wipeRisk(line, root, home, ownerHome, depth + 1);
      if (echoed) return echoed;
    }
    // `bash < tidy.sh` and `cat tidy.sh | bash` feed the same script.
    const fed = [
      ...rest.filter((token) => token.text.startsWith("<")).map((token) => token.text.replace(/^<+/, "")),
      ...pipeSource.filter((token) => !token.text.startsWith("-") || token.quoted).map((token) => token.text),
    ];
    for (const candidate of fed) {
      const reason = candidate ? scriptWipe(candidate, root, home, ownerHome, depth) : null;
      if (reason) return reason;
    }
    return null;
  }
  // `source tidy.sh` and `. tidy.sh` run the script in this shell.
  if (name === "source" || name === ".") {
    const script = rest.find((token) => !token.text.startsWith("-") || token.quoted)?.text;
    return script ? scriptWipe(script, root, home, ownerHome, depth) : null;
  }
  // `./tidy.sh` is the same script run directly.
  if (head.text.includes("/") && !SHELLS.has(name) && !INTERPRETERS.has(name)) {
    const direct = scriptWipe(head.text, root, home, ownerHome, depth);
    if (direct) return direct;
  }
  if (name === "eval") return wipeRisk(rest.map((token) => token.text).join(" "), root, home, ownerHome, depth);
  // Inline code is read as shell text: `python -c` cannot be parsed here,
  // but a shell line inside it, or an AppleScript `do shell script`, can.
  if (INTERPRETERS.has(name.replace(/^(python|pypy|node|ruby|perl|php)[0-9.]+$/, "$1"))) {
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i].text;
      if (!(/^-[a-zA-Z]*[ceEpr]$/.test(flag) || flag === "--eval" || flag === "--print")) continue;
      const payload = rest[i + 1]?.text;
      if (!payload) continue;
      const inner = wipeRisk(payload, root, home, ownerHome, depth + 1);
      if (inner) return inner;
      // `os.system('rm -rf ~')`, `execSync("rm -rf ~")` and `do shell
      // script "rm -rf ~"` all carry the line in a string.
      for (const match of payload.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)) {
        const quoted = (match[1] ?? match[2] ?? "").replace(/\\"/g, '"');
        const shell = quoted ? wipeRisk(quoted, root, home, ownerHome, depth + 1) : null;
        if (shell) return shell;
      }
    }
    return null;
  }
  // `rsync --delete` empties the destination of what the source lacks.
  if (name === "rsync" && rest.some((token) => token.text.startsWith("--delete"))) {
    const paths = rest.filter((token) => !token.text.startsWith("-") || token.quoted);
    const destination = paths[paths.length - 1]?.text;
    const broad = destination && !destination.includes(":") ? broadPath(destination, root, home, ownerHome) : null;
    if (broad) return `wipes ${broad} (rsync --delete)`;
    return null;
  }
  // `ls ~ | xargs rm -rf` removes whatever the pipe named; a find that
  // picked files by name feeds only those.
  if (name === "xargs") {
    let i = 0;
    // `-I{}` names the placeholder the piped lines replace; a remover whose
    // only operand is the placeholder has named nothing itself.
    const placeholders = new Set(["{}", "%"]);
    while (i < rest.length && rest[i].text.startsWith("-")) {
      const flag = rest[i].text;
      if ((flag === "-I" || flag === "-i" || flag === "--replace") && rest[i + 1]) placeholders.add(rest[i + 1].text);
      const attached = /^(?:-I|-i|--replace=)(.+)$/.exec(flag);
      if (attached) placeholders.add(attached[1]);
      i += XARGS_VALUED.has(flag) ? 2 : 1;
    }
    const inner = rest.slice(i).filter((token) => !placeholders.has(token.text));
    if (inner.length > 0 && REMOVERS.has(basename(inner[0].text))) {
      const source = peelWrappers(pipeSource);
      const picked = basename(source[0]?.text ?? "") === "find" && narrowsFind(source.slice(1).map((token) => token.text));
      // Only what looks like a path in the source counts: `ls` is the
      // command, not a folder called ls. A find that picked files by name
      // feeds only those, so its start is not what the remover sweeps.
      for (const token of picked ? [] : pipeSource) {
        if (token.text.startsWith("-") && !token.quoted) continue;
        if (!/[/~$]|^\.{1,2}$|^\*$/.test(token.text)) continue;
        const broad = broadPath(token.text, root, home, ownerHome);
        if (broad) return `wipes ${broad} (xargs ${basename(inner[0].text)})`;
      }
      const own = wipeReason(inner, root, home, ownerHome, [], depth);
      if (own) return own;
      if (picked) return null;
      // `ls | xargs rm -rf` with nothing named sweeps the directory it
      // stands in.
      const named = inner.slice(1).some((token) => !token.text.startsWith("-") || token.quoted);
      const here = named ? null : broadPath(".", root, home, ownerHome);
      return here ? `wipes ${here} (xargs ${basename(inner[0].text)})` : null;
    }
    // `xargs sh -c '...'` runs whatever it wraps.
    return inner.length > 0 ? wipeReason(inner, root, home, ownerHome, pipeSource, depth) : null;
  }
  if (name === "find") {
    const flags = rest.map((token) => token.text);
    // `-exec sudo rm {} \;` is rm behind a wrapper: peeled the same way.
    // `-exec sh -c 'rm -rf ~' \;` carries a whole line: judged as one.
    const execAt = flags.reduce<number[]>((out, flag, at) => ((flag === "-exec" || flag === "-execdir" || flag === "-ok" || flag === "-okdir") ? [...out, at] : out), []);
    for (const at of execAt) {
      const end = rest.findIndex((token, i) => i > at && !token.quoted && (token.text === ";" || token.text === "+"));
      const payload = rest.slice(at + 1, end === -1 ? rest.length : end).filter((token) => token.text !== "{}");
      if (REMOVERS.has(basename(peelWrappers(payload)[0]?.text ?? ""))) continue;
      const carried = payload.length > 0 ? wipeReason(payload, root, home, ownerHome, [], depth + 1) : null;
      if (carried) return carried;
    }
    const execRemoves = (at: number) => REMOVERS.has(basename(peelWrappers(rest.slice(at + 1))[0]?.text ?? ""));
    const deletes = flags.includes("-delete") || execAt.some(execRemoves);
    if (!deletes) return null;
    // `find ~ -name '*.log' -delete` removes the matching files, not the
    // area: an everyday delete. Only an unfiltered sweep is a wipe.
    if (narrowsFind(flags)) return null;
    // The starting points come before the first expression flag, after
    // find's own leading options (`find -H / -delete`); none means the
    // current directory.
    let from = 0;
    const starts: string[] = [];
    while (from < rest.length && /^-[HLPEXsdx]+$/.test(rest[from].text)) from += 1;
    while (from < rest.length && rest[from].text === "-f" && rest[from + 1]) {
      starts.push(rest[from + 1].text);
      from += 2;
    }
    const firstFlag = rest.findIndex((token, at) => at >= from && token.text.startsWith("-") && !token.quoted);
    starts.push(...rest.slice(from, firstFlag === -1 ? rest.length : firstFlag).map((token) => token.text).filter((text) => !/^[0-9]*[<>]/.test(text)));
    for (const start of starts.length > 0 ? starts : ["."]) {
      const broad = broadPath(start, root, home, ownerHome);
      if (broad) return `wipes ${broad} (find -delete)`;
    }
    return null;
  }
  if (/^(mkfs|newfs)([._]|$)/.test(name)) return `formats a disk (${name})`;
  if (name === "diskutil" && rest.some((token) => /^(erase|reformat|partition|zero|random|secureErase|deleteContainer|deleteVolume)/i.test(token.text))) {
    return "erases a disk (diskutil)";
  }
  if (name === "dd" && rest.some((token) => /^of=\/dev\//.test(token.text) && !DEVICE_PATHS.includes(token.text.slice(3)) && token.text !== "of=/dev/zero")) {
    return "writes raw data to a disk (dd)";
  }
  return null;
}

/**
 * A shell script run by name, judged line by line for a wipe. Anything
 * unreadable, too large or not a shell script runs: Full access does not
 * card what it cannot see.
 */
function scriptWipe(path: string, root: string, home: string, ownerHome: string, depth: number): string | null {
  const abs = resolve(root, expandHome(path, home, ownerHome));
  if (/[$`*]/.test(abs)) return null;
  const text = readScript(abs);
  if (!text) return null;
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
  const isShell = /^#!.*\b(sh|bash|zsh|dash|ksh|fish|csh|tcsh|pwsh)\b/.test(firstLine) || /\.(sh|bash|zsh|command|fish|csh|ps1)$/.test(abs) || !firstLine.startsWith("#!");
  if (!isShell) return null;
  const lines = text.split("\n").filter((line) => !/^\s*#/.test(line));
  return wipeRisk(lines.join("\n"), root, home, ownerHome, depth + 1);
}

/**
 * What a remover target covers when it is a whole area of the Mac, or null
 * when it is something smaller. A trailing `/`, `/*` or `/**` names the
 * same area as the folder itself; `*` and `.` name the current root.
 */
function broadPath(text: string, root: string, home: string, ownerHome: string): string | null {
  let target = expandHome(text, home, ownerHome);
  // A target read from a variable is unknown; Full access runs it.
  if (/[$`]/.test(target)) return null;
  if (target === "*") target = ".";
  target = target.replace(/(\/\*{1,2}|\/\.)+\/?$/, "").replace(/\/+$/, "") || (text.startsWith("/") ? "/" : ".");
  const abs = resolve(root, target);
  // A single file directly under the home (`rm ~/notes.txt`) is an
  // everyday delete, not a wipe; only a folder or a name that is not there
  // to look at is judged by its place.
  // A missing name with an extension (`rm ~/notes.txt` after the file is
  // gone) is a file the same way it would be if it were there. That only
  // spares the home-level folder rule: the disk, a volume, a top-level
  // folder and a home are judged whatever the name looks like.
  let fileByName = false;
  try {
    if (statSync(abs).isFile()) return null;
  } catch {
    // `.config` is a dotfolder, not a file called config with no name.
    fileByName = !basename(abs).startsWith(".") && /\.[A-Za-z0-9]{1,8}$/.test(basename(abs));
  }
  const parts = abs.split("/").filter(Boolean);
  if (parts.length === 0) return "the whole disk (/)";
  if (parts.length === 1) return `a top-level folder (${abs})`;
  if (parts[0] === "Volumes" && parts.length === 2) return `a whole volume (${abs})`;
  if (parts[0] === "Users" && parts.length === 2) return `a whole home folder (${abs})`;
  if (parts[0] === "Users" && parts.length === 3) return fileByName ? null : `a top-level home folder (${abs})`;
  const underHome = relative(resolve(ownerHome), abs);
  if (underHome === "") return `a whole home folder (${abs})`;
  if (!underHome.startsWith("..") && !underHome.includes("/")) return fileByName ? null : `a top-level home folder (${abs})`;
  return null;
}

/**
 * `~/x` and `$HOME/x` are the home, spelled the way the shell expands them;
 * `~user/x` is another home altogether. Quoted or not: double quotes still
 * expand `$HOME`, and the tokenizer does not say which quotes it saw.
 */
function expandHome(text: string, home: string, ownerHome: string = home): string {
  if (text === "~" || text.startsWith("~/")) return home + text.slice(1);
  if (/^\$\{?HOME\}?(\/|$)/.test(text)) return home + text.replace(/^\$\{?HOME\}?/, "");
  // `~user` comes from the passwd database, not from HOME: it sits beside
  // the owner's real home whatever HOME the line runs with.
  if (/^~[A-Za-z0-9_.-]+(\/|$)/.test(text)) return join(dirname(ownerHome), text.slice(1));
  return text;
}

/** `opens` subshells begin before this segment, `closes` end after it. */
type Segment = { tokens: Token[]; pipedInto: boolean; opens: number; closes: number };

const isAssignment = (token: Token) => !token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text);

function commandReason(tokens: Token[], root: string, afterPipe: boolean, depth = 0): string | null {
  // `PATH=./bin:$PATH git status` runs whatever ./bin calls git.
  const hijack = tokens.find((token) => !token.quoted && HIJACK_VARS.test(token.text));
  if (hijack) return `changes what a command runs (${hijack.text.split("=")[0]}=)`;
  let args = tokens.filter((token) => !isAssignment(token));
  // Peel wrappers, their flags and their numeric arguments so `env -i FOO=1
  // rm -rf x`, `timeout 5 rm x` and `exec rm x` still see `rm`.
  while (args.length > 0 && WRAPPERS.has(basename(args[0].text))) {
    // `env -S '...'` carries a whole command line as an option value:
    // judged as a line of its own.
    const wrapper = basename(args[0].text);
    const carriedAt = args.findIndex((token, at) => at > 0 && wrapper === "env" && (token.text === "-S" || token.text.startsWith("--split-string")));
    if (carriedAt > 0) {
      const option = args[carriedAt].text;
      const line = option.includes("=") ? option.slice(option.indexOf("=") + 1) : args[carriedAt + 1]?.text;
      if (!line) return `runs a command from the command line (${wrapper} ${option})`;
      const carried = commandRisk(line, root, depth);
      if (carried) return carried;
    }
    // Only the wrapper's own leading options go; the inner command keeps
    // its flags, or `timeout 5 git push --force` would lose its force.
    // Options with a value take it along, so `exec -a backup rm` does not
    // leave `backup` as the head.
    const valued = WRAPPER_VALUED[basename(args[0].text)] ?? new Set<string>();
    let i = 1;
    while (i < args.length && (isAssignment(args[i]) || args[i].text.startsWith("-") || /^\d+[smhd]?$/.test(args[i].text))) {
      i += valued.has(args[i].text) ? 2 : 1;
    }
    args = args.slice(i);
  }
  const head = args[0];
  if (!head) return null;
  // A command the line only names through a variable or a substitution is
  // one this cannot read.
  if (/[$`]/.test(head.text)) return "runs a command from a variable";
  // Quoting is shell syntax, not a safety signal: `"rm"` and `'/bin/rm'`
  // run rm just the same, and `git push "--force"` still forces.
  // A version suffix is not a different program: python3.12 is python.
  const name = basename(head.text).replace(/^(python|pypy|node|ruby|perl|php)[0-9.]+$/, "$1");
  const rest = args.slice(1);
  const flags = rest.map((token) => token.text);

  const words = flags.filter((flag) => !flag.startsWith("-"));

  if (DESTRUCTIVE_COMMANDS[name]) return `${DESTRUCTIVE_COMMANDS[name]} (${name})`;
  if (OPAQUE_LAUNCHERS[name]) return OPAQUE_LAUNCHERS[name];
  if (EDITORS[name]) return EDITORS[name];
  // Copying a device over a file empties it, the way truncate does.
  if ((name === "cp" || name === "install" || name === "dd") && flags.some((flag) => /^(if=)?\/dev\/(null|zero)$/.test(flag))) {
    return `empties a file (${name} /dev/null)`;
  }
  if (SHELLS.has(name)) {
    if (afterPipe) return `pipes into a shell (${name})`;
    // `sh -c "..."` runs its argument: classify that line on its own. A
    // script from the folder is read and judged; anything else a shell is
    // fed (stdin, -s, a file elsewhere) is a payload this cannot read.
    const at = rest.findIndex((token) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token.text));
    const payload = at >= 0 ? rest[at + 1] : null;
    if (payload) return commandRisk(payload.text, root, depth);
    const script = words[0] ? fileUnderRoot(words[0], root) : null;
    if (script) return scriptRisk(script, root, depth, "shell");
    return `runs a shell script (${name})`;
  }
  if (name === "source" || name === ".") {
    const script = words[0] ? fileUnderRoot(words[0], root) : null;
    return script ? scriptRisk(script, root, depth, "shell") : "runs a shell script (source)";
  }
  if (name === "eval") return commandRisk(rest.map((token) => token.text).join(" "), root, depth);
  if (INTERPRETERS.has(name)) {
    if (flags.some((flag) => /^-[a-zA-Z]*[ceEpr]/.test(flag) || flag === "--eval" || flag === "--print")) {
      return `runs inline code (${name} -e)`;
    }
    // `curl ... | python3` runs whatever came down the pipe.
    if (afterPipe && !words[0]) return `runs code from stdin (${name})`;
    // Code from stdin, or from a descriptor, is a payload this cannot read.
    if (flags.some((flag) => flag === "-" || flag === "<" || flag.startsWith("<") || flag.startsWith("/dev/"))) {
      return `runs code from stdin (${name})`;
    }
    // `python -m pip install .` is pip; other modules are the interpreter's
    // own. Only python has this form, and only before the first positional:
    // a `-m` after a script name belongs to the script.
    const firstWordAt = flags.findIndex((flag) => !flag.startsWith("-"));
    const moduleAt = flags.indexOf("-m");
    if ((name === "python" || name === "pypy") && moduleAt >= 0 && (firstWordAt === -1 || moduleAt < firstWordAt)) {
      const module = flags[moduleAt + 1];
      if ((module === "pip" || module === "pip3") && flags.includes("install") && flags.some(isLocalInstall)) {
        return "runs the project's setup (pip install .)";
      }
      if ((module === "pip" || module === "pip3") && flags.includes("install")) return "installs packages (python -m pip install)";
      return null;
    }
    if (name === "deno") {
      if (words[0] === "eval") return "runs inline code (deno eval)";
      if (words[0] === "run" || words[0] === "task") {
        const target = words.slice(1).find((word) => !word.startsWith("-"));
        if (!target) return null;
        const script = fileUnderRoot(target, root);
        return script ? scriptRisk(script, root, depth, "source") : `downloads and runs a package (deno run ${target})`;
      }
      return null;
    }
    // bun is a package manager too: only its interpreter forms end here.
    if (name !== "bun" || (words[0] && fileUnderRoot(words[0], root))) {
      const script = words[0] ? fileUnderRoot(words[0], root) : null;
      return script ? scriptRisk(script, root, depth, "source") : null;
    }
  }
  if (name === "xargs") {
    // Skip xargs's own options to the command it runs, then judge that.
    let i = 0;
    while (i < rest.length && rest[i].text.startsWith("-")) {
      i += XARGS_VALUED.has(rest[i].text) ? 2 : 1;
    }
    const inner = commandReason(rest.slice(i), root, false, depth);
    return inner ? `${inner.replace(/\)$/, "")} via xargs)` : null;
  }
  if (name === "find") {
    // Every -exec is judged, each up to its own `;` or `+`.
    for (let i = 0; i < rest.length; i += 1) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[i].text)) continue;
      let end = i + 1;
      while (end < rest.length && ![";", "\\;", "+"].includes(rest[end].text)) end += 1;
      const inner = commandReason(rest.slice(i + 1, end), root, false, depth);
      if (inner) return `${inner.replace(/\)$/, "")} via find -exec)`;
      i = end;
    }
    return rest.some((token) => token.text === "-delete") ? "deletes files (find -delete)" : null;
  }
  if (PACKAGE_RUNNERS.has(name) || ((name === "npm" || name === "pnpm" || name === "yarn" || name === "bun")
    && ["exec", "x", "dlx", "create", "init"].includes(words[0] ?? ""))) {
    return packageRunnerRisk(name, rest, root, depth);
  }
  if (name === "awk" || name === "gawk" || name === "mawk" || name === "nawk") {
    // An awk program can shell out; that is a command this cannot read,
    // whether it sits on the line or in a -f file.
    const shellsOut = /\bsystem\s*\(|\|\s*"|"\s*\||\bgetline\b/;
    if (rest.some((token) => shellsOut.test(token.text))) return `runs a command from awk (${name} system())`;
    // Every spelling of the program file: -f x, -fx, --file=x, --source-file=x.
    const programs: string[] = [];
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      if (flag === "-f" || flag === "--file" || flag === "--source-file") {
        programs.push(flags[i + 1] ?? "");
        i += 1;
        continue;
      }
      const attached = /^(?:--file=|--source-file=|-f)(.+)$/.exec(flag);
      if (attached) programs.push(attached[1]);
    }
    for (const program of programs) {
      const file = program ? fileUnderRoot(program, root) : null;
      const text = file ? readScript(file) : null;
      if (!text) return `runs an awk program this cannot read (${name} -f)`;
      if (shellsOut.test(text)) return `runs a command from awk (${name} -f ${program})`;
    }
  }
  if (name === "rsync" && flags.some((flag) => flag.startsWith("--delete"))) return "deletes at the destination (rsync --delete)";
  if (name === "chmod" && flags.some((flag) => /^-[a-zA-Z]*R/.test(flag))) return "changes permissions recursively (chmod -R)";
  const configDestination = configFolderDestinationRisk(name, flags);
  if (configDestination) return configDestination;
  if (name === "git") return gitRisk(flags, root);
  if (name === "make") return makeRisk(flags, root, depth);
  if (VERB_CLIS.has(name)) {
    const verbs = words.slice(0, 2);
    const hit = verbs.find((verb) => DESTRUCTIVE_VERBS.has(verb));
    if (hit) return `${hit === "publish" ? "publishes" : "removes something"} (${name} ${hit})`;
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      // What the project's own lifecycle scripts do is the sharper reason;
      // an install with nothing worse in it still asks, because it runs
      // install scripts of whatever it fetches.
      return packageScriptRisk(name, words, root, depth) ?? packageInstallRisk(name, words, flags);
    }
    // Installing the project itself runs its setup code.
    if ((name === "pip" || name === "pip3" || name === "uv") && words[0] === "install" && flags.some(isLocalInstall)) {
      return `runs the project's setup (${name} install .)`;
    }
    return packageInstallRisk(name, words, flags) ?? cloudDeployRisk(name, words, flags);
  }
  // A script from the folder run by path: judged by what it does.
  const script = fileUnderRoot(head.text, root);
  if (script) return scriptRisk(script, root, depth);
  // An unknown launcher with a destructive command among its arguments.
  const carried = rest.find((token) => !token.quoted && DESTRUCTIVE_COMMANDS[basename(token.text)]);
  if (carried) return `${DESTRUCTIVE_COMMANDS[basename(carried.text)]} (${name} ${basename(carried.text)})`;
  return null;
}

/**
 * `npx tool`, `npm exec tool`, `pnpm dlx`, `yarn dlx`, `bunx`: a tool
 * already installed in the folder runs; one that would be fetched, or a
 * plain command smuggled behind `--`, asks.
 */
function packageRunnerRisk(name: string, rest: Token[], root: string, depth: number): string | null {
  let i = 0;
  if (!PACKAGE_RUNNERS.has(name)) i = 1; // past exec / dlx / create
  while (i < rest.length && (rest[i].text.startsWith("-") && rest[i].text !== "--")) {
    const option = rest[i].text;
    // `-c` carries a shell line; `-p` names a package to fetch.
    if (option === "-c" || option === "--call" || option.startsWith("--call=")) {
      const line = option.includes("=") ? option.slice(option.indexOf("=") + 1) : rest[i + 1]?.text;
      return (line ? commandRisk(line, root, depth) : null) ?? `runs a shell line (${name} --call)`;
    }
    if (option === "-p" || option === "--package" || option.startsWith("--package=")) {
      return `downloads and runs a package (${name} --package)`;
    }
    i += 1;
  }
  if (rest[i]?.text === "--") i += 1;
  const tool = rest[i];
  if (!tool) return rest.length > 0 ? `runs something this cannot read (${name})` : null;
  const inner = commandReason(rest.slice(i), root, false, depth);
  if (inner) return `${inner.replace(/\)$/, "")} via ${name})`;
  let local = false;
  try {
    local = statSync(join(root, "node_modules", ".bin", basename(tool.text))).isFile();
  } catch {
    local = false;
  }
  return local ? null : `downloads and runs a package (${name} ${tool.text})`;
}

// MARK: - Scripts

/** The file a token names, when it is a regular file inside the folder. */
function fileUnderRoot(candidate: string, root: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  const abs = resolve(root, candidate);
  const inside = root.endsWith("/") ? root : `${root}/`;
  if (!abs.startsWith(inside)) return null;
  // Vendored tools are not the owner's scripts, and far too large to read.
  if (abs.includes("/node_modules/")) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

function readScript(abs: string): string | null | undefined {
  try {
    const bytes = readFileSync(abs);
    // Too large to read through; the caller asks rather than trusts.
    if (bytes.length > MAX_SCRIPT_BYTES) return undefined;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * What a script from the folder does. Shell scripts are judged line by
 * line with the same rules; other sources are scanned for the calls that
 * delete or shell out.
 */
function scriptRisk(abs: string, root: string, depth: number, kind?: "shell" | "source"): string | null {
  const label = relative(root, abs);
  // Deeper than this is a chain of scripts nobody has read.
  if (depth >= MAX_DEPTH) return `runs scripts more than ${MAX_DEPTH} levels deep (${label})`;
  const text = readScript(abs);
  if (text === undefined) return `runs a script too large to check (${label})`;
  if (text === null) return `runs a script this cannot read (${label})`;
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
  const isShell = kind === "shell"
    || /^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(firstLine)
    || /\.(sh|bash|zsh|command)$/.test(abs);
  if (isShell) return shellScriptRisk(text, root, depth, label);
  if (kind === "source" || /^#!/.test(firstLine) || /\.(py|js|mjs|cjs|ts|rb|pl|php)$/.test(abs)) {
    return sourceRisk(text, label);
  }
  return null;
}

function shellScriptRisk(text: string, root: string, depth: number, label: string): string | null {
  for (const raw of text.replace(/\\\n/g, " ").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const reason = commandRisk(line, root, depth + 1);
    if (reason) return `${label}: ${reason}`;
  }
  return null;
}

/** Calls in a Python, JavaScript, Ruby or Perl script that delete or shell out. */
const SOURCE_PATTERNS: [RegExp, string][] = [
  [/\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\bsend2trash\b|\.unlink\(|\.rmdir\(|\brmtree\(/, "deletes files"],
  [/\bfs(?:Promises|\.promises)?\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b|\brimraf\b|\bremoveSync\(|\bemptyDir(?:Sync)?\(|\bDeno\.remove(?:Sync)?\b/, "deletes files"],
  [/\bFileUtils\.(rm|rm_r|rm_rf|remove\w*)\b|\bFile\.delete\b|\bunlink\b/, "deletes files"],
  [/\bsubprocess\b|\bos\.system\b|\bos\.popen\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bshelljs\b|\bexeca\b|\bsystem\(|\bKernel\.exec\b/, "shells out"],
  [/\brm -[a-z]*[rf]|git push --force|git push -f\b|git reset --hard|git clean\b|\bsudo\b/, "contains a destructive command"],
];

function sourceRisk(text: string, label: string): string | null {
  for (const [pattern, reason] of SOURCE_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) return `${label}: ${reason} (${hit[0].trim()})`;
  }
  return null;
}

/** The package.json script a package-manager line runs, judged as a line. */
function packageScriptRisk(manager: string, words: string[], root: string, depth: number): string | null {
  let name: string | undefined;
  // Installing runs the project's own lifecycle scripts too.
  const installing = ["install", "i", "ci", "add", "up", "update"].includes(words[0] ?? "") || words.length === 0;
  if (installing) name = "install";
  else if (manager === "npm") {
    if (words[0] === "run" || words[0] === "run-script") name = words[1];
    else if (["test", "start", "stop", "restart"].includes(words[0] ?? "")) name = words[0];
  } else {
    name = words[0] === "run" ? words[1] : words[0];
  }
  if (!name) return null;
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return null;
  }
  const keys = installing ? ["preinstall", "install", "postinstall", "prepare"] : [`pre${name}`, name, `post${name}`];
  for (const key of keys) {
    const line = scripts[key];
    if (typeof line !== "string") continue;
    const reason = commandRisk(line, root, depth + 1);
    if (reason) return `package.json ${key}: ${reason}`;
  }
  return null;
}

/** The Makefile recipes a `make` line runs, targets and prerequisites both. */
function makeRisk(flags: string[], root: string, depth: number): string | null {
  // `-f file` and `-C dir` choose the makefile; `-j4` and friends do not.
  let dir = root;
  const files: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    // Make code on the command line runs at parse time, before any target.
    if (flag === "--eval" || flag === "-E" || flag.startsWith("--eval=")) return "runs make code from the command line (make --eval)";
    if (flag === "-f" || flag === "--file" || flag === "--makefile") files.push(flags[++i] ?? "");
    else if (flag.startsWith("--file=") || flag.startsWith("--makefile=")) files.push(flag.slice(flag.indexOf("=") + 1));
    else if (/^-f./.test(flag)) files.push(flag.slice(2));
    else if (flag === "-C" || flag === "--directory") dir = resolve(root, flags[++i] ?? ".");
    else if (flag.startsWith("--directory=")) dir = resolve(root, flag.slice(12));
    else if (/^-C./.test(flag)) dir = resolve(root, flag.slice(2));
    else if (!flag.startsWith("-")) words.push(flag);
  }
  // A makefile from stdin or a device is a payload this cannot read.
  if (files.some((file) => file === "-" || file.startsWith("/dev/"))) return "runs a makefile this cannot read (make -f -)";
  if (files.length === 0) files.push("Makefile", "makefile", "GNUmakefile");
  let text: string | null = null;
  for (const name of files) {
    const file = fileUnderRoot(resolve(dir, name), root);
    if (file) {
      const read = readScript(file);
      if (read === undefined || read === null) return `runs a makefile this cannot read (${name})`;
      text = read;
      break;
    }
    // A makefile named on the line that this cannot read is a payload.
    if (!["Makefile", "makefile", "GNUmakefile"].includes(name)) return `runs a makefile this cannot read (${name})`;
  }
  if (!text) return null;
  // Make functions that run commands at parse time, before any target.
  const fn = /\$[({](shell|eval|file)\b/.exec(text);
  if (fn) return `Makefile: runs a shell at parse time ($(${fn[1]}))`;
  const targets = new Map<string, { deps: string[]; recipe: string[] }>();
  // Plain `NAME = value` definitions, so `rm -rf $(APP)` is judged on the
  // path it names; automatic variables become a neutral placeholder.
  const vars = new Map<string, string>();
  const expand = (line: string): string => line
    .replace(/\$[({]([^)}]+)[)}]/g, (_, name: string) => vars.get(name) ?? name)
    .replace(/\$[@<^*?%+|]/g, "_");
  let first: string | null = null;
  let current: string[] = [];
  for (const raw of text.replace(/\\\n/g, " ").split("\n")) {
    if (raw.startsWith("\t")) {
      for (const name of current) targets.get(name)?.recipe.push(expand(expand(raw.trim())));
      continue;
    }
    const definition = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:?+]?=\s*(.*)$/.exec(raw);
    if (definition) {
      vars.set(definition[1], expand(definition[2].trim()));
      continue;
    }
    const rule = /^([^\s:#=]+(?:\s+[^\s:#=]+)*)\s*:(?![=:])\s*(.*)$/.exec(raw);
    if (!rule) {
      if (raw.trim() && !raw.startsWith(" ")) current = [];
      continue;
    }
    current = rule[1].split(/\s+/).filter((name) => !name.startsWith("."));
    const deps = rule[2].split(/\s+/).filter(Boolean);
    for (const name of current) {
      if (!targets.has(name)) targets.set(name, { deps: [], recipe: [] });
      targets.get(name)!.deps.push(...deps);
      first ??= name;
    }
  }
  const requested = words.filter((word) => !word.includes("="));
  const queue = requested.length > 0 ? requested : first ? [first] : [];
  // Included makefiles are judged as a whole, whatever target they serve.
  for (const inc of text.matchAll(/^-?include\s+(.+)$/gm)) {
    for (const name of inc[1].split(/\s+/)) {
      const file = fileUnderRoot(resolve(dir, expand(name)), root);
      if (!file) continue;
      const reason = scriptRisk(file, root, depth, "shell");
      if (reason) return `Makefile include: ${reason}`;
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const target = targets.get(name);
    if (!target) continue;
    for (const line of target.recipe) {
      const command = line.replace(/^[@+-]+\s*/, "");
      if (!command) continue;
      const reason = commandRisk(command, root, depth + 1);
      if (reason) return `Makefile ${name}: ${reason}`;
    }
    queue.push(...target.deps);
  }
  return null;
}

/** Git's own options that take a value, before the subcommand. */
const GIT_VALUED_GLOBALS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);

/** `.`, `-e .`, `-e.`, `--editable=.`, `./pkg`: installing the project itself. */
function isLocalInstall(flag: string): boolean {
  return flag === "." || flag.startsWith("./") || flag.startsWith("-e") || flag.startsWith("--editable");
}

function gitRisk(all: string[], root: string): string | null {
  // `-c alias.x='!rm -rf .' x` runs a shell through git's config; no
  // subcommand parse can see that, so config on the line always asks.
  const flags: string[] = [];
  let beforeSubcommand = true;
  for (let i = 0; i < all.length; i += 1) {
    const flag = all[i];
    if (beforeSubcommand) {
      if (flag === "-c" || flag === "--config-env" || flag.startsWith("--config-env=")) {
        return "sets git config on the command line (git -c)";
      }
      // `--exec-path=./evil` makes git run whatever sits there.
      if (flag === "--exec-path" || flag.startsWith("--exec-path=")) return "changes where git finds its commands (git --exec-path)";
      if (GIT_VALUED_GLOBALS.has(flag)) {
        i += 1;
        continue;
      }
      if ([...GIT_VALUED_GLOBALS].some((name) => flag.startsWith(`${name}=`))) continue;
      // The first plain word is the subcommand; `-C` after it is its own.
      if (!flag.startsWith("-")) beforeSubcommand = false;
    }
    flags.push(flag);
  }
  const words = flags.filter((flag) => !flag.startsWith("-"));
  const sub = words[0];
  const has = (...names: string[]) => flags.some((flag) => names.includes(flag));
  switch (sub) {
    case "reset":
      if (has("--hard", "--merge", "--keep")) return "discards changes (git reset --hard)";
      // Moving the branch to another commit rewrites its history even when
      // the working tree is kept; unstaging (`git reset HEAD file`) does not.
      if (has("--soft", "--mixed")) return "moves the branch (git reset --soft)";
      // `git reset HEAD`, `git reset -- path` and `git reset path` unstage;
      // any other first word is a commit the branch would move to.
      if (!words[1] || words[1] === "HEAD" || has("--")) return null;
      return fileUnderRoot(words[1], root) ? null : "moves the branch (git reset <commit>)";
    case "clean":
      return "deletes untracked files (git clean)";
    case "push":
      if (has("-f", "--force", "--force-with-lease", "--force-if-includes", "-d", "--delete", "--mirror", "--prune")) {
        return "rewrites or deletes a remote branch (git push --force)";
      }
      return flags.some((flag) => /^[+:]/.test(flag)) ? "rewrites or deletes a remote branch (git push)" : null;
    case "branch":
      if (has("-d", "-D", "--delete")) return "deletes a branch (git branch -D)";
      return has("-f", "--force", "-m", "-M", "--move") ? "moves or overwrites a branch (git branch -f)" : null;
    case "checkout":
      if (has("-B", "--orphan")) return "overwrites or restarts a branch (git checkout -B)";
      if (has("-f", "--force")) return "discards working changes (git checkout -f)";
      return has("--", ".") && !has("-b") ? "discards working changes (git checkout)" : null;
    case "submodule":
      // `foreach` runs its argument as a shell line in every submodule.
      if (words[1] === "foreach") return commandRisk(words.slice(2).join(" "), root) ?? (words[2] ? null : "runs a shell line (git submodule foreach)");
      return words[1] === "deinit" || words[1] === "absorbgitdirs" || (words[1] === "update" && has("-f", "--force", "--checkout"))
        ? `rewrites a submodule (git submodule ${words[1]})`
        : null;
    case "bisect":
      // `bisect run <cmd>` runs the command at every step.
      return words[1] === "run" ? commandRisk(words.slice(2).join(" "), root) ?? null : null;
    case "difftool":
    case "mergetool":
      return has("-x", "--extcmd", "--tool", "-t") || flags.some((flag) => flag.startsWith("--extcmd=") || flag.startsWith("--tool="))
        ? `runs an external tool (git ${sub})`
        : null;
    case "switch":
      return has("-C", "--force-create", "-f", "--force", "--discard-changes", "--orphan") ? "overwrites a branch or discards changes (git switch -C)" : null;
    case "restore":
      return has("--staged", "-S") && !has("--worktree", "-W") ? null : "discards working changes (git restore)";
    case "stash":
      return words[1] === "drop" || words[1] === "clear" ? `deletes stashed changes (git stash ${words[1]})` : null;
    case "rebase":
    case "filter-branch":
    case "filter-repo":
    case "replace":
      return `rewrites history (git ${sub})`;
    case "commit":
      return has("--amend") ? "rewrites history (git commit --amend)" : null;
    case "reflog":
      return words[1] === "expire" || words[1] === "delete" ? `deletes reflog entries (git reflog ${words[1]})` : null;
    case "gc":
      return has("--prune") || flags.some((flag) => flag.startsWith("--prune=")) ? "prunes objects (git gc --prune)" : null;
    case "tag":
      if (has("-d", "--delete")) return "deletes a tag (git tag -d)";
      return has("-f", "--force") ? "overwrites a tag (git tag -f)" : null;
    case "symbolic-ref":
      // `git symbolic-ref HEAD` reads; a second word writes, -d deletes.
      return words.length > 2 || has("--delete", "-d") ? "rewrites a ref (git symbolic-ref)" : null;
    case "worktree":
      return words[1] === "remove" || words[1] === "prune" ? `removes a worktree (git worktree ${words[1]})` : null;
    case "rm":
      return "deletes tracked files (git rm)";
    case "update-ref":
      return has("-d") ? "deletes a ref (git update-ref -d)" : "rewrites a ref (git update-ref)";
    case "config":
      // Reads are fine; a write can plant an alias that runs a shell later.
      if (has("--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope")) return null;
      return words.length >= 3 || has("--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--remove-section", "--rename-section")
        ? "writes git config (git config)"
        : null;
    case "remote":
      if (words[1] === "remove" || words[1] === "rm" || words[1] === "prune") return `removes from a remote (git remote ${words[1]})`;
      return words[1] === "set-url" ? "rewrites a remote (git remote set-url)" : null;
    case "clone":
      return has("-c", "--config") || flags.some((flag) => flag.startsWith("--config=")) ? "sets git config on the command line (git clone -c)" : null;
    case "fetch":
    case "pull":
      return has("-p", "--prune", "--prune-tags") ? `deletes stale refs (git ${sub} --prune)` : null;
    case "prune":
    case "prune-packed":
      return `deletes unreachable objects (git ${sub})`;
    case "repack":
      return has("-d", "-A") ? "deletes packed objects (git repack -d)" : null;
    case "notes":
      return words[1] === "remove" || words[1] === "prune" ? `deletes notes (git notes ${words[1]})` : null;
    default:
      return null;
  }
}

/** An absolute path that is neither the folder, a system binary nor a device. */
function outsideFolder(tokens: Token[], root: string): string | null {
  const inside = root.endsWith("/") ? root : `${root}/`;
  const home = homedir();
  for (const token of tokens) {
    // `>/tmp/x` and `2>/var/log/y` carry the path behind the redirection.
    // `~/x` and `$HOME/x` are the home, spelled the way the shell expands
    // them, so a project folder does not mistake them for a relative path.
    const text = expandHome(token.text.replace(/^[0-9]*[<>|&]+/, ""), home);
    if (!text.startsWith("/")) continue;
    if (text === root || text.startsWith(inside)) continue;
    if (DEVICE_PATHS.some((device) => text === device || text.startsWith(device.endsWith("/") ? device : `${device}/`))) continue;
    if (SYSTEM_BIN_PREFIXES.some((prefix) => text.startsWith(prefix) && !text.slice(prefix.length).includes("/"))) continue;
    return `reaches outside the folder (${text})`;
  }
  return null;
}

function basename(text: string): string {
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * The program this line runs, when the line runs exactly one and nothing
 * else. Null for anything with a chain, a pipe, a substitution, a
 * redirection, an environment prefix or a variable in the program's own
 * name.
 *
 * This is what decides whether a command is handed the credentials of the
 * CLI it names (see `credentialPathsFor`), so it answers narrowly on
 * purpose: a "no" costs that one run its sign-in, a wrong "yes" hands a
 * second command on the same line a token it was never meant to see.
 */
export function loneCommandHead(command: string): string | null {
  const tokens = tokenize(command.replace(/\\\n/g, " "));
  // A separator means a second command, a subshell or a backtick.
  if (tokens.some((item) => "separator" in item)) return null;
  const plain = tokens as Token[];
  for (const token of plain) {
    if (token.quoted) continue;
    // `>out`, `2>&1`, `<in`: the line does more than run the program.
    // Tested across the whole token, not just its start: `tokenize` does not
    // split on a redirection, so `codex foo>/tmp/x` arrives as one token and
    // a check anchored at the head would read it as a plain argument.
    if (/[<>]/.test(token.text)) return null;
    // `PATH=... codex` runs whatever that PATH resolves.
    if (isAssignment(token)) return null;
  }
  const head = plain[0];
  // A quoted or expanded head is not a name this can verify.
  if (!head || head.quoted || head.text.includes("$") || head.text.length === 0) return null;
  return head.text;
}

/** Split into segments at `&&`, `||`, `;`, `|`, `&` and newlines. */
function split(tokens: (Token | { separator: string })[]): Segment[] {
  const segments: Segment[] = [];
  let current: Token[] = [];
  let pipedInto = false;
  let opens = 0;
  for (const item of tokens) {
    if ("separator" in item) {
      const pushed = current.length > 0;
      if (pushed) segments.push({ tokens: current, pipedInto, opens, closes: 0 });
      if (pushed) opens = 0;
      current = [];
      // A paren is not a pipe boundary: `echo x | (sh)` still pipes into sh.
      if (item.separator === "(" || item.separator === ")") {
        if (pushed) pipedInto = false;
      } else {
        pipedInto = item.separator === "|";
      }
      if (item.separator === "(") opens += 1;
      // A close belongs to the segment it ends; one with nothing before it
      // (`()`) closes the open that never held a segment.
      if (item.separator === ")") {
        if (segments.length > 0 && opens === 0) segments[segments.length - 1].closes += 1;
        else if (opens > 0) opens -= 1;
      }
      continue;
    }
    current.push(item);
  }
  if (current.length > 0) segments.push({ tokens: current, pipedInto, opens, closes: 0 });
  return segments;
}

/**
 * A small shell tokenizer: quotes group, backslashes escape, and the
 * operators above separate. Parentheses and backticks open a new segment
 * so `$(rm -rf x)`, `( rm x )` and `<(rm x)` are all seen as `rm`.
 */
function tokenize(command: string): (Token | { separator: string })[] {
  const out: (Token | { separator: string })[] = [];
  let buffer = "";
  let quoted = false;
  let inSingle = false;
  let inDouble = false;
  const flush = () => {
    if (buffer.length > 0 || quoted) out.push({ text: buffer, quoted });
    buffer = "";
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else buffer += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        buffer += command[i + 1];
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === "'") { inSingle = true; quoted = true; continue; }
    if (ch === '"') { inDouble = true; quoted = true; continue; }
    if (ch === "\\" && i + 1 < command.length) { buffer += command[i + 1]; i += 1; continue; }
    if (ch === "`") { flush(); out.push({ separator: ";" }); continue; }
    if (ch === "(" || ch === ")") { flush(); out.push({ separator: ch }); continue; }
    if (ch === "&" && command[i + 1] === "&") { flush(); out.push({ separator: "&&" }); i += 1; continue; }
    if (ch === "|" && command[i + 1] === "|") { flush(); out.push({ separator: "||" }); i += 1; continue; }
    if (SEPARATORS.has(ch)) { flush(); out.push({ separator: ch }); continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { flush(); continue; }
    buffer += ch;
  }
  flush();
  return out;
}

/**
 * Whether a line only looks: every command in it reads, prints or measures,
 * nothing is redirected into a file, and nothing that runs other programs
 * (`xargs`, `find -exec`, a shell, an interpreter with code) is on it. Such
 * a line runs without a card in every posture, because reading is what the
 * owner expects a bot to do on its own, and it runs with every write refused
 * anyway. Returns why the line is not read-only, or null when it is.
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "rg", "ag",
  "fd", "stat", "file", "du", "df", "pwd", "echo", "printf", "date", "cal", "which", "whereis",
  "type", "uname", "id", "whoami", "sw_vers", "printenv", "tree", "diff", "cmp",
  "comm", "sort", "cut", "tr", "column", "nl", "od", "xxd", "hexdump", "strings", "basename",
  "dirname", "realpath", "readlink", "md5", "md5sum", "shasum", "sha256sum", "cksum", "base64",
  "jq", "yq", "mdfind", "mdls", "ps", "lsof", "netstat", "system_profiler",
  "uptime", "w", "who", "last", "env", "locale", "getconf",
  "cd", "pushd", "popd", "true", "false", "test", "[", ":", "seq", "expr", "bc", "sleep",
  "tput", "tty", "otool", "nm", "iconv", "expand", "unexpand", "fold", "fmt", "paste",
  "join", "look", "rev", "tac", "zcat", "gzcat", "bzcat", "xzcat", "zipinfo",
  "git", "brew", "npm", "pip", "pip3", "docker", "defaults", "launchctl",
]);
// Deliberately absent: anything that reads AND writes through one binary
// with a flag (`sysctl -w`, `hostname name`, `ifconfig ... up`, `xattr -d`,
// `plutil -replace`, `codesign -s`, `spctl --master-disable`), and `tar`,
// whose listing form still runs a program per member with `--to-command`.
// Those ask like any other change.

/** Per command, the flags that turn a read into a change. */
const READ_ONLY_REFUSED: Record<string, Set<string>> = {
  date: new Set(["-s", "--set"]),
  sort: new Set(["-o", "--output"]),
  fd: new Set(["-x", "--exec", "-X", "--exec-batch"]),
  rg: new Set(["--pre", "--pre-glob"]),
};

/** Commands whose first argument decides: only these forms read. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  brew: new Set(["list", "ls", "info", "deps", "outdated", "search", "config", "doctor", "--version", "-v", "--prefix"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why", "-v", "--version", "root", "prefix"]),
  pip: new Set(["list", "show", "freeze", "check", "--version"]),
  pip3: new Set(["list", "show", "freeze", "check", "--version"]),
  docker: new Set(["ps", "images", "inspect", "logs", "version", "info", "stats", "top", "port"]),
  defaults: new Set(["read", "domains", "find"]),
  launchctl: new Set(["list", "print", "version", "blame", "dumpstate"]),
};

/** Interpreters may only report their version; anything else runs code. */
const VERSION_FLAGS = new Set(["--version", "-V", "-v", "version"]);

const GIT_READS = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "grep", "describe",
  "shortlog", "cat-file", "rev-list", "count-objects", "check-ignore", "diff-tree", "name-rev", "var",
]);
/** Per subcommand, the flags and words that make a listing form write. */
const GIT_WRITES: Record<string, Set<string>> = {
  branch: new Set(["-d", "-D", "-m", "-M", "-c", "-C", "-u", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"]),
  tag: new Set(["-a", "-s", "-u", "-m", "-F", "-d", "-f", "--annotate", "--sign", "--delete", "--force", "--edit"]),
  config: new Set(["--add", "--unset", "--unset-all", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section", "--global", "--system", "--worktree", "--local"]),
  remote: new Set(["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"]),
  stash: new Set(["pop", "apply", "drop", "push", "save", "clear", "branch", "create", "store"]),
  worktree: new Set(["add", "remove", "move", "prune", "lock", "unlock", "repair"]),
  reflog: new Set(["expire", "delete", "exists"]),
};

/** `git <sub> <rest>`: true when that form only reads. */
function gitReadOnly(sub: string, rest: string[]): boolean {
  if (GIT_READS.has(sub)) return true;
  const writes = GIT_WRITES[sub];
  if (!writes) return false;
  if (rest.some((word) => writes.has(word) || writes.has(word.split("=")[0]))) return false;
  const positional = rest.filter((word) => !word.startsWith("-"));
  switch (sub) {
    case "branch":
    case "tag":
      // Bare or with listing flags it lists; a name creates one.
      return positional.length === 0 || rest.some((word) => word === "-l" || word === "--list" || word.startsWith("--contains") || word.startsWith("--points-at") || word.startsWith("--merged") || word.startsWith("--no-merged"));
    case "remote":
      return positional.length === 0 || positional[0] === "show" || positional[0] === "get-url";
    case "stash":
      return positional[0] === "list" || positional[0] === "show";
    case "worktree":
      return positional[0] === "list";
    case "reflog":
      return positional.length === 0 || positional[0] === "show";
    case "config":
      // `git config user.name` reads; a second positional sets it.
      return rest.some((word) => word === "--get" || word === "--get-all" || word === "--get-regexp" || word === "--list" || word === "-l" || word === "--show-origin" || word === "--show-scope")
        ? true
        : positional.length === 1;
    default:
      return false;
  }
}

/** Redirections are judged in `readOnlyRisk`; here they are not arguments. */
const isRedirection = (text: string) => /^[0-9]*[<>]|^&>/.test(text);

function readOnlySegment(tokens: Token[]): string | null {
  // `GIT_EXTERNAL_DIFF=/bin/rm git diff` runs rm: an assignment that changes
  // what a command runs makes the line a change, the way commandReason sees it.
  const hijack = tokens.find((token) => !token.quoted && HIJACK_VARS.test(token.text));
  if (hijack) return `changes what a command runs (${hijack.text.split("=")[0]}=)`;
  let args = tokens.filter((token, index, all) => {
    if (isAssignment(token)) return false;
    if (!token.quoted && isRedirection(token.text)) return false;
    // The target of a bare `>` or `2>` sits in the token after it.
    const before = all[index - 1];
    return !(before && !before.quoted && /^[0-9]*(>>?|&>|>\||<)$/.test(before.text));
  });
  // Peel timing and priority wrappers the way commandReason does; `env` with
  // a command after it is itself a launcher, handled below.
  while (args.length > 0 && WRAPPERS.has(basename(args[0].text)) && basename(args[0].text) !== "env") {
    const valued = WRAPPER_VALUED[basename(args[0].text)] ?? new Set<string>();
    let i = 1;
    while (i < args.length && (isAssignment(args[i]) || args[i].text.startsWith("-") || /^\d+[smhd]?$/.test(args[i].text))) {
      i += valued.has(args[i].text) ? 2 : 1;
    }
    args = args.slice(i);
  }
  if (args.length === 0) return null;
  // A head with a path in it is a program the owner did not necessarily
  // install: `./ls`, `node_modules/.bin/cat`. Only the system directories
  // vouch for a name; anything else is judged as a change.
  const headText = args[0].text;
  if (headText.includes("/") && !SYSTEM_BIN_PREFIXES.some((prefix) => headText.startsWith(prefix) && !headText.slice(prefix.length).includes("/"))) {
    return `runs a program by path (${headText})`;
  }
  const head = basename(headText);
  const rest = args.slice(1).map((token) => token.text);
  if (head === "xargs" || head === "parallel") return `runs other commands (${head})`;
  if (head === "env") return rest.length === 0 ? null : "env runs another command";
  if (head === "find") {
    const refused = rest.find((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls", "-fprint0"].includes(word));
    return refused ? `find ${refused} changes or runs things` : null;
  }
  // `python3`, `python3.12`, `node22`: the interpreter, whatever its version suffix.
  const bare = head.replace(/[0-9.]+$/, "");
  if (SHELLS.has(head) || INTERPRETERS.has(head) || INTERPRETERS.has(bare)) {
    return rest.length === 1 && VERSION_FLAGS.has(rest[0]) ? null : `${head} runs code`;
  }
  if (!READ_ONLY_COMMANDS.has(head)) return `${head} is not a read-only command`;
  if (head === "git") {
    const at = rest.findIndex((word) => !word.startsWith("-"));
    const sub = at >= 0 ? rest[at] : "";
    // A global option ahead of the subcommand (`--exec-path=`, `-c`,
    // `--git-dir`) changes which git runs or what it reads; none is a read.
    if (at > 0) return `git ${rest[0]} changes how git runs`;
    const after = rest.slice(at + 1);
    if (after.some((word) => word === "--ext-diff" || word.startsWith("--output"))) return "git runs an external tool or writes a file";
    return sub && gitReadOnly(sub, after) ? null : `git ${sub || "(no subcommand)"} is not read-only`;
  }
  const subs = READ_ONLY_SUBCOMMANDS[head];
  if (subs) {
    const first = rest[0] ?? "";
    return subs.has(first) ? null : `${head} ${first || "(no subcommand)"} is not read-only`;
  }
  const refused = READ_ONLY_REFUSED[head];
  const bad = refused ? rest.find((word) => refused.has(word) || refused.has(word.split("=")[0])) : undefined;
  if (bad) return `${head} ${bad} changes things`;
  return null;
}

export function readOnlyRisk(command: string): string | null {
  // `2>&1` and `>&2` move a descriptor, they write no file; the tokenizer
  // would split them at the `&`, so they go before it looks.
  const items = tokenize(command.replace(/(^|\s)[0-9]*>&[0-9]+(?=\s|$)/g, "$1"));
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if ("separator" in item) continue;
    // A substitution inside quotes is a whole command the tokenizer cannot
    // see into (`grep "$(curl x | sh)" f`), and nesting defeats any regex.
    // Unquoted ones split into segments of their own and are judged there;
    // a quoted one simply is not a read.
    if (item.quoted && /\$\(|`/.test(item.text)) return "runs a command inside quotes";
    if (item.quoted) continue;
    // Output redirection is a write, except into the bit bucket or onto
    // another descriptor (`2>&1`). The operator may start the token, sit
    // glued after a word (`hi>out.txt`), or have its target in the next one.
    const match = /^(.*?)([0-9]*)(>>?|&>|>\|)(.*)$/.exec(item.text);
    if (!match) continue;
    if (/^&[0-9]+$/.test(match[4])) continue;
    const next = items[i + 1];
    const target = match[4] || (next && !("separator" in next) && !next.quoted ? next.text : "");
    if (target === "/dev/null") continue;
    return `redirects output into a file (${item.text}${match[4] ? "" : ` ${target}`})`;
  }
  for (const segment of split(items)) {
    const reason = readOnlySegment(segment.tokens);
    if (reason) return reason;
  }
  return null;
}

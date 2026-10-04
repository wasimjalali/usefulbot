import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { foldPath } from "../../shared/fold-path.ts";
import { APP_STATE_DIR, RUNTIME_INSTALL_DIRS } from "../../shared/stack.ts";
import { ownerPath, pathCandidates } from "../../shared/user-path.ts";
import { delimiter, dirname, join } from "node:path";
import {
  PLANTED_CONFIG_CREATE_ALLOW,
  PLANTED_CONFIG_HOME_CREATE_DENY,
  isPlantedConfigPath,
  PLANTED_CONFIG_SYMLINK_DENY_LEAVES,
  PLANTED_CONFIG_NAMES,
  PLANTED_CONFIG_PATTERNS,
  PLANTED_CONFIG_WRITE_ALLOW,
} from "../../shared/policy.ts";

/**
 * Confinement for a shell line that runs without a card.
 *
 * The classifier reads the line; this decides what the line may touch once
 * it runs, whatever the text said. macOS's seatbelt refuses every file
 * write outside the granted folder (plus this user's temp and cache dirs
 * and /dev), and refuses writes to credential files even inside it. Reads
 * stay open: the folder grant already allows them, and a build needs the
 * toolchain. A line the owner approved on a card runs unconfined, because
 * they read it and said yes to exactly that.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Names that never take a write inside the folder, whatever the mode. */
export const PROTECTED_NAMES = [
  ".env", ".ssh", ".aws", ".gnupg", ".netrc", "netrc", ".npmrc", ".pypirc",
  ".docker", ".kube", ".kubeconfig", "id_rsa", "id_ecdsa", "id_ed25519", "keychain", "keychains", "auth.json",
  // Claude Code's token in its file form. `auth.json` covered codex and
  // opencode, and this one was left reachable by a plain `cat` at Full
  // access, with no grant and no tripwire, which would have made dropping
  // the keychain grant pointless.
  ".credentials.json",
  ".authinfo",
  // The user-domain stores, spelled as the disk spells them: the text
  // tripwire lowercases, the kernel does not.
  "Library/Keychains", "Library/Cookies",
  // The app's own stores and the launch agents that start it.
  APP_STATE_DIR, "LaunchAgents",
  // The runtime install folders (service code and the `.eve/` transcripts),
  // both stacks. RUNTIME_INSTALL_PATTERN below adds the case-folded form.
  ...RUNTIME_INSTALL_DIRS,
  // Shell startup files: a planted line runs in the owner's own shell.
  ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
  ".bash_profile", ".bashrc", ".bash_login", ".bash_logout", ".profile", ".inputrc",
  "config.fish", ".config/fish",
];

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names whose contents are never read by a line that ran without a card.
 * The text tripwire in `bash` is only as good as the text (`cat .e*` names
 * no `.env`), so the kernel refuses the read too. Inside a project folder
 * the build tooling itself reads `.env`, `.npmrc`, `.docker` and `.kube`
 * (dotenv, the registry, the daemon), so those stay readable there; under
 * the home and for read-only lines nothing legitimately needs them.
 */
const READ_DENIED_NAMES = PROTECTED_NAMES.filter((name) => !name.startsWith(".z") && !name.startsWith(".bash") && name !== ".profile" && name !== ".inputrc");
const TOOLING_READS = new Set([".env", ".npmrc", ".docker", ".kube"]);

/**
 * `secrets` cannot be matched the way the other names are.
 *
 * As a plain name it produced `(regex #"/secrets($|[/.])")`, which also
 * matches `.../lib/python3.14/secrets.py` - a module in Python's OWN
 * standard library. Any Python program that imports it, directly or through
 * a dependency, died inside the profile with `ModuleNotFoundError: No module
 * named 'secrets'`, which reads like a broken install rather than a refusal
 * and sent at least one debugging session after the wrong thing entirely.
 *
 * So the store is named rather than the word: a file or folder called
 * `secrets`, and the extensions a credential file actually carries. Source
 * files keep their name. This is the only entry whose bare word is both
 * common English and a module name, which is why it is the only exception.
 */
const SECRETS_DENY_PATTERN = "/secrets($|[/.])";
/**
 * Allowed back for READING only, after the deny so it wins. Never for
 * writing, so no `secrets.py` can be planted anywhere: importing one is what
 * a CLI needs, writing one is not.
 *
 * Narrow twice over. Only Python, because its standard library is the whole
 * of the demonstrated need and a `secrets.ts` in a project is a plausible
 * place for a hardcoded key. And only under a `python3.N` directory, which
 * every install has - Homebrew, the framework builds, uv, pyenv, conda, a
 * venv - rather than a list of install prefixes, because pinning prefixes
 * breaks the next interpreter that keeps its library somewhere else, which
 * is the same class of bug this rule exists to fix.
 */
const SECRETS_ALLOW_PATTERN = "/python3\\.[0-9]+/([^/]+/)*secrets\\.(py|pyc|pyi|so)$";

/**
 * The app's other state folders, `.useful-bot-dev` and `.useful-bot-dev-app`
 * (the dev stack's). The name list above matches `.useful-bot` followed by an
 * end, a slash or a dot, which a dashed sibling does not satisfy, so these
 * get their own rule. `.useful-botany` still matches neither.
 */
const APP_STATE_DASHED_PATTERN = `/${regexEscape(APP_STATE_DIR)}-[^/]*($|/)`;

/**
 * `~/Library/Application Support/Useful Bot` and `.../Useful Bot Dev`, whole
 * folders in either posture. APFS folds case, so each letter is a class: the
 * kernel matches the path as the line spelled it.
 */
const caseless = (text: string) => text.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const RUNTIME_INSTALL_PATTERN = `/${caseless(RUNTIME_INSTALL_DIRS[0])}( ${caseless("Dev")})?($|/)`;

export type SandboxScope = "folder" | "computer";

/**
 * `root` is the folder the line may write under. Null means none at all: a
 * line judged read-only runs with every write refused except the temp and
 * cache dirs, so a misjudged line still cannot change a file. `scope` says
 * whether that root is a project folder the owner handed over or their
 * home, which decides how strict the read denies are. `unbounded` is Full
 * access: writes land anywhere on the Mac, and only the credential files,
 * the app's own stores and the shell startup files stay refused.
 */
/**
 * System paths the text tripwire in `bash` refuses by substring. The scoped
 * profiles never allowed a write there; the unbounded one says so itself,
 * so a spelling the substring misses still cannot land.
 */
const SYSTEM_WRITE_DENIED = ["/etc", "/private/etc", "/var/db", "/private/var/db", "/Library/Keychains", "/Library/Cookies"];

/**
 * Every directory on the PATH a bot's own lines run with.
 *
 * A binary planted on that PATH shadows the real `git` or `ls` for the owner
 * and for the next turn alike, and it is also how a line claims another
 * tool's name and so its credential store. `~/.local/bin` alone was one of
 * six: `/opt/homebrew/bin` and `/opt/homebrew/sbin` are writable by this
 * user on a normal Homebrew install, and nothing refused a write there.
 *
 * `install_cli` lifts this for an install the owner approved by name.
 */
function toolBinDirs(): string[] {
  const dirs = new Set<string>();
  // The resolved PATH holds only directories that exist, because that is what
  // a PATH means. The candidates hold the ones a shell profile names whether
  // they are there or not, and those matter more: a `subpath` deny on a
  // missing path is exactly what stops it being created and then used. Without
  // them, a bot makes its own `~/.cargo/bin`, plants a `git` in it, and the
  // owner's next terminal runs that instead.
  for (const dir of [...ownerPath().split(delimiter), ...pathCandidates()]) {
    if (!dir || !dir.startsWith("/")) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      // A directory the owner cannot write is not a way in, and denying it
      // would only make the profile longer.
      accessSync(dir, constants.W_OK);
      dirs.add(realpathSync(dir));
    } catch {
      // Missing, or not writable yet. A missing one is still denied, so it
      // cannot be created and filled; anything else is skipped.
      if (!existsSync(dir)) dirs.add(dir);
    }
  }
  return [...dirs];
}

/**
 * The planted-config denies, from the one list in shared/policy.ts (the write
 * tool's `isPlantedConfigPath` reads the same list). The kernel on this volume
 * folds case, so plain lowercase rules also match `.Claude/Settings.json`;
 * `(?i)` loads but matches nothing, so it is never used (spike 2026-10-01,
 * evals/results/2026-10-01-ub009-spikes/sbpl-case.md).
 */
export function toSbplRules(): string[] {
  return [
    ...PLANTED_CONFIG_NAMES.map((name) => `(deny file-write* (regex #"/${regexEscape(name)}($|[/.])"))`),
    ...PLANTED_CONFIG_PATTERNS.map((pattern) => `(deny file-write* (regex #"${pattern}"))`),
    ...PLANTED_CONFIG_SYMLINK_DENY_LEAVES.map((leaf) => `(deny file-write-create (require-all (vnode-type SYMLINK) (regex #"/${regexEscape(leaf)}$")))`),
    ...PLANTED_CONFIG_WRITE_ALLOW.map((pattern) => `(allow file-write* (regex #"${pattern}"))`),
    ...PLANTED_CONFIG_CREATE_ALLOW.map((pattern) => `(allow file-write-create (regex #"${pattern}"))`),
  ];
}

/**
 * Creating a tool's config folder directly under the owner's home, in every
 * confined profile except a registered coding-tool CLI's own line at Full
 * access: an approved line (a first-time `codex login` makes `~/.codex`)
 * may, and planted files inside stay denied by the name rules either way.
 */
export function homeCreateRules(): string[] {
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    home = homedir();
  }
  return PLANTED_CONFIG_HOME_CREATE_DENY.map((leaf) => `(deny file-write-create (regex #"^${regexEscape(home)}/${regexEscape(leaf)}$"))`);
}

function plantedConfigRules(allowToolInstall: boolean, confined = false): string[] {
  const rules = [...toSbplRules(), ...(confined ? homeCreateRules() : [])];
  if (allowToolInstall) return rules;
  for (const path of toolBinDirs()) {
    rules.push(`(deny file-write* (subpath ${sbplString(path)}))`);
  }
  return rules;
}

/**
 * Whether the guard would refuse a write at this absolute path: planted config,
 * a tool's config folder name, a protected credential or app-state name, or a
 * PATH directory. Used to tell a refusal this profile made from any other
 * "Operation not permitted" (a macOS privacy prompt, a read-only volume).
 */
export function isGuardedPath(abs: string): boolean {
  const folded = foldPath(abs);
  if (isPlantedConfigPath(abs)) return true;
  const segments = folded.split("/").filter(Boolean);
  if (segments.some((segment) => PLANTED_CONFIG_SYMLINK_DENY_LEAVES.includes(segment as never))) return true;
  if (PROTECTED_NAMES.some((name) => {
    const n = foldPath(name);
    return folded.endsWith(`/${n}`) || folded.includes(`/${n}/`) || folded.includes(`/${n}.`);
  })) return true;
  return toolBinDirs().some((dir) => folded === foldPath(dir) || folded.startsWith(`${foldPath(dir)}/`));
}

/**
 * The allows for the credential stores this one command may reach.
 *
 * The caller decides which: `credentialPathsFor` in agent/lib/cli-registry.ts
 * hands over the store of the CLI the line runs, and nothing at all for any
 * other line. So a `claude` line reaches the login keychain and a `cat` line
 * on the same posture does not.
 *
 * Read AND write, because a CLI refreshes its own token mid-run and a
 * refresh it cannot save turns into a sign-in loop. A path that does not
 * exist is skipped: `subpath` on a missing path parses but says nothing, and
 * leaving it out keeps the profile a readable list of what is really open.
 */
function credentialRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const path of paths) {
    // Never resolve a link into a rule. The caller screens which paths may
    // be opened at all; this refuses to turn any of them into an allow for
    // somewhere else, so a store swapped for a symlink between the two
    // cannot widen the profile. A path is opened as it is spelled or not at
    // all.
    let directory: boolean;
    try {
      if (lstatSync(path).isSymbolicLink()) continue;
      const stat = statSync(path);
      if (!stat.isDirectory() && !stat.isFile()) continue;
      if (realpathSync(path) !== path) continue;
      directory = stat.isDirectory();
    } catch {
      continue;
    }
    // A directory is a tool's own working state: it opens for reading and
    // writing, because a CLI refreshes its token into it and a refresh it
    // cannot save turns into a sign-in loop.
    //
    // A file is the narrow case, and today the only one is the login
    // keychain that gh and Claude Code read their token from. It opens as
    // itself and READ ONLY: the rest of the keyring never opens with it, and
    // nothing a bot runs can write the owner's keychain. Reading is what
    // authenticating needs; verified by running `gh auth status` through a
    // read-only literal grant. If a CLI ever fails to persist a refreshed
    // token, this rule is why.
    rules.push(directory
      ? `(allow file-read* file-write* (subpath ${sbplString(path)}))`
      : `(allow file-read* (literal ${sbplString(path)}))`);
  }
  return rules;
}

export type ConfineOptions = {
  /**
   * Absolute credential-store paths this one command may reach. Only honoured
   * at Full access; the scoped postures card a CLI line instead, and an
   * approved line runs unconfined anyway.
   */
  credentialPaths?: readonly string[];
  /** The line is a single plain run of a registered coding-tool CLI (first-time sign-in may create its home folder). */
  registeredCli?: boolean;
  /** The line is an install of a named CLI the owner approved. */
  allowToolInstall?: boolean;
};

export function sandboxProfile(
  root: string | null,
  scope: SandboxScope = "computer",
  unbounded = false,
  options: ConfineOptions = {},
): string {
  const real = root === null ? null : realpathSync(root);
  // Tools that ignore TMPDIR fall back to the darwin per-user dirs; those
  // sit beside each other under one parent (.../T for temp, .../C for cache).
  const temp = realpathSync(tmpdir());
  const cache = join(dirname(temp), "C");
  const protectedRules = [
    ...PROTECTED_NAMES.map((name) => `(deny file-write* (regex #"/${regexEscape(name)}($|[/.])"))`),
    `(deny file-write* (regex #"${APP_STATE_DASHED_PATTERN}"))`,
    `(deny file-write* (regex #"${RUNTIME_INSTALL_PATTERN}"))`,
    `(deny file-write* (regex #"${SECRETS_DENY_PATTERN}"))`,
  ];
  // Inside a project folder the build tooling reads its own .env and the
  // like. Scoped, that is the whole of what the line can reach anyway;
  // unbounded, the deny stays on for the rest of the disk and only the
  // folder's own copies are allowed back (a later rule wins).
  const tooling = root !== null && scope === "folder";
  const readDenied = tooling && !unbounded
    ? READ_DENIED_NAMES.filter((name) => !TOOLING_READS.has(name))
    : READ_DENIED_NAMES;
  const readRules = [
    ...readDenied.map((name) => `(deny file-read* (regex #"/${regexEscape(name)}($|[/.])"))`),
    `(deny file-read* (regex #"${APP_STATE_DASHED_PATTERN}"))`,
    `(deny file-read* (regex #"${RUNTIME_INSTALL_PATTERN}"))`,
    `(deny file-read* (regex #"${SECRETS_DENY_PATTERN}"))`,
    `(allow file-read* (regex #"${SECRETS_ALLOW_PATTERN}"))`,
    ...(tooling && unbounded && real !== null
      ? [...TOOLING_READS].map((name) => `(allow file-read* (regex #"^${regexEscape(real)}(/.*)?/${regexEscape(name)}($|[/.])"))`)
      : []),
  ];
  return [
    "(version 1)",
    "(allow default)",
    ...(unbounded ? SYSTEM_WRITE_DENIED.map((path) => `(deny file-write* (subpath ${sbplString(path)}))`) : [
      "(deny file-write*)",
      ...(real === null ? [] : [`(allow file-write* (subpath ${sbplString(real)}))`]),
      `(allow file-write* (subpath ${sbplString(temp)}))`,
      `(allow file-write* (subpath ${sbplString(cache)}))`,
      '(allow file-write* (subpath "/dev"))',
    ]),
    ...protectedRules,
    ...readRules,
    // Full access only, and only the store belonging to the CLI this very
    // line runs. Auto and read-only lines keep every credential store
    // refused, including the CLIs' own.
    ...(unbounded ? credentialRules(options.credentialPaths ?? []) : []),
    // Last, so a planted hook stays refused even inside a store the rule
    // above just opened: `~/.codex` is readable to a codex line, but
    // `~/.codex/config.toml` is not writable by it.
    // The home-folder create deny applies in Auto AND Full access, except for a
    // single plain line that runs a registered coding-tool CLI (codex, claude,
    // gemini, gh...): its first-time sign-in may make `~/.codex` and the like,
    // and the planted files inside stay denied by the name rules. Any other line
    // cannot plant `~/.gemini` by renaming a prepared directory.
    ...plantedConfigRules(options.allowToolInstall === true, !(unbounded && options.registeredCli === true)),
  ].join("\n");
}

/** The argv that runs `command` confined to `root` (null: no writes at all). */
export function confinedCommand(
  root: string | null,
  command: string,
  scope: SandboxScope = "computer",
  unbounded = false,
  options: ConfineOptions = {},
): string[] {
  return [SANDBOX_EXEC, "-p", sandboxProfile(root, scope, unbounded, options), "/bin/sh", "-c", command];
}

/**
 * The profile for a line the owner approved on a card: everything allowed
 * (credential stores stay reachable, so an approved `gh auth login` or
 * `codex login` still works) except writes to planted config and to the PATH
 * directories. `allowToolInstall` lifts the PATH denies, as for `install_cli`.
 */
export function approvedLineProfile(options: { allowToolInstall?: boolean } = {}): string {
  return ["(version 1)", "(allow default)", ...plantedConfigRules(options.allowToolInstall === true)].join("\n");
}

/**
 * The argv for an approved line. Throws when there is no sandbox or the
 * profile cannot be built: the caller refuses the line, it never runs bare.
 */
export function approvedCommand(
  command: string,
  options: { allowToolInstall?: boolean } = {},
  available: () => boolean = sandboxAvailable,
): string[] {
  if (!available()) throw new Error("sandbox_unavailable");
  return [SANDBOX_EXEC, "-p", approvedLineProfile(options), "/bin/sh", "-c", command];
}

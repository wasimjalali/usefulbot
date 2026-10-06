import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { foldPath } from "./fold-path.ts";

/**
 * The one place that knows where this install keeps its state and which
 * ports and Keychain names it owns.
 *
 * Two stacks can run side by side: the daily app and the "Useful Bot Dev"
 * build. With no UB_STACK / UB_STATE_ROOT / port / prefix setting every value
 * here is today's daily literal, so a daily install behaves exactly as it
 * always has. The dev build's launcher sets UB_STACK=dev, UB_STATE_ROOT, the
 * three ports, UB_KEYCHAIN_PREFIX and UB_MEDIA_DIR, and `assertStack` refuses
 * to start a dev service with any of them missing or equal to the daily value,
 * so a partial dev environment can never quietly fall back onto the daily
 * stack's state, ports, Keychain items or media folder.
 *
 * Runtime code reads these through the functions below. No other module
 * carries 4319, 4320, 4321, `com.usefulbot.` or a `.useful-bot` path join
 * (test/dev-stack.test.ts greps for them).
 */

type Env = Record<string, string | undefined>;

export type StackName = "daily" | "dev";

export const LOOPBACK = "127.0.0.1";

/** What the daily app has always used. The dev stack must differ on every one. */
export const DAILY = {
  routerPort: 4319,
  webPort: 4320,
  evePort: 4321,
  keychainPrefix: "com.usefulbot",
  stateDir: ".useful-bot",
  mediaDir: "Useful Bot",
} as const;

/** What the dev build uses where it must differ from the daily one. */
export const DEV = {
  keychainPrefix: "com.usefulbot.dev",
} as const;

/** The folder name the app's own stores live under, in any stack. */
export const APP_STATE_DIR = DAILY.stateDir;

/**
 * Every per-store override a module still honours. The dev stack refuses all of
 * them (stores derive from UB_STATE_ROOT). test/dev-stack.test.ts
 * scans the code for UB_*_PATH / _DIR / _ROOT / _DB / _CONFIG reads and fails
 * when one is missing here (or from its short list of reasoned exemptions), so
 * a new store can never quietly bypass the dev state root.
 */
export const STORE_OVERRIDE_VARS = [
  "UB_ROUTER_CONFIG", "UB_ROUTER_DB", "UB_AGENT_STORE_PATH", "UB_SHELL_PATH", "UB_APPROVALS_PATH",
  "UB_WORKSPACE_STORE_PATH", "UB_ROUTINES_PATH", "UB_WEB_SESSIONS_PATH", "UB_HANDOFF_DIR", "UB_MEMORY_ROOT",
  "UB_WIDGETS_DIR", "UB_IMAGES_DIR", "UB_MEDIA_INDEX_PATH", "UB_PROVIDERS_PATH",
  "UB_MODELS_CACHE_PATH", "UB_CONNECTORS_PATH", "UB_CONNECTIONS_PATH", "UB_CONNECTION_TOOLS_PATH",
  "UB_OAUTH_PENDING_PATH", "UB_CATALOGUE_PATH", "UB_LIMITS_PATH", "UB_SESSION_OWNERS_PATH", "UB_CHATGPT_SIGNIN_PATH",
] as const;

/** Base-URL overrides. On the dev stack none may aim at a loopback host on a daily port. */
export const ORIGIN_OVERRIDE_VARS = ["UB_ROUTER_BASE_URL", "UB_WEB_BASE_URL", "UB_OPENCODE_GO_BASE"] as const;

const DAILY_PORTS: readonly number[] = [DAILY.routerPort, DAILY.webPort, DAILY.evePort];

const PORT_VARS = [
  ["UB_ROUTER_PORT", DAILY.routerPort],
  ["UB_WEB_PORT", DAILY.webPort],
  ["UB_EVE_PORT", DAILY.evePort],
] as const;

// The part after the stack's prefix: `device.desktop`, `connection.<id>`.
/** The dev state root's folder name: inside what the sandbox's `.useful-bot-` deny rule protects. */
const DEV_STATE_NAME = /^\.useful-bot-[a-z0-9]+(-[a-z0-9]+)*$/;

const SERVICE_TAIL = /^[a-z0-9][a-z0-9._-]{0,120}$/;

export class StackConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`dev stack is misconfigured: ${problems.join("; ")}`);
    this.name = "StackConfigError";
    this.problems = problems;
  }
}

export function stackName(env: Env = process.env): StackName {
  const raw = env.UB_STACK?.trim();
  if (!raw || raw === "daily") return "daily";
  if (raw === "dev") return "dev";
  throw new Error(`UB_STACK must be "daily" or "dev", got "${raw}"`);
}

function homeDir(env: Env): string {
  return env.HOME || homedir();
}

/** Where every store lives: UB_STATE_ROOT, else ~/.useful-bot. */
export function stateRoot(env: Env = process.env): string {
  const raw = env.UB_STATE_ROOT;
  if (raw) return raw;
  return join(homeDir(env), DAILY.stateDir);
}

export function statePath(...segments: string[]): string {
  return join(stateRoot(), ...segments);
}

export function routerConfigPath(env: Env = process.env): string {
  return env.UB_ROUTER_CONFIG || join(stateRoot(env), "config.json");
}

export function routerDbPath(env: Env = process.env): string {
  return env.UB_ROUTER_DB || join(stateRoot(env), "router", "usage.sqlite");
}

function portFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port number from 1 to 65535, got "${raw}"`);
  }
  return value;
}

export function routerPort(env: Env = process.env): number {
  return portFrom(env, "UB_ROUTER_PORT", DAILY.routerPort);
}

export function webPort(env: Env = process.env): number {
  return portFrom(env, "UB_WEB_PORT", DAILY.webPort);
}

export function evePort(env: Env = process.env): number {
  return portFrom(env, "UB_EVE_PORT", DAILY.evePort);
}

/** `http://127.0.0.1:<router port>`, no path. */
export function routerOrigin(env: Env = process.env): string {
  return `http://${LOOPBACK}:${routerPort(env)}`;
}

/** The router's OpenAI-style base, ending in /v1. UB_ROUTER_BASE_URL still wins. */
export function routerApiBase(env: Env = process.env): string {
  return env.UB_ROUTER_BASE_URL ?? `${routerOrigin(env)}/v1`;
}

export function eveOrigin(env: Env = process.env): string {
  return `http://${LOOPBACK}:${evePort(env)}`;
}

/** The loopback origin the web service binds; UB_WEB_BASE_URL still wins. */
export function webOrigin(env: Env = process.env): string {
  return env.UB_WEB_BASE_URL || `http://${LOOPBACK}:${webPort(env)}`;
}

/**
 * The Keychain namespace belongs to the stack, it is not a setting: exactly
 * `com.usefulbot` on daily and `com.usefulbot.dev` on dev. UB_KEYCHAIN_PREFIX
 * may only repeat that value; anything else throws, so a stale or mistyped
 * variable can never aim one stack at the other's items.
 */
export function keychainPrefix(env: Env = process.env): string {
  const stack = stackName(env);
  const fixed = stack === "dev" ? DEV.keychainPrefix : DAILY.keychainPrefix;
  const raw = env.UB_KEYCHAIN_PREFIX;
  if (raw !== undefined && raw !== "" && raw !== fixed) {
    throw new Error(`UB_KEYCHAIN_PREFIX must be exactly ${fixed} on the ${stack} stack, got "${raw}"`);
  }
  return fixed;
}

/**
 * Whether a Keychain service name sits in this stack's namespace: `<prefix>.<name>`
 * with a plain name. The daily stack also refuses `com.usefulbot.dev` and
 * everything under it, so it can never touch the dev stack's items. Throws when
 * UB_KEYCHAIN_PREFIX is not the stack's own value.
 */
export function keychainServiceAllowed(service: string, env: Env = process.env): boolean {
  if (typeof service !== "string") return false;
  const prefix = keychainPrefix(env);
  if (!service.startsWith(`${prefix}.`)) return false;
  const tail = service.slice(prefix.length + 1);
  if (!SERVICE_TAIL.test(tail)) return false;
  if (prefix === DAILY.keychainPrefix && (tail === "dev" || tail.startsWith("dev."))) return false;
  return true;
}

/** A Keychain service name in this stack: `<prefix>.<name>`. */
export function keychainName(name: string, env: Env = process.env): string {
  return `${keychainPrefix(env)}.${name}`;
}

// ---------------------------------------------------------------------------
// Where a path really is. Every dev-stack path is judged on its canonical form:
// symlinks resolved (for a path that does not exist yet, its nearest existing
// ancestor), compared case-insensitively (APFS folds case by default).

/** The folding the comparison uses (shared/fold-path.ts). */
const fold = foldPath;

/** Resolve symlinks in the path or its nearest existing ancestor; a dangling link is followed too. */
function canonicalPath(path: string, depth = 0): string {
  if (depth > 40) throw new Error("too many symbolic links");
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return canonicalPath(join(resolve(dirname(current), readlinkSync(current)), ...tail), depth + 1);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

type Relation = "same" | "under" | "over" | null;

/** How `a` sits against `b`: the same folder, inside it, or containing it. Both already folded. */
function relation(a: string, b: string): Relation {
  if (a === b) return "same";
  const slash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
  if (slash(a).startsWith(slash(b))) return "under";
  if (slash(b).startsWith(slash(a))) return "over";
  return null;
}

const RELATION_TEXT = { same: "is", under: "sits inside", over: "contains" } as const;

/** The folders the dev stack must never be, sit inside or contain, spelled for each home that might be in play. */
function dailyFolders(env: Env, includeDevInstall: boolean): Array<{ label: string; path: string }> {
  const homes = new Set<string>([homeDir(env)]);
  try {
    homes.add(userInfo().homedir);
  } catch {
    // No passwd entry: the environment's HOME is all there is.
  }
  const folders: Array<{ label: string; path: string }> = [];
  for (const home of homes) {
    if (!home) continue;
    folders.push(
      { label: "the daily state root", path: join(home, DAILY.stateDir) },
      { label: "older owner data", path: join(home, ".useful-bot-dev") },
      { label: "the daily media folder", path: join(home, "Documents", DAILY.mediaDir) },
      { label: "the daily app install", path: join(home, RUNTIME_INSTALL_DIRS[0]) },
    );
    if (includeDevInstall) folders.push({ label: "the dev app install", path: join(home, RUNTIME_INSTALL_DIRS[1]) });
  }
  return folders;
}

/**
 * Both spellings of a path, folded: the lexical one (resolve(), nothing followed)
 * and the canonical one (symlinks followed). Containment is judged on every
 * pairing, so a link planted on either side cannot hide it. An unresolvable
 * path is a problem, never a skipped check.
 */
function pathForms(name: string, value: string, problems: string[]): string[] | null {
  if (!isAbsolute(value)) {
    problems.push(`${name} must be an absolute path, got "${value}"`);
    return null;
  }
  // `..` is judged before anything is resolved: normalising it ahead of following links lands somewhere else.
  if (value.split("/").includes("..")) {
    problems.push(`${name} must not contain a ".." segment, got "${value}"`);
    return null;
  }
  try {
    return [...new Set([fold(resolve(value)), fold(canonicalPath(value))])];
  } catch (error) {
    problems.push(`${name} cannot be resolved: ${(error as Error).message}`);
    return null;
  }
}

/** The first way any form of `a` sits against any form of `b` (limited to `hows`), with the form of `b` that matched. */
function touches(
  a: string[],
  b: string[],
  hows: ReadonlyArray<Exclude<Relation, null>> = ["same", "under", "over"],
): { how: Exclude<Relation, null>; folder: string } | null {
  for (const want of hows) {
    for (const left of a) {
      for (const right of b) {
        if (relation(left, right) === want) return { how: want, folder: right };
      }
    }
  }
  return null;
}

function isLoopbackHost(rawHost: string): boolean {
  let host = rawHost.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return Number(v4[1]) === 127 || host === "0.0.0.0";
  if (host === "::1" || host === "::") return true;
  // ::ffff:7f00:1 is how URL spells ::ffff:127.0.0.1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return high >> 8 === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
  }
  return false;
}

const STATE_WALK_MAX_PROBLEMS = 5;
const STATE_WALK_MAX_ENTRIES = 50_000;

/**
 * Threat model: this is a startup check against a dev state folder that was
 * wired back to daily state (by a stray link, a copied folder, a script). It
 * is not a defence against a process swapping files in while services run:
 * anything that can write there at runtime already has the owner's file
 * access and could read daily state directly, and bots in either stack are
 * kernel-denied every .useful-bot* folder.
 *
 * Every symlink or hard link inside the dev state folder is refused,
 * regardless of target: a link in there (config.json, memory/x, ...) can lead
 * a dev service back into daily data. Walks with lstat and never follows a
 * link. A missing root is fine; an unreadable folder or a walk past the entry
 * cap is itself a problem.
 */
export function stateRootLinkProblems(root: string, maxEntries: number = STATE_WALK_MAX_ENTRIES): string[] {
  const problems: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length > 0 && problems.length < STATE_WALK_MAX_PROBLEMS) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir === root) return problems;
      problems.push(`${dir} could not be checked for links (${(error as Error).message})`);
      continue;
    }
    for (const name of names) {
      if (++seen > maxEntries) {
        problems.push(`the dev state folder has too many entries to check for links (over ${maxEntries})`);
        return problems;
      }
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          problems.push(`${path} is a symlink; the dev state folder may not contain links`);
          if (problems.length >= STATE_WALK_MAX_PROBLEMS) return problems;
        } else if (stat.isDirectory()) {
          stack.push(path);
        } else if (stat.nlink > 1) {
          // A hard link is a second name for a file that may live in daily state.
          problems.push(`${path} is a hard link; the dev state folder may not contain links`);
          if (problems.length >= STATE_WALK_MAX_PROBLEMS) return problems;
        }
      } catch (error) {
        problems.push(`${path} could not be checked for links (${(error as Error).message})`);
        if (problems.length >= STATE_WALK_MAX_PROBLEMS) return problems;
      }
    }
  }
  return problems;
}

/**
 * Everything wrong with this environment for the stack it names. Empty means
 * fine. A daily environment is checked only for malformed values it chose to
 * set; a dev one must also set every stack value, none of them may equal or
 * touch a daily one, and every place it points at is judged on its real,
 * symlink-resolved, case-folded location.
 */
export function stackProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  let stack: StackName;
  try {
    stack = stackName(env);
  } catch (error) {
    return [(error as Error).message];
  }
  const dev = stack === "dev";
  const set = (name: string) => env[name] !== undefined && env[name] !== "";

  const devPorts = new Map<number, string>();
  for (const [name, daily] of PORT_VARS) {
    if (!set(name)) {
      if (dev) problems.push(`${name} is required on the dev stack`);
      continue;
    }
    try {
      const value = portFrom(env, name, daily);
      if (dev) {
        if (DAILY_PORTS.includes(value)) problems.push(`${name} is ${value}, a daily port`);
        const other = devPorts.get(value);
        if (other) problems.push(`${other} and ${name} are the same port (${value})`);
        else devPorts.set(value, name);
      }
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  if (!set("UB_KEYCHAIN_PREFIX")) {
    if (dev) problems.push("UB_KEYCHAIN_PREFIX is required on the dev stack");
  } else {
    try {
      keychainPrefix(env);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  if (!dev) return problems;

  const root = env.UB_STATE_ROOT;
  let rootForms: string[] | null = null;
  if (!root) {
    problems.push("UB_STATE_ROOT is required on the dev stack");
  } else {
    rootForms = pathForms("UB_STATE_ROOT", root, problems);
    if (rootForms !== null) {
      for (const folder of dailyFolders(env, false)) {
        const forms = pathForms(`protected folder ${folder.path}`, folder.path, problems);
        const hit = forms === null ? null : touches(rootForms, forms);
        if (hit) problems.push(`UB_STATE_ROOT ${RELATION_TEXT[hit.how]} ${folder.label} (${hit.folder})`);
      }
      // The kernel sandbox denies `.useful-bot-` plus anything up to the next slash, case-sensitively.
      // Hold the name to a stricter, lowercase shape, as given and as the disk resolves it.
      for (const name of new Set([basename(resolve(root)), basename(canonicalPath(root))])) {
        if (!DEV_STATE_NAME.test(name)) {
          problems.push(`UB_STATE_ROOT's folder name "${name}" must be lowercase .useful-bot-<words joined by hyphens>, such as .useful-bot-dev-app, so the bots' deny-lists cover it`);
        }
      }
      problems.push(...stateRootLinkProblems(root));
    }
  }

  const media = env.UB_MEDIA_DIR;
  if (!media) {
    problems.push("UB_MEDIA_DIR is required on the dev stack");
  } else {
    const mediaForms = pathForms("UB_MEDIA_DIR", media, problems);
    if (mediaForms !== null) {
      for (const folder of dailyFolders(env, false)) {
        const forms = pathForms(`protected folder ${folder.path}`, folder.path, problems);
        const hit = forms === null ? null : touches(mediaForms, forms);
        if (hit) problems.push(`UB_MEDIA_DIR ${RELATION_TEXT[hit.how]} ${folder.label} (${hit.folder})`);
      }
    }
  }

  // The dev stack takes no per-store override: its stores derive from UB_STATE_ROOT.
  // The one exception is UB_ROUTER_CONFIG spelled exactly as that derived path,
  // which scripts/service.mjs passes to the router and web children.
  for (const name of STORE_OVERRIDE_VARS) {
    if (!set(name)) continue;
    if (name === "UB_ROUTER_CONFIG" && root && env[name] === join(root, "config.json")) continue;
    problems.push(`${name} is not allowed on the dev stack; dev stores live under UB_STATE_ROOT`);
  }

  // The bots' working root is normally $HOME; it may not be, or sit inside, a store.
  if (set("UB_WORKSPACE_ROOT")) {
    const workForms = pathForms("UB_WORKSPACE_ROOT", env.UB_WORKSPACE_ROOT as string, problems);
    if (workForms !== null) {
      const stores = dailyFolders(env, true);
      if (root && isAbsolute(root)) stores.push({ label: "the dev state root", path: root });
      for (const store of stores) {
        const forms = pathForms(`protected folder ${store.path}`, store.path, problems);
        const hit = forms === null ? null : touches(workForms, forms, ["same", "under"]);
        if (hit) {
          problems.push(`UB_WORKSPACE_ROOT ${RELATION_TEXT[hit.how]} ${store.label} (${hit.folder})`);
        }
      }
    }
  }

  // An origin override must not point a dev service at a daily one.
  for (const name of ORIGIN_OVERRIDE_VARS) {
    if (!set(name)) continue;
    let url: URL;
    try {
      url = new URL(env[name] as string);
    } catch {
      problems.push(`${name} is not a URL, got "${env[name]}"`);
      continue;
    }
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (isLoopbackHost(url.hostname) && DAILY_PORTS.includes(port)) {
      problems.push(`${name} points at ${url.hostname}:${port}, a daily service`);
    }
  }
  return problems;
}

/** Throws a StackConfigError when the dev stack's environment is incomplete or points at daily. */
export function assertStack(env: Env = process.env): void {
  const problems = stackProblems(env);
  if (problems.length > 0) throw new StackConfigError(problems);
}

/**
 * The startup check every service entry runs: print what is wrong and exit
 * non-zero, before anything is read, written, bound or launched.
 */
export function enforceStack(service: string, env: Env = process.env): void {
  const problems = stackProblems(env);
  if (problems.length === 0) return;
  process.stderr.write(`${JSON.stringify({ service, error: "stack_misconfigured", problems })}\n`);
  process.exit(1);
}

/**
 * `.useful-bot` and its dashed siblings (`.useful-bot-dev`,
 * `.useful-bot-dev-app`): every folder the app keeps state in, in any stack.
 * Not `.useful-botany`: the name ends there, or carries on with a separator.
 */
const APP_STATE_SEGMENT = /^\.useful-bot($|[^a-z0-9_])/i;
const APP_STATE_IN_TEXT = /\.useful-bot(?![a-z0-9_])/i;

/** True for one path segment that names an app-state folder. */
export function isAppStateSegment(segment: string): boolean {
  return APP_STATE_SEGMENT.test(foldPath(segment));
}

/**
 * The runtime install roots, one per stack: the service code and the `.eve/`
 * session transcripts live under them, so a bot may not read or write there
 * any more than in the state folders. Whole folders, compared case-insensitively
 * (APFS folds case). Other `Application Support` folders are not covered, and
 * neither is `Useful Botany`.
 */
export const RUNTIME_INSTALL_DIRS = [
  "Library/Application Support/Useful Bot",
  "Library/Application Support/Useful Bot Dev",
] as const;

const RUNTIME_INSTALL_PATH = /(^|\/)library\/application support\/useful bot( dev)?(\/|$)/;
const RUNTIME_INSTALL_IN_TEXT = /library\/application support\/useful bot(?: dev)?(?![a-z0-9_])/;

/** True when an absolute or resolved path is at or inside either stack's runtime install folder. */
export function isRuntimeInstallPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return RUNTIME_INSTALL_PATH.test(fold(segments.join("/")));
}

/** True when text, a shell line included, names a runtime install folder, with its spaces backslashed or quoted. */
function mentionsRuntimeInstall(text: string): boolean {
  const plain = text.replace(/\\(.)/g, "$1").replace(/["']/g, "").replace(/\/{2,}/g, "/");
  return RUNTIME_INSTALL_IN_TEXT.test(fold(plain));
}

/** True when a shell line (or any text) names an app-state or runtime install folder anywhere in it. */
export function mentionsAppState(text: string): boolean {
  return APP_STATE_IN_TEXT.test(foldPath(text)) || mentionsRuntimeInstall(text);
}

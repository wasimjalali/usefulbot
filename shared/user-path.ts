import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The PATH a command the owner asked for should run with.
 *
 * The services start from launchd or from the app bundle, so the environment
 * they inherit is the minimal one: no `~/.zshrc`, no Homebrew, no `~/.local/bin`.
 * Every CLI the owner has installed and signed in to lives in one of those
 * directories, which is why a bot could not run `codex`, `claude`, `gh` or
 * `npm` at all. Asking the owner's own login shell what its PATH is answers
 * that exactly the way their terminal would.
 */

/** Always present, and what the probe itself runs with. */
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Where installers put things when no shell profile says otherwise. Used to
 * fill in what a probe missed, and as the whole answer when there is no
 * usable shell. Ordered ahead of the system dirs so a Homebrew `python3`
 * wins over Apple's, which is what the owner's terminal does too.
 */
function commonDirs(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
  ];
}

const PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_BYTES = 16 * 1024;
/** A profile that appends in a loop must not produce an unbounded argv. */
const MAX_ENTRIES = 64;

/**
 * Absolute, existing, deduplicated, in the order first seen. A relative entry
 * (or the empty entry a trailing `:` leaves) means "the current directory" to
 * a shell, and a cwd that resolves a bare command name is how a dropped
 * `ls` script gets run instead of the real one.
 */
function sanitise(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (!trimmed || !isAbsolute(trimmed) || trimmed.includes("\0")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (!existsSync(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * The owner's login shell, or null when the environment does not name one we
 * can run. `SHELL` reaches here from launchd, so it is trusted about as far
 * as the rest of that environment; requiring an absolute path that exists is
 * what stops a bare word turning into a PATH lookup.
 */
function loginShell(): string | null {
  const named = process.env.SHELL?.trim();
  if (named && isAbsolute(named) && existsSync(named)) return named;
  return existsSync("/bin/zsh") ? "/bin/zsh" : null;
}

/**
 * Ask the login shell for its PATH. `-l` sources the profile files where
 * Homebrew's `shellenv`, nvm and a hand-written `PATH=` line all live. It is
 * the owner's own startup code, so it can be slow or can hang; the timeout
 * is the whole of the recovery, and a failure just means the composed list
 * below is used instead.
 */
/**
 * A profile that prints a greeting writes it to stdout ahead of the answer,
 * so the answer is marked rather than assumed to be the whole of it.
 */
const PROBE_MARK = "__ub_path__";

function probe(): string[] {
  const shell = loginShell();
  if (!shell) return [];
  try {
    const raw = execFileSync(shell, ["-l", "-c", `printf '\\n${PROBE_MARK}%s\\n' "$PATH"`], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_BYTES,
      encoding: "utf8",
      // stdin closed: a profile that prompts would otherwise hold the probe
      // open until the timeout. stderr dropped: a noisy profile is not an
      // error here, and its text is not the PATH.
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        HOME: homedir(),
        PATH: SYSTEM_DIRS.join(delimiter),
        TERM: "dumb",
        ...(process.env.USER ? { USER: process.env.USER } : {}),
      },
    });
    const line = raw.split("\n").reverse().find((candidate) => candidate.startsWith(PROBE_MARK));
    if (line === undefined) return [];
    return line.slice(PROBE_MARK.length).split(delimiter);
  } catch {
    return [];
  }
}

let cached: string | null = null;
/**
 * Every directory the probe and the defaults named, before the existence
 * check dropped any of them. Kept so `rescanOwnerPath` can look again
 * without asking the shell a second time.
 */
let candidates: string[] | null = null;

/**
 * The PATH for a child process the owner asked for, computed once per
 * service lifetime. `UB_OWNER_PATH` pins it outright, for tests and for an
 * owner who wants to say exactly what a bot may reach.
 */
export function ownerPath(): string {
  if (cached !== null) return cached;
  const pinned = process.env.UB_OWNER_PATH?.trim();
  if (pinned) {
    candidates = pinned.split(delimiter);
    const fixed = sanitise(candidates);
    cached = (fixed.length > 0 ? fixed : SYSTEM_DIRS).join(delimiter);
    return cached;
  }
  const home = homedir();
  // The probe first, in its own order: that is what the owner's terminal
  // resolves. The common dirs fill in what a minimal profile left out, and
  // the system dirs are last so a `sh` always exists.
  candidates = [...probe(), ...commonDirs(home), ...SYSTEM_DIRS];
  cached = sanitise(candidates).join(delimiter);
  return cached;
}

/**
 * Look again at the directories already known, and keep any that have since
 * appeared.
 *
 * `sanitise` drops a directory that is not there yet, so a first-ever
 * `~/.local/bin` created by an install would stay invisible until the
 * service restarted. This re-checks those same candidates and nothing else:
 * no shell runs, which matters because the probe is a synchronous
 * `execFileSync` of the owner's login shell with a three second ceiling, and
 * this service runs every bot on one thread. Resetting the cache outright
 * would have stalled every other bot's turn for as long as that shell took
 * to start.
 */
/**
 * Every directory a PATH could name here, existing or not: what the login
 * shell reported plus the conventional install locations. The sandbox profile
 * denies writes to all of them, and a directory that is not there yet is the
 * one that matters, because denying it is what stops a bot creating it and
 * putting a program on the owner's PATH.
 */
export function pathCandidates(): string[] {
  if (candidates === null) ownerPath();
  return [...new Set([...(candidates ?? []), ...commonDirs(homedir())])]
    .map((dir) => dir.trim())
    .filter((dir) => dir.startsWith("/"));
}

export function rescanOwnerPath(): string {
  if (candidates === null) return ownerPath();
  const fixed = sanitise(candidates);
  cached = (fixed.length > 0 ? fixed : SYSTEM_DIRS).join(delimiter);
  return cached;
}

/** Test seam. The probe is cached for the life of the process otherwise. */
export function resetOwnerPath(): void {
  cached = null;
  candidates = null;
}

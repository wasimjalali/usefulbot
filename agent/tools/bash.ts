import { defineTool } from "eve/tools";
import { z } from "zod";
import { homedir, tmpdir } from "node:os";
import { effectiveRoot } from "../lib/workspace.ts";
import { commandRisk, readOnlyRisk, wipeRisk } from "../lib/command-risk.ts";
import { confinedCommand, sandboxAvailable } from "../lib/sandbox.ts";
import { credentialPathsFor } from "../lib/cli-registry.ts";
import { runCommand } from "../lib/run-command.ts";
import { actionSha256, approvalActor, executeIfApproved, waitUntilNotPending } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { FORBIDDEN_PATH_SUBSTRINGS } from "../../shared/policy.ts";
import { ownerPath } from "../../shared/user-path.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

const OUTPUT_MAX_BYTES = 32 * 1024;
const INPUT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * A coding CLI working through a task runs for minutes, so the old 60s
 * ceiling killed every useful run of one. The default stays where it was: a
 * line that needs longer says so, rather than every mistyped command holding
 * a turn open for half an hour.
 */
const MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * Best-effort refusal for commands that reach for credential stores or walk
 * out of the workspace. cwd/env confinement alone does not stop an absolute
 * path, so this is a tripwire in addition to the owner's per-command approval.
 */
const BLOCKED_COMMAND_SUBSTRINGS = [
  ...FORBIDDEN_PATH_SUBSTRINGS,
  // The app's own stores: approvals, the roster, the grants. read_file and
  // list_dir refuse the same name; a shell line must not be the way round.
  ".useful-bot",
  "/etc",
  "/private/etc",
  "/var/db",
  "/library/keychains",
  "/library/cookies",
];
/**
 * `..` is a path traversal marker in the scoped postures: it costs the odd
 * benign `echo "a..b"`, but the owner still sees the command on a card, so
 * a false block is a retype, while a miss is a read the card made look
 * routine. Full access has no folder boundary to traverse, so it keeps only
 * the credential list above.
 */
const SCOPED_COMMAND_SUBSTRINGS = [".."];

function blockedReason(command: string, scoped: boolean): string | null {
  const lowered = command.toLowerCase();
  for (const part of scoped ? [...BLOCKED_COMMAND_SUBSTRINGS, ...SCOPED_COMMAND_SUBSTRINGS] : BLOCKED_COMMAND_SUBSTRINGS) {
    if (lowered.includes(part.toLowerCase())) return `command references ${part}`;
  }
  return null;
}

export default defineTool({
  description: "Run a shell command on this Mac, in the attached folder or under the owner's home when none is attached. The owner's own PATH and home directory apply, so a CLI they have installed and signed in to (codex, claude, gh, npm...) runs the way it does in their terminal. Lines that only read run at once; what else runs without asking depends on the owner's permission: Full access runs everything, anywhere on the Mac, and asks only before a wipe. Not a login shell, and stdin is closed: pass a non-interactive flag. Default timeout 30s; pass timeoutMs for a command that works for minutes.",
  inputSchema: z.object({
    command: z.string().min(1).max(8192),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  }),
  async execute(input, ctx) {
    // One grant read for root AND permission: two reads could pair a root
    // from before a permission change with the permission after it. A
    // grant whose folder is gone still answers a tripwired line with the
    // block, not a workspace error.
    let workspace;
    try {
      workspace = effectiveRoot(ctx?.session?.id);
    } catch (error) {
      // The posture is unknown here, so only the list every posture shares.
      const blocked = blockedReason(input.command, false);
      if (blocked) return { status: "blocked", error: blocked };
      throw error;
    }
    const { root, permission, scope } = workspace;
    // The HOME the line runs with is the owner's real one, in both scopes.
    // It used to be the attached folder, so `~` stayed inside the grant; the
    // cost was that every CLI on this Mac looked unconfigured and signed out,
    // because `codex` reads `~/.codex`, `gh` reads `~/.config/gh` and `git`
    // reads `~/.gitconfig`. Nothing was gained by the swap: writes are
    // refused by the sandbox profile, not by where `~` points, and a line
    // that spelled the home path in full was never affected either way.
    const shellHome = homedir();
    const blocked = blockedReason(input.command, permission !== "full_access");
    if (blocked) {
      return { status: "blocked", error: blocked };
    }
    // A line that only reads runs in every posture, with every write refused
    // by the sandbox in case the classifier misjudged it. Reading is what the
    // owner expects a bot to do on its own, wherever it is looking.
    const readOnly = readOnlyRisk(input.command) === null;
    if (permission === "read_only" && !readOnly) {
      return { status: "blocked", error: "workspace_read_only" };
    }
    const hash = actionSha256({
      tool: "bash",
      canonicalArgs: JSON.stringify({ command: input.command }),
      cwd: root,
      targetRevision: null,
      backend: "just-bash",
      toolVersion: "1",
    });
    // The posture decides who answers the card. In an attached folder, Auto
    // runs the everyday lines and stops for one that deletes, rewrites
    // history, escalates, runs a payload it cannot read, or reaches outside
    // the folder. Under the owner's home with no folder attached, Auto runs
    // only the lines that read; anything that changes a file asks, because
    // nothing there was handed over the way a project folder is. Full
    // access runs every line, wherever on the Mac it reaches, and stops
    // only for a wipe: a remover aimed at the disk, a volume, a home or a
    // top-level folder in one, or disk formatting. The tripwire above still
    // refuses credential paths in every posture.
    let risk: string | null = null;
    let askOwner = true;
    if (readOnly) {
      askOwner = false;
    } else if (permission === "full_access") {
      // `~` and the top-level folders are now the same home in both scopes.
      risk = wipeRisk(input.command, root, shellHome, shellHome);
      askOwner = risk !== null;
    } else if (scope === "folder") {
      risk = commandRisk(input.command, root);
      askOwner = risk !== null;
    } else {
      risk = commandRisk(input.command, root) ?? "changes files outside a project folder";
      askOwner = true;
    }
    // Nothing runs unconfined without the owner: a system with no sandbox
    // gets a card for every line instead of a bare shell.
    if (!askOwner && !sandboxAvailable()) {
      risk = "no sandbox on this system";
      askOwner = true;
    }
    const store = getApprovalStore();
    const rec = store.request({
      ...approvalActor(ctx),
      tool: "bash",
      actionSha256: hash,
      preview: risk ? `${input.command}\n${risk}` : input.command,
    });
    if (!askOwner) {
      store.decide(rec.id, "approve", hash);
    } else {
      await waitUntilNotPending(store, rec.id);
      // The workspace may have changed while the card sat open. The approval
      // was granted against the cwd AND the posture at request time, so a
      // changed root, a changed permission, or a revoked grant all refuse the
      // approval rather than spend it on something the owner did not see.
      // Same rule as the write path.
      let refreshed;
      try {
        refreshed = effectiveRoot(ctx?.session?.id);
      } catch {
        // A grant revoked with no legacy root configured leaves nothing to
        // run in. That is the workspace changing, not a tool crash.
        return { status: "blocked", error: "workspace_changed" };
      }
      if (refreshed.root !== root || refreshed.permission !== permission) {
        return { status: "blocked", error: "workspace_changed" };
      }
    }
    return executeIfApproved(store, rec.id, hash, async () => {
      // What ran without a card runs confined: a read-only line with every
      // write refused, an everyday line with writes kept inside the scope,
      // so a line the classifier misjudged still cannot write outside it.
      // Full access writes anywhere but into credential files and the
      // app's own stores. A line the owner approved runs as they read it.
      const unbounded = permission === "full_access" && !readOnly;
      const args = askOwner
        ? ["/bin/sh", "-c", input.command]
        : confinedCommand(readOnly ? null : root, input.command, scope, unbounded, {
            // The store of the CLI this line runs, and nothing for a line
            // that runs anything else. An approved line skips this because
            // it is not confined at all: the owner read it and said yes.
            credentialPaths: unbounded ? credentialPathsFor(input.command) : [],
          });
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // A line that exits non-zero (`grep` with no match, a failing test) is
      // a result, not a tool failure, and so is one the timeout killed: the
      // exit code and whatever output arrived go back as they are. Only a
      // spawn failure or the owner's Stop throws, which is what `runCommand`
      // rejects on.
      const run = await runCommand(args, {
        cwd: root,
        env: {
          // The owner's own PATH, so a CLI they installed and signed in to
          // is found the way their terminal finds it.
          PATH: ownerPath(),
          HOME: shellHome,
          // The system temp dir, which every posture's profile allows to be
          // written. It used to be the workspace root for a line that could
          // write, which left a CLI's scratch files sitting in the owner's
          // project.
          TMPDIR: tmpdir(),
          // Enough for a CLI to behave: its own config, a non-interactive
          // terminal and the owner's locale. Deliberately still a list and
          // not `...process.env`, so the router's own credentials never
          // reach a child.
          LANG: process.env.LANG ?? "en_US.UTF-8",
          TERM: "dumb",
          SHELL: process.env.SHELL ?? "/bin/zsh",
          ...(process.env.USER ? { USER: process.env.USER, LOGNAME: process.env.USER } : {}),
          ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
        },
        timeoutMs,
        maxBytes: INPUT_MAX_BYTES,
        // The turn's signal reaches the child: a Stop must not leave a
        // cancelled line running to its own timeout with side effects
        // landing after the owner gave up.
        signal: ctx?.abortSignal,
      });
      const truncated = run.truncated
        || run.stdout.length > OUTPUT_MAX_BYTES
        || run.stderr.length > OUTPUT_MAX_BYTES;
      return {
        stdout: wrapUntrusted("bash stdout", run.stdout.slice(0, OUTPUT_MAX_BYTES)),
        stderr: wrapUntrusted("bash stderr", run.stderr.slice(0, OUTPUT_MAX_BYTES)),
        exitCode: run.exitCode,
        truncated,
        // Named, so the model reads "this ran out of time" instead of
        // guessing at exit 124 and retrying the same line unchanged.
        ...(run.timedOut ? { timedOut: true, timeoutMs } : {}),
      };
    });
  },
});

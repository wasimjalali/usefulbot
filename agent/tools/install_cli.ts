import { defineTool } from "eve/tools";
import { z } from "zod";
import { homedir, tmpdir } from "node:os";
import { effectiveRoot } from "../lib/workspace.ts";
import { confinedCommand, sandboxAvailable } from "../lib/sandbox.ts";
import { runCommand } from "../lib/run-command.ts";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, settle } from "../lib/permission.ts";
import { CLI_REGISTRY, cliStatus, findCli, resolveBin } from "../lib/cli-registry.ts";
import { ownerPath, rescanOwnerPath } from "../../shared/user-path.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

/** An install fetches a package and builds it; npm on a cold cache is slow. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX_BYTES = 8 * 1024;
const BUFFER_MAX_BYTES = 256 * 1024;

export default defineTool({
  description:
    "Look up which command-line tools this Mac has, and install one the owner asks for. `list` reports every known CLI, where it resolves on the owner's PATH and whether it holds a sign-in; it only reads, so it runs in every mode. `install` takes one name from that list and runs its exact install command: Read only refuses, Auto shows the owner an approval card with the command on it, Full access runs it. Use `list` before telling the owner a tool is missing, and before guessing a package name. A CLI that is not in the list is still installable through bash, where the owner reads the whole line.",
  inputSchema: z.object({
    action: z.enum(["list", "install"]),
    /** Required for install; ignored by list. */
    name: z.string().min(1).max(40).optional(),
  }),
  async execute(input, ctx) {
    const path = ownerPath();
    if (input.action === "list") {
      return {
        status: "ok",
        clis: CLI_REGISTRY.map((entry) => cliStatus(entry, path)),
        // A sign-in that is present is not a sign-in that still works, and
        // the difference matters to what the model tells the owner next.
        note: "signedIn means a stored credential exists, not that it is still valid.",
      };
    }

    const wanted = (input.name ?? "").trim();
    const entry = wanted ? findCli(wanted) : null;
    if (!entry) {
      return {
        status: "not_found",
        error: wanted ? `no known CLI named ${wanted}` : "install needs a name",
        hint: `Known names: ${CLI_REGISTRY.map((cli) => cli.id).join(", ")}. Anything else goes through bash.`,
      };
    }
    const already = resolveBin(entry.id, path);
    if (already) {
      return { status: "already_installed", name: entry.id, path: already, docs: entry.docs };
    }

    // An install puts a program on the owner's machine and leaves it there,
    // so it carries the same weight as the in-app actions nothing undoes:
    // Read only refuses, Auto asks, Full access runs.
    let workspace;
    try {
      workspace = effectiveRoot(ctx?.session?.id);
    } catch {
      return { status: "blocked", error: "workspace_changed" };
    }
    const { root, permission, scope } = workspace;
    let gate = inAppGate(permission, true);
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    // Same rule as bash: nothing runs unconfined without the owner, so a
    // machine with no sandbox gets a card instead.
    if (gate === "run" && !sandboxAvailable()) gate = "ask";

    const hash = actionSha256({
      tool: "install_cli",
      canonicalArgs: JSON.stringify({ name: entry.id }),
      cwd: root,
      targetRevision: null,
      backend: "just-bash",
      toolVersion: "1",
    });
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "install_cli",
      // The command in full: the owner is approving that line, not the name
      // of a tool a model told them about.
      preview: `install ${entry.label}\n${entry.install}`,
      actionSha256: hash,
    });
    await settle(store, record.id, hash, gate, ctx, permission);

    return executeIfApproved(store, record.id, hash, async () => {
      // Approved on a card: run it as the owner read it. Full access: run it
      // confined, which at that posture still refuses the credential files
      // and the app's own stores.
      const argv = gate === "ask"
        ? ["/bin/sh", "-c", entry.install]
        : confinedCommand(root, entry.install, scope, true, { allowToolInstall: true });
      const run = await runCommand(argv, {
        cwd: root,
        env: {
          PATH: path,
          HOME: homedir(),
          TMPDIR: tmpdir(),
          LANG: process.env.LANG ?? "en_US.UTF-8",
          TERM: "dumb",
          SHELL: process.env.SHELL ?? "/bin/zsh",
          ...(process.env.USER ? { USER: process.env.USER, LOGNAME: process.env.USER } : {}),
        },
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxBytes: BUFFER_MAX_BYTES,
        signal: ctx?.abortSignal,
      });
      // Look again at the directories already known, rather than reuse the
      // PATH resolved before the install ran: that one dropped every
      // directory that did not exist when it was cached, so a first-ever
      // `~/.local/bin` created BY this install would be invisible and a
      // working install would report itself failed. A rescan, not a reset:
      // resetting re-runs the login shell, synchronously, on the one thread
      // every bot shares.
      const resolved = resolveBin(entry.id, rescanOwnerPath());
      // Exit 0 is the installer's opinion; the binary resolving on the
      // owner's own PATH is the thing that decides whether a bot can now
      // run it, and a global install can land somewhere PATH never looks.
      const status = resolved ? "installed" : run.timedOut ? "timeout" : "failed";
      return {
        status,
        name: entry.id,
        path: resolved,
        exitCode: run.exitCode,
        docs: entry.docs,
        stdout: wrapUntrusted("install stdout", run.stdout.slice(-OUTPUT_MAX_BYTES)),
        stderr: wrapUntrusted("install stderr", run.stderr.slice(-OUTPUT_MAX_BYTES)),
        ...(resolved
          ? { hint: `Sign in by running it: see ${entry.docs}.` }
          : run.exitCode === 0
            ? { hint: "The install reported success but the command is not on the owner's PATH; tell them where npm put it." }
            : {}),
      };
    });
  },
});

// How a service gets its secrets: on its stdin, never in its exec environment.
// On macOS any process of the same user can read another process's exec-time
// argv and environment (`ps -E`, sysctl KERN_PROCARGS2), and the sandbox does
// not stop it, so a token in `env` is readable by a shell line the bot runs.
// scripts/secrets-preload.mjs reads the object this writes.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Starts `command` with `--import <preload>` first, `env` as its exec
 * environment (it must hold no secret) and `secrets` as one JSON object on its
 * stdin, which is then closed. `stdio` is the usual triple; its stdin entry is
 * always a pipe.
 */
export function spawnWithSecrets(command, args, { cwd, env, secrets, preload, stdio = ["pipe", "inherit", "inherit"] }) {
  const child = spawn(command, ["--import", pathToFileURL(preload).href, ...args], {
    cwd,
    // The marker tells the preload to read stdin; without it an inherited preload does nothing.
    env: { ...env, UB_SECRETS_ON_STDIN: "1" },
    stdio: ["pipe", stdio[1], stdio[2]],
  });
  child.stdin.on("error", (error) => {
    // A child that dies before reading its stdin is reported by its exit, not by a broken pipe.
    if (error.code === "EPIPE") return;
    // One that cannot get its secrets must not run on without them.
    process.stderr.write(`${JSON.stringify({ service: "service-secrets", error: "secrets_handoff_failed", code: error.code })}\n`);
    child.kill("SIGKILL");
  });
  child.stdin.end(`${JSON.stringify(secrets ?? {})}\n`);
  return child;
}

import { spawn } from "node:child_process";

/**
 * Run one command and collect its output.
 *
 * `execFile` was what this replaced, and three of its defaults are wrong for
 * a CLI the owner asked for: it leaves the child's stdin open, so a tool that
 * asks a question hangs until the timeout instead of reading EOF and giving
 * up; it throws past `maxBuffer` and hands back the partial output attached
 * to an error; and a timeout kill arrives as a rejection whose message is the
 * whole command line, which for a sandboxed line is the entire seatbelt
 * profile. Here a timeout and a flood of output are both results.
 */

export type CommandResult = {
  stdout: string;
  stderr: string;
  /** The child's own code, 124 when the timeout killed it. */
  exitCode: number;
  timedOut: boolean;
  /** Either stream reached `maxBytes`; what came after was dropped. */
  truncated: boolean;
};

export type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Per stream. Collection stops here; the child keeps running. */
  maxBytes: number;
  signal?: AbortSignal;
};

/** How long a timed-out child has to exit on its own before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Collects up to a byte budget and remembers whether it overflowed. */
class Sink {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly max: number;
  overflowed = false;

  // A field, not a parameter property: the services run TypeScript through
  // Node's strip-only mode, which refuses the shorthand.
  constructor(max: number) {
    this.max = max;
  }

  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.overflowed = true;
      return;
    }
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      this.overflowed = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function runCommand(argv: string[], options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      // stdin closed at once: a CLI that prompts reads EOF and exits instead
      // of waiting for input nobody is there to type.
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout or a Stop can take down what the
      // line started and not just the shell that started it. `sh -c 'x;
      // sleep 30'` forks rather than execs, and killing only the shell
      // leaves the sleep holding the output pipes open: the call would then
      // return when the command finished anyway, which is the one thing a
      // timeout exists to prevent.
      detached: true,
    });
    const out = new Sink(options.maxBytes);
    const err = new Sink(options.maxBytes);
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const stopTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    /**
     * Signal the whole group, falling back to the child alone when the group
     * has already gone (ESRCH). SIGTERM first, then SIGKILL for anything that
     * ignores it or has wedged.
     */
    const signalGroup = (signal: NodeJS.Signals) => {
      // No pid means the spawn failed outright (a missing binary, a cwd that
      // is gone), and there is nothing left to signal. Killing that handle
      // anyway does not throw and cannot be caught: it takes the whole
      // process down, which here is the service every bot runs on. The
      // pending `error` event is what settles this call.
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const end = (signal: NodeJS.Signals) => {
      signalGroup(signal);
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (child.exitCode === null) signalGroup("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      end("SIGTERM");
    }, options.timeoutMs);

    function onAbort(): void {
      end("SIGTERM");
    }

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    // Attached before anything below can return. A spawn that fails emits
    // `error` asynchronously, and an `error` on a ChildProcess with no
    // listener is an unhandled event: it takes the process down, and this
    // process is the service. So nothing returns from here without a
    // listener already in place, whatever the reason for returning.
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      stopTimers();
      reject(error);
    });

    if (options.signal) {
      if (options.signal.aborted) {
        settled = true;
        stopTimers();
        signalGroup("SIGKILL");
        reject(options.signal.reason ?? new Error("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // `close` rather than `exit`: the pipes have to drain first, or the tail
    // of a command's output is lost to the race with its own exit.
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stopTimers();
      // A Stop the owner pressed is not a result to report back as one.
      if (options.signal?.aborted && !timedOut) {
        reject(options.signal.reason ?? new Error("aborted"));
        return;
      }
      resolve({
        stdout: out.text(),
        stderr: err.text(),
        exitCode: timedOut ? 124 : code ?? 1,
        timedOut,
        truncated: out.overflowed || err.overflowed,
      });
    });
  });
}

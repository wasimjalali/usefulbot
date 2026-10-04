import { resolve } from "node:path";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { isGuardedPath } from "./sandbox.ts";

/**
 * When the sandbox refused a write that one of its own guard rules covers
 * (planted config, a tool's config folder, a credential or app-state name, a
 * PATH folder), a hint naming the path. Any other "Operation not permitted"
 * (a macOS privacy refusal, a read-only volume) gets none. The path comes from
 * the command's own output, so it is quoted as untrusted data.
 */
export function protectedPathHint(stderr: string, cwd: string): { hint: string } | Record<string, never> {
  const match = /(?:^|: )([^:\n]+): Operation not permitted/m.exec(stderr);
  if (!match) return {};
  const path = match[1].trim().split(/\s+/).pop() ?? "";
  if (!path || !isGuardedPath(resolve(cwd, path))) return {};
  return {
    hint: `The write guard refused a path (shown as data from the command's own output):\n${wrapUntrusted("refused path", path)}\nIt is config a tool runs, or a program folder on the PATH, so no bot can change it. Tell the owner they can run that step in Terminal themselves.`,
  };
}

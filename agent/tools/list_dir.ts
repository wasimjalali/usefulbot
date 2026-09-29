import { defineTool } from "eve/tools";
import { z } from "zod";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { effectiveRoot, resolveWorkspacePath } from "../lib/workspace.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

const LIST_MAX_ENTRIES = 500;

/**
 * Read-only listing of the workspace this conversation works in. Bounded the
 * same way read_file is: a cap on entries, no recursion here (the agent asks
 * per directory), no symlink following (a link reports as `link`, it is never
 * entered or sized), and every row goes out wrapped as untrusted data.
 */
export default defineTool({
  description: "List a folder in the workspace this conversation works in.",
  inputSchema: z.object({
    path: z.string().optional(),
    limit: z.number().int().min(1).max(LIST_MAX_ENTRIES).optional(),
  }),
  execute(input, ctx) {
    const { root } = effectiveRoot(ctx?.session?.id);
    const target = resolveWorkspacePath(input.path || ".", root);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("path_missing");
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("path_symlink");
    if (!stat.isDirectory()) throw new Error("path_not_directory");
    const limit = Math.min(input.limit ?? LIST_MAX_ENTRIES, LIST_MAX_ENTRIES);
    let names: string[];
    try {
      names = readdirSync(target).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") throw new Error("path_unreadable");
      throw error;
    }
    const truncated = names.length > limit;
    const entries = names.slice(0, limit).map((name) => {
      let kind = "file";
      let size: number | null = null;
      try {
        const entry = lstatSync(join(target, name));
        kind = entry.isSymbolicLink()
          ? "link"
          : entry.isDirectory()
            ? "directory"
            : "file";
        if (kind === "file") size = entry.size;
      } catch {
        kind = "unknown";
      }
      return { name, kind, size };
    });
    return {
      path: input.path || ".",
      truncated,
      // One wrapped block per row: a file name is untrusted data, and a
      // planted name must not be able to pose as an instruction.
      rows: entries.map((row) => wrapUntrusted(
        "dir-entry",
        `${row.name}\t${row.kind}${row.size === null ? "" : `\t${row.size} bytes`}`,
      )),
    };
  },
});

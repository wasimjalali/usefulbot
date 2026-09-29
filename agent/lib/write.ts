import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, readFileSync, unlinkSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApprovalStore, actionSha256, defaultApprovalsPath, executeIfApproved, waitUntilNotPending } from "./approvals.ts";
import { autoApproved, effectiveRoot, resolveWorkspacePath } from "./workspace.ts";
import { WRITE_MAX_BYTES } from "../../shared/policy.ts";

let store: ApprovalStore | null = null;

const PREVIEW_MAX = 500;

/** Fit the content onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const bytes = Buffer.byteLength(value, "utf8");
  return flat.length > PREVIEW_MAX
    ? `${flat.slice(0, PREVIEW_MAX)} ... (${bytes} bytes)`
    : flat;
}

export function getApprovalStore(): ApprovalStore {
  if (!store) store = new ApprovalStore(Date.now, defaultApprovalsPath());
  return store;
}

export function setApprovalStore(next: ApprovalStore): void {
  store = next;
}

export async function approvedWrite(input: {
  path: string;
  content: string;
  expectedSha256: string | null;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  autoDecision?: "approve" | "deny";
}): Promise<{ bytes: number; path: string; approvalId: string; actionSha256: string }> {
  if (Buffer.byteLength(input.content, "utf8") > WRITE_MAX_BYTES) {
    throw new Error("write_too_large");
  }
  // One grant read for root AND permission: two reads could pair a root from
  // before a permission change with the permission after it.
  const { root, permission, scope } = effectiveRoot(input.sessionId || undefined);
  if (permission === "read_only") {
    throw new Error("workspace_read_only");
  }
  // Reject a bad path before it ever reaches the owner. Whether the target
  // already exists is what decides, under the owner's home, if Auto asks.
  const target = resolveWorkspacePath(input.path, root);
  let targetExists = false;
  try {
    lstatSync(target);
    targetExists = true;
  } catch {
    targetExists = false;
  }
  const hash = actionSha256({
    tool: "write_file",
    canonicalArgs: JSON.stringify({ path: input.path, content: input.content, expectedSha256: input.expectedSha256 }),
    cwd: root,
    targetRevision: input.expectedSha256,
    backend: "just-bash",
    toolVersion: "1",
  });
  const approvals = getApprovalStore();
  const rec = approvals.request({
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    tool: "write_file",
    actionSha256: hash,
    // The content is what the owner is actually authorising, so it goes on
    // the card after the path; without it they would be approving a bare
    // filename. The hash still binds the full text.
    preview: `write ${input.path}: ${clipPreview(input.content)}`,
  });
  if (input.autoDecision) {
    approvals.decide(rec.id, input.autoDecision, hash);
  } else if (autoApproved(permission, scope, targetExists)) {
    approvals.decide(rec.id, "approve", hash);
  } else {
    await waitUntilNotPending(approvals, rec.id);
    // The owner may have changed the folder or its permission while the card
    // sat open. The approval was granted against the root at request time,
    // so a changed workspace must not consume it: refuse and let the turn
    // retry against the new grant. A grant revoked with no legacy root
    // configured leaves nothing to write into, which is the same answer.
    let refreshed;
    try {
      refreshed = effectiveRoot(input.sessionId || undefined);
    } catch {
      throw new Error("workspace_changed");
    }
    if (refreshed.root !== root || refreshed.permission !== permission) {
      throw new Error("workspace_changed");
    }
  }
  return executeIfApproved(approvals, rec.id, hash, () => {
    // The path is resolved again after consume: a parent directory could have
    // been swapped for a symlink while the owner was reviewing, so the check
    // that ran before the approval is not enough. Writing to the re-resolved
    // target closes that window.
    const target = resolveWorkspacePath(input.path, root);
    // Under the home, Auto ran without a card because the file did not exist.
    // A file that appeared since is one the owner never agreed to replace.
    if (!targetExists && scope === "computer" && permission === "auto") {
      let existsNow = false;
      try {
        lstatSync(target);
        existsNow = true;
      } catch {
        existsNow = false;
      }
      if (existsNow) throw new Error("workspace_changed");
    }
    // expectedSha256 is optimistic concurrency: the owner approved a write
    // against a known revision, so a file that changed since the proposal must
    // not be silently clobbered.
    if (input.expectedSha256 !== null) {
      let current: string | null = null;
      try {
        current = createHash("sha256").update(readFileSync(target)).digest("hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== input.expectedSha256) {
        throw new Error("write_revision_conflict");
      }
    }
    return { ...writeAtomically(target, root, input.content), approvalId: rec.id, actionSha256: hash };
  });
}

/**
 * Create the parent directory and land the file without following a symlink
 * that could have been swapped in. Parents are created one level at a time
 * with lstat checks, and the final parent is re-verified by realpath before
 * the rename, so a symlinked component cannot redirect the write.
 */
function writeAtomically(target: string, root: string, content: string): { bytes: number; path: string } {
  let parent = dirname(target);
  const rootReal = realpathSync(root);
  const missing: string[] = [];
  let probe = parent;
  while (probe !== rootReal && probe !== "/") {
    let stat;
    try {
      stat = lstatSync(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.unshift(probe);
        probe = dirname(probe);
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("path_symlink");
    if (!stat.isDirectory()) throw new Error("path_not_directory");
    break;
  }
  for (const dir of missing) {
    mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error("path_symlink");
  }
  // The realpath of the parent must sit under the real root: a symlink
  // component created between the checks above and this call would otherwise
  // redirect the rename.
  const parentReal = realpathSync(parent);
  if (!parentReal.startsWith(`${rootReal}/`) && parentReal !== rootReal) {
    throw new Error("path_escape");
  }
  const tmp = join(
    parent,
    `.${createHash("sha256").update(target).digest("hex").slice(0, 12)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return { bytes: Buffer.byteLength(content, "utf8"), path: target };
}

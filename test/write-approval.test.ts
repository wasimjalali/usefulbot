import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, executeIfApproved } from "../agent/lib/approvals.ts";
import { approvedWrite, getApprovalStore, setApprovalStore } from "../agent/lib/write.ts";
import { upsertSessionGrant } from "../shared/workspace-store.ts";

/**
 * Session "s" works with no folder attached under the pinned root, in Auto.
 * A session the web server never stamped fails closed to Read only, so the
 * grant is written the way agent-exec writes it.
 */
function stampAuto(): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-ws-store-"));
  process.env.UB_WORKSPACE_STORE_PATH = join(dir, "workspace.json");
  upsertSessionGrant({ sessionId: "s", path: null, permission: "auto" }, new Date(), process.env.UB_WORKSPACE_STORE_PATH);
}

test("denied write does not create the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  setApprovalStore(new ApprovalStore(() => 1_000));
  await assert.rejects(
    () => approvedWrite({
      path: "out.txt",
      content: "secret-should-not-land",
      expectedSha256: null,
      sessionId: "s",
      turnId: "t",
      toolCallId: "c1",
      autoDecision: "deny",
    }),
    /approval_denied/,
  );
  assert.equal(existsSync(join(root, "out.txt")), false);
});

test("approved write is exact bytes and replay is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  mkdirSync(root, { recursive: true });
  setApprovalStore(new ApprovalStore(() => 1_000));
  const first = await approvedWrite({
    path: "note.txt",
    content: "S3-APPROVED-BYTES",
    expectedSha256: null,
    sessionId: "s",
    turnId: "t",
    toolCallId: "c2",
    autoDecision: "approve",
  });
  assert.equal(readFileSync(first.path, "utf8"), "S3-APPROVED-BYTES");
  await assert.rejects(
    () => executeIfApproved(getApprovalStore(), first.approvalId, first.actionSha256, () => "replay"),
    /approval_replay/,
  );
  assert.equal(readFileSync(first.path, "utf8"), "S3-APPROVED-BYTES");
});

test("path escape is rejected before write", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  setApprovalStore(new ApprovalStore(() => 1_000));
  await assert.rejects(
    () => approvedWrite({
      path: "../escape.txt",
      content: "nope",
      expectedSha256: null,
      sessionId: "s",
      turnId: "t",
      toolCallId: "c3",
      autoDecision: "approve",
    }),
    /path_escape/,
  );
});

test("a symlinked parent directory cannot escape the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "ub-out-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  setApprovalStore(new ApprovalStore(() => 1_000));
  symlinkSync(outside, join(root, "link"));
  await assert.rejects(
    () => approvedWrite({
      path: "link/pwned.txt",
      content: "nope",
      expectedSha256: null,
      sessionId: "s",
      turnId: "t",
      toolCallId: "c4",
      autoDecision: "approve",
    }),
    /path_symlink/,
  );
  assert.equal(existsSync(join(outside, "pwned.txt")), false);
});

test("expectedSha256 refuses to clobber a changed file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  setApprovalStore(new ApprovalStore(() => 1_000));
  const target = join(root, "note.txt");
  writeFileSync(target, "current", { encoding: "utf8", mode: 0o600 });
  const stale = createHash("sha256").update("stale").digest("hex");
  await assert.rejects(
    () => approvedWrite({
      path: "note.txt",
      content: "clobber",
      expectedSha256: stale,
      sessionId: "s",
      turnId: "t",
      toolCallId: "c5",
      autoDecision: "approve",
    }),
    /write_revision_conflict/,
  );
  assert.equal(readFileSync(target, "utf8"), "current");

  const current = createHash("sha256").update("current").digest("hex");
  const wrote = await approvedWrite({
    path: "note.txt",
    content: "updated",
    expectedSha256: current,
    sessionId: "s",
    turnId: "t",
    toolCallId: "c6",
    autoDecision: "approve",
  });
  assert.equal(readFileSync(wrote.path, "utf8"), "updated");
});

test("a directory swapped for a symlink during review is rejected after consume", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "ub-out-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  const store = new ApprovalStore(() => 1_000);
  setApprovalStore(store);
  mkdirSync(join(root, "sub"), { recursive: true });
  // With no folder attached, Auto asks only before changing a file that
  // exists, so the card this test needs comes from an overwrite.
  writeFileSync(join(root, "sub", "file.txt"), "before", "utf8");
  const pending = approvedWrite({
    path: "sub/file.txt",
    content: "nope",
    expectedSha256: null,
    sessionId: "s",
    turnId: "t",
    toolCallId: "c7",
  });
  const [record] = store.listPending();
  assert.ok(record, "approval should be pending");
  // The owner is reviewing while the parent directory is swapped for a link.
  rmSync(join(root, "sub"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "sub"));
  store.decide(record.id, "approve", record.actionSha256);
  await assert.rejects(pending, /path_symlink/);
  assert.equal(existsSync(join(outside, "file.txt")), false);
});

test("the write card carries a clipped content preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "ub-ws-"));
  process.env.UB_WORKSPACE_ROOT = root;
  stampAuto();
  const store = new ApprovalStore(() => 1_000);
  setApprovalStore(store);
  await approvedWrite({
    path: "out.txt",
    content: "a".repeat(600),
    expectedSha256: null,
    sessionId: "s",
    turnId: "t",
    toolCallId: "c8",
    autoDecision: "approve",
  });
  const [record] = [...store.records.values()];
  assert.ok(record, "the card was written");
  assert.equal(record.preview.startsWith("write out.txt: "), true);
  // The cut is explicit and the true size is on the card.
  assert.equal(record.preview.includes(" ... (600 bytes)"), true);
});

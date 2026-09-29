import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_APPROVAL_TTL_MS } from "../shared/policy.ts";
import {
  ApprovalStore,
  actionSha256,
  approvalActor,
  executeIfApproved,
  waitUntilNotPending,
} from "../agent/lib/approvals.ts";

function hashFor(args: string) {
  return actionSha256({
    tool: "memory.upsert",
    canonicalArgs: args,
    cwd: "memory",
    targetRevision: null,
    backend: "memory",
    toolVersion: "1",
  });
}

test("approval attribution falls back to live and threads tool context", () => {
  assert.deepEqual(approvalActor(), { sessionId: "live", turnId: "live", toolCallId: "live" });
  assert.deepEqual(
    approvalActor({ session: { id: "ses_1", turn: { id: "turn_1" } }, callId: "call_1" }),
    { sessionId: "ses_1", turnId: "turn_1", toolCallId: "call_1" },
  );
});

test("file-backed store shares request decide and consume across instances", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"pref"}');
  const writer = new ApprovalStore(Date.now, path);
  const rec = writer.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory pref",
  });
  const ui = new ApprovalStore(Date.now, path);
  assert.equal(ui.listPending().length, 1);
  assert.equal(ui.listPending()[0].id, rec.id);
  ui.decide(rec.id, "approve", hash);
  let ran = false;
  await executeIfApproved(new ApprovalStore(Date.now, path), rec.id, hash, () => {
    ran = true;
    return "ok";
  });
  assert.equal(ran, true);
  assert.equal(new ApprovalStore(Date.now, path).listPending().length, 0);
});

test("waitUntilNotPending settles when another process approves", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"wait"}');
  const agent = new ApprovalStore(Date.now, path);
  const rec = agent.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory wait",
  });
  const waiter = waitUntilNotPending(agent, rec.id, 2000, 20);
  setTimeout(() => {
    new ApprovalStore(Date.now, path).decide(rec.id, "approve", hash);
  }, 40);
  const settled = await waiter;
  assert.equal(settled.status, "approved");
});

test("a second decision on a settled approval is rejected", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"once"}');
  const rec = new ApprovalStore(Date.now, path).request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory once",
  });
  const first = new ApprovalStore(Date.now, path).decide(rec.id, "approve", hash);
  assert.equal(first.status, "approved");
  // The loser must see the winner's status, not overwrite it.
  assert.throws(
    () => new ApprovalStore(Date.now, path).decide(rec.id, "deny", hash),
    /approval_not_pending:approved/,
  );
  assert.equal(new ApprovalStore(Date.now, path).get(rec.id)?.status, "approved");
});

test("deciding an expired approval is rejected", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"old"}');
  const rec = new ApprovalStore(() => 0, path).request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory old",
  });
  assert.throws(
    () => new ApprovalStore(Date.now, path).decide(rec.id, "approve", hash),
    /approval_not_pending:expired/,
  );
});

test("a mismatched action hash cannot decide an approval", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"real"}');
  const rec = new ApprovalStore(Date.now, path).request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory real",
  });
  assert.throws(
    () => new ApprovalStore(Date.now, path).decide(rec.id, "approve", hashFor('{"title":"other"}')),
    /approval_hash_mismatch/,
  );
  assert.equal(new ApprovalStore(Date.now, path).get(rec.id)?.status, "pending");
});

test("an approved record from an earlier boot cannot be consumed after restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"restart"}');
  const before = new ApprovalStore(Date.now, path, "boot-a");
  const rec = before.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory restart",
  });
  // The UI process has its own epoch and may still record the decision.
  new ApprovalStore(Date.now, path, "ui-boot").decide(rec.id, "approve", hash);
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(new ApprovalStore(Date.now, path, "boot-b"), rec.id, hash, () => {
      ran = true;
    }),
    /approval_expired/,
  );
  assert.equal(ran, false);
});

test("denied wait does not execute", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"no"}');
  const agent = new ApprovalStore(Date.now, path);
  const rec = agent.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory no",
  });
  const waiter = waitUntilNotPending(agent, rec.id, 2000, 20);
  setTimeout(() => {
    new ApprovalStore(Date.now, path).decide(rec.id, "deny", hash);
  }, 40);
  const settled = await waiter;
  assert.equal(settled.status, "denied");
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(agent, rec.id, hash, () => {
      ran = true;
    }),
    /approval_denied/,
  );
  assert.equal(ran, false);
});

test("waitUntilNotPending retries a transient lock error instead of aborting", async () => {
  let calls = 0;
  const stub = {
    get() {
      calls += 1;
      if (calls === 1) throw new Error("approvals_locked");
      return { id: "apr_x", status: "approved" };
    },
  } as unknown as ApprovalStore;
  const settled = await waitUntilNotPending(stub, "apr_x", 1000, 5);
  assert.equal(calls, 2);
  assert.equal(settled.status, "approved");
});

test("persist prunes settled records after the grace window and keeps a recent decision", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"prune"}');
  const started = 1_000;
  const agent = new ApprovalStore(() => started, path);
  const rec = agent.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory prune",
  });
  new ApprovalStore(() => started, path).decide(rec.id, "approve", hash);
  // Inside the grace window the decided card is still on disk for a slow
  // poll to read.
  const soon = new ApprovalStore(() => started + POLICY_APPROVAL_TTL_MS, path);
  assert.equal(soon.get(rec.id)?.status, "approved");
  // Past expiry plus the TTL and the grace window it goes on the next write.
  const late = started + 2 * POLICY_APPROVAL_TTL_MS + 60 * 60 * 1000 + 1;
  new ApprovalStore(() => late, path).request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hashFor('{"title":"later"}'),
    preview: "memory later",
  });
  assert.equal(new ApprovalStore(Date.now, path).get(rec.id), undefined);
});

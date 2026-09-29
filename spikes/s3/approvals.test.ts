import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStore,
  actionSha256,
  executeIfApproved,
} from "../../agent/lib/approvals.ts";

function hashFor(args: string) {
  return actionSha256({
    tool: "write_file",
    canonicalArgs: args,
    cwd: "/workspace",
    targetRevision: null,
    backend: "just-bash",
    toolVersion: "s3",
  });
}

test("deny never executes", async () => {
  const store = new ApprovalStore(() => 1_000);
  const hash = hashFor('{"path":"a.txt","content":"no"}');
  const rec = store.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "write_file",
    actionSha256: hash,
    preview: "write a.txt",
  });
  store.decide(rec.id, "deny", hash);
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(store, rec.id, hash, () => {
      ran = true;
    }),
    /approval_denied/,
  );
  assert.equal(ran, false);
});

test("expired pending never executes", async () => {
  let now = 1_000;
  const store = new ApprovalStore(() => now);
  const hash = hashFor('{"path":"b.txt"}');
  const rec = store.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "write_file",
    actionSha256: hash,
    preview: "write b.txt",
  });
  now = 1_000 + 5 * 60 * 1000 + 1;
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(store, rec.id, hash, () => {
      ran = true;
    }),
    /approval_expired|approval_not_approved/,
  );
  assert.equal(ran, false);
});

test("modified arguments are a hash mismatch", async () => {
  const store = new ApprovalStore(() => 1_000);
  const hash = hashFor('{"path":"c.txt","content":"one"}');
  const rec = store.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "write_file",
    actionSha256: hash,
    preview: "write c.txt",
  });
  store.decide(rec.id, "approve", hash);
  const other = hashFor('{"path":"c.txt","content":"two"}');
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(store, rec.id, other, () => {
      ran = true;
    }),
    /approval_hash_mismatch/,
  );
  assert.equal(ran, false);
});

test("approved action runs once and replay is rejected", async () => {
  const store = new ApprovalStore(() => 1_000);
  const hash = hashFor('{"path":"d.txt","content":"ok"}');
  const rec = store.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "write_file",
    actionSha256: hash,
    preview: "write d.txt",
  });
  store.decide(rec.id, "approve", hash);
  let runs = 0;
  await executeIfApproved(store, rec.id, hash, () => {
    runs += 1;
    return "wrote";
  });
  assert.equal(runs, 1);
  await assert.rejects(
    () => executeIfApproved(store, rec.id, hash, () => {
      runs += 1;
    }),
    /approval_replay/,
  );
  assert.equal(runs, 1);
});

test("restart invalidates unused approvals", async () => {
  const store = new ApprovalStore(() => 1_000);
  const hash = hashFor('{"path":"e.txt"}');
  const rec = store.request({
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    tool: "write_file",
    actionSha256: hash,
    preview: "write e.txt",
  });
  store.decide(rec.id, "approve", hash);
  store.invalidateOnRestart();
  let ran = false;
  await assert.rejects(
    () => executeIfApproved(store, rec.id, hash, () => {
      ran = true;
    }),
    /approval_expired/,
  );
  assert.equal(ran, false);
});

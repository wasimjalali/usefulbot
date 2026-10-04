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

// A sub-agent's card names its root session and says a sub-agent raised it;
// stopping the root retires the root's cards and every child's, and no other
// session's.
test("a sub-agent's card carries its root and the marker, and a root stop retires the children's cards", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const store = new ApprovalStore(Date.now, path);
  const hash = hashFor("{}");
  const ask = (sessionId: string, extra: Record<string, unknown> = {}) => store.request({
    sessionId, turnId: "t", toolCallId: "c", tool: "memory.upsert", actionSha256: hash, preview: sessionId, ...extra,
  });
  const base = approvalActor({ session: { id: "root-1" }, callId: "c" });
  assert.equal("subagent" in base, false);
  const child = approvalActor({ session: { id: "kid-1", parent: "not-an-object" }, callId: "c" });
  // An unverifiable child still shows, marked, with itself as the root.
  assert.deepEqual(child, { sessionId: "kid-1", turnId: "live", toolCallId: "c", rootSessionId: "kid-1", subagent: true });
  ask("root-1");
  ask("kid-1", { rootSessionId: "root-1", subagent: true });
  ask("kid-2", { rootSessionId: "root-1", subagent: true });
  ask("other-root");
  ask("other-kid", { rootSessionId: "other-root", subagent: true });
  const cards = store.listPending();
  assert.equal(cards.length, 5);
  const kid = cards.find((card) => card.sessionId === "kid-1");
  assert.equal(kid?.subagent, true);
  assert.equal(kid?.rootSessionId, "root-1");
  assert.equal(cards.find((card) => card.sessionId === "root-1")?.subagent, undefined);
  // A child's own cancel retires only that child's cards.
  assert.equal(store.expireSession("kid-1"), 1);
  assert.deepEqual(store.listPending().map((card) => card.sessionId).sort(), ["kid-2", "other-kid", "other-root", "root-1"]);
  // The app's automatic stopped-report cancel retires only the root's own cards.
  assert.equal(store.expireSession("root-1", { children: false }), 1);
  assert.deepEqual(store.listPending().map((card) => card.sessionId).sort(), ["kid-2", "other-kid", "other-root"]);
  // The owner's Stop on a root fails closed: it also retires its sub-agents'
  // cards, never another root's.
  ask("root-1");
  assert.equal(store.expireSession("root-1"), 2);
  assert.deepEqual(store.listPending().map((card) => card.sessionId).sort(), ["other-kid", "other-root"]);
});

test("the owner's Stop on a root expires a sub-agent's approved, unconsumed card", () => {
  const store = new ApprovalStore();
  const hash = hashFor("{}");
  const card = store.request({ sessionId: "kid-9", rootSessionId: "root-9", subagent: true, turnId: "t", toolCallId: "c", tool: "memory.upsert", actionSha256: hash, preview: "p" });
  store.decide(card.id, "approve", hash);
  // The child's own cancel never landed; the root's Stop still closes it.
  assert.equal(store.expireSession("root-9"), 1);
  assert.throws(() => store.consume(card.id, hash), /approval_expired/);
});

test("Stop retires an approved card that has not run, and leaves a consumed one", () => {
  const store = new ApprovalStore();
  const hash = hashFor("{}");
  const ask = (sessionId: string) => store.request({ sessionId, turnId: "t", toolCallId: "c", tool: "memory.upsert", actionSha256: hash, preview: "p" });
  const approved = ask("kid-1");
  store.decide(approved.id, "approve", hash);
  const consumed = ask("kid-1");
  store.decide(consumed.id, "approve", hash);
  store.consume(consumed.id, hash);
  // Approve-then-Stop: the approval must not run afterwards.
  assert.equal(store.expireSession("kid-1"), 1);
  assert.throws(() => store.consume(approved.id, hash), /approval_expired/);
  assert.equal(store.get(consumed.id)?.status, "consumed");
});

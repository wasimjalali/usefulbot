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

test("approval attribution names the chat, bot, turn and tool call", () => {
  assert.deepEqual(
    approvalActor({ chatId: "chat_1", botId: "bot-useful", turnId: "turn_1", callId: "call_1" }),
    { chatId: "chat_1", botId: "bot-useful", turnId: "turn_1", toolCallId: "call_1" },
  );
});

test("file-backed store shares request decide and consume across instances", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"pref"}');
  const writer = new ApprovalStore(Date.now, path);
  const rec = writer.request({
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory wait",
  });
  const waiter = waitUntilNotPending(agent, rec.id, undefined, 2000, 20);
  setTimeout(() => {
    new ApprovalStore(Date.now, path).decide(rec.id, "approve", hash);
  }, 40);
  const settled = await waiter;
  assert.notEqual(settled, "aborted");
  assert.equal(settled === "aborted" ? "aborted" : settled.status, "approved");
});

test("a second decision on a settled approval is rejected", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"once"}');
  const rec = new ApprovalStore(Date.now, path).request({
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hash,
    preview: "memory no",
  });
  const waiter = waitUntilNotPending(agent, rec.id, undefined, 2000, 20);
  setTimeout(() => {
    new ApprovalStore(Date.now, path).decide(rec.id, "deny", hash);
  }, 40);
  const settled = await waiter;
  assert.equal(settled === "aborted" ? "aborted" : settled.status, "denied");
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
  const settled = await waitUntilNotPending(stub, "apr_x", undefined, 1000, 5);
  assert.equal(calls, 2);
  assert.equal(settled === "aborted" ? "aborted" : settled.status, "approved");
});

test("persist prunes settled records after the grace window and keeps a recent decision", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor('{"title":"prune"}');
  const started = 1_000;
  const agent = new ApprovalStore(() => started, path);
  const rec = agent.request({
    chatId: "s",
    botId: "bot-useful",
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
    chatId: "s",
    botId: "bot-useful",
    turnId: "t",
    toolCallId: "c",
    tool: "memory.upsert",
    actionSha256: hashFor('{"title":"later"}'),
    preview: "memory later",
  });
  assert.equal(new ApprovalStore(Date.now, path).get(rec.id), undefined);
});

// A card names the chat, bot, turn and tool call that raised it; stopping a
// chat retires that chat's cards, and no other chat's.
test("a card names the chat and bot that raised it, and a Stop retires only that chat's cards", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const store = new ApprovalStore(Date.now, path);
  const hash = hashFor("{}");
  const ask = (chatId: string) => store.request({
    chatId, botId: "bot-useful", turnId: "t", toolCallId: "c", tool: "memory.upsert", actionSha256: hash, preview: chatId,
  });
  ask("chat-1");
  ask("chat-1");
  ask("chat-2");
  const cards = store.listPending();
  assert.equal(cards.length, 3);
  assert.equal(cards[0].botId, "bot-useful");
  for (const gone of ["sessionId", "rootSessionId", "subagent", "originLabel"]) assert.equal(gone in cards[0], false);
  assert.equal(store.expireSession("chat-1"), 2);
  assert.deepEqual(store.listPending().map((card) => card.chatId), ["chat-2"]);
  assert.equal(store.expireSession("chat-1"), 0);
});

test("a Stop while a card waits ends the wait at once and retires the card", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const store = new ApprovalStore(Date.now, path);
  const hash = hashFor('{"title":"stop"}');
  const rec = store.request({ chatId: "c", botId: "bot-useful", turnId: "t", toolCallId: "k", tool: "bash", actionSha256: hash, preview: "p" });
  const controller = new AbortController();
  const started = Date.now();
  const waiter = waitUntilNotPending(store, rec.id, controller.signal, 60_000, 250);
  setTimeout(() => controller.abort(), 30);
  assert.equal(await waiter, "aborted");
  assert.ok(Date.now() - started < 1000, "the abort waited out a poll interval");
  assert.equal(store.get(rec.id)?.status, "expired");
  assert.deepEqual(store.listPending(), []);
  // Already aborted before the wait starts: returns without polling.
  const second = store.request({ chatId: "c", botId: "bot-useful", turnId: "t", toolCallId: "k", tool: "bash", actionSha256: hash, preview: "p" });
  assert.equal(await waitUntilNotPending(store, second.id, AbortSignal.abort(), 60_000, 250), "aborted");
  assert.equal(store.get(second.id)?.status, "expired");
});

test("the engine's Stop path: expireSession then abort leaves the waiter aborted, not approved", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const store = new ApprovalStore(Date.now, path);
  const hash = hashFor('{"title":"cancel"}');
  const rec = store.request({ chatId: "chat-9", botId: "bot-useful", turnId: "t", toolCallId: "k", tool: "bash", actionSha256: hash, preview: "p" });
  const controller = new AbortController();
  const waiter = waitUntilNotPending(store, rec.id, controller.signal, 60_000, 20);
  store.expireSession("chat-9");
  controller.abort();
  const settled = await waiter;
  // Either answer ends the tool's wait; neither lets the action run.
  assert.ok(settled === "aborted" || settled.status === "expired");
  await assert.rejects(() => executeIfApproved(store, rec.id, hash, () => "ran"), /approval_(expired|not_approved)/);
});

test("invalidateOnRestart retires every card an earlier process left pending or approved", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ub-apr-")), "approvals.json");
  const hash = hashFor("{}");
  const before = new ApprovalStore(Date.now, path, "boot-a");
  const ask = () => before.request({ chatId: "c", botId: "bot-useful", turnId: "t", toolCallId: "k", tool: "bash", actionSha256: hash, preview: "p" });
  const pending = ask();
  const approved = ask();
  before.decide(approved.id, "approve", hash);
  const consumed = ask();
  before.decide(consumed.id, "approve", hash);
  before.consume(consumed.id, hash);
  const after = new ApprovalStore(Date.now, path, "boot-b");
  assert.equal(after.listPending().length, 1, "the ghost card shows until boot retires it");
  after.invalidateOnRestart();
  assert.deepEqual(after.listPending(), []);
  assert.equal(after.get(pending.id)?.status, "expired");
  assert.equal(after.get(approved.id)?.status, "expired");
  assert.equal(after.get(consumed.id)?.status, "consumed");
});

test("Stop retires an approved card that has not run, and leaves a consumed one", () => {
  const store = new ApprovalStore();
  const hash = hashFor("{}");
  const ask = (chatId: string) => store.request({ chatId, botId: "bot-useful", turnId: "t", toolCallId: "c", tool: "memory.upsert", actionSha256: hash, preview: "p" });
  const approved = ask("chat-1");
  store.decide(approved.id, "approve", hash);
  const consumed = ask("chat-1");
  store.decide(consumed.id, "approve", hash);
  store.consume(consumed.id, hash);
  // Approve-then-Stop: the approval must not run afterwards.
  assert.equal(store.expireSession("chat-1"), 1);
  assert.throws(() => store.consume(approved.id, hash), /approval_expired/);
  assert.equal(store.get(consumed.id)?.status, "consumed");
});

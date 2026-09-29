import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentEvent,
  claimProposal,
  createProposal,
  isReserved,
  listPendingProposals,
  listProposalsOfKind,
  listThreadEvents,
  newProposalId,
  parseAgentStore,
  readAgentStore,
  readProposal,
  reserveKey,
  reserveSend,
  threadSnapshot,
  updateProposal,
  writeAgentStore,
} from "../shared/agent-store.ts";
import {
  claimHandoff,
  HANDOFF_ATTEMPTS_MAX,
  listDeliverable,
  listHandoffs,
  markDelivered,
  markFailed,
  ownsHandoffClaim,
  queueHandoff,
  readHandoff,
  pendingHandoffCycle,
  waitForHandoff,
} from "../shared/handoffs.ts";
import { sendHandoff, writeHandoffReply } from "../shared/agents-send.ts";

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "ub-agents-"));
  return { dir, storePath: join(dir, "agents.json"), handoffDir: join(dir, "handoffs") };
}

test("unknown keys at any level are tolerated instead of dropping data", () => {
  // A newer build adding a field must not make this build prune transcripts.
  const parsed = parseAgentStore({
    schemaVersion: 1,
    threads: [{
      id: "b1",
      botId: "b1",
      kind: "bot",
      sessionId: "",
      updatedAt: "x",
      events: [],
      futureThreadField: 1,
    }],
    proposals: [],
    reserves: [],
    futureTopLevel: true,
  });
  assert.equal(parsed.threads.length, 1);
  assert.equal(parsed.threads[0].id, "b1");
});

test("thread events dedupe by id and stay capped", () => {
  const { storePath } = tempPaths();
  appendAgentEvent("b1", { kind: "user", text: "hi", id: "e1" }, storePath);
  appendAgentEvent("b1", { kind: "user", text: "hi", id: "e1" }, storePath);
  const events = listThreadEvents("b1", storePath);
  assert.equal(events.length, 1);
  for (let index = 0; index < 320; index += 1) {
    appendAgentEvent("b1", { kind: "note", text: `n${index}`, id: `n${index}` }, storePath);
  }
  const capped = listThreadEvents("b1", storePath);
  assert.equal(capped.length, 300);
  assert.equal(capped.at(-1)?.id, "n319");
});

test("proposals are created pending, scoped to a thread, and resolved once", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "createBot",
    name: "Research Lead",
    petname: "New Bot 1",
    title: "Research",
    description: "Find sources and cite them.",
    sectionId: null,
    sourceBotId: null,
    threadId: "b1",
    brief: "",
  }, storePath);
  assert.equal(proposal.status, "pending");
  appendAgentEvent("b1", {
    kind: "proposal",
    text: "Proposed teammate",
    proposalId: proposal.id,
    id: "ev1",
  }, storePath);
  const snapshot = threadSnapshot("b1", storePath);
  assert.equal(snapshot.proposals.length, 1);
  assert.equal(snapshot.proposals[0].id, proposal.id);
  const resolved = claimProposal(proposal.id, "confirmed", storePath);
  assert.equal(resolved?.status, "confirmed");
  assert.equal(threadSnapshot("b1", storePath).proposals.length, 0);
  assert.equal(threadSnapshot("b2", storePath).proposals.length, 0);
});

test("a proposal can only be claimed once", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "createBot",
    name: "Once",
    petname: "New Bot 1",
    title: "",
    description: "",
    sectionId: null,
    sourceBotId: null,
    threadId: "b1",
    brief: "",
  }, storePath);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath)?.id, proposal.id);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
  assert.equal(claimProposal(proposal.id, "dismissed", storePath), null);
});

test("an expired proposal cannot be claimed", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "createBot",
    name: "Too Late",
    petname: "New Bot 1",
    title: "",
    description: "",
    sectionId: null,
    sourceBotId: null,
    threadId: "b1",
    brief: "",
  }, storePath);
  const store = readAgentStore(storePath);
  store.proposals[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeAgentStore(store, storePath);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
});

test("a corrupt expiry is treated as expired, not confirmable", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "createBot",
    name: "Corrupt",
    petname: "New Bot 1",
    title: "",
    description: "",
    sectionId: null,
    sourceBotId: null,
    threadId: "b1",
    brief: "",
  }, storePath);
  const store = readAgentStore(storePath);
  store.proposals[0].expiresAt = "not-a-date";
  writeAgentStore(store, storePath);
  // The pending list already hides an unparsable expiry; confirming must fail
  // the same way instead of letting a corrupt card through.
  assert.deepEqual(listPendingProposals("b1", storePath), []);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
});

test("the same side of a handoff lands once per transcript", () => {
  const { storePath } = tempPaths();
  appendAgentEvent("b1", { kind: "post", text: "task", handoffId: "hnd_x", id: "e1" }, storePath);
  appendAgentEvent("b1", { kind: "post", text: "task", handoffId: "hnd_x", id: "e2" }, storePath);
  appendAgentEvent("b1", { kind: "assistant", text: "reply", handoffId: "hnd_x", id: "e3" }, storePath);
  assert.equal(listThreadEvents("b1", storePath).length, 2);
});

test("agent tool sends are idempotent per request id", () => {
  const { storePath } = tempPaths();
  const key = reserveKey("handoff", "req-1");
  assert.equal(isReserved(key, storePath), false);
  assert.equal(reserveSend("handoff", "req-1", storePath), true);
  assert.equal(reserveSend("handoff", "req-1", storePath), false);
  assert.equal(isReserved(key, storePath), true);
  assert.equal(reserveSend("handoff", "req-2", storePath), true);
});

test("handoff queue delivers oldest first, retries twice, then gives up", () => {
  const { handoffDir } = tempPaths();
  const first = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "one",
  }, handoffDir);
  const second = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b3",
    targetName: "Writer",
    message: "two",
  }, handoffDir);
  const queued = listDeliverable(handoffDir);
  assert.deepEqual(queued.map((row) => row.message), ["one", "two"]);
  assert.equal(readHandoff(first.id, handoffDir)?.status, "pending");

  markFailed(second.id, "boom", handoffDir);
  assert.equal(readHandoff(second.id, handoffDir)?.status, "pending");
  for (let attempt = 1; attempt < HANDOFF_ATTEMPTS_MAX; attempt += 1) {
    markFailed(second.id, "boom", handoffDir);
  }
  assert.equal(readHandoff(second.id, handoffDir)?.attempts, HANDOFF_ATTEMPTS_MAX);
  assert.equal(readHandoff(second.id, handoffDir)?.status, "failed");
  assert.deepEqual(listDeliverable(handoffDir).map((row) => row.id), [first.id]);

  markDelivered(first.id, "done", handoffDir);
  assert.equal(readHandoff(first.id, handoffDir)?.status, "delivered");
  assert.deepEqual(listDeliverable(handoffDir), []);
  assert.equal(listHandoffs(handoffDir).length, 2);
});

test("handoff records carry and default the hop depth", () => {
  const { handoffDir } = tempPaths();
  const shallow = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "one",
  }, handoffDir);
  const deep = queueHandoff({
    sourceBotId: "b2",
    sourceName: "Research",
    targetBotId: "b1",
    targetName: "CEO",
    message: "two",
    depth: 2,
  }, handoffDir);
  assert.equal(readHandoff(shallow.id, handoffDir)?.depth, 0);
  assert.equal(readHandoff(deep.id, handoffDir)?.depth, 2);
});

test("a handoff record is claimed by one deliverer at a time", () => {
  const { handoffDir } = tempPaths();
  const record = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "claim me",
  }, handoffDir);
  const first = claimHandoff(record.id, handoffDir);
  assert.ok(first);
  assert.equal(claimHandoff(record.id, handoffDir), null);
  assert.equal(ownsHandoffClaim(record.id, first, handoffDir), true);
  // A failed attempt releases the claim so the retry can pick it up.
  markFailed(record.id, "boom", handoffDir, first);
  assert.equal(ownsHandoffClaim(record.id, first, handoffDir), false);
  assert.ok(claimHandoff(record.id, handoffDir));
});

test("sendHandoff writes both sides of the transcript and one queue record", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-send-"));
  const storePath = join(dir, "agents.json");
  const handoffDir = join(dir, "handoffs");
  const previousStore = process.env.UB_AGENT_STORE_PATH;
  const previousDir = process.env.UB_HANDOFF_DIR;
  process.env.UB_AGENT_STORE_PATH = storePath;
  process.env.UB_HANDOFF_DIR = handoffDir;
  try {
    const record = sendHandoff({
      source: { id: "bot-ceo", name: "CEO" },
      target: { id: "bot-research", name: "Research" },
      message: "Draft the pricing page brief.",
    });
    assert.equal(record.status, "pending");
    assert.equal(listHandoffs(handoffDir).length, 1);
    const sender = listThreadEvents("bot-ceo", storePath);
    const receiver = listThreadEvents("bot-research", storePath);
    assert.equal(sender.length, 1);
    assert.equal(sender[0].kind, "handoff");
    assert.equal(sender[0].targetBotIds[0], "bot-research");
    assert.equal(receiver.length, 1);
    assert.equal(receiver[0].kind, "post");
    assert.equal(receiver[0].authorName, "CEO");
    assert.equal(sender[0].handoffId, record.id);
  } finally {
    if (previousStore === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previousStore;
    if (previousDir === undefined) delete process.env.UB_HANDOFF_DIR;
    else process.env.UB_HANDOFF_DIR = previousDir;
  }
});

test("writeHandoffReply records the answer on both transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-reply-"));
  const storePath = join(dir, "agents.json");
  const previousStore = process.env.UB_AGENT_STORE_PATH;
  process.env.UB_AGENT_STORE_PATH = storePath;
  try {
    const record = sendHandoff({
      source: { id: "bot-ceo", name: "CEO" },
      target: { id: "bot-research", name: "Research" },
      message: "What is the price?",
    });
    writeHandoffReply({
      handoff: record,
      reply: "Forty.",
      sessionId: "sess_1",
      receiverId: "bot-research",
      threadKind: "bot",
    });
    const sender = listThreadEvents("bot-ceo", storePath);
    const receiver = listThreadEvents("bot-research", storePath);
    assert.equal(sender.map((event) => event.kind).join(","), "handoff,post");
    assert.equal(sender[1].text, "Forty.");
    assert.equal(sender[1].authorName, "Research");
    assert.equal(receiver.map((event) => event.kind).join(","), "post,assistant");
    assert.equal(receiver[1].text, "Forty.");
    assert.equal(sender[1].kind, "post");
  } finally {
    if (previousStore === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previousStore;
  }
});

test("waitForHandoff resolves when the record is delivered", async () => {
  const { handoffDir } = tempPaths();
  const record = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "wait for me",
  }, handoffDir);
  setTimeout(() => {
    markDelivered(record.id, "here", handoffDir);
  }, 40);
  const done = await waitForHandoff(record.id, 1000, handoffDir, 10);
  assert.equal(done?.status, "delivered");
  assert.equal(done?.response, "here");
});

test("pendingHandoffCycle sees a three-hop wait loop", () => {
  const { handoffDir } = tempPaths();
  queueHandoff({
    sourceBotId: "a",
    sourceName: "A",
    targetBotId: "b",
    targetName: "B",
    message: "one",
  }, handoffDir);
  queueHandoff({
    sourceBotId: "b",
    sourceName: "B",
    targetBotId: "c",
    targetName: "C",
    message: "two",
  }, handoffDir);
  assert.equal(pendingHandoffCycle("c", "a", "", handoffDir), true);
  assert.equal(pendingHandoffCycle("a", "b", "", handoffDir), false);
});

test("waitForHandoff returns the pending snapshot when the budget expires", async () => {
  const { handoffDir } = tempPaths();
  const record = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "still going",
  }, handoffDir);
  const done = await waitForHandoff(record.id, 40, handoffDir, 10);
  assert.equal(done?.status, "pending");
  assert.equal(done?.id, record.id);
});

test("waitForHandoff gives up as soon as the turn is cancelled", async () => {
  const { handoffDir } = tempPaths();
  const record = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "stop me",
  }, handoffDir);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  // A three minute budget the wait must not serve out once nobody is waiting.
  const done = await waitForHandoff(record.id, 180_000, handoffDir, 10, controller.signal);
  const waited = Date.now() - started;
  assert.equal(done?.status, "pending");
  assert.ok(waited < 5_000, `returned after ${waited}ms`);
});

test("waitForHandoff still answers a reply that lands before the cancel", async () => {
  const { handoffDir } = tempPaths();
  const record = queueHandoff({
    sourceBotId: "b1",
    sourceName: "CEO",
    targetBotId: "b2",
    targetName: "Research",
    message: "beat the stop",
  }, handoffDir);
  const controller = new AbortController();
  setTimeout(() => markDelivered(record.id, "done", handoffDir), 20);
  setTimeout(() => controller.abort(), 400);
  const done = await waitForHandoff(record.id, 5_000, handoffDir, 10, controller.signal);
  assert.equal(done?.status, "delivered");
  assert.equal(done?.response, "done");
});

test("writeHandoffReply records a note on both sides when the reply is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-empty-"));
  const storePath = join(dir, "agents.json");
  const previousStore = process.env.UB_AGENT_STORE_PATH;
  process.env.UB_AGENT_STORE_PATH = storePath;
  try {
    const record = sendHandoff({
      source: { id: "bot-ceo", name: "CEO" },
      target: { id: "bot-research", name: "Research" },
      message: "Anything?",
    });
    writeHandoffReply({
      handoff: record,
      reply: "",
      sessionId: "sess_1",
      receiverId: "bot-research",
      threadKind: "bot",
      sourceThreadKind: "bot",
    });
    const sender = listThreadEvents("bot-ceo", storePath);
    const receiver = listThreadEvents("bot-research", storePath);
    assert.equal(sender.at(-1)?.kind, "note");
    assert.match(sender.at(-1)?.text ?? "", /no reply/);
    assert.equal(receiver.at(-1)?.kind, "note");
    assert.match(receiver.at(-1)?.text ?? "", /no reply/);
  } finally {
    if (previousStore === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previousStore;
  }
});

test("a corrupt store reads as empty rather than throwing", () => {
  const { dir } = tempPaths();
  const store = readAgentStore(join(dir, "missing.json"));
  assert.deepEqual(store.threads, []);
  assert.match(newProposalId(), /^prp_[0-9a-f]{16}$/);
});

test("group fan-out sends one handoff per member and one card per target thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-fanout-"));
  const storePath = join(dir, "agents.json");
  const handoffDir = join(dir, "handoffs");
  const previousStore = process.env.UB_AGENT_STORE_PATH;
  const previousDir = process.env.UB_HANDOFF_DIR;
  process.env.UB_AGENT_STORE_PATH = storePath;
  process.env.UB_HANDOFF_DIR = handoffDir;
  try {
    const targets = [
      { id: "bot-a", name: "Alpha" },
      { id: "bot-b", name: "Beta" },
    ];
    for (const target of targets) {
      sendHandoff({
        source: { id: "bot-ceo", name: "CEO" },
        target,
        message: "Kickoff at nine.",
        group: { id: "grp-1", name: "Launch" },
        receiver: target,
      });
    }
    assert.equal(listHandoffs(handoffDir).length, 2);
    // One copy in each member thread, and the handoff records the room.
    for (const id of ["bot-a", "bot-b"]) {
      const post = listThreadEvents(id, storePath)[0];
      assert.equal(post.kind, "post");
      assert.equal(post.text, "Kickoff at nine.");
      assert.notEqual(post.handoffId, null, `${id} post links to its handoff`);
    }
    const queued = listHandoffs(handoffDir);
    assert.deepEqual(queued.map((row) => row.groupId), ["grp-1", "grp-1"]);
    assert.deepEqual(queued.map((row) => row.threadKind), ["bot", "bot"]);
  } finally {
    if (previousStore === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previousStore;
    if (previousDir === undefined) delete process.env.UB_HANDOFF_DIR;
    else process.env.UB_HANDOFF_DIR = previousDir;
  }
});

test("a connectApp proposal round-trips its phase fields and can be patched in place", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "connectApp",
    slug: "gmail",
    name: "Gmail",
    logo: "https://logos.composio.dev/api/gmail",
    purpose: "Read the last invoice thread",
    sourceBotId: "b1",
    threadId: "b1",
    phase: "proposed",
    accountId: null,
    waitingSince: null,
    toolCount: null,
    handoffId: null,
  }, storePath);
  const stored = readProposal(proposal.id, storePath);
  assert.equal(stored?.kind, "connectApp");
  assert.equal(stored && stored.kind === "connectApp" ? stored.phase : null, "proposed");
  updateProposal(proposal.id, (item) => {
    if (item.kind === "connectApp") {
      item.phase = "waiting";
      item.accountId = "ca_gmail";
      item.waitingSince = "2026-09-16T10:00:00.000Z";
    }
  }, storePath);
  const waiting = listProposalsOfKind("connectApp", storePath);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].phase, "waiting");
  assert.equal(waiting[0].accountId, "ca_gmail");
  assert.equal(waiting[0].logo, "https://logos.composio.dev/api/gmail");
  // A bad phase on disk reads as proposed, never as connected.
  updateProposal(proposal.id, (item) => { (item as { phase: string }).phase = "bogus"; }, storePath);
  assert.equal(listProposalsOfKind("connectApp", storePath)[0].phase, "proposed");
  assert.equal(updateProposal("prp_missing", () => undefined, storePath), null);
});

test("a connectServer proposal round-trips auth and phase fields", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({
    kind: "connectServer",
    connectionKind: "mcp",
    connectionId: "excalidraw",
    name: "Excalidraw",
    description: "Draw diagrams",
    url: "https://mcp.excalidraw.com/mcp",
    urlHost: "mcp.excalidraw.com",
    purpose: "Draw a cat",
    authKind: "none",
    authHeader: null,
    sourceBotId: "b1",
    threadId: "b1",
    phase: "proposed",
    redirectHost: null,
    waitingSince: null,
    toolCount: null,
    handoffId: null,
  }, storePath);
  assert.equal(readProposal(proposal.id, storePath)?.kind, "connectServer");
  updateProposal(proposal.id, (item) => {
    if (item.kind === "connectServer") {
      item.phase = "waiting";
      item.redirectHost = "auth.example.com";
    }
  }, storePath);
  const waiting = listProposalsOfKind("connectServer", storePath);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].phase, "waiting");
  assert.equal(waiting[0].redirectHost, "auth.example.com");
  assert.equal(waiting[0].urlHost, "mcp.excalidraw.com");
  updateProposal(proposal.id, (item) => { (item as { phase: string }).phase = "bogus"; }, storePath);
  assert.equal(listProposalsOfKind("connectServer", storePath)[0].phase, "proposed");
});

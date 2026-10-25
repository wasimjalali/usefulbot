import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimProposal,
  createProposal,
  isReserved,
  listPendingProposals,
  listProposalsOfKind,
  newProposalId,
  openProposals,
  parseAgentStore,
  readAgentStore,
  readProposal,
  releaseSend,
  reopenProposal,
  reserveKey,
  reserveSend,
  updateProposal,
  writeAgentStore,
} from "../shared/agent-store.ts";

// The agent store keeps the open connect cards and the idempotency keys of tool
// calls. Ways it can fail: a card confirmed twice or after it expired, a card
// of a removed kind shown or claimable, a retried tool call acting twice, an
// old build's threads carried forward, one bot's cards listed for another.

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "ub-agents-"));
  return { dir, storePath: join(dir, "agents.json") };
}

/** A connect card for an app. */
function appCard(name: string, threadId = "b1") {
  return {
    kind: "connectApp" as const,
    slug: name.toLowerCase(),
    name,
    logo: null,
    purpose: "Read the last invoice thread",
    sourceBotId: threadId,
    threadId,
    phase: "proposed" as const,
    accountId: null,
    waitingSince: null,
    toolCount: null,
  };
}

test("unknown keys at any level are tolerated instead of dropping data", () => {
  // A newer build adding a field must not make this build prune the cards.
  const parsed = parseAgentStore({
    schemaVersion: 1,
    proposals: [{ ...appCard("Gmail"), id: "prp_a", createdAt: "x", expiresAt: "y", status: "pending", futureCardField: 1 }],
    reserves: ["sent:image:r1"],
    futureTopLevel: true,
  });
  assert.equal(parsed.proposals.length, 1);
  assert.deepEqual(parsed.reserves, ["sent:image:r1"]);
});

test("the store keeps no transcript: threads an older file held are not read and are not written back", () => {
  const { storePath } = tempPaths();
  const live = createProposal(appCard("Gmail"), storePath);
  const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
  raw.threads = [{ id: "b1", botId: "b1", kind: "bot", sessionId: "", updatedAt: "x", events: [{ id: "e1", kind: "assistant", text: "hi", at: "x" }] }];
  writeFileSync(storePath, JSON.stringify(raw), "utf8");
  assert.equal("threads" in readAgentStore(storePath), false);
  assert.deepEqual(readAgentStore(storePath).proposals.map((item) => item.id), [live.id]);
  // The next write is the first without them.
  reserveSend("image", "r1", storePath);
  assert.equal("threads" in JSON.parse(readFileSync(storePath, "utf8")), false);
  assert.deepEqual(readAgentStore(storePath).proposals.map((item) => item.id), [live.id]);
});

test("proposals are created pending, scoped to a bot, and resolved once", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal(appCard("ResearchLead"), storePath);
  assert.equal(proposal.status, "pending");
  assert.deepEqual(openProposals("b1", storePath).map((item) => item.id), [proposal.id]);
  assert.deepEqual(openProposals("b2", storePath), []);
  const resolved = claimProposal(proposal.id, "confirmed", storePath);
  assert.equal(resolved?.status, "confirmed");
  assert.deepEqual(openProposals("b1", storePath), []);
});

test("a proposal can only be claimed once, and a failed apply gives the card back", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal(appCard("Once"), storePath);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath)?.id, proposal.id);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
  assert.equal(claimProposal(proposal.id, "dismissed", storePath), null);
  reopenProposal(proposal.id, storePath);
  assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
  assert.equal(claimProposal(proposal.id, "dismissed", storePath)?.status, "dismissed");
});

test("an expired proposal cannot be claimed, and is not open", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal(appCard("TooLate"), storePath);
  const store = readAgentStore(storePath);
  store.proposals[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeAgentStore(store, storePath);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
  assert.deepEqual(openProposals("b1", storePath), []);
});

test("a corrupt expiry is treated as expired, not confirmable", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal(appCard("Corrupt"), storePath);
  const store = readAgentStore(storePath);
  store.proposals[0].expiresAt = "not-a-date";
  writeAgentStore(store, storePath);
  // The pending list already hides an unparsable expiry; confirming must fail
  // the same way instead of letting a corrupt card through.
  assert.deepEqual(listPendingProposals("b1", storePath), []);
  assert.equal(claimProposal(proposal.id, "confirmed", storePath), null);
});

test("agent tool sends are idempotent per request id, and a slot can be given back", () => {
  const { storePath } = tempPaths();
  const key = reserveKey("proposal", "req-1");
  assert.equal(isReserved(key, storePath), false);
  assert.equal(reserveSend("proposal", "req-1", storePath), true);
  assert.equal(reserveSend("proposal", "req-1", storePath), false);
  assert.equal(isReserved(key, storePath), true);
  assert.equal(reserveSend("proposal", "req-2", storePath), true);
  // The same request id on another kind is its own slot.
  assert.equal(reserveSend("image", "req-1", storePath), true);
  releaseSend("proposal", "req-1", storePath);
  assert.equal(isReserved(key, storePath), false);
  assert.equal(reserveSend("proposal", "req-1", storePath), true);
});

test("cards of the removed kinds on disk are ignored: never listed, never claimable, never kept", () => {
  const { storePath } = tempPaths();
  const base = { createdAt: "2026-09-01T00:00:00.000Z", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: "pending", threadId: "b1", sourceBotId: null };
  const live = createProposal(appCard("Gmail"), storePath);
  const raw = readAgentStore(storePath) as unknown as { proposals: unknown[] };
  raw.proposals.push(
    { ...base, id: "prp_bot", kind: "createBot", name: "Writer", petname: "New Bot 1", title: "", description: "x", sectionId: null, brief: "", proposerId: "bot-useful" },
    { ...base, id: "prp_group", kind: "createGroup", name: "Desk", memberIds: ["a", "b"], description: "", proposerId: "bot-useful" },
    { ...base, id: "prp_profile", kind: "updateBotProfile", botId: "b1", baseRevision: 0, patch: {}, proposerId: "bot-useful" },
    { ...base, id: "prp_fanout", kind: "fanout", message: "hi", targetIds: ["a"], groupId: null },
  );
  writeFileSync(storePath, JSON.stringify(raw), "utf8");
  assert.deepEqual(readAgentStore(storePath).proposals.map((item) => item.id), [live.id]);
  for (const id of ["prp_bot", "prp_group", "prp_profile", "prp_fanout"]) {
    assert.equal(readProposal(id, storePath), null, id);
    assert.equal(claimProposal(id, "confirmed", storePath), null, id);
  }
  assert.deepEqual(listPendingProposals("b1", storePath).map((item) => item.id), [live.id]);
});

test("a missing store reads as empty rather than throwing", () => {
  const { dir } = tempPaths();
  const store = readAgentStore(join(dir, "missing.json"));
  assert.deepEqual(store, { schemaVersion: 1, proposals: [], reserves: [] });
  assert.match(newProposalId(), /^prp_[0-9a-f]{16}$/);
});

test("a connectApp proposal round-trips its phase fields and its resume key, and can be patched in place", () => {
  const { storePath } = tempPaths();
  const proposal = createProposal({ ...appCard("Gmail"), logo: "https://logos.composio.dev/api/gmail" }, storePath);
  const stored = readProposal(proposal.id, storePath);
  assert.equal(stored?.kind, "connectApp");
  assert.equal(stored && stored.kind === "connectApp" ? stored.phase : null, "proposed");
  assert.equal(stored && stored.kind === "connectApp" ? stored.resumeKey : "unset", null);
  updateProposal(proposal.id, (item) => {
    if (item.kind === "connectApp") {
      item.phase = "waiting";
      item.accountId = "ca_gmail";
      item.waitingSince = "2026-09-16T10:00:00.000Z";
      item.resumeKey = `connect:${item.id}`;
    }
  }, storePath);
  const waiting = listProposalsOfKind("connectApp", storePath);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].phase, "waiting");
  assert.equal(waiting[0].accountId, "ca_gmail");
  assert.equal(waiting[0].logo, "https://logos.composio.dev/api/gmail");
  assert.equal(waiting[0].resumeKey, `connect:${proposal.id}`);
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
  assert.equal(waiting[0].connectionKind, "mcp");
  updateProposal(proposal.id, (item) => { (item as { phase: string }).phase = "bogus"; }, storePath);
  assert.equal(listProposalsOfKind("connectServer", storePath)[0].phase, "proposed");
});

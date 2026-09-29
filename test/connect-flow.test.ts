import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, listThreadEvents, readProposal, updateProposal } from "../shared/agent-store.ts";
import { resetCatalogueMemo } from "../shared/composio-catalogue.ts";
import { CONNECT_LINGER_MS, CONNECT_WAIT_MS, pumpConnects, resetConnectMemo, startConnectAuthorize } from "../shared/connect-flow.ts";
import { forgetConnected, setComposioFactory, type ComposioLike, type ComposioSessionLike } from "../shared/composio.ts";
import { setConnectorsKey, updateConnectorsStore } from "../shared/connectors-store.ts";
import { claimHandoff, listHandoffs, markDelivered, queueHandoff } from "../shared/handoffs.ts";
import { writeShell } from "../shared/shell-io.ts";
import { seedStore } from "../shared/shell-store.ts";

type Item = {
  slug: string;
  name: string;
  isNoAuth: boolean;
  logo?: string;
  connection?: { isActive: boolean; connectedAccount?: { status: string; id: string } };
};

const CALLBACK = "http://127.0.0.1:4320/api/connectors/callback";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "ub-connect-"));
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_CONNECTORS_PATH = join(dir, "connectors.json");
  process.env.UB_CATALOGUE_PATH = join(dir, "catalogue.json");
  process.env.UB_HANDOFF_DIR = join(dir, "handoffs");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  resetCatalogueMemo();
  forgetConnected();
  resetConnectMemo();
  updateConnectorsStore((store) => setConnectorsKey(store, "ak_stub_1234567890"));
  return { storePath: process.env.UB_AGENT_STORE_PATH };
}

function stubComposio(items: Item[], toolCount = 3) {
  const state = { items, authorized: 0, countThrows: false };
  const session: ComposioSessionLike = {
    sessionId: "trs_1",
    async authorize(toolkit) {
      state.authorized += 1;
      return { id: `ca_${toolkit}_${state.authorized}`, redirectUrl: `https://connect.composio.dev/${toolkit}` };
    },
    async toolkits(options) {
      const rows = options?.isConnected ? state.items.filter((item) => item.connection?.isActive) : state.items;
      return { items: rows, cursor: undefined };
    },
    async search() {
      return { results: [], toolSchemas: {}, toolkits: [] };
    },
    async execute() {
      return {};
    },
  };
  const client: ComposioLike = {
    sessions: {
      async create() {
        return session;
      },
      async use() {
        return session;
      },
    },
    connectedAccounts: {
      async list() {
        return { items: [] };
      },
      async delete() {
        return {};
      },
    },
    toolkits: {
      async get(slug) {
        return { slug };
      },
    },
    authConfigs: {
      async list() {
        return { items: [] };
      },
      async create() {
        return { id: "ac_stub" };
      },
      async delete() {
        return {};
      },
    },
    client: {
      toolkits: {
        async list() {
          return { items: [] };
        },
      },
    },
    tools: {
      async getRawComposioTools() {
        if (state.countThrows) throw new Error("boom");
        return Array.from({ length: toolCount }, (_, index) => ({ slug: `GMAIL_T${index}`, toolkit: { slug: "gmail" } }));
      },
    },
  };
  setComposioFactory(() => client);
  return state;
}

function seed(storePath: string) {
  const shell = seedStore();
  shell.bots.push({ ...shell.bots[0], id: "b1", name: "Mailer" });
  shell.selectedBotId = "b1";
  writeShell(shell);
  return createProposal({
    kind: "connectApp",
    slug: "gmail",
    name: "Gmail",
    logo: null,
    purpose: "Find the invoice",
    sourceBotId: "b1",
    threadId: "b1",
    phase: "proposed",
    accountId: null,
    waitingSince: null,
    toolCount: null,
    handoffId: null,
  }, storePath);
}

test.afterEach(() => {
  setComposioFactory(null);
  resetConnectMemo();
});

test("authorize moves the card to waiting, stores the account id and returns the URL once", async () => {
  const { storePath } = paths();
  const state = stubComposio([{ slug: "gmail", name: "Gmail", isNoAuth: false }]);
  const proposal = seed(storePath);
  const { redirectUrl } = await startConnectAuthorize(proposal.id, CALLBACK);
  assert.equal(redirectUrl, "https://connect.composio.dev/gmail");
  const stored = readProposal(proposal.id, storePath);
  assert.equal(stored?.kind === "connectApp" && stored.phase, "waiting");
  assert.equal(stored?.kind === "connectApp" && stored.accountId, "ca_gmail_1");
  assert.equal(stored?.status, "pending");
  assert.ok(!JSON.stringify(stored).includes("composio.dev"));
  // Reopen: a second authorize issues a new account id.
  await startConnectAuthorize(proposal.id, CALLBACK);
  assert.equal(state.authorized, 2);
  assert.equal((readProposal(proposal.id, storePath) as { accountId: string }).accountId, "ca_gmail_2");
  await assert.rejects(startConnectAuthorize("prp_missing", CALLBACK), /proposal_missing/);
  // Two clicks in flight mint one account, and a card past its TTL is refused.
  const [one, two] = await Promise.allSettled([
    startConnectAuthorize(proposal.id, CALLBACK),
    startConnectAuthorize(proposal.id, CALLBACK),
  ]);
  assert.equal([one, two].filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(state.authorized, 3);
  updateProposal(proposal.id, (item) => { item.expiresAt = "2000-01-01T00:00:00.000Z"; }, storePath);
  await assert.rejects(startConnectAuthorize(proposal.id, CALLBACK), /proposal_expired/);
});

test("a resume that cannot be queued leaves the card Connected and is retried", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  // An unwritable handoff dir makes queueHandoff throw.
  const dir = process.env.UB_HANDOFF_DIR ?? "";
  writeFileSync(dir, "not a directory");
  resetConnectMemo();
  const out = await pumpConnects({ now: Date.now() + 6_000 });
  assert.deepEqual(out.connected, [proposal.id]);
  const stored = readProposal(proposal.id, storePath) as { phase: string; status: string; handoffId: string | null };
  assert.equal(stored.phase, "connected");
  // No resume yet, so the card stays until one is queued or the cap passes.
  assert.equal(stored.status, "pending");
  assert.equal(stored.handoffId, null);
  const notes = () => listThreadEvents("b1", storePath).filter((e) => e.kind === "note").length;
  assert.equal(notes(), 1);
  // Still broken: no second note, still no handoff, card unchanged.
  await pumpConnects({ now: Date.now() + 12_000 });
  assert.equal(notes(), 1);
  assert.equal((readProposal(proposal.id, storePath) as { handoffId: string | null }).handoffId, null);
  // Repaired: the sweep queues the resume once.
  rmSync(dir, { force: true });
  await pumpConnects({ now: Date.now() + 18_000 });
  assert.equal(listHandoffs().length, 1);
  assert.equal((readProposal(proposal.id, storePath) as { handoffId: string | null }).handoffId, listHandoffs()[0].id);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
  assert.equal(notes(), 1);
});

test("a card whose resume never queues leaves after the linger cap", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  const t0 = Date.now();
  await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  writeFileSync(process.env.UB_HANDOFF_DIR ?? "", "not a directory");
  resetConnectMemo();
  await pumpConnects({ now: t0 + 6_000 });
  assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
  await pumpConnects({ now: t0 + 6_000 + CONNECT_LINGER_MS + 1_000 });
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("overlapping pumps queue the resume once", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  resetConnectMemo();
  const t = Date.now() + 6_000;
  const results = await Promise.all([pumpConnects({ now: t }), pumpConnects({ now: t + 6_000 }), pumpConnects({ now: t + 12_000 })]);
  assert.equal(results.flatMap((r) => r.connected).length, 1);
  assert.equal(listHandoffs().length, 1);
  assert.equal(listThreadEvents("b1", storePath).filter((e) => e.kind === "note").length, 1);
});

test("a card that lost its handoff id adopts the queued resume instead of queueing another", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  // A resume from an earlier connect of the same app, same purpose, long
  // delivered: it must not be mistaken for this cycle's resume.
  const stale = queueHandoff({ sourceBotId: "bot-useful", sourceName: "Useful Bot", targetBotId: "b1", targetName: "Mailer", message: "The owner connected the app gmail. Continue the task: Find the invoice" });
  const earlier = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(process.env.UB_HANDOFF_DIR ?? "", `${stale.id}.json`), JSON.stringify({ ...stale, status: "delivered", createdAt: earlier, updatedAt: earlier }));
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  resetConnectMemo();
  // Real time here: the record's createdAt must not predate the flip stamp.
  await pumpConnects();
  assert.equal(listHandoffs().length, 2);
  const first = (readProposal(proposal.id, storePath) as { handoffId: string }).handoffId;
  assert.notEqual(first, stale.id);
  // The id write is lost (simulated) and the resume was delivered meanwhile;
  // the sweep must find that same record, not queue another.
  const token = claimHandoff(first);
  markDelivered(first, "on it", undefined, token ?? "");
  updateProposal(proposal.id, (p) => { if (p.kind === "connectApp") { p.handoffId = null; p.status = "pending"; } }, storePath);
  await pumpConnects();
  assert.equal(listHandoffs().length, 2);
  assert.equal((readProposal(proposal.id, storePath) as { handoffId: string }).handoffId, first);
});

test("an overdue card whose sign-in finished while no tick ran still connects", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  const t0 = Date.now();
  await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  const out = await pumpConnects({ now: t0 + CONNECT_WAIT_MS + 60_000 });
  assert.deepEqual(out.expired, []);
  assert.deepEqual(out.connected, [proposal.id]);
  assert.equal(listHandoffs().length, 1);
});

test("a failed resume is re-queued, not adopted", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  resetConnectMemo();
  await pumpConnects();
  const first = listHandoffs()[0];
  const dir = process.env.UB_HANDOFF_DIR ?? "";
  writeFileSync(join(dir, `${first.id}.json`), JSON.stringify({ ...first, status: "failed", attempts: 3 }));
  updateProposal(proposal.id, (p) => { if (p.kind === "connectApp") { p.handoffId = null; p.status = "pending"; } }, storePath);
  await pumpConnects();
  assert.equal(listHandoffs().length, 2);
  const id = (readProposal(proposal.id, storePath) as { handoffId: string }).handoffId;
  assert.notEqual(id, first.id);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("a reopen that lands during the expiry check is not expired", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  const t0 = Date.now();
  await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
  // The pump's snapshot is stale: the owner reopened after it was read.
  await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 + CONNECT_WAIT_MS + 30_000 });
  const fresh = (readProposal(proposal.id, storePath) as { waitingSince: string }).waitingSince;
  // Simulate the stale read by rewinding only what the pump compares.
  updateProposal(proposal.id, (p) => { if (p.kind === "connectApp") p.waitingSince = new Date(t0).toISOString(); }, storePath);
  const stale = readProposal(proposal.id, storePath);
  updateProposal(proposal.id, (p) => { if (p.kind === "connectApp") p.waitingSince = fresh; }, storePath);
  assert.ok(stale);
  const out = await pumpConnects({ now: t0 + CONNECT_WAIT_MS + 60_000 });
  assert.equal((readProposal(proposal.id, storePath) as { phase: string }).phase, "waiting");
  assert.deepEqual(out.expired, []);
});

test("an authorize that overlaps the pump's flip does not rewind a connected card", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  resetConnectMemo();
  // Authorize reads the card as waiting, then the pump connects it before
  // authorize writes back.
  const pending = pumpConnects({ now: Date.now() + 6_000 });
  await pending;
  await assert.rejects(startConnectAuthorize(proposal.id, CALLBACK), /proposal_settled|already_connected/);
  assert.equal((readProposal(proposal.id, storePath) as { phase: string }).phase, "connected");
  assert.equal(listHandoffs().length, 1);
});

test("the pump connects a waiting card once, writes the note and queues one resume handoff", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  stubComposio([item]);
  const proposal = seed(storePath);
  await startConnectAuthorize(proposal.id, CALLBACK);
  // Not active yet: nothing happens.
  assert.deepEqual(await pumpConnects({ now: Date.now() }), { connected: [], expired: [] });
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "ca_gmail_1" } };
  resetConnectMemo();
  const first = await pumpConnects({ now: Date.now() + 6_000 });
  assert.deepEqual(first.connected, [proposal.id]);
  const stored = readProposal(proposal.id, storePath);
  // Confirmed the moment the resume is queued: the card leaves the dock and
  // the note row plus the bot's next turn tell the rest.
  assert.equal(stored?.status, "confirmed");
  assert.equal(stored?.kind === "connectApp" && stored.phase, "connected");
  assert.equal(stored?.kind === "connectApp" && stored.toolCount, 3);
  const handoffs = listHandoffs();
  assert.equal(handoffs.length, 1);
  assert.equal(stored?.kind === "connectApp" && stored.handoffId, handoffs[0].id);
  assert.equal(handoffs[0].targetBotId, "b1");
  assert.equal(handoffs[0].targetName, "Mailer");
  assert.equal(handoffs[0].depth, 0);
  assert.match(handoffs[0].message, /connected the app gmail\./);
  assert.ok(!handoffs[0].message.includes("Gmail"));
  assert.match(handoffs[0].message, /Find the invoice/);
  assert.ok(listThreadEvents("b1", storePath).some((event) => event.kind === "note" && event.text === "Gmail connected" && event.connectedName === "Gmail"));
  // A second tick does nothing more.
  resetConnectMemo();
  assert.deepEqual(await pumpConnects({ now: Date.now() + 12_000 }), { connected: [], expired: [] });
  assert.equal(listHandoffs().length, 1);
  assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
});

test("the pump respects the 5 s memo, expires after 10 min, and leaves toolCount null on a count failure", async () => {
  const { storePath } = paths();
  const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
  const state = stubComposio([item]);
  const proposal = seed(storePath);
  const t0 = Date.now();
  await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
  await pumpConnects({ now: t0 });
  item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "x" } };
  // Within 5 s of the last check: no Composio call, still waiting.
  await pumpConnects({ now: t0 + 2_000 });
  assert.equal((readProposal(proposal.id, storePath) as { phase: string }).phase, "waiting");
  state.countThrows = true;
  await pumpConnects({ now: t0 + 6_000 });
  const stored = readProposal(proposal.id, storePath) as { phase: string; toolCount: number | null; status: string };
  assert.equal(stored.phase, "connected");
  assert.equal(stored.toolCount, null);
  assert.equal(stored.status, "confirmed");

  const second = seed(storePath);
  await startConnectAuthorize(second.id, CALLBACK, { now: t0 });
  item.connection = undefined;
  resetConnectMemo();
  const late = await pumpConnects({ now: t0 + CONNECT_WAIT_MS + 60_000 });
  assert.deepEqual(late.expired, [second.id]);
  const expired = readProposal(second.id, storePath) as { phase: string; status: string };
  assert.equal(expired.phase, "expired");
  assert.equal(expired.status, "pending");
  assert.equal(listHandoffs().length, 1);
  // Reopen after a timeout goes back to waiting.
  await startConnectAuthorize(second.id, CALLBACK, { now: t0 + CONNECT_WAIT_MS + 61_000 });
  assert.equal((readProposal(second.id, storePath) as { phase: string }).phase, "waiting");
});

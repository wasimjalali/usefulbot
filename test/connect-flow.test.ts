import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, readProposal, updateProposal } from "../shared/agent-store.ts";
import { resetCatalogueMemo } from "../shared/composio-catalogue.ts";
import { CONNECT_LINGER_MS, CONNECT_WAIT_MS, pumpConnects, resetConnectMemo, startConnectAuthorize } from "../shared/connect-flow.ts";
import { forgetConnected, setComposioFactory, type ComposioLike, type ComposioSessionLike } from "../shared/composio.ts";
import { setConnectorsKey, updateConnectorsStore } from "../shared/connectors-store.ts";
import { startStubEngine, withEnv, type StubEngine } from "./web/stub-engine.ts";

// Ways the connect card flow can fail:
// 1. a card connects and the bot is never resumed, or is resumed twice (overlapping pumps, a retry);
// 2. a resume the engine did not take drops the card instead of retrying it;
// 3. a card that can never be resumed stays on screen for good;
// 4. the resume text carries the app's display name (data from the catalogue) as an instruction;
// 5. the connected note is written twice, or to the wrong bot.

type Item = {
  slug: string;
  name: string;
  isNoAuth: boolean;
  logo?: string;
  connection?: { isActive: boolean; connectedAccount?: { status: string; id: string } };
};

const CALLBACK = "http://127.0.0.1:4320/api/connectors/callback";
const RESUME = "/internal/bots/b1/system-turn";
const ROWS = "/internal/bots/b1/rows";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "ub-connect-"));
  process.env.UB_AGENT_STORE_PATH = join(dir, "agents.json");
  process.env.UB_CONNECTORS_PATH = join(dir, "connectors.json");
  process.env.UB_CATALOGUE_PATH = join(dir, "catalogue.json");
  resetCatalogueMemo();
  forgetConnected();
  resetConnectMemo();
  updateConnectorsStore((store) => setConnectorsKey(store, "ak_stub_1234567890"));
  return { storePath: process.env.UB_AGENT_STORE_PATH };
}

/** The flow talks to the engine over HTTP; the stub records what it sent. */
async function withEngine(fn: (engine: StubEngine) => Promise<void>): Promise<void> {
  const engine = await startStubEngine();
  try {
    await withEnv({ UB_ENGINE_PORT: String(engine.port), UB_ENGINE_TOKEN: engine.token }, () => fn(engine));
  } finally {
    await engine.close();
  }
}

const sent = (engine: StubEngine, path: string) => engine.requests.filter((request) => request.method === "POST" && request.path === path);

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

function seed(storePath: string, over: { sourceBotId?: string | null } = {}) {
  return createProposal({
    kind: "connectApp",
    slug: "gmail",
    name: "Gmail",
    logo: null,
    purpose: "Find the invoice",
    sourceBotId: over.sourceBotId === undefined ? "b1" : over.sourceBotId,
    threadId: "b1",
    phase: "proposed",
    accountId: null,
    waitingSince: null,
    toolCount: null,
  }, storePath);
}

const connect = (item: Item) => { item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "ca_gmail_1" } }; };

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

test("a resume the engine does not take leaves the card Connected and is retried with the same key", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    connect(item);
    engine.answer("POST", RESUME, 503, { ok: false, error: "engine_starting" });
    resetConnectMemo();
    const out = await pumpConnects({ now: Date.now() + 6_000 });
    assert.deepEqual(out.connected, [proposal.id]);
    const stored = readProposal(proposal.id, storePath) as { phase: string; status: string; resumeKey: string | null };
    assert.equal(stored.phase, "connected");
    // No resume yet, so the card stays until one is accepted or the cap passes.
    assert.equal(stored.status, "pending");
    assert.equal(stored.resumeKey, null);
    assert.equal(sent(engine, ROWS).length, 1, "the connected note");
    // Still refused: no second note, no resume key, card unchanged.
    await pumpConnects({ now: Date.now() + 12_000 });
    assert.equal(sent(engine, ROWS).length, 1);
    assert.equal((readProposal(proposal.id, storePath) as { resumeKey: string | null }).resumeKey, null);
    // The engine takes it: the sweep resumes the bot with the card's own key.
    engine.clear("POST", RESUME);
    await pumpConnects({ now: Date.now() + 18_000 });
    const resumes = sent(engine, RESUME);
    const keys = new Set(resumes.map((request) => JSON.parse(request.body).key));
    assert.deepEqual([...keys], [`connect:${proposal.id}`], "every attempt carries the card's key, so the engine runs it once");
    assert.equal((readProposal(proposal.id, storePath) as { resumeKey: string }).resumeKey, `connect:${proposal.id}`);
    assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
    assert.equal(sent(engine, ROWS).length, 1);
  });
});

test("a card whose resume is never accepted leaves after the linger cap", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    const t0 = Date.now();
    await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
    connect(item);
    engine.answer("POST", RESUME, 500, { ok: false, error: "engine_error" });
    resetConnectMemo();
    await pumpConnects({ now: t0 + 6_000 });
    assert.equal(readProposal(proposal.id, storePath)?.status, "pending");
    await pumpConnects({ now: t0 + 6_000 + CONNECT_LINGER_MS + 1_000 });
    assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
  });
});

test("an engine that is down keeps the card Connected, writes no note and does not throw", async () => {
  const engine = await startStubEngine();
  const port = engine.port;
  await engine.close();
  await withEnv({ UB_ENGINE_PORT: String(port), UB_ENGINE_TOKEN: "t" }, async () => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    connect(item);
    resetConnectMemo();
    const out = await pumpConnects({ now: Date.now() + 6_000 });
    assert.deepEqual(out.connected, [proposal.id]);
    const stored = readProposal(proposal.id, storePath) as { phase: string; status: string; resumeKey: string | null };
    assert.deepEqual([stored.phase, stored.status, stored.resumeKey], ["connected", "pending", null]);
  });
});

test("overlapping pumps resume the bot once", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    connect(item);
    resetConnectMemo();
    const t = Date.now() + 6_000;
    const results = await Promise.all([pumpConnects({ now: t }), pumpConnects({ now: t + 6_000 }), pumpConnects({ now: t + 12_000 })]);
    assert.equal(results.flatMap((r) => r.connected).length, 1);
    assert.equal(sent(engine, RESUME).length, 1);
    assert.equal(sent(engine, ROWS).length, 1);
  });
});

test("a card that lost its resume key asks again with the same key instead of inventing another", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    connect(item);
    resetConnectMemo();
    await pumpConnects();
    assert.equal(sent(engine, RESUME).length, 1);
    // The key write is lost (simulated): the card reads as pending with no key.
    updateProposal(proposal.id, (p) => { if (p.kind === "connectApp") { p.resumeKey = null; p.status = "pending"; } }, storePath);
    await pumpConnects();
    const resumes = sent(engine, RESUME);
    assert.equal(resumes.length, 2);
    assert.equal(JSON.parse(resumes[0].body).key, JSON.parse(resumes[1].body).key, "the engine dedupes by this key");
    assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
  });
});

test("an overdue card whose sign-in finished while no tick ran still connects", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    const t0 = Date.now();
    await startConnectAuthorize(proposal.id, CALLBACK, { now: t0 });
    connect(item);
    const out = await pumpConnects({ now: t0 + CONNECT_WAIT_MS + 60_000 });
    assert.deepEqual(out.expired, []);
    assert.deepEqual(out.connected, [proposal.id]);
    assert.equal(sent(engine, RESUME).length, 1);
  });
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
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    connect(item);
    resetConnectMemo();
    await pumpConnects({ now: Date.now() + 6_000 });
    await assert.rejects(startConnectAuthorize(proposal.id, CALLBACK), /proposal_settled|already_connected/);
    assert.equal((readProposal(proposal.id, storePath) as { phase: string }).phase, "connected");
    assert.equal(sent(engine, RESUME).length, 1);
  });
});

test("the pump connects a waiting card once, writes the note and starts one resume turn", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const proposal = seed(storePath);
    await startConnectAuthorize(proposal.id, CALLBACK);
    // Not active yet: nothing happens.
    assert.deepEqual(await pumpConnects({ now: Date.now() }), { connected: [], expired: [] });
    assert.equal(engine.requests.length, 0);
    item.connection = { isActive: true, connectedAccount: { status: "ACTIVE", id: "ca_gmail_1" } };
    resetConnectMemo();
    const first = await pumpConnects({ now: Date.now() + 6_000 });
    assert.deepEqual(first.connected, [proposal.id]);
    const stored = readProposal(proposal.id, storePath);
    // Confirmed the moment the engine takes the resume: the card leaves the
    // dock and the note row plus the bot's next turn tell the rest.
    assert.equal(stored?.status, "confirmed");
    assert.equal(stored?.kind === "connectApp" && stored.phase, "connected");
    assert.equal(stored?.kind === "connectApp" && stored.toolCount, 3);
    const resumes = sent(engine, RESUME);
    assert.equal(resumes.length, 1);
    assert.equal(stored?.kind === "connectApp" && stored.resumeKey, `connect:${proposal.id}`);
    assert.equal(resumes[0].headers.authorization, `Bearer ${engine.token}`);
    const resume = JSON.parse(resumes[0].body) as { key: string; text: string };
    assert.equal(resume.key, `connect:${proposal.id}`);
    assert.match(resume.text, /connected the app gmail\./);
    assert.ok(!resume.text.includes("Gmail"), "the catalogue's display name is data, not part of the instruction");
    assert.match(resume.text, /Find the invoice/);
    assert.match(resume.text, /BEGIN-UNTRUSTED\(connect-purpose\)/, "the bot-written purpose reaches the model fenced as untrusted");
    const notes = sent(engine, ROWS);
    assert.equal(notes.length, 1);
    assert.deepEqual(JSON.parse(notes[0].body), { key: `connect:${proposal.id}`, kind: "note", text: "Connected Gmail.", source: "connect" });
    // A second tick does nothing more.
    resetConnectMemo();
    assert.deepEqual(await pumpConnects({ now: Date.now() + 12_000 }), { connected: [], expired: [] });
    assert.equal(sent(engine, RESUME).length, 1);
    assert.equal(readProposal(proposal.id, storePath)?.status, "confirmed");
  });
});

test("the pump respects the 5 s memo, expires after 10 min, and leaves toolCount null on a count failure", async () => {
  await withEngine(async (engine) => {
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
    assert.equal(sent(engine, RESUME).length, 1);
    // Reopen after a timeout goes back to waiting.
    await startConnectAuthorize(second.id, CALLBACK, { now: t0 + CONNECT_WAIT_MS + 61_000 });
    assert.equal((readProposal(second.id, storePath) as { phase: string }).phase, "waiting");
  });
});

test("the resume and the note go to the bot that raised the card, and to the card's bot when none is named", async () => {
  await withEngine(async (engine) => {
    const { storePath } = paths();
    const item: Item = { slug: "gmail", name: "Gmail", isNoAuth: false };
    stubComposio([item]);
    const named = createProposal({ ...{ kind: "connectApp" as const, slug: "gmail", name: "Gmail", logo: null, purpose: "Find it", phase: "proposed" as const, accountId: null, waitingSince: null, toolCount: null }, sourceBotId: "bot-source", threadId: "bot-card" }, storePath);
    await startConnectAuthorize(named.id, CALLBACK);
    connect(item);
    resetConnectMemo();
    await pumpConnects({ now: Date.now() + 6_000 });
    assert.equal(sent(engine, "/internal/bots/bot-source/system-turn").length, 1);
    assert.equal(sent(engine, "/internal/bots/bot-source/rows").length, 1);

    const unnamed = createProposal({ ...{ kind: "connectApp" as const, slug: "gmail", name: "Gmail", logo: null, purpose: "Find it", phase: "proposed" as const, accountId: null, waitingSince: null, toolCount: null }, sourceBotId: null, threadId: "bot-card" }, storePath);
    await startConnectAuthorize(unnamed.id, CALLBACK);
    resetConnectMemo();
    await pumpConnects({ now: Date.now() + 12_000 });
    assert.equal(sent(engine, "/internal/bots/bot-card/system-turn").length, 1);
    assert.equal(sent(engine, "/internal/bots/bot-card/rows").length, 1);
  });
});

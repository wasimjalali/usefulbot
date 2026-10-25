import assert from "node:assert/strict";
import test from "node:test";
import type { Row } from "../../agent/engine/protocol.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld, waitForRequests, type World } from "./helpers.ts";
import { assertEnvelope, assertShapes, fixtureJson, fixtureLines, shape } from "./shapes.ts";

/**
 * The engine's output against test/fixtures/chat-protocol/. Scripted turns run
 * through the whole engine; what comes out must have the fixtures' fields and
 * types (values are synthetic there, so only shapes are compared). Each
 * scenario checks its own behaviour, and the last test holds everything the
 * scenarios produced against everything the fixtures pin.
 */

type Event = Record<string, unknown>;

const produced: Event[] = [];
const producedRows: Row[] = [];

const asEvent = (row: Row): Event => ({ type: "row", row, seq: 0, epoch: "", at: "", chatId: "" });

async function fullTurn(world: World, chatId: string): Promise<void> {
  const row = (fields: Record<string, unknown>) => ({ name: "file_row", args: { row: fields } });
  world.router.enqueue(
    { kind: "tools", calls: [{ name: "web_search", args: { query: "pi" } }] },
    { kind: "tools", text: "Here are two sources.", calls: [{ name: "find_tools", args: { query: "draw" } }] },
    { kind: "tools", calls: [{ name: "demo__ping", args: { elements: [{ type: "rectangle", x: 0, y: 0 }] } }] },
    { kind: "tools", calls: [row({ key: "image:img-0001", kind: "image", imageId: "img-0001", prompt: "A small robot reading a map" })] },
    { kind: "tools", calls: [row({ key: "page:media-0001", kind: "page", mediaId: "media-0001", title: "Pi notes", path: "/Users/owner/Desktop/pi-notes.html" })] },
    { kind: "tools", text: "I drew the flow and saved a page.", calls: [{ name: "ask", args: { prompt: "Which folder should I save the report in?", options: [{ id: "desktop", label: "Desktop" }, { id: "docs", label: "Documents", detail: "~/Documents/Reports" }] } }] },
    { kind: "text", text: "Saved to the Desktop." },
  );
  world.send(chatId, "Find two sources on Pi and draw the flow", {
    attachments: [{ name: "notes.txt", mediaType: "text/plain", size: 812, text: "my notes" }],
  });
  await world.idle(chatId);
  world.send(chatId, "Desktop");
  await world.idle(chatId);
}

test("a turn with search, a widget, an image row, a question and its answer", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    await fullTurn(world, chatId);
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: "widget:call-excal-1", kind: "widget", widgetId: "wdg-0001", callId: world.engine.host.chat(chatId).calls.keys().next().value as string, connectionId: "excalidraw", toolName: "create_view" } as never);
    recorder.events.push(world.engine.host.chat(chatId).bus.ping());
    const events = recorder.events as Event[];
    assertEnvelope(events);
    produced.push(...events);
    const types = events.map((event) => event.type);
    assert.equal(types[0], "stream.ready");
    assert.ok(types.indexOf("turn.started") < types.indexOf("message.user"));
    assert.ok(types.indexOf("message.delta") < types.indexOf("message.final"));
    assert.equal(types.filter((type) => type === "input.requested").length, 1);
    const requested = types.indexOf("input.requested");
    const resolved = types.indexOf("input.resolved");
    assert.ok(resolved > requested, "the answer resolves the question");
    assert.ok(types.indexOf("turn.started", requested) > resolved, "input.resolved comes before the answering turn.started");
    const attachment = events.find((event) => event.type === "message.user")?.attachments as { name: string }[];
    assert.deepEqual(attachment.map((item) => item.name), ["notes.txt"]);
    const widgetCall = events.find((event) => event.type === "tool.call" && event.widget);
    assert.deepEqual((widgetCall?.widget as { connectionId: string }).connectionId, "demo");
    const search = events.find((event) => event.type === "tool.result" && event.searchResults);
    assert.equal((search?.searchResults as unknown[]).length, 1);
    producedRows.push(...world.engine.rows(chatId, {}).rows);
  } finally {
    await world.close();
  }
});

test("a failed turn and its Retry", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    const clientId = crypto.randomUUID();
    world.router.enqueue(
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 20 },
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 20 },
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 20 },
      { kind: "text", text: "Saved to the Desktop." },
    );
    world.send(chatId, "Desktop", { clientId });
    await world.idle(chatId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    world.send(chatId, "Desktop", { clientId, retry: true });
    await world.idle(chatId);
    const events = recorder.events as Event[];
    produced.push(...events);
    const failed = events.find((event) => event.type === "turn.failed");
    assert.equal(failed?.code, "upstream_unavailable");
    assert.equal(failed?.detail, "The provider didn't answer.");
    assert.equal(failed?.retryAfterMs, 20);
    assert.equal(failed?.messageKept, true);
    assert.equal(failed?.rowId, `${failed?.turnId}:f`);
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("row") < types.indexOf("turn.failed"), "the failure row comes just before turn.failed");
    assert.ok(events.some((event) => event.type === "activity" && event.kind === "retrying"));
  } finally {
    await world.close();
  }
});

test("a queue and a Stop", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "stall", text: "Step one" });
    world.send(chatId, "Write a long plan");
    world.send(chatId, "Make it shorter");
    world.send(chatId, "and email it to me");
    await waitForRequests(world, 1);
    world.engine.cancel(chatId);
    await world.idle(chatId);
    produced.push(...(recorder.events as Event[]));
    const types = recorder.events.map((event) => event.type);
    assert.ok(types.indexOf("row") < types.indexOf("message.dropped"), "the unsent row comes just before message.dropped");
    producedRows.push(...world.engine.rows(chatId, {}).rows);
  } finally {
    await world.close();
  }
});

test("a system turn has no owner bubble and a note before it", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "text", text: "Gmail is connected." });
    world.engine.systemTurn(DEFAULT_BOT_ID, "connect-gmail-1", "Gmail is connected. Carry on.", "Connected Gmail.");
    await world.idle(chatId);
    const events = recorder.events as Event[];
    produced.push(...events);
    const types = events.map((event) => event.type);
    assert.ok(!types.includes("message.user"), "a system turn has no message.user");
    assert.equal((events.find((event) => event.type === "turn.started"))?.origin, "system");
    assert.ok(!("clientId" in (events.find((event) => event.type === "turn.started") as Event)));
    assert.ok(types.indexOf("row") < types.indexOf("turn.started"), "the note comes first");
    const rows = world.engine.rows(chatId, {}).rows;
    assert.deepEqual(rows.map((row) => row.kind), ["note", "assistant"]);
    producedRows.push(...rows);
  } finally {
    await world.close();
  }
});

test("compaction in the middle of a turn", async () => {
  const world = await makeWorld({ window: 20_000 });
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    const filler = "lorem ipsum ".repeat(1200);
    world.router.fallback((request) => {
      if (JSON.stringify(request.body.messages).includes("<conversation>")) return { kind: "text", text: "SUMMARY" };
      return { kind: "text", text: "Continuing.", usage: { prompt_tokens: 16_500, completion_tokens: 20 } };
    });
    for (let i = 0; i < 3; i += 1) {
      world.send(chatId, `Keep going with the report ${i} ${filler}`);
      await world.idle(chatId);
    }
    const events = recorder.events as Event[];
    produced.push(...events);
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("row") < types.indexOf("compaction.done"), "the note row comes before compaction.done");
    const done = events.find((event) => event.type === "compaction.done");
    assert.match(String(done?.rowId), /^compaction:/);
    producedRows.push(...world.engine.rows(chatId, {}).rows);
  } finally {
    await world.close();
  }
});

test("a reconnect with an old seq is told to refetch", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "x".repeat(5_000), chunks: 2_500 });
    world.send(chatId, "stream a lot");
    await world.idle(chatId);
    const tail = world.engine.host.chat(chatId).bus.tailSeq;
    assert.ok(tail > 2_000, "more events than the ring holds");
    const stale = world.record(chatId, { after: 3, epoch: world.engine.epoch });
    assert.equal(stale.events.length, 1, "no replay when the client fell behind the ring");
    assert.equal(stale.events[0].resync, true);
    assert.equal(stale.events[0].tailSeq, tail);
    produced.push(...(stale.events as Event[]));
    // And with a turn running, the same line names it.
    world.router.enqueue({ kind: "stall", text: "partial" });
    world.send(chatId, "again");
    await waitForRequests(world, 2);
    const live = world.record(chatId, { after: 3, epoch: world.engine.epoch });
    produced.push(...(live.events as Event[]));
    assert.equal(typeof (live.events[0].running as { turnId: string }).turnId, "string");
    world.engine.cancel(chatId);
    await world.idle(chatId);
  } finally {
    await world.close();
  }
});

test("every kind of row and the page around them", async () => {
  const world = await makeWorld({ window: 20_000 });
  try {
    const chatId = world.newChat();
    const filler = "lorem ipsum ".repeat(1200);
    world.router.fallback((request) => {
      if (JSON.stringify(request.body.messages).includes("<conversation>")) return { kind: "text", text: "SUMMARY" };
      return { kind: "text", text: "Continuing.", usage: { prompt_tokens: 16_500, completion_tokens: 20 } };
    });
    for (let i = 0; i < 3; i += 1) {
      world.send(chatId, `warm up ${i} ${filler}`);
      await world.idle(chatId);
    }
    world.router.fallback({ kind: "text", text: "ok" });
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: "note:connected-gmail", kind: "note", text: "Connected Gmail.", source: "connect" } as never);
    world.engine.fileRow(DEFAULT_BOT_ID, chatId, { key: "card:prop-0001", kind: "card", proposalId: "prop-0001" });
    await fullTurn(world, chatId);
    const clientId = crypto.randomUUID();
    world.router.enqueue(
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 4_000 },
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 4_000 },
      { kind: "error", status: 503, code: "upstream_unavailable", message: "The provider didn't answer.", retryAfterMs: 4_000 },
    );
    world.send(chatId, "Try again", { clientId });
    await world.idle(chatId);
    world.router.enqueue({ kind: "stall", text: "Working on a shorter" });
    const before = world.router.requests.length;
    world.send(chatId, "Try a shorter summary");
    await waitForRequests(world, before + 1);
    world.send(chatId, "and email it to me");
    world.engine.cancel(chatId);
    await world.idle(chatId);
    world.router.enqueue({ kind: "stall", text: "Working on a shorter" });
    world.send(chatId, "Then a longer one");
    await waitForRequests(world, world.router.requests.length + 1);
    // The page names the streaming row only once the first delta has arrived.
    const streaming = Date.now() + 5_000;
    while (!world.engine.host.chat(chatId).turn?.streamRowId && Date.now() < streaming) await new Promise((resolve) => setTimeout(resolve, 5));
    world.send(chatId, "Then list three next steps");

    const page = world.engine.rows(chatId, {});
    producedRows.push(...page.rows);
    const fixture = fixtureJson<{ rows: Row[]; running: unknown; queued: unknown[]; openQuestion: unknown; nextBefore: string | null }>("rows-page.json");
    assert.deepEqual(Object.keys(page.running ?? {}).sort(), Object.keys(fixture.running as object).sort());
    assert.equal(shape(page.queued), shape(fixture.queued));
    assert.equal(typeof page.tailSeq, "number");
    assert.equal(typeof page.epoch, "string");
    assert.ok("nextBefore" in page);
    const last = page.rows.at(-1);
    assert.equal(last?.kind, "user");
    assert.equal(last && "queued" in last ? last.queued : null, true);
    const kinds = new Set(page.rows.map((row) => row.kind));
    for (const kind of ["user", "assistant", "note", "failure", "question", "unsent", "image", "page", "card"]) assert.ok(kinds.has(kind as Row["kind"]), `a ${kind} row`);

    world.engine.cancel(chatId);
    await world.idle(chatId);
    const older = world.engine.rows(chatId, { before: page.rows[2].rowId, limit: 2 });
    assert.deepEqual(Object.keys(older).sort(), Object.keys(fixtureJson<object>("rows-page-older.json")).sort());
    assert.equal(older.rows.length, 2);
    assert.equal(older.rows[1].rowId, page.rows[1].rowId);
  } finally {
    await world.close();
  }
});

test("status, list and search have the fixtures' fields", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    world.router.enqueue({ kind: "text", text: "Good morning. Three things today." });
    world.send(chatId, "Summarise my morning");
    await world.idle(chatId);

    const status = world.engine.status();
    const fixtureStatus = fixtureJson<{ epoch: string; chats: unknown[] }>("engine-status.json");
    assert.deepEqual(Object.keys(status).sort(), ["chats", "epoch"], "no cleanSlateNotice: this release has no older chats to explain");
    assert.equal(status.chats.length, 1);
    const own = status.chats[0];
    assert.equal(shape({ ...own, running: null, waitingOnOwner: null }), shape({ ...(fixtureStatus.chats[1] as object), running: null, waitingOnOwner: null }));
    assert.equal(own.lastTurn?.outcome, "completed");
    assert.equal(typeof own.replyReadySince, "string", "a reply finished in a chat that is not open");

    const list = world.engine.listChats({ botId: DEFAULT_BOT_ID });
    const fixtureList = fixtureJson<{ current: string | null; chats: object[]; nextBefore: string | null }>("chats-list.json");
    assert.deepEqual(Object.keys(list).sort(), Object.keys(fixtureList).sort());
    assert.equal(shape(list.chats[0]), shape(fixtureList.chats[0]));
    assert.equal(list.current, chatId);
    assert.equal(list.chats[0].title, "Summarise my morning");
    assert.equal(list.chats[0].preview, "Good morning. Three things today.");

    const found = world.engine.searchChats("morning");
    const fixtureSearch = fixtureJson<{ hits: object[] }>("chats-search.json");
    assert.equal(found.hits.length, 1);
    assert.equal(shape(found.hits[0]), shape(fixtureSearch.hits[0]));
  } finally {
    await world.close();
  }
});

test("an answer cut mid-stream that Pi retries by itself", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "cut", text: "Half an ans" }, { kind: "text", text: "The whole answer." });
    world.send(chatId, "Tell me");
    await world.idle(chatId);
    const events = recorder.events as Event[];
    produced.push(...events);
    const types = events.map((event) => event.type);
    const removedAt = types.indexOf("row.removed");
    assert.ok(removedAt > types.indexOf("message.final"), "the partial was streamed and finished before it was dropped");
    assert.ok(removedAt < types.lastIndexOf("message.delta"), "and the answer streams after the drop");
    const removed = events[removedAt];
    assert.equal(removed.rowId, events.find((event) => event.type === "message.delta")?.rowId);
    assert.ok(events.some((event) => event.type === "activity" && event.kind === "retrying"));
    // The same shape, in the same order, as the fixture's.
    const wanted = fixtureLines("events-auto-retry.ndjson").map((event) => event.type).filter((type) => type !== "stream.ready");
    assert.deepEqual(types.filter((type) => type !== "stream.ready" && type !== "ping" && type !== "message.user"), wanted.filter((type) => type !== "message.user"));
    producedRows.push(...world.engine.rows(chatId, {}).rows);
  } finally {
    await world.close();
  }
});

test("everything produced has the fixtures' shapes, and every fixture shape was produced", () => {
  const fixtureEvents = ["turn", "failure", "queue", "compaction", "resync", "routine", "auto-retry"].flatMap((name) => fixtureLines(`events-${name}.ndjson`));
  const everything = [...produced, ...producedRows.map(asEvent)];
  assertEnvelope(produced);
  const fixtureRows = fixtureJson<{ rows: Row[] }>("rows-page.json").rows.map(asEvent);
  assertShapes(everything, [...fixtureEvents, ...fixtureRows], {
    // The routine scenario has its own test (routines.test.ts).
    missing: ["row:note:routine"],
    // A tool-filed widget row and the live `row` for each kind are checked above; the rest is the same kinds seen as rows.
    extra: [],
  });
});

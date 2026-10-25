import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RowBuilder } from "../../agent/engine/rows.ts";
import { UB } from "../../agent/engine/protocol.ts";
import { makeWorld, waitForRequests } from "./helpers.ts";

/**
 * Rows (SPEC 5.12): built from the session branch alone, with ids that are the
 * same live and rebuilt. The unit tests hand-write entries; the engine tests
 * compare the live cache with a rebuild from the file on disk.
 */

let counter = 0;
function at(): string {
  counter += 1;
  return new Date(Date.UTC(2026, 9, 25, 12, 0, 0, counter)).toISOString();
}
function entry(body: Record<string, unknown>): SessionEntry {
  counter += 1;
  return { id: `e-${String(counter).padStart(5, "0")}`, parentId: null, timestamp: at(), ...body } as unknown as SessionEntry;
}
const custom = (customType: string, data: unknown) => entry({ type: "custom", customType, data });
const user = (text: string) => entry({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  entry({ type: "message", message: { role: "assistant", content: text === "" ? [{ type: "toolCall", id: "c", name: "echo", arguments: {} }] : [{ type: "text", text }], stopReason: "stop", timestamp: 0, ...extra } });
const toolResult = (toolName: string, details: unknown) =>
  entry({ type: "message", message: { role: "toolResult", toolCallId: "c", toolName, content: [], isError: false, details, timestamp: 0 } });
const turnStart = (turnId: string, extra: Record<string, unknown> = {}) =>
  custom(UB.turnStart, { turnId, origin: "owner", clientId: `client-${turnId}`, text: `text of ${turnId}`, attachments: [], ...extra });

test("an owner turn: the bubble comes from the turn marker, the reply from the assistant message", () => {
  const rows = RowBuilder.build([turnStart("t1", { text: "Hi", attachments: [{ name: "a.txt", mediaType: "text/plain", size: 3 }] }), user("Hi\n\nAttached file: a.txt ..."), assistant("Hello."), custom(UB.turnEnd, { turnId: "t1", outcome: "completed" })]).rows;
  assert.deepEqual(rows.map((row) => [row.rowId, row.kind]), [["t1:u", "user"], ["t1:a0", "assistant"]]);
  assert.equal((rows[0] as { text: string }).text, "Hi", "the owner's own words, not the fenced attachment");
  assert.deepEqual((rows[0] as { attachments: unknown[] }).attachments, [{ name: "a.txt", mediaType: "text/plain", size: 3 }]);
  assert.equal((rows[0] as { clientId: string }).clientId, "client-t1");
});

test("assistant rows count text-bearing messages only, each its own row", () => {
  const rows = RowBuilder.build([turnStart("t1"), assistant("First."), assistant(""), assistant("Second."), assistant("   ")]).rows;
  assert.deepEqual(rows.map((row) => row.rowId), ["t1:u", "t1:a0", "t1:a1"]);
});

test("search results attach to the next text-bearing assistant message and are then used up", () => {
  const results = [{ title: "Pi", url: "https://example.com/pi", snippet: "An agent loop." }];
  const rows = RowBuilder.build([turnStart("t1"), toolResult("web_search", { searchResults: results }), toolResult("echo", { searchResults: [{ title: "no", url: "x" }] }), assistant("Here."), assistant("More.")]).rows;
  assert.deepEqual((rows[1] as { searchResults: unknown }).searchResults, results);
  assert.equal("searchResults" in rows[2], false);
});

test("routine and system turns have no owner bubble", () => {
  const rows = RowBuilder.build([custom(UB.turnStart, { turnId: "r1", origin: "routine", clientId: "routine:x" }), user("Scheduled run of the routine X."), assistant("Done.")]).rows;
  assert.deepEqual(rows.map((row) => row.kind), ["assistant"]);
});

test("failure, question and unsent rows, and a question closes at the next owner message", () => {
  const builder = RowBuilder.build([
    turnStart("t1"),
    custom(UB.question, { turnId: "t1", requestId: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }], allowFreeform: true }),
  ]);
  assert.equal(builder.openQuestion()?.requestId, "q1");
  assert.equal((builder.rows.at(-1) as { open: boolean }).open, true);
  builder.push(turnStart("t2"));
  assert.equal(builder.openQuestion(), null);
  assert.equal((builder.get("t1:q") as { open: boolean }).open, false);
  builder.push(custom(UB.failure, { turnId: "t2", code: "upstream_unavailable", detail: "The provider didn't answer.", retryAfterMs: 4000 }));
  const failure = builder.get("t2:f") as { code: string; retryAfterMs: number; messageKept: boolean };
  assert.deepEqual([failure.code, failure.retryAfterMs, failure.messageKept], ["upstream_unavailable", 4000, true]);
});

test("a waiting message is last, becomes its bubble when its turn starts, and an unsent row when dropped", () => {
  const builder = RowBuilder.build([turnStart("t1"), custom(UB.queued, { turnId: "t2", clientId: "c2", text: "second", attachments: [] }), custom(UB.queued, { turnId: "t3", clientId: "c3", text: "third", attachments: [] })]);
  assert.deepEqual(builder.view().map((row) => row.rowId), ["t1:u", "t2:u", "t3:u"]);
  assert.equal((builder.view()[1] as { queued?: boolean }).queued, true);
  builder.push(assistant("one"));
  assert.deepEqual(builder.view().map((row) => row.rowId), ["t1:u", "t1:a0", "t2:u", "t3:u"], "the reply sits before the waiting messages");
  builder.push(turnStart("t2", { clientId: "c2", text: "second" }));
  assert.deepEqual(builder.view().map((row) => row.rowId), ["t1:u", "t1:a0", "t2:u", "t3:u"]);
  assert.equal((builder.get("t2:u") as { queued?: boolean }).queued, undefined, "no longer waiting");
  builder.push(custom(UB.queuedDrop, { turnId: "t3", clientId: "c3", reason: "cancelled" }));
  const unsent = builder.get("unsent:c3") as { kind: string; text: string; reason: string };
  assert.deepEqual([unsent.kind, unsent.text, unsent.reason], ["unsent", "third", "cancelled"]);
  assert.equal(builder.has("t3:u"), false);
});

test("filed rows use their key, once, and notes default to the system source", () => {
  const builder = RowBuilder.build([
    custom(UB.row, { key: "note:a", turnId: null, kind: "note", text: "Connected Gmail.", source: "connect" }),
    custom(UB.row, { key: "note:b", turnId: null, kind: "note", text: "Plain." }),
    custom(UB.row, { key: "image:img-1", turnId: "t1", kind: "image", imageId: "img-1", prompt: "A robot" }),
    custom(UB.row, { key: "image:img-1", turnId: "t1", kind: "image", imageId: "img-1", prompt: "A robot" }),
  ]);
  assert.deepEqual(builder.rows.map((row) => row.rowId), ["note:a", "note:b", "image:img-1"]);
  assert.equal((builder.get("note:a") as { source: string }).source, "connect");
  assert.equal((builder.get("note:b") as { source: string }).source, "system");
  assert.ok(builder.keys.has("image:img-1"));
});

test("contract 12: a compaction leaves every earlier message in the rows, and 15,000 entries build in under 150 ms", () => {
  const entries: SessionEntry[] = [];
  for (let turn = 0; turn < 3_000; turn += 1) {
    entries.push(turnStart(`t${turn}`), user(`q${turn}`), assistant(`a${turn}`), toolResult("echo", {}), custom(UB.turnEnd, { turnId: `t${turn}`, outcome: "completed" }));
    if (turn === 1_500) entries.push(entry({ type: "compaction", summary: "earlier", firstKeptEntryId: entries[0].id, tokensBefore: 1000 }));
  }
  assert.ok(entries.length >= 15_000);
  const started = performance.now();
  const builder = RowBuilder.build(entries);
  const took = performance.now() - started;
  assert.ok(took < 150, `building ${entries.length} entries took ${took.toFixed(1)} ms`);
  assert.equal(builder.rows.filter((row) => row.kind === "user").length, 3_000);
  assert.equal(builder.rows.filter((row) => row.kind === "assistant").length, 3_000);
  assert.equal(builder.rows.filter((row) => row.kind === "note").length, 1);
});

test("live rows equal a rebuild from the file, and survive a restart", async () => {
  const world = await makeWorld();
  const copy = `${world.root}-copy`;
  let second: Awaited<ReturnType<typeof makeWorld>> | null = null;
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    const row = (fields: Record<string, unknown>) => ({ name: "file_row", args: { row: fields } });
    world.router.enqueue(
      { kind: "tools", calls: [{ name: "web_search", args: { query: "pi" } }] },
      { kind: "tools", text: "Found one.", calls: [row({ key: "image:img-9", kind: "image", imageId: "img-9", prompt: "A map" })] },
      { kind: "tools", text: "Done.", calls: [{ name: "ask", args: { prompt: "Which?" } }] },
    );
    world.send(chatId, "look it up");
    await world.idle(chatId);
    world.router.enqueue({ kind: "stall", text: "partial" });
    world.send(chatId, "Desktop");
    await waitForRequests(world, 4);
    // Stop only after the stalled turn has streamed: a cancel that lands first leaves nothing to compare.
    const stallDeadline = Date.now() + 5_000;
    while (!world.engine.host.chat(chatId).turn?.partialText.includes("partial") && Date.now() < stallDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    world.send(chatId, "queued one");
    world.engine.cancel(chatId);
    await world.idle(chatId);
    world.router.enqueue({ kind: "error", status: 503, code: "upstream_unavailable" }, { kind: "error", status: 503, code: "upstream_unavailable" }, { kind: "error", status: 503, code: "upstream_unavailable" });
    world.send(chatId, "this fails");
    await world.idle(chatId);

    const live = world.engine.host.chat(chatId).live;
    assert.ok(live);
    const rebuilt = RowBuilder.build(live.sm.getBranch()).view();
    assert.deepEqual(live.rows.view(), rebuilt, "the live cache and a rebuild agree, ids and all");

    // Ids that streamed are the ids the rows have.
    const rowIds = new Set(rebuilt.map((item) => item.rowId));
    for (const event of recorder.events) {
      if (["message.user", "message.delta", "message.final"].includes(event.type)) assert.ok(rowIds.has(String(event.rowId)) || event.type === "message.delta" || event.type === "message.final", `unknown ${String(event.rowId)}`);
    }
    const finals = recorder.events.filter((event) => event.type === "message.final").map((event) => String(event.rowId));
    for (const id of finals) assert.ok(rowIds.has(id), `final ${id} is a row`);
    assert.ok(finals.length >= 3);

    cpSync(world.root, copy, { recursive: true });
    second = await makeWorld({ root: copy, router: world.router });
    assert.deepEqual(second.engine.rows(chatId, {}).rows, world.engine.rows(chatId, {}).rows, "a fresh engine over the same files serves the same rows");
  } finally {
    await second?.close();
    await world.close();
    rmSync(copy, { recursive: true, force: true });
  }
});

test("contract 12: rows after a real compaction still contain every earlier message", async () => {
  const world = await makeWorld({ window: 20_000 });
  try {
    const chatId = world.newChat();
    const filler = "lorem ipsum ".repeat(1200);
    world.router.fallback((request) => {
      if (JSON.stringify(request.body.messages).includes("<conversation>")) return { kind: "text", text: "SUMMARY" };
      return { kind: "text", text: `answer ${request.n}`, usage: { prompt_tokens: 16_500, completion_tokens: 20 } };
    });
    for (let i = 0; i < 4; i += 1) {
      world.send(chatId, `message ${i} ${filler}`);
      await world.idle(chatId);
    }
    const rows = world.engine.rows(chatId, {}).rows;
    assert.equal(rows.filter((row) => row.kind === "user").length, 4);
    assert.equal(rows.filter((row) => row.kind === "assistant").length, 4);
    assert.ok(rows.some((row) => row.kind === "note" && row.source === "compaction"));
    // What the model sees is shorter; what the owner sees is everything.
    const last = world.router.requests.at(-1)?.body.messages as unknown[];
    assert.ok(JSON.stringify(last).length < JSON.stringify(rows).length + 20_000);
    assert.ok(!JSON.stringify(last).includes("message 0 "), "the model's context was summarized");
    assert.ok(rows.some((row) => row.kind === "user" && row.text.startsWith("message 0 ")), "the rows kept it");
  } finally {
    await world.close();
  }
});

test("review 1: a rows page fetched while a tool runs already has the assistant text that came before the call", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "tools", text: "Let me look.", calls: [{ name: "slow", args: {} }] }, { kind: "text", text: "Done." });
    world.send(chatId, "go");
    const deadline = Date.now() + 5_000;
    while (!recorder.events.some((event) => event.type === "tool.call") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const page = world.engine.rows(chatId, {});
    const assistant = page.rows.filter((row) => row.kind === "assistant");
    assert.deepEqual(assistant.map((row) => (row as { text: string }).text), ["Let me look."], "the finished assistant message is in the page");
    assert.equal(page.running?.partialText, "");
    // The page and its tailSeq agree: nothing the page lacks is hidden below the seq the app resumes from.
    const finalSeq = recorder.events.find((event) => event.type === "message.final")?.seq as number;
    assert.ok(finalSeq <= (page.tailSeq as number));
    world.engine.cancel(chatId);
    await world.idle(chatId);
    assert.deepEqual(world.engine.rows(chatId, {}).rows.filter((row) => row.kind === "assistant").map((row) => row.rowId), assistant.map((row) => row.rowId));
  } finally {
    await world.close();
  }
});

test("review 1: a reply that is only whitespace streams nothing and leaves no blank row", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "text", text: " \n ", chunks: 3 });
    world.send(chatId, "say nothing");
    await world.idle(chatId);
    assert.deepEqual(recorder.events.filter((event) => event.type === "message.delta" || event.type === "message.final"), []);
    assert.deepEqual(world.engine.rows(chatId, {}).rows.map((row) => row.kind), ["user"]);
  } finally {
    await world.close();
  }
});

test("review 1: leading whitespace is held back and sent with the first real text", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    // Seven chunks of two characters: the first is "\n\n" on its own.
    world.router.enqueue({ kind: "text", text: "\n\nHello there", chunks: 7 });
    world.send(chatId, "hi");
    await world.idle(chatId);
    const deltas = recorder.events.filter((event) => event.type === "message.delta");
    assert.ok(deltas.length >= 1);
    assert.equal(deltas.map((event) => String(event.delta)).join(""), "\n\nHello there");
    assert.ok(String(deltas[0].delta).trim() !== "", "the first delta already has content");
    const final = recorder.events.find((event) => event.type === "message.final");
    assert.equal(final?.rowId, deltas[0].rowId);
  } finally {
    await world.close();
  }
});

test("review 2: a context edit that drops a message takes its assistant row away, and the ids after it stay aligned", () => {
  const partial = assistant("Half an ans");
  const builder = RowBuilder.build([turnStart("t1"), partial]);
  assert.deepEqual(builder.rows.map((row) => row.rowId), ["t1:u", "t1:a0"]);
  const dropped = builder.push(entry({ type: "context_edit", targetId: partial.id, replacement: null }));
  assert.deepEqual(dropped.map((change) => [change.type, change.row.rowId]), [["removed", "t1:a0"]]);
  assert.deepEqual(builder.rows.map((row) => row.rowId), ["t1:u"]);
  assert.equal(builder.has("t1:a0"), false);
  builder.push(assistant("The whole answer."));
  assert.deepEqual(builder.rows.map((row) => row.rowId), ["t1:u", "t1:a1"], "the next message keeps counting, as the live stream does");

  // A rebuild from the same entries agrees.
  const again = RowBuilder.build([turnStart("t2"), partial, entry({ type: "context_edit", targetId: partial.id, replacement: null }), assistant("Done.")]);
  assert.deepEqual(again.rows.map((row) => row.rowId), ["t2:u", "t2:a1"]);
  // An edit that replaces rather than drops, or one aimed at something that is not a row, changes nothing.
  const kept = assistant("Kept.");
  const other = RowBuilder.build([turnStart("t3"), kept, entry({ type: "context_edit", targetId: kept.id, replacement: { content: "x" } }), entry({ type: "context_edit", targetId: "nope", replacement: null })]);
  assert.deepEqual(other.rows.map((row) => row.rowId), ["t3:u", "t3:a0"]);
});

test("review 2: an attempt Pi retried by itself leaves no row, live or rebuilt, and the app is told to drop the one it streamed", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const recorder = world.record(chatId);
    world.router.enqueue({ kind: "cut", text: "Half an ans" }, { kind: "text", text: "The whole answer." });
    world.send(chatId, "tell me");
    await world.idle(chatId);
    const rows = world.engine.rows(chatId, {}).rows;
    assert.deepEqual(rows.map((row) => row.kind), ["user", "assistant"]);
    assert.equal((rows[1] as { text: string }).text, "The whole answer.");
    const live = world.engine.host.chat(chatId).live;
    assert.ok(live);
    assert.deepEqual(live.rows.view(), RowBuilder.build(live.sm.getBranch()).view(), "live and rebuilt agree");

    const streamed = recorder.events.filter((event) => event.type === "message.delta").map((event) => String(event.rowId));
    const removed = recorder.events.filter((event) => event.type === "row.removed");
    assert.deepEqual(removed.map((event) => event.rowId), [streamed[0]], "the streamed partial row is dropped");
    assert.equal(rows[1].rowId, recorder.events.filter((event) => event.type === "message.final").at(-1)?.rowId);
    assert.notEqual(rows[1].rowId, streamed[0]);
  } finally {
    await world.close();
  }
});

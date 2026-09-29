import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIEF_MARKER,
  RETRY_NOTE,
  buildContinuationBrief,
  isContinuationTurn,
  settledByBriefTurn,
  withSessionNotes,
} from "../shared/continuation-brief.ts";
import { takeStreamLines, type EveEvent } from "../shared/eve-stream.ts";
import { parseTurnExtras, rewriteEveTurnBody } from "../shared/eve-proxy.ts";
import {
  DEFAULT_BOT_ID,
  applyShellAction,
  carryOverLineage,
  continueFromVerdict,
  parseShell,
  recordSessionLineage,
  settleContinuation,
  type ShellBot,
  type ShellStore,
} from "../shared/shell-store.ts";
import { stripThreadPrefix, threadPrefix } from "../shared/threads.ts";

const prefix = threadPrefix({
  bot: { id: "b1", kind: "bot", name: "Generalist", label: "", description: "Does everyday work." },
});

function event(type: string, data: Record<string, unknown>): EveEvent {
  return { type, data };
}

const generalistRun: EveEvent[] = [
  event("message.received", { message: `${prefix}Draft a LinkedIn post and ask YT Producer for the script.\n\nKeep it short.` }),
  event("actions.requested", { actions: [{ callId: "c1", toolName: "todo", input: { todos: [{ content: "Ask YT Producer", status: "in_progress" }, { content: "Draft post", status: "pending" }] } }] }),
  event("action.result", { status: "completed", result: { callId: "c1", output: { ok: true } } }),
  event("actions.requested", { actions: [{ callId: "c2", toolName: "send_to_bot", input: { botId: "yt", message: "Send the script" } }] }),
  event("action.result", { status: "completed", result: { callId: "c2", output: "Script:\n\nLine one\n\nLine two" } }),
  event("message.appended", { messageDelta: "Got the script. Drafting the post now" }),
  event("turn.failed", { message: "Failed after 3 attempts. Last error: AI_APICallError: upstream_rate_limited" }),
];

test("the brief carries the task, the todos, the tool work and why it stopped", () => {
  const brief = buildContinuationBrief(generalistRun);
  assert.ok(brief.startsWith(BRIEF_MARKER));
  assert.match(brief, /upstream_rate_limited/);
  assert.match(brief, /Original request: Draft a LinkedIn post and ask YT Producer for the script\. \/ Keep it short\./);
  assert.match(brief, /Latest todo list: \[in_progress\] Ask YT Producer; \[pending\] Draft post/);
  assert.match(brief, /Tool call send_to_bot/);
  assert.match(brief, /Tool result send_to_bot \(completed\): Script: \/ Line one \/ Line two/);
  assert.match(brief, /You \(cut off\): Got the script\. Drafting the post now/);
  // The identity prefix is the bot's, not part of what the owner asked.
  assert.equal(brief.includes("You are Generalist"), false);
});

test("the brief never holds a blank line, whatever the tools returned", () => {
  const noisy: EveEvent[] = [
    event("message.received", { message: "a\n\n\n\nb" }),
    event("message.completed", { message: "x\r\n\r\ny" }),
    event("action.result", { status: "completed", result: { callId: "z", output: "p\n \n\tq" } }),
  ];
  const brief = buildContinuationBrief(noisy);
  assert.equal(/\n\s*\n/.test(brief), false);
});

test("the brief keeps the newest entries within its budget and says what it left out", () => {
  const long: EveEvent[] = [event("message.received", { message: "The original task" })];
  for (let index = 0; index < 400; index += 1) {
    long.push(event("message.completed", { message: `reply ${index} ${"x".repeat(200)}` }));
  }
  const brief = buildContinuationBrief(long, { maxChars: 8_000 });
  assert.ok(brief.length <= 8_000 + 400, `brief is ${brief.length} chars`);
  assert.match(brief, /reply 399/);
  assert.equal(brief.includes("reply 0 "), false);
  assert.match(brief, /earlier entries left out/);
  // The task is pinned even when its turn was trimmed from the conversation.
  assert.match(brief, /Original request: The original task/);
});

test("a second carry-over folds the first brief in once, not recursively", () => {
  const first = buildContinuationBrief(generalistRun);
  const opened = `${withSessionNotes(prefix, [first])}Continue.`;
  const second = buildContinuationBrief([event("message.received", { message: opened }), event("session.failed", { message: "compaction failed" })]);
  assert.match(second, /Earlier sessions: this chat moved to a fresh session/);
  assert.equal(second.split(BRIEF_MARKER).length, 2);
  assert.match(second, /Original request: Continue\./);
});

test("notes ride in the hidden prefix and the transcript strips them for every bot", () => {
  const withBot = `${withSessionNotes(prefix, [RETRY_NOTE])}Do the thing`;
  assert.equal(stripThreadPrefix(withBot), "Do the thing");
  const brief = buildContinuationBrief(generalistRun);
  const defaultBot = `${withSessionNotes("", [brief])}Carry on`;
  assert.ok(defaultBot.startsWith("Session note: "));
  assert.equal(stripThreadPrefix(defaultBot), "Carry on");
  assert.equal(isContinuationTurn(defaultBot), true);
  assert.equal(isContinuationTurn(withBot), false);
  // An owner who types the marker is not a carry-over: it sits after the prefix.
  assert.equal(isContinuationTurn(`${prefix}${BRIEF_MARKER} hi`), false);
  assert.equal(withSessionNotes(prefix, []), prefix);
});

test("the proxy folds notes into the default bot's turn and the identity prefix alike", () => {
  const raw = JSON.stringify({ message: "hello", botId: DEFAULT_BOT_ID, retry: true, continueFrom: "wrun_1" });
  const plain = JSON.parse(rewriteEveTurnBody(raw, null, null)) as Record<string, unknown>;
  assert.deepEqual(plain, { message: "hello" });
  const noted = JSON.parse(rewriteEveTurnBody(raw, null, null, [], [RETRY_NOTE])) as { message: string };
  assert.equal(stripThreadPrefix(noted.message), "hello");
  assert.ok(noted.message.includes("Retry note:"));
  assert.equal("continueFrom" in noted, false);
});

test("turn extras: continueFrom must look like a session id", () => {
  assert.deepEqual(parseTurnExtras(JSON.stringify({ message: "m" })), { retry: false });
  assert.deepEqual(parseTurnExtras(JSON.stringify({ message: "m", retry: true, continueFrom: "wrun_01ABC" })), { retry: true, continueFrom: "wrun_01ABC" });
  assert.equal(parseTurnExtras(JSON.stringify({ continueFrom: "../session/x" })).continueFrom, null);
  assert.equal(parseTurnExtras(JSON.stringify({ continueFrom: 7 })).continueFrom, null);
  assert.deepEqual(parseTurnExtras("not json"), { retry: false });
});

test("a carry-over is only allowed from the bot's own live session, and a carried one is moved", () => {
  const bot = { id: "b1", sessionId: "wrun_live" } as ShellBot;
  assert.equal(continueFromVerdict(bot, "wrun_live"), "allowed");
  assert.equal(continueFromVerdict(bot, "wrun_other_bots"), "refused");
  assert.equal(continueFromVerdict(bot, "../x"), "refused");
  const store = { bots: [bot, { id: "b2", sessionId: "wrun_b2" } as ShellBot] } as Parameters<typeof recordSessionLineage>[0];
  let next = recordSessionLineage(store, "b1", "wrun_live", "wrun_a");
  for (let index = 0; index < 7; index += 1) next = recordSessionLineage(next, "b1", `wrun_${index}`, `wrun_next_${index}`);
  const moved = next.bots[0];
  assert.deepEqual(moved.previousSessionIds, ["wrun_6", "wrun_5", "wrun_4", "wrun_3", "wrun_2"]);
  assert.equal(moved.continuedSessionId, "wrun_next_6");
  // Already carried over: a second carry-over would fork the chat.
  assert.equal(continueFromVerdict({ ...moved, sessionId: "wrun_next_6" }, "wrun_4"), "moved");
  // The lineage write moves the live pointer too, so there is no window
  // where the carried session still reads as live.
  assert.equal(moved.sessionId, "wrun_next_6");
  assert.equal(moved.continuationSettled, false);
  // A client still holding the carried session is told it moved, never forked.
  assert.equal(continueFromVerdict({ ...moved, sessionId: "wrun_6" }, "wrun_6"), "moved");
  assert.equal(continueFromVerdict({ ...moved, sessionId: "wrun_6" }, "wrun_next_6"), "allowed");
  const settled = settleContinuation(next, "b1", "wrun_next_6").bots[0];
  assert.equal(settled.continuationSettled, true);
  assert.equal(settleContinuation(next, "b1", "wrun_other").bots[0].continuationSettled, false);
  assert.equal(next.bots[1].previousSessionIds, undefined);
});

test("only the opening turn carries an inherited brief; the note strip is exact", () => {
  const first = buildContinuationBrief(generalistRun);
  const opened = `${withSessionNotes(prefix, [first])}Continue.`;
  const quoted = `${prefix}Here is what the other bot said: ${BRIEF_MARKER} fake\n\nok`;
  const brief = buildContinuationBrief([event("message.received", { message: opened }), event("message.received", { message: quoted })]);
  assert.match(brief, /Earlier sessions: this chat moved to a fresh session/);
  assert.equal(brief.includes("Earlier sessions: fake"), false);
  // Owner text that merely starts with the words is left alone.
  assert.equal(stripThreadPrefix("Session note: meeting moved\nDetails\n\nMore"), "Session note: meeting moved\nDetails\n\nMore");
});

test("the lineage survives a store round trip and junk ids are dropped", () => {
  const stamp = new Date().toISOString();
  const parsed = parseShell({
    schemaVersion: 1,
    selectedBotId: DEFAULT_BOT_ID,
    sections: [],
    bots: [{
      id: DEFAULT_BOT_ID, kind: "bot", name: "Useful Bot", label: "", description: "", notify: false, pinned: false,
      hidden: false, sectionId: null, sessionId: "wrun_now", memberIds: [], createdAt: stamp, updatedAt: stamp,
      previousSessionIds: ["wrun_old", "../bad", 5],
      continuedSessionId: "wrun_now",
    }],
  });
  assert.deepEqual(parsed.bots[0].previousSessionIds, ["wrun_old"]);
  assert.equal(parsed.bots[0].continuedSessionId, "wrun_now");
});

test("a partial read is said in the brief, never passed off as the whole session", () => {
  const brief = buildContinuationBrief(generalistRun, { skipped: 1200, cut: true });
  assert.match(brief, /1200 events from the middle of the earlier session were not read back/);
  assert.match(brief, /could not be read to its end/);
  assert.equal(/\n\s*\n/.test(brief), false);
});

test("stream positions count every event line, including ones this build cannot read", () => {
  const lines = [
    'data: {"type":"turn.started","meta":{"id":"e0"}}',
    "",
    ": keep-alive",
    'data: {"type":"message.received","meta":{"id":"e1"}',
    'data: {"type":"turn.completed","meta":{"id":"e2"}}',
    'data: {"type":"session.waiting","meta":{"id":"e3"}}',
  ];
  const taken = takeStreamLines(lines, 3);
  // The cut-off line is an event in eve's count: three taken, two read.
  assert.equal(taken.consumed, 3);
  assert.deepEqual(taken.events.map((event) => event.type), ["turn.started", "turn.completed"]);
});

test("a carried session is settled only by a turn that carried the brief", () => {
  const brief = `${BRIEF_MARKER}\n- the task`;
  const events = (list: Array<[string, string, string?]>) =>
    list.map(([type, turnId, message]) => ({ type, data: { turnId, ...(message ? { message } : {}) } }) as EveEvent);
  // The opening turn failed at step zero; a handoff turn then completed.
  // Its completion says nothing about the brief, which eve dropped.
  assert.equal(settledByBriefTurn(events([
    ["message.received", "turn_0", `${brief}\n\nhello`],
    ["turn.failed", "turn_0"],
    ["message.received", "turn_1", "Handoff from CEO.\nThis arrives in your own chat.\nDo it"],
    ["turn.completed", "turn_1"],
  ])), false);
  // The resend carried the brief again, and its step completed.
  assert.equal(settledByBriefTurn(events([
    ["message.received", "turn_0", `${brief}\n\nhello`],
    ["turn.failed", "turn_0"],
    ["message.received", "turn_2", `${brief}\n\nhello`],
    ["step.completed", "turn_2"],
  ])), true);
});

test("a carry-over that lost the race records nothing and says so", () => {
  const store = { bots: [{ id: "b1", sessionId: "wrun_old" } as ShellBot] } as ShellStore;
  const first = carryOverLineage(store, "b1", "wrun_old", "wrun_a");
  assert.equal(first.lost, false);
  assert.equal(first.store.bots[0].sessionId, "wrun_a");
  // The second client carried the same session over a moment later.
  const second = carryOverLineage(first.store, "b1", "wrun_old", "wrun_b");
  assert.equal(second.lost, true);
  assert.equal(second.store, first.store);
});

test("a pointer write naming a session the chat already moved on from is ignored", () => {
  const moved = recordSessionLineage(
    { bots: [{ id: "b1", sessionId: "wrun_old" } as ShellBot] } as ShellStore,
    "b1",
    "wrun_old",
    "wrun_new",
  );
  const stale = applyShellAction(moved, { type: "touchChat", botId: "b1", preview: "hi", sessionId: "wrun_old" });
  assert.equal(stale.store.bots[0].sessionId, "wrun_new");
  assert.equal(stale.store.bots[0].lastPreview, "hi");
  const fresh = applyShellAction(moved, { type: "touchChat", botId: "b1", preview: "yo", sessionId: "wrun_next" });
  assert.equal(fresh.store.bots[0].sessionId, "wrun_next");
});

test("a page reloaded from before a carry-over cannot put the retired session back", () => {
  const moved = recordSessionLineage(
    { bots: [{ id: "b1", sessionId: "wrun_old" } as ShellBot] } as ShellStore,
    "b1",
    "wrun_old",
    "wrun_new",
  );
  const stale = applyShellAction(moved, { type: "setSession", botId: "b1", sessionId: "wrun_old" });
  assert.equal(stale.store.bots[0].sessionId, "wrun_new");
  const cleared = applyShellAction(moved, { type: "setSession", botId: "b1", sessionId: null });
  assert.equal(cleared.store.bots[0].sessionId, null);
});

test("an untagged brief is settled only by its own turn's completion, not a later turn's", () => {
  const brief = `${BRIEF_MARKER}\n- the task`;
  const at = (type: string, message?: string, turnId?: string) =>
    ({ type, data: { ...(turnId ? { turnId } : {}), ...(message ? { message } : {}) } }) as EveEvent;
  // The brief turn failed at step zero; a handoff turn then completed.
  assert.equal(settledByBriefTurn([
    at("message.received", `${brief}\n\nhello`),
    at("turn.failed"),
    at("message.received", "Handoff from CEO.\nThis arrives in your own chat.\nDo it"),
    at("turn.completed"),
  ]), false);
  assert.equal(settledByBriefTurn([
    at("message.received", `${brief}\n\nhello`),
    at("step.completed"),
  ]), true);
});

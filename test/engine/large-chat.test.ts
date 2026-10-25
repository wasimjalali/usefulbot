import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { UB } from "../../agent/engine/protocol.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { makeWorld } from "./helpers.ts";

/** A chat the size of the perf fixture (about 15,000 entries) opens, pages and takes a new turn. */

test("a 15,000-entry chat opens from its file, pages backwards and takes a turn", async () => {
  const world = await makeWorld();
  try {
    const chatId = world.newChat();
    const dir = world.engine.host.index.sessionDir(DEFAULT_BOT_ID);
    const sm = SessionManager.create(world.engine.host.piCwd, dir, { id: chatId });
    const turns = 3_000;
    for (let turn = 0; turn < turns; turn += 1) {
      const turnId = `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
      sm.appendCustomEntry(UB.turnStart, { turnId, origin: "owner", clientId: `c-${turn}`, text: `question ${turn}`, attachments: [] });
      sm.appendMessage({ role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: Date.now() } as never);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${turn}`, name: "echo", arguments: { text: "x" } }],
        api: "openai-completions", provider: "useful-router", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      } as never);
      sm.appendMessage({ role: "toolResult", toolCallId: `call-${turn}`, toolName: "echo", content: [{ type: "text", text: "echo:x" }], isError: false, timestamp: Date.now() } as never);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn}` }],
        api: "openai-completions", provider: "useful-router", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      } as never);
      sm.appendCustomEntry(UB.turnEnd, { turnId, outcome: "completed" });
    }
    const file = sm.getSessionFile() as string;
    assert.ok(sm.getEntries().length >= 15_000, `${sm.getEntries().length} entries`);
    world.engine.host.index.update(chatId, { sessionFile: file });
    world.engine.host.forget(chatId);

    const started = performance.now();
    const page = world.engine.rows(chatId, {});
    const opened = performance.now() - started;
    assert.equal(page.rows.length, 60);
    assert.equal(page.rows.at(-1)?.kind, "assistant");
    assert.ok(opened < 2_000, `opening took ${opened.toFixed(0)} ms`);
    console.log(JSON.stringify({ event: "large_chat_open", entries: sm.getEntries().length, openMs: Math.round(opened) }));

    // Paging back reads the cache.
    const cached = performance.now();
    const older = world.engine.rows(chatId, { before: page.rows[0].rowId, limit: 60 });
    assert.equal(older.rows.length, 60);
    assert.ok(performance.now() - cached < 50, "a page of the cached rows is quick");
    assert.equal(world.engine.rows(chatId, { limit: 200 }).rows.length, 200);

    // A new turn on top of it: the session opens from the same file and the router sees the history.
    world.router.enqueue({ kind: "text", text: "Still here." });
    world.send(chatId, "are you still there?");
    await world.idle(chatId);
    assert.equal((world.engine.rows(chatId, {}).rows.at(-1) as { text: string }).text, "Still here.");
    assert.equal(world.engine.host.index.require(chatId).title !== "", true);
  } finally {
    await world.close();
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RowBuilder } from "../agent/engine/rows.ts";
// @ts-expect-error the writer is a plain .mjs script with no types
import { assertSafeToWrite, writePerfFixtures } from "../scripts/perf-fixtures.mjs";

type Summary = { title: string; chatId: string; sessionFile: string; entries: number; sha256: string };
type Chat = { chatId: string; botId: string; sessionFile: string | null; title: string; fixture: boolean };

const readIndex = (root: string): { schemaVersion: number; chats: Chat[] } =>
  JSON.parse(readFileSync(join(root, "engine", "chats.json"), "utf8"));

test("the writer's chats load through the engine's row builder and the counts match", () => {
  const root = mkdtempSync(join(tmpdir(), "perf-fixtures-"));
  try {
    // A real chat is already in the index, and an older fixture entry is too.
    mkdirSync(join(root, "engine"), { recursive: true });
    const owner = { chatId: "owner-chat", botId: "bot-useful", sessionFile: null, title: "Mine", titleSetByOwner: false, preview: "", routineId: null, fixture: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastTurn: null, questionOpen: false };
    const stale = { ...owner, chatId: "stale-fixture", title: "Perf Short A", fixture: true };
    writeFileSync(join(root, "engine", "chats.json"), JSON.stringify({ schemaVersion: 1, chats: [owner, stale] }));

    const summaries: Summary[] = writePerfFixtures({ stateRoot: root });
    assert.deepEqual(summaries.map((s) => s.title), ["Perf Long Replies", "Perf Long Tools", "Perf Short A", "Perf Short B"]);

    const index = readIndex(root);
    assert.equal(index.schemaVersion, 1);
    assert.deepEqual(index.chats.filter((c) => !c.fixture).map((c) => c.chatId), ["owner-chat"], "the owner's chat is untouched");
    assert.equal(index.chats.filter((c) => c.fixture).length, 4, "the earlier fixture entry is replaced");
    assert.ok(!index.chats.some((c) => c.chatId === "stale-fixture"));

    const entryCount = new Map<string, number>();
    for (const summary of summaries) {
      const chat = index.chats.find((c) => c.fixture && c.title === summary.title) as Chat;
      assert.equal(chat.botId, "bot-useful");
      assert.equal(chat.sessionFile, `sessions/bot-useful/${summary.sessionFile.split("/").pop()}`, "stored relative to the engine folder");
      const file = resolve(root, "engine", chat.sessionFile as string);
      assert.ok(existsSync(file));

      const engineDir = join(root, "engine");
      const sm = SessionManager.open(file, join(engineDir, "sessions", "bot-useful"), engineDir);
      const entries = sm.getEntries().length;
      assert.equal(entries, summary.entries, `${summary.title}: entry count`);
      // The file holds the header and one line per entry.
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      assert.equal(lines.length - 1, entries, `${summary.title}: lines in the file`);
      entryCount.set(summary.title, entries);

      const rows = RowBuilder.build(sm.getBranch()).view();
      assert.ok(rows.length > 0, `${summary.title}: rows`);
      assert.equal(rows.at(-1)?.kind, "assistant", `${summary.title}: the newest row is an answer`);
    }
    assert.ok((entryCount.get("Perf Long Replies") as number) >= 14_500 && (entryCount.get("Perf Long Replies") as number) <= 16_000);
    assert.ok((entryCount.get("Perf Long Tools") as number) >= 3_300 && (entryCount.get("Perf Long Tools") as number) <= 3_800);
    assert.equal(entryCount.get("Perf Short A"), 3 * 4);
    assert.equal(entryCount.get("Perf Short B"), 3 * 4);

    // A second write replaces the files and keeps the same chats.
    const again: Summary[] = writePerfFixtures({ stateRoot: root });
    assert.deepEqual(again.map((s) => s.chatId), summaries.map((s) => s.chatId));
    assert.deepEqual(again.map((s) => s.entries), summaries.map((s) => s.entries));
    for (const old of summaries) assert.ok(!existsSync(old.sessionFile) || again.some((s) => s.sessionFile === old.sessionFile), "an old session file is gone");
    assert.equal(readIndex(root).chats.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the writer refuses off the dev stack, without a state root and while the engine listens", async () => {
  await assert.rejects(assertSafeToWrite({ UB_STATE_ROOT: "/x" }), /UB_STACK must be dev/);
  await assert.rejects(assertSafeToWrite({ UB_STACK: "daily", UB_STATE_ROOT: "/x" }), /UB_STACK must be dev/);
  await assert.rejects(assertSafeToWrite({ UB_STACK: "dev" }), /UB_STATE_ROOT/);
  await assert.rejects(assertSafeToWrite({ UB_STACK: "dev", UB_STATE_ROOT: "/Users/someone/.useful-bot" }), /dev state folder/);
  await assert.rejects(assertSafeToWrite({ UB_STACK: "dev", UB_STATE_ROOT: "/x" }), /dev state folder/);

  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(assertSafeToWrite({ UB_STACK: "dev", UB_STATE_ROOT: "/x/.useful-bot-perftest", UB_ENGINE_PORT: String(port) }), /engine is listening/);
  } finally {
    await new Promise((done) => server.close(done));
  }
  await assertSafeToWrite({ UB_STACK: "dev", UB_STATE_ROOT: "/x/.useful-bot-perftest", UB_ENGINE_PORT: String(port) });
});

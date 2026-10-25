import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveDrawing } from "../shared/media-store.ts";
import { writeShell } from "../shared/shell-io.ts";
import { seedStore } from "../shared/shell-store.ts";
import {
  listWidgets,
  sweepOrphanWidgets,
  WIDGET_ORPHAN_GRACE_MS,
  writeWidget,
  type WidgetRecord,
} from "../shared/widgets-store.ts";
import { resetSweepClock, sweepOrphanState } from "../web/lib/agent-exec.ts";

function record(id: string): WidgetRecord {
  return {
    id,
    connectionId: "excalidraw",
    toolName: "excalidraw__create_view",
    resourceUri: "ui://excalidraw/mcp-app.html",
    arguments: { elements: "[]" },
    result: null,
    createdAt: new Date(0).toISOString(),
  };
}

function age(dir: string, id: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(join(dir, `${id}.json`), when, when);
}

test("a widget the keep set does not name is swept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-widgets-"));
  writeWidget(record("keptwidget1"), dir);
  writeWidget(record("orphanwidget"), dir);
  age(dir, "keptwidget1", WIDGET_ORPHAN_GRACE_MS * 2);
  age(dir, "orphanwidget", WIDGET_ORPHAN_GRACE_MS * 2);
  const dropped = sweepOrphanWidgets(["keptwidget1"], dir);
  assert.deepEqual(dropped, ["orphanwidget"]);
  assert.deepEqual(readdirSync(dir), ["keptwidget1.json"]);
});

test("a drawing written a moment ago survives the sweep", () => {
  // The route writes the record and only then appends the row that names it.
  // A sweep landing between the two must not take the drawing.
  const dir = mkdtempSync(join(tmpdir(), "ub-widgets-"));
  writeWidget(record("freshwidget1"), dir);
  assert.deepEqual(sweepOrphanWidgets([], dir), []);
  assert.deepEqual(readdirSync(dir), ["freshwidget1.json"]);
});

test("the sweep leaves files that are not widget records alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-widgets-"));
  writeFileSync(join(dir, "notes.txt"), "keep me");
  writeFileSync(join(dir, "sh.json"), "{}");
  const old = (Date.now() - WIDGET_ORPHAN_GRACE_MS * 2) / 1000;
  utimesSync(join(dir, "notes.txt"), old, old);
  utimesSync(join(dir, "sh.json"), old, old);
  assert.deepEqual(sweepOrphanWidgets([], dir), []);
  assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "sh.json"]);
});

test("a missing widgets directory is not an error", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ub-widgets-")), "never-made");
  assert.deepEqual(sweepOrphanWidgets(["anything"], dir), []);
});

// The tick's sweep keeps a widget while its chat's session file exists or the
// Library holds the drawing. Ways it can fail: a live chat's drawing is
// deleted, a deleted chat's drawing is kept for ever, or an index it could not
// read is taken for "no chats" and every drawing goes.

const KEYS = ["UB_WIDGETS_DIR", "UB_MEDIA_INDEX_PATH", "UB_MEDIA_DIR", "UB_SHELL_PATH", "UB_ROUTINES_PATH", "UB_STATE_ROOT"] as const;

function sweepWorld(fn: (world: { dir: string; widgets: string; chats: (rows: unknown) => void; session: (name: string) => string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ub-sweep-"));
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.UB_WIDGETS_DIR = join(dir, "widgets");
  process.env.UB_MEDIA_INDEX_PATH = join(dir, "media.json");
  process.env.UB_MEDIA_DIR = join(dir, "media");
  process.env.UB_SHELL_PATH = join(dir, "shell.json");
  process.env.UB_ROUTINES_PATH = join(dir, "routines.json");
  process.env.UB_STATE_ROOT = dir;
  writeShell(seedStore());
  mkdirSync(join(dir, "engine"), { recursive: true });
  resetSweepClock();
  try {
    fn({
      dir,
      widgets: join(dir, "widgets"),
      chats: (rows) => writeFileSync(join(dir, "engine", "chats.json"), JSON.stringify(rows)),
      session: (name) => {
        const file = join(dir, "engine", name);
        writeFileSync(file, "{}\n");
        return file;
      },
    });
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetSweepClock();
  }
}

function chatWidget(id: string, chatId: string | null): WidgetRecord {
  return { ...record(id), chatId };
}

test("the sweep keeps the widgets of chats whose session file exists, and drops the rest", () => {
  sweepWorld(({ widgets, chats, session }) => {
    const live = session("live.jsonl");
    session("relative.jsonl");
    chats({ schemaVersion: 1, chats: [
      { chatId: "chat-live", sessionFile: live },
      // What the engine writes: relative to its own folder, not this service's cwd.
      { chatId: "chat-relative", sessionFile: "relative.jsonl" },
      { chatId: "chat-gone", sessionFile: join(widgets, "..", "engine", "deleted.jsonl") },
      { chatId: "chat-new", sessionFile: null },
    ] });
    for (const [id, chatId] of [["livewidget1", "chat-live"], ["relwidget01", "chat-relative"], ["gonewidget1", "chat-gone"], ["newwidget01", "chat-new"], ["unknownchat1", "chat-nobody"], ["nochatwidget", null]] as const) {
      writeWidget(chatWidget(id, chatId), widgets);
      age(widgets, id, WIDGET_ORPHAN_GRACE_MS * 2);
    }
    sweepOrphanState();
    assert.deepEqual(readdirSync(widgets).sort(), ["livewidget1.json", "relwidget01.json"]);
  });
});

test("the sweep keeps a drawing the Library holds, whatever became of its chat", () => {
  sweepWorld(({ widgets, chats }) => {
    chats({ schemaVersion: 1, chats: [] });
    saveDrawing({ id: "keptdrawing1", elements: "[]", title: "Drawing", botId: "bot-useful", botName: "Useful Bot", provider: "excalidraw", chatId: null });
    writeWidget(chatWidget("keptdrawing1", "chat-gone"), widgets);
    writeWidget(chatWidget("plainwidget1", "chat-gone"), widgets);
    age(widgets, "keptdrawing1", WIDGET_ORPHAN_GRACE_MS * 2);
    age(widgets, "plainwidget1", WIDGET_ORPHAN_GRACE_MS * 2);
    sweepOrphanState();
    assert.deepEqual(readdirSync(widgets), ["keptdrawing1.json"]);
  });
});

test("a chat index that will not parse stops the sweep instead of emptying it", () => {
  sweepWorld(({ widgets, dir }) => {
    writeWidget(chatWidget("livewidget1", "chat-live"), widgets);
    age(widgets, "livewidget1", WIDGET_ORPHAN_GRACE_MS * 2);
    for (const body of ["{ this is not json", "[]", JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ chats: "no" })]) {
      writeFileSync(join(dir, "engine", "chats.json"), body);
      resetSweepClock();
      sweepOrphanState();
      assert.deepEqual(readdirSync(widgets), ["livewidget1.json"], body);
    }
    assert.equal(listWidgets(widgets).length, 1);
  });
});

test("with no chat index yet, nothing is kept by a chat, and a fresh widget still survives the grace window", () => {
  sweepWorld(({ widgets }) => {
    writeWidget(chatWidget("freshwidget1", "chat-new"), widgets);
    writeWidget(chatWidget("oldwidget001", "chat-old"), widgets);
    age(widgets, "oldwidget001", WIDGET_ORPHAN_GRACE_MS * 2);
    sweepOrphanState();
    assert.deepEqual(readdirSync(widgets), ["freshwidget1.json"]);
  });
});

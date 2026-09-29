import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { referencedWidgetIds } from "../shared/agent-store.ts";
import {
  sweepOrphanWidgets,
  WIDGET_ORPHAN_GRACE_MS,
  writeWidget,
  type WidgetRecord,
} from "../shared/widgets-store.ts";

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

test("a widget nothing names any more is swept", () => {
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
  // The route writes the record and only then appends the event that names
  // it. A sweep landing between the two must not take the drawing.
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

test("a store that will not parse stops the sweep instead of emptying it", () => {
  // readAgentStore answers a corrupt file with an empty store, which reads as
  // "nothing references any widget". Sweeping on that would delete every
  // drawing on the machine.
  const dir = mkdtempSync(join(tmpdir(), "ub-widgets-"));
  const storePath = join(dir, "agents.json");
  const previous = process.env.UB_AGENT_STORE_PATH;
  process.env.UB_AGENT_STORE_PATH = storePath;
  try {
    writeFileSync(storePath, "{ this is not json");
    assert.equal(referencedWidgetIds(), null);

    // Valid JSON that parseAgentStore answers with an empty store rather than
    // throwing: a wrong shape, and a schema this build does not know. Both
    // would otherwise read as "nothing references a widget".
    writeFileSync(storePath, "[]");
    assert.equal(referencedWidgetIds(), null);
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 2, threads: [] }));
    assert.equal(referencedWidgetIds(), null);
    // parseAgentStore falls back to an empty list for a missing or non-array
    // `threads`, which would read the same as a store that genuinely has none.
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 1 }));
    assert.equal(referencedWidgetIds(), null);
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, threads: null }));
    assert.equal(referencedWidgetIds(), null);

    writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, threads: [], proposals: [], reserves: [] }));
    assert.deepEqual([...(referencedWidgetIds() ?? [])], []);

    writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      proposals: [],
      reserves: [],
      threads: [{
        id: "b1",
        kind: "bot",
        botId: "b1",
        sessionId: "",
        updatedAt: new Date(0).toISOString(),
        events: [{
          id: "wgt_keptwidget1",
          at: new Date(0).toISOString(),
          kind: "widget",
          text: "Drawing",
          widgetId: "keptwidget1",
        }],
      }],
    }));
    assert.deepEqual([...(referencedWidgetIds() ?? [])], ["keptwidget1"]);
  } finally {
    if (previous === undefined) delete process.env.UB_AGENT_STORE_PATH;
    else process.env.UB_AGENT_STORE_PATH = previous;
  }
});

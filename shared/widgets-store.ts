import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./stack.ts";

/**
 * MCP App widget payloads. The HTML bundle is too large for the transcript
 * (TEXT_MAX is 4000). Each widget is a 0600 file named by its id.
 */

export type WidgetRecord = {
  id: string;
  /** The chat the widget was drawn in; absent on a record from before chats. */
  chatId?: string | null;
  connectionId: string;
  toolName: string;
  resourceUri: string | null;
  arguments: Record<string, unknown>;
  result: unknown;
  createdAt: string;
};

const ID = /^[a-zA-Z0-9_-]{8,80}$/;

export function widgetsDir(root = process.env.UB_WIDGETS_DIR): string {
  if (root) return root;
  return statePath("widgets");
}

function pathFor(id: string, dir = widgetsDir()): string {
  if (!ID.test(id)) throw new Error("widget_id");
  return join(dir, `${id}.json`);
}

const RECORD_MAX = 400_000;

export function writeWidget(record: WidgetRecord, dir = widgetsDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = pathFor(record.id, dir);
  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body, "utf8") > RECORD_MAX) throw new Error("widget_too_large");
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readWidget(id: string, dir = widgetsDir()): WidgetRecord | null {
  const path = pathFor(id, dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WidgetRecord;
    if (!raw || raw.id !== id) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Every readable record, for the orphan sweep. */
export function listWidgets(dir = widgetsDir()): WidgetRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: WidgetRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!ID.test(id)) continue;
    const record = readWidget(id, dir);
    if (record) out.push(record);
  }
  return out;
}

/** How long a record is kept before a sweep may call it an orphan. */
export const WIDGET_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Delete every stored widget the keep set does not name, and return the ids it
 * dropped. The caller keeps the widgets of chats that still exist and the
 * drawings the Library holds.
 *
 * Deleting a chat leaves its drawings behind, so the directory would only ever
 * grow: each record holds the drawing itself, up to RECORD_MAX.
 *
 * The grace window is what keeps the sweep off a live drawing. The widget
 * route writes the record and only then appends the row that names it, so a
 * sweep landing between the two would delete a drawing that is about to be
 * referenced. Anything younger than the window is left alone.
 */
export function sweepOrphanWidgets(
  keepIds: Iterable<string>,
  dir = widgetsDir(),
  now = Date.now(),
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No directory yet, or one this process cannot read: nothing to sweep.
    return [];
  }
  const keep = new Set(keepIds);
  const dropped: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!ID.test(id) || keep.has(id)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < WIDGET_ORPHAN_GRACE_MS) continue;
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
      dropped.push(id);
    } catch {
      // Gone already, or not ours to remove. The next sweep tries again.
    }
  }
  return dropped;
}

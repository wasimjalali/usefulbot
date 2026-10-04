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

export function deleteWidget(id: string, dir = widgetsDir()): void {
  try { unlinkSync(pathFor(id, dir)); } catch { /* ignore */ }
}

/** How long a record is kept before a sweep may call it an orphan. */
export const WIDGET_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Delete every stored widget no thread event names any more, and return the
 * ids it dropped.
 *
 * Clearing a chat takes its events with it but left the drawings behind, so
 * the directory only ever grew: each record holds the drawing itself, up to
 * RECORD_MAX, and nothing ever read them again. Nothing else deleted one
 * either, so this is the first caller `deleteWidget` has had.
 *
 * The grace window is what keeps the sweep off a live drawing. The widget
 * route writes the record and only then appends the event that names it, so a
 * sweep landing between the two would delete a drawing that is about to be
 * referenced. Anything younger than the window is left alone.
 */
export function sweepOrphanWidgets(
  referencedIds: Iterable<string>,
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
  const keep = new Set(referencedIds);
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

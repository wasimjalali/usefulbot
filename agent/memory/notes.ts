import { defineMemory, defineMemoryProvider } from "eve/memory";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  renderNotesBlock,
  NOTES_FULL_COUNT,
  NOTES_TITLE_COUNT,
  type NoteCard,
} from "../../shared/notes-block.ts";
import { sharedMemoryStore, type MemoryStore } from "../lib/memory.ts";
import { boundBotId, type SnapshotCtx } from "../lib/turn-snapshot.ts";

/**
 * The bot's own notes, recalled before each turn and after compaction (UB-009).
 * They arrive as a user-role record, so a note can never pass as a system
 * rule, and eve keeps it verbatim through compaction. The slot adds no tools:
 * the app's own memory_* tools stay as they are.
 *
 * Failure rules (spike: evals/results/2026-10-01-ub009-spikes/eve-spikes.md):
 * a throwing `scope` or `recall` fails the turn, so both catch and return
 * null. A null scope hides the slot and every earlier record of it, which is
 * the safe shape for an unbound session. A null recall keeps the previous
 * record. The same record id is replaced each time, and an empty list sends a
 * sentinel because blank content is refused and a recall cannot retract.
 *
 * Replay: eve stores a digest per operation id and throws "replayed with a
 * different result" if a replayed recall renders other bytes, which would
 * retire the session. After a restart mid-turn eve can replay the operation,
 * and the owner may have edited a note meanwhile. So the rendered block is
 * persisted per (bot, operation) in a small bounded folder next to the memory
 * index, written before the result is returned, and read back first on replay.
 * (Not proved from eve's source that a resumed turn never re-runs recall for a
 * recorded operation, so the persistence is what makes the replay safe.)
 */
export const NOTES_RECORD_ID = "bot-notes";
const OPERATION_CAP = 256;

/** The rendered block per operation, in memory: the fast path in front of the disk copy. */
const byOperation = new Map<string, Render>();

/** Forget the in-memory renders, as a process restart does. The disk copies stay. */
export function forgetRecallCache(): void {
  byOperation.clear();
}

/** The folder of persisted renders, beside the notes and the index of the store. */
function recallDir(store: MemoryStore): string {
  return join(dirname(store.notesDir), "recall");
}

function recallFile(store: MemoryStore, key: string): string {
  return join(recallDir(store), `${createHash("sha256").update(key).digest("hex")}.txt`);
}

/** What one recall rendered. */
type Render = { content: string };

/**
 * The format of a persisted render. Bump it whenever the block's rules change:
 * a copy from an older renderer may show what the current one withholds (an
 * outside-sourced note's body), so it is rendered again instead of replayed.
 */
const RECALL_FORMAT = 3;

function readPersisted(store: MemoryStore, key: string): Render | undefined {
  try {
    const text = readFileSync(recallFile(store, key), "utf8");
    try {
      const parsed = JSON.parse(text) as { v?: unknown; content?: unknown };
      if (parsed?.v === RECALL_FORMAT && typeof parsed.content === "string") return { content: parsed.content };
    } catch {
      /* not this format */
    }
    // The copy is from an older build: this render is made again, which can
    // differ from what that turn first saw. Logged so a retired session traces back.
    console.error("[memory] a persisted notes render is not the current format; rendering it again");
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write the render before it is returned, and keep the folder to the newest OPERATION_CAP files. */
function persist(store: MemoryStore, key: string, render: Render): void {
  const dir = recallDir(store);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = recallFile(store, key);
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ v: RECALL_FORMAT, content: render.content })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    throw err;
  }
  const files = readdirSync(dir).filter((name) => name.endsWith(".txt"));
  if (files.length <= OPERATION_CAP) return;
  const aged = files.map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs })).sort((x, y) => x.at - y.at);
  for (const old of aged.slice(0, files.length - OPERATION_CAP)) {
    try { unlinkSync(join(dir, old.name)); } catch { /* another recall pruned it */ }
  }
}

/** Which bot's notes this session holds: the same claim and binding the turn snapshot uses. Never throws. */
export async function notesScope(ctx: SnapshotCtx): Promise<string | null> {
  try {
    return await boundBotId(ctx);
  } catch (err) {
    console.error("[memory] notes scope failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The exact block a bot's recall renders from its live notes: the newest few
 * with their whole body, then titles, counted against the bot's true note
 * count. Recall and admission sizing both call this one function.
 */
export function renderNotesFor(botId: string, store: () => MemoryStore = sharedMemoryStore): string {
  return renderNotes(botId, store).content;
}

function renderNotes(botId: string, store: () => MemoryStore): Render {
  const notes = store();
  const page = notes.list(botId, NOTES_FULL_COUNT + NOTES_TITLE_COUNT);
  // Same order the block uses, so the bodies loaded are the ones it shows in full.
  const sorted = [...page].sort((a, b) => {
    const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const cards: NoteCard[] = sorted.map((card, index) => ({
    id: card.id,
    title: card.title,
    // An outside-sourced note shows no body, so none is loaded for it.
    body: index < NOTES_FULL_COUNT && card.source !== "model-after-outside-content"
      ? notes.readCard(card.id, botId).body
      : card.body,
    updatedAt: card.updatedAt,
    source: card.source,
  }));
  return { content: renderNotesBlock(cards, notes.countLive(botId)) };
}

/** The recall result for one operation. Never throws: a failure returns null. */
export function recallNotes(
  ctx: {
    operationId: string;
    memory: { scope: { value: string | readonly string[] } };
  },
  store: () => MemoryStore = sharedMemoryStore,
) {
  try {
    // The scope is the bot id the slot resolved; anything else is not a bot.
    const botId = ctx.memory.scope.value;
    if (typeof botId !== "string" || !botId) return null;
    // Keyed by bot too, so a cached render can never reach another bot.
    const key = `${botId}\u0000${ctx.operationId}`;
    let render = byOperation.get(key);
    if (render === undefined) {
      const notes = store();
      render = readPersisted(notes, key);
      if (render === undefined) {
        render = renderNotes(botId, () => notes);
        try {
          persist(notes, key, render);
        } catch (err) {
          // Without the copy a replay could differ, but the turn is not worth failing for it.
          console.error("[memory] notes render not persisted", err instanceof Error ? err.message : err);
        }
      }
      if (byOperation.size >= OPERATION_CAP) byOperation.delete(byOperation.keys().next().value as string);
      byOperation.set(key, render);
    }
    return { messages: [{ id: NOTES_RECORD_ID, content: render.content }] };
  } catch (err) {
    console.error("[memory] notes recall failed", err instanceof Error ? err.message : err);
    return null;
  }
}

export default defineMemory({
  description: "The bot's own saved notes.",
  provider: defineMemoryProvider({
    recall: {
      "turn.started": (ctx) => recallNotes(ctx),
      "compaction.completed": (ctx) => recallNotes(ctx),
    },
  }),
  scope: (ctx) => notesScope(ctx),
});

import type { TurnSelection } from "../../shared/session-selection.ts";
import { routerIds, type RouterIds } from "./router-identity.ts";

/**
 * What one turn froze at its first step: the selection every request of the
 * turn sends, and the window compaction was sized from.
 */
export interface FrozenTurn {
  turnId: string | undefined;
  selection: TurnSelection;
}

/**
 * The frozen turn per eve session, readable from any module in this process.
 *
 * eve may load a hook file (compaction logging) as its own module instance, so
 * a Map local to this file would be empty there. A process-wide registry under
 * a Symbol.for key is the same object in every instance. The model handles keep
 * their own copy in their entry; this one only serves readers outside them.
 */
const REGISTRY_KEY = Symbol.for("useful-bot.frozen-turns");
const REGISTRY_CAP = 256;

function registry(): Map<string, FrozenTurn> {
  const holder = globalThis as unknown as Record<symbol, Map<string, FrozenTurn> | undefined>;
  return (holder[REGISTRY_KEY] ??= new Map());
}

/** The turn a session froze most recently, or null before its first step. */
export function frozenTurnFor(eveSessionId: string): FrozenTurn | null {
  const map = registry();
  const held = map.get(eveSessionId);
  if (!held) return null;
  // A read keeps the session alive, so an active turn is never the idlest key.
  map.delete(eveSessionId);
  map.set(eveSessionId, held);
  return held;
}

function remember(eveSessionId: string, frozen: FrozenTurn): void {
  const map = registry();
  // Insertion order is age: re-inserting keeps the oldest key the idlest session.
  map.delete(eveSessionId);
  map.set(eveSessionId, frozen);
  if (map.size > REGISTRY_CAP) map.delete(map.keys().next().value as string);
}

let warnedNoTurnId = false;

/**
 * One model handle per eve session, not per process. The handle itself never
 * changes (the router picks the upstream model per request), but its fetch
 * stamps the session, and the router gates and caches by that: see
 * router-identity.ts. The ids are bound to the handle when it is built, never
 * read from shared state at fetch time, so two sessions stepping at the same
 * moment cannot stamp each other's id. The turn id moves with each turn, so
 * the entry holds it and the fetch reads it per attempt.
 *
 * With `freeze`, the entry also holds the turn's selection (and a rebuilt
 * entry takes it back from the process registry for the same turn). `freeze` runs on
 * the first step of every turn (a new turn id) and its result stays for every
 * later step, retry, 429 wait and compaction call of that turn: the handle's
 * fetch reads it from the entry, so a pick made mid-turn changes nothing until
 * the next turn. Without `freeze` (the reviewer) no selection is carried.
 */
export function perSessionModel<M>(
  build: (ids: () => RouterIds, selection: () => TurnSelection | null) => M,
  cap = 64,
  freeze?: (eveSessionId: string, eveTurnId: string | undefined) => TurnSelection,
): (eveSessionId: string, eveTurnId: string | undefined) => M {
  type Entry = { model: M; turnId: string | undefined; frozen: TurnSelection | null };
  const entries = new Map<string, Entry>();
  return (eveSessionId, eveTurnId) => {
    let entry = entries.get(eveSessionId);
    if (entry) {
      // A Map iterates in insertion order: re-inserting keeps the first key the
      // session that has gone longest without a step.
      entries.delete(eveSessionId);
      entries.set(eveSessionId, entry);
    } else {
      const created: Entry = { model: undefined as M, turnId: undefined, frozen: null };
      // A handle evicted mid-turn (the cap) comes back for the next step of the
      // SAME turn: the process registry still holds that turn's selection, so
      // it is reused and the turn does not re-read a grant or last pick that
      // moved meanwhile. A different turn id freezes afresh below.
      const held = eveTurnId === undefined ? null : frozenTurnFor(eveSessionId);
      if (freeze && held && held.turnId === eveTurnId) {
        created.turnId = eveTurnId;
        created.frozen = held.selection;
      }
      created.model = build(
        () => routerIds(eveSessionId, created.turnId),
        () => created.frozen,
      );
      entries.set(eveSessionId, created);
      entry = created;
      // Rebuilding a dropped handle is cheap, and a session that is mid-call
      // keeps its own handle alive through the closure, so eviction is safe.
      if (entries.size > cap) entries.delete(entries.keys().next().value as string);
    }
    if (freeze) {
      if (eveTurnId === undefined && !warnedNoTurnId) {
        warnedNoTurnId = true;
        console.warn("[useful-bot] step.started carried no turn id; the model selection is re-read every step");
      }
      // A step with no turn id cannot be told from the turn before it, so it
      // re-reads: the old per-step behaviour, said once, never a stale freeze.
      // That re-read prefers the grant (written once, at turn start) over the
      // owner's live selection, so a pick made mid-turn cannot split the turn.
      const sameTurn = entry.frozen !== null && eveTurnId !== undefined && entry.turnId === eveTurnId;
      if (!sameTurn) {
        entry.frozen = freeze(eveSessionId, eveTurnId);
        remember(eveSessionId, { turnId: eveTurnId, selection: entry.frozen });
      }
    }
    entry.turnId = eveTurnId;
    return entry.model;
  };
}

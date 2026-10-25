/** The slice of a tool context the marker needs (`ToolCtx` has it). */
export type OutsideCtx = { session?: { id?: string; turn?: { id?: string } } };

/**
 * Whether this turn has read content the owner did not write: a web page, a
 * connected app's answer, a file, a command's output. A note the model writes
 * after that is stored as `model-after-outside-content`, so Settings can show
 * it and the owner can delete it in one click. The marker is per chat and turn
 * and lives in this process only: a restart mid-turn forgets it, and the next
 * turn starts clean. Notes saved before this mark existed carry source
 * "model", whatever they were written from.
 */
const REGISTRY_KEY = Symbol.for("useful-bot.outside-content");
const CAP = 256;

function seen(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (holder[REGISTRY_KEY] ??= new Set());
}

function keyOf(ctx: OutsideCtx | undefined): string | null {
  const sessionId = ctx?.session?.id;
  if (!sessionId) return null;
  return `${sessionId}\u0000${ctx?.session?.turn?.id ?? ""}`;
}

function add(key: string): void {
  const set = seen();
  set.delete(key);
  set.add(key);
  if (set.size > CAP) set.delete(set.values().next().value as string);
}

/** Record that this turn read outside content. A call with no session (a test) is ignored. */
export function markOutside(ctx: OutsideCtx | undefined): void {
  const key = keyOf(ctx);
  if (!key) return;
  add(key);
}

/** True once a tool marked the turn. */
export function seenOutside(ctx: OutsideCtx | undefined): boolean {
  const key = keyOf(ctx);
  if (!key) return false;
  return seen().has(key);
}

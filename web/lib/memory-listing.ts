import type { MemoryNoteCard } from "../../agent/lib/memory.ts";

/** The store call the listing needs; a test hands in the real store. */
type Listable = { list(botId: string, limit: number): MemoryNoteCard[] };

/**
 * GET /api/memory without a note id: a page of at most 100 notes. No bot named
 * is an empty listing.
 */
export function memoryListing(store: Listable | null, botId: string): { notes: MemoryNoteCard[] } {
  if (!store || !botId) return { notes: [] };
  return { notes: store.list(botId, 100) };
}

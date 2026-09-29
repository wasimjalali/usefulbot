import { routerIds, type RouterIds } from "./router-identity.ts";

/**
 * One model handle per eve session, not per process. The handle itself never
 * changes (the router picks the upstream model per request), but its fetch
 * stamps the session, and the router gates and caches by that: see
 * router-identity.ts. The ids are bound to the handle when it is built, never
 * read from shared state at fetch time, so two sessions stepping at the same
 * moment cannot stamp each other's id. The turn id moves with each turn, so
 * the entry holds it and the fetch reads it per attempt.
 */
export function perSessionModel<M>(
  build: (ids: () => RouterIds) => M,
  cap = 64,
): (eveSessionId: string, eveTurnId: string | undefined) => M {
  const entries = new Map<string, { model: M; turnId: string | undefined }>();
  return (eveSessionId, eveTurnId) => {
    const cached = entries.get(eveSessionId);
    if (cached) {
      cached.turnId = eveTurnId;
      // A Map iterates in insertion order: re-inserting keeps the first key the
      // session that has gone longest without a step.
      entries.delete(eveSessionId);
      entries.set(eveSessionId, cached);
      return cached.model;
    }
    const entry: { model: M; turnId: string | undefined } = { model: undefined as M, turnId: eveTurnId };
    entry.model = build(() => routerIds(eveSessionId, entry.turnId));
    entries.set(eveSessionId, entry);
    // Rebuilding a dropped handle is cheap, and a session that is mid-call
    // keeps its own handle alive through the closure, so eviction is safe.
    if (entries.size > cap) entries.delete(entries.keys().next().value as string);
    return entry.model;
  };
}

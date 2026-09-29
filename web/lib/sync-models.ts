import { keyRejected, refreshProviderModels } from "../../shared/live-models.ts";
import { providerMode, type AuthMode, type ProviderMode } from "../../shared/provider-catalog.ts";
import { accessTokenFor } from "../../shared/provider-oauth.ts";
import type { ProviderStore } from "../../shared/providers.ts";

function substituteFields(baseUrl: string, fields: Record<string, string>): string {
  return baseUrl.replace(/\{(\w+)\}/g, (_, name: string) => fields[name] ?? "");
}

/**
 * The refresh running or queued per connection, with the request it was
 * started for. A poll that lands mid-fetch joins it. A forced refresh (a
 * save or a sign in) queues behind it and forces its own fetch, so the
 * newest credential always writes last and a job started with an old key can
 * never leave the cache looking fresh over the new one.
 */
interface SyncState {
  inFlight: Map<string, { sig: string; job: Promise<unknown> }>;
  lastAttempt: Map<string, { sig: string; at: number }>;
}
// On globalThis: the dev server gives each API route its own copy of this
// module, and the ordering only holds if every route shares one set of maps.
const SYNC_STATE_KEY = Symbol.for("useful-bot.sync-models.state");
const syncState: SyncState = ((globalThis as Record<symbol, unknown>)[SYNC_STATE_KEY] ??= {
  inFlight: new Map(),
  lastAttempt: new Map(),
}) as SyncState;
const inFlight = syncState.inFlight;

/**
 * When each connection's list was last asked for, and with which request.
 * A failed fetch writes nothing, so the cache TTL alone would retry an
 * expired key or a stopped local server on every 2.5 s poll. An unforced
 * refresh with the same request waits this long after the last attempt;
 * a success is covered by the 30 minute cache TTL anyway.
 */
const RETRY_AFTER_MS = 5 * 60 * 1000;
const lastAttempt = syncState.lastAttempt;

async function refreshOne(store: ProviderStore, id: string, force: boolean): Promise<unknown> {
  const env = process.env;
  const conn = store.connections[id] ?? null;
  let mode: ProviderMode;
  let baseUrl: string;
  let key: string | null = null;
  let headers: Record<string, string>;
  if (conn) {
    mode = providerMode(conn.providerId, conn.mode);
    if (!mode.listsModels) return;
    if (conn.credential.kind === "none" && conn.mode !== "local") return;
    baseUrl = substituteFields(mode.baseUrl, conn.fields);
    if (conn.providerId === "opencode-go" && env.UB_OPENCODE_GO_BASE) baseUrl = env.UB_OPENCODE_GO_BASE;
    headers = { ...(mode.headers ?? {}) };
    if (conn.credential.kind === "key") {
      key = conn.credential.key;
    } else if (conn.credential.kind === "oauth") {
      const auth = accessTokenFor(conn.providerId, conn.credential);
      key = auth.token;
      headers = { ...headers, ...auth.headers };
    }
  } else if (id === "opencode-go:plan") {
    // The implicit env connection for the Go plan.
    mode = providerMode("opencode-go", "plan");
    if (!mode.listsModels) return;
    key = env.UB_OPENCODE_GO_KEY ?? null;
    baseUrl = env.UB_OPENCODE_GO_BASE || mode.baseUrl;
    headers = { ...(mode.headers ?? {}) };
  } else {
    return;
  }
  const query = mode.modelsQuery;
  const imagesPath = mode.images?.listPath;
  const sig = JSON.stringify([baseUrl, key, headers, query, imagesPath]);
  const running = inFlight.get(id);
  // An unforced poll never queues behind a running fetch: its request may be
  // older than the one running, and writing after it would put a stale list
  // in the cache as fresh. It joins, and the next poll picks up any change.
  if (running && !force) return running.job;
  const tried = lastAttempt.get(id);
  if (!running && !force && tried?.sig === sig && Date.now() - tried.at < RETRY_AFTER_MS) return;
  lastAttempt.set(id, { sig, at: Date.now() });
  const run = () => refreshProviderModels({
    providerId: id,
    baseUrl,
    key,
    keyHeader: mode.keyHeader,
    headers,
    query,
    imagesPath,
    force: force || Boolean(running),
  });
  const job: Promise<unknown> = (running ? running.job.catch(() => undefined).then(run) : run()).finally(() => {
    if (inFlight.get(id)?.job === job) inFlight.delete(id);
  });
  inFlight.set(id, { sig, job });
  return job;
}

/**
 * True when the vendor turns down a key the owner just pasted, asked the same
 * way the model list is fetched for that connection. Modes with no model list
 * and local servers are never asked.
 */
export async function keyRejectedFor(
  providerId: string,
  mode: AuthMode,
  key: string,
  fields: Record<string, string> = {},
): Promise<boolean> {
  if (mode === "local" || mode === "oauth") return false;
  const def = providerMode(providerId, mode);
  if (!def.listsModels) return false;
  let baseUrl = substituteFields(def.baseUrl, fields);
  if (providerId === "opencode-go" && process.env.UB_OPENCODE_GO_BASE) baseUrl = process.env.UB_OPENCODE_GO_BASE;
  return keyRejected(baseUrl, key, fetch, def.keyHeader, { ...(def.headers ?? {}) }, def.modelsQuery ?? {});
}

/**
 * Refresh the model list of every connected provider, keyed by connection id
 * so plan and api lists never collide. Only refreshing the active connection
 * left every other connected provider on its two-model static fallback, so a
 * ChatGPT sign in next to an active Go plan never showed its real lineup.
 *
 * The active connection (and `alsoAwait`, a connection just signed in) is
 * awaited, and forced when `force` is set, so the response carries its list.
 * The rest refresh in the background on the 30 minute cache TTL and show up
 * on the next poll, which keeps a slow or offline provider from holding up
 * the response.
 */
export async function syncProviderModels(
  store: ProviderStore,
  opts: { force?: boolean; alsoAwait?: string } = {},
): Promise<void> {
  const env = process.env;
  const ids = new Set(Object.keys(store.connections));
  const implicitGo = !store.connections["opencode-go:plan"] && Boolean(env.UB_OPENCODE_GO_KEY);
  if (implicitGo) ids.add("opencode-go:plan");
  const activeId = store.activeConnectionId ?? (implicitGo ? "opencode-go:plan" : null);
  const awaited = new Set([activeId, opts.alsoAwait].filter((id): id is string => Boolean(id)));
  const waits: Promise<unknown>[] = [];
  for (const id of ids) {
    if (awaited.has(id)) waits.push(refreshOne(store, id, Boolean(opts.force)));
    else void refreshOne(store, id, false).catch((err) => console.error(`[models] refresh ${id} failed`, err));
  }
  await Promise.all(waits);
}

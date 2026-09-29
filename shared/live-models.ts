import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConnectionId, providerMode, type KeyHeader } from "./provider-catalog.ts";
import { EFFORTS, isEffortId, mergeLiveModels, modelsFor, type EffortId, type ModelMeta, type ModelOption } from "./models.ts";

const CACHE_TTL_MS = 30 * 60 * 1000;
/** Context windows and modalities change with releases, not by the hour. */
const META_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Version 2 added the models.dev facts on each row. A version 1 file reads
 * as empty so the first refresh after the upgrade fetches them instead of
 * serving a fresh-looking list with no context window on it. Version 3 adds
 * OpenRouter's image models and modalities, which the image picker needs.
 */
const CACHE_SCHEMA = 3;

type CacheFile = {
  schemaVersion: typeof CACHE_SCHEMA;
  providers: Record<string, { fetchedAt: number; models: ModelOption[] }>;
  /** models.dev facts per provider, keyed by the provider's model id. */
  meta?: { fetchedAt: number; providers: Record<string, Record<string, ModelMeta>> };
};

export function modelsCachePath(root = process.env.UB_MODELS_CACHE_PATH): string {
  if (root) return root;
  return join(process.env.HOME ?? "/tmp", ".useful-bot/models-cache.json");
}

function emptyCache(): CacheFile {
  return { schemaVersion: CACHE_SCHEMA, providers: {} };
}

/**
 * The last parse, kept while the file on disk is the one it came from. The
 * file is several hundred KB and was parsed on every composer poll (each 2.5 s
 * per open app) and twice per model call in the router. Writers replace the
 * file by rename, so a new inode, size or mtime means a new file; any process
 * may be the writer, which is why this asks the disk instead of trusting
 * itself.
 */
let parsed: { path: string; ino: number; size: number; mtimeMs: number; cache: CacheFile } | undefined;

export function readModelsCache(path = modelsCachePath()): CacheFile {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return emptyCache();
  }
  if (parsed && parsed.path === path && parsed.ino === stat.ino && parsed.size === stat.size && parsed.mtimeMs === stat.mtimeMs) {
    return parsed.cache;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (raw?.schemaVersion !== CACHE_SCHEMA || !raw.providers || typeof raw.providers !== "object") return emptyCache();
    parsed = { path, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, cache: raw };
    return raw;
  } catch {
    return emptyCache();
  }
}

export function writeModelsCache(cache: CacheFile, path = modelsCachePath()): void {
  // Callers edit the object they read and hand it back. Dropped first, so a
  // write that fails cannot leave an edited copy standing in for the file.
  parsed = undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic like the catalogue cache: readers see the old file or the new one.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function cachedModels(providerId: string, path = modelsCachePath()): ModelOption[] {
  return readModelsCache(path).providers[providerId]?.models ?? [];
}

/**
 * Live list for a connection, keyed by connection id so plan and api lists
 * do not collide. Falls back to the static or catalogue derived list. Caches
 * written before connections existed are keyed by bare provider id, so those
 * are read once as a bridge until the next refresh rewrites the entry.
 */
export function catalogFor(connectionId: string, path = modelsCachePath()): ModelOption[] {
  const live = cachedModels(connectionId, path);
  if (live.length > 0) return live;
  try {
    const legacy = cachedModels(parseConnectionId(connectionId).providerId, path);
    if (legacy.length > 0) return legacy;
  } catch {
    /* not a connection id, modelsFor below handles bare ids and unknowns */
  }
  return modelsFor(connectionId);
}

export function parseModelList(raw: unknown): string[] {
  return idsFromRows(rowsOf(raw));
}

/**
 * OpenAI shaped rows carry `id`. The ChatGPT Codex list carries `slug`
 * instead and marks internal models (auto review, reserve) with
 * `visibility: "hide"`, which the Codex picker leaves out too.
 */
function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  if (Array.isArray(rec.data)) return rec.data;
  if (Array.isArray(rec.models)) return rec.models;
  return [];
}

/**
 * Facts the vendor's own list states about each model: the ChatGPT Codex list
 * carries display_name, context_window, input_modalities and the reasoning
 * levels the model takes. OpenAI shaped lists carry none of these, so their
 * rows come back empty and models.dev plus the name guess fill in.
 */
export function parseListedMeta(raw: unknown): Record<string, ModelMeta> {
  const out: Record<string, ModelMeta> = {};
  for (const row of rowsOf(raw)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : rec.slug;
    if (typeof id !== "string" || !id.trim()) continue;
    const meta: ModelMeta = {};
    // OpenRouter nests the modalities under `architecture`.
    const arch = rec.architecture && typeof rec.architecture === "object" ? rec.architecture as Record<string, unknown> : {};
    const inputs = rec.input_modalities ?? arch.input_modalities;
    const outputs = rec.output_modalities ?? arch.output_modalities;
    if (typeof rec.display_name === "string" && rec.display_name.trim()) meta.label = rec.display_name.trim();
    if (Number.isInteger(rec.context_window) && (rec.context_window as number) > 0) meta.contextTokens = rec.context_window as number;
    // An empty array says nothing, so it leaves models.dev and the name guess standing.
    if (Array.isArray(inputs) && inputs.length > 0 && inputs.every((item) => typeof item === "string")) {
      meta.inputs = inputs as string[];
    }
    if (Array.isArray(outputs) && outputs.length > 0 && outputs.every((item) => typeof item === "string")) {
      meta.outputs = outputs as string[];
    }
    if (Array.isArray(rec.supported_reasoning_levels)) {
      const efforts = rec.supported_reasoning_levels
        .map((level) => (level as { effort?: unknown } | null)?.effort)
        .filter((effort): effort is EffortId => isEffortId(effort))
        // Vendor order is not level order ("minimal" can come last), so sort
        // onto this app's ladder: the menu reads low to max and [0] is lowest.
        .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
      if (efforts.length > 0) {
        meta.efforts = efforts;
        // A default this app cannot express ("minimal") snaps to the lowest
        // listed level, so the effort control always has a value.
        meta.defaultEffort = isEffortId(rec.default_reasoning_level) && efforts.includes(rec.default_reasoning_level)
          ? rec.default_reasoning_level
          : efforts[0];
      }
    }
    if (Object.keys(meta).length > 0) out[id.trim()] = meta;
  }
  return out;
}

/** Formats the image store keeps (shared/images-store.ts IMAGE_MIME). */
const STORABLE_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);

/**
 * The vendor's image endpoint list (OpenRouter GET /images/models). Every row
 * is a model POST /images serves, so each is marked an image generator, with
 * its aspect ratios. A model whose only formats this app cannot store (the
 * SVG-only Recraft vector models) is left out: every call to it would bill
 * and then be refused.
 */
export function parseImageModels(raw: unknown): { ids: string[]; meta: Record<string, ModelMeta> } {
  const ids: string[] = [];
  const meta: Record<string, ModelMeta> = {};
  const listed = parseListedMeta(raw);
  for (const row of rowsOf(raw)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id.trim()) continue;
    const id = rec.id.trim();
    const params = rec.supported_parameters && typeof rec.supported_parameters === "object"
      ? rec.supported_parameters as Record<string, { values?: unknown }>
      : {};
    const formats = Array.isArray(params.output_format?.values) ? params.output_format.values : null;
    if (formats && !formats.some((format) => typeof format === "string" && STORABLE_IMAGE_FORMATS.has(format))) continue;
    const ratios = Array.isArray(params.aspect_ratio?.values)
      ? params.aspect_ratio.values.filter((value): value is string => typeof value === "string")
      : [];
    ids.push(id);
    // No `outputs` default: imageGen alone marks the generator, and a made-up
    // ["image"] would overwrite a dual model's chat-side modalities.
    meta[id] = {
      ...listed[id],
      imageGen: true,
      ...(ratios.length > 0 ? { aspectRatios: ratios } : {}),
    };
  }
  return { ids, meta };
}

function idsFromRows(rows: unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) ids.push(row.trim());
    if (!row || typeof row !== "object") continue;
    const rec = row as { id?: unknown; slug?: unknown; visibility?: unknown };
    if (rec.visibility === "hide") continue;
    const id = typeof rec.id === "string" ? rec.id : rec.slug;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids.filter((id) => !/embed|whisper|tts|moderation/i.test(id));
}

/**
 * The models.dev catalog, reduced to what this app needs: the context window
 * and the input modalities per model, per provider. The provider keys there
 * match this app's provider ids. Rows without a usable limit are skipped.
 */
export function parseModelsDev(raw: unknown): Record<string, Record<string, ModelMeta>> {
  const out: Record<string, Record<string, ModelMeta>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") continue;
    const rows: Record<string, ModelMeta> = {};
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue;
      const limit = (model as { limit?: { context?: unknown } }).limit;
      const inputs = (model as { modalities?: { input?: unknown } }).modalities?.input;
      const outputs = (model as { modalities?: { output?: unknown } }).modalities?.output;
      const meta: ModelMeta = {};
      if (limit && Number.isInteger(limit.context) && (limit.context as number) > 0) {
        meta.contextTokens = limit.context as number;
      }
      if (Array.isArray(inputs) && inputs.every((item) => typeof item === "string")) {
        meta.inputs = inputs as string[];
      }
      if (Array.isArray(outputs) && outputs.every((item) => typeof item === "string")) {
        meta.outputs = outputs as string[];
      }
      if (meta.contextTokens || meta.inputs || meta.outputs) rows[id] = meta;
    }
    if (Object.keys(rows).length > 0) out[providerId] = rows;
  }
  return out;
}

async function fetchModelsDev(fetchImpl: typeof fetch): Promise<Record<string, Record<string, ModelMeta>>> {
  const res = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: "application/json", "user-agent": "useful-bot/1.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return {};
  return parseModelsDev(await res.json());
}

/**
 * Catalog facts for a provider, refreshed from models.dev once a day and
 * kept in the same cache file as the live list. A failed fetch keeps the
 * last copy; no copy at all means the models carry no facts, which the
 * callers treat as unknown rather than as "no".
 */
export async function modelMetaFor(
  providerId: string,
  path = modelsCachePath(),
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ModelMeta>> {
  const cache = readModelsCache(path);
  const fresh = cache.meta && Date.now() - cache.meta.fetchedAt < META_TTL_MS;
  if (fresh) return cache.meta?.providers[providerId] ?? {};
  try {
    const providers = await fetchModelsDev(fetchImpl);
    if (Object.keys(providers).length === 0) return cache.meta?.providers[providerId] ?? {};
    const latest = readModelsCache(path);
    latest.meta = { fetchedAt: Date.now(), providers };
    writeModelsCache(latest, path);
    return providers[providerId] ?? {};
  } catch {
    return cache.meta?.providers[providerId] ?? {};
  }
}

function listHeaders(key: string | null | undefined, keyHeader: KeyHeader, headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    accept: "application/json",
    "user-agent": "useful-bot/1.0",
    ...headers,
  };
  if (key) {
    if (keyHeader === "x-api-key") out["x-api-key"] = key;
    else if (keyHeader === "api-key") out["api-key"] = key;
    else out.authorization = `Bearer ${key}`;
  }
  return out;
}

/**
 * Asks the vendor's model list whether it takes a pasted key, before the key
 * is stored. Only a 401 or 403 is a rejection: a timeout, an offline Mac, a
 * rate limit or a vendor outage lets the key through, the way a save always
 * did, so a good key is never refused for someone else's trouble. Nothing is
 * cached; the list itself is fetched after the save.
 */
export async function keyRejected(
  baseUrl: string,
  key: string,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  keyHeader: KeyHeader = "bearer",
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<boolean> {
  const search = new URLSearchParams(query).toString();
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models${search ? `?${search}` : ""}`, {
      headers: listHeaders(key, keyHeader, headers),
      signal: AbortSignal.timeout(4000),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

export async function fetchProviderModels(
  baseUrl: string,
  key?: string | null,
  fetchImpl: typeof fetch = fetch,
  keyHeader: KeyHeader = "bearer",
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
  path = "models",
): Promise<{ ids: string[]; meta: Record<string, ModelMeta> }> {
  const search = new URLSearchParams(query).toString();
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/${path}${search ? `?${search}` : ""}`, {
    headers: listHeaders(key, keyHeader, headers),
    signal: AbortSignal.timeout(4000),
  });
  // The image list fails loud so the caller can keep the last good rows; an
  // answer with no storable models is a real empty list and replaces them.
  if (!res.ok && path !== "models") throw new Error(`image list ${res.status}`);
  if (!res.ok) return { ids: [], meta: {} };
  const raw = await res.json();
  if (path !== "models") return parseImageModels(raw);
  return { ids: parseModelList(raw), meta: parseListedMeta(raw) };
}

export async function fetchProviderModelIds(
  ...args: Parameters<typeof fetchProviderModels>
): Promise<string[]> {
  return (await fetchProviderModels(...args)).ids;
}

/**
 * models.dev key for the meta lookup. Prefers an explicit override, then the
 * catalogue modelsDevId for the connection, then the raw id for legacy bare
 * provider calls. Null means models.dev has no entry, so no meta is fetched.
 */
function metaKeyFor(providerId: string, override?: string | null): string | null {
  if (override !== undefined) return override;
  try {
    const parsed = parseConnectionId(providerId);
    return providerMode(parsed.providerId, parsed.mode).modelsDevId;
  } catch {
    return providerId;
  }
}

export async function refreshProviderModels(input: {
  providerId: string;
  baseUrl: string;
  key?: string | null;
  keyHeader?: KeyHeader;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** The vendor's image model list, merged into the list (OpenRouter's images/models). */
  imagesPath?: string;
  modelsDevId?: string | null;
  force?: boolean;
  path?: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelOption[]> {
  const path = input.path ?? modelsCachePath();
  const cache = readModelsCache(path);
  const current = cache.providers[input.providerId];
  const fresh = current && Date.now() - current.fetchedAt < CACHE_TTL_MS && current.models.length > 0;
  if (!input.force && fresh) return current.models;
  try {
    const listed = await fetchProviderModels(input.baseUrl, input.key, input.fetchImpl, input.keyHeader, input.headers, input.query);
    if (listed.ids.length === 0) return current?.models?.length ? current.models : modelsFor(input.providerId);
    if (input.imagesPath) {
      // The image list is a separate call. If it fails, the chat list still
      // lands and the image rows from the last good refresh stay with all
      // their facts, so one bad fetch does not empty the picker for 30 min.
      let images: { ids: string[]; meta: Record<string, ModelMeta> };
      try {
        images = await fetchProviderModels(input.baseUrl, input.key, input.fetchImpl, input.keyHeader, input.headers, {}, input.imagesPath);
      } catch (err) {
        console.error(`[models] image list ${input.providerId} failed`, err);
        const kept = (current?.models ?? []).filter((item) => item.imageGen);
        images = {
          ids: kept.map((item) => item.id),
          meta: Object.fromEntries(kept.map(({ id, label, contextTokens, inputs, outputs, aspectRatios, efforts, defaultEffort }) => [id, {
            label,
            efforts,
            defaultEffort,
            imageGen: true,
            ...(contextTokens ? { contextTokens } : {}),
            ...(inputs ? { inputs } : {}),
            ...(outputs ? { outputs } : {}),
            ...(aspectRatios ? { aspectRatios } : {}),
          } satisfies ModelMeta])),
        };
      }
      listed.ids.push(...images.ids);
      for (const [id, meta] of Object.entries(images.meta)) listed.meta[id] = { ...listed.meta[id], ...meta };
    }
    const ids = [...new Set(listed.ids)];
    const metaKey = metaKeyFor(input.providerId, input.modelsDevId);
    const catalogMeta = metaKey ? await modelMetaFor(metaKey, path, input.fetchImpl) : {};
    // The vendor's own facts win over models.dev, field by field.
    const meta: Record<string, ModelMeta> = {};
    for (const id of ids) meta[id] = { ...catalogMeta[id], ...listed.meta[id] };
    const models = mergeLiveModels(input.providerId, ids, meta);
    // The fetch awaited above can overlap a refresh for a different provider,
    // so the snapshot taken before the await is stale by write time. Re-read
    // the cache and set only this provider's entry, or the write would clobber
    // the models the overlapping refresh just stored.
    const latest = readModelsCache(path);
    latest.providers[input.providerId] = { fetchedAt: Date.now(), models };
    writeModelsCache(latest, path);
    return models;
  } catch {
    return current?.models?.length ? current.models : modelsFor(input.providerId);
  }
}

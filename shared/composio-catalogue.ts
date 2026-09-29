import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposioLike, ComposioSessionLike } from "./composio.ts";

/**
 * Composio's toolkit catalogue, about a thousand rows, cached on disk for a
 * day so the dialog pages and searches it locally instead of walking twenty
 * pages of the API on every open. The cache holds names, slugs and logos
 * only, never connection state: that is asked live.
 *
 * The first open after the cache is missing or stale gets the popular set
 * at once while the walk runs in the background; the next request sees the
 * full catalogue.
 *
 * Each row also records whether Composio runs the app's OAuth sign-in for
 * us. The session listing does not say, so a second walk over the plain
 * toolkit endpoint fills it in: an app whose only sign-in is OAuth and whose
 * OAuth Composio does not manage needs the owner's own developer app before
 * Connect can work (TikTok, X, Spotify). The dialog says so up front instead
 * of failing on the click.
 */

export interface CatalogueItem {
  slug: string;
  name: string;
  isNoAuth: boolean;
  logo?: string | undefined;
  /** Connect needs the owner's own OAuth app: Composio has none for it. */
  ownApp?: boolean | undefined;
}

interface CatalogueFile {
  schemaVersion: 2;
  fetchedAt: string;
  items: CatalogueItem[];
}

const TTL_MS = 24 * 60 * 60 * 1000;
const PAGE = 50;
const MAX_PAGES = 60;

// Keyed by path: two catalogue paths in one process must not read each
// other's items out of one shared slot.
const memo = new Map<string, { fetchedAt: number; items: CatalogueItem[] }>();
const building = new Map<string, Promise<void>>();

export function cataloguePath(root = process.env.UB_CATALOGUE_PATH): string {
  if (root) return root;
  return join(process.env.HOME ?? "/tmp", ".useful-bot/composio-catalogue.json");
}

function load(path: string): { fetchedAt: number; items: CatalogueItem[] } | null {
  const cached = memo.get(path);
  if (cached) return cached;
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalogueFile>;
    if (raw.schemaVersion !== 2 || !Array.isArray(raw.items) || typeof raw.fetchedAt !== "string") return null;
    const items = raw.items.filter(
      (item): item is CatalogueItem =>
        !!item && typeof item === "object" && typeof item.slug === "string" && typeof item.name === "string",
    );
    const entry = { fetchedAt: Date.parse(raw.fetchedAt) || 0, items };
    memo.set(path, entry);
    return entry;
  } catch {
    return null;
  }
}

function save(items: CatalogueItem[], path: string): void {
  const fetchedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const file: CatalogueFile = { schemaVersion: 2, fetchedAt, items };
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  memo.set(path, { fetchedAt: Date.parse(fetchedAt), items });
}

/**
 * Whether an app's sign-in needs the owner's own OAuth app. True only when
 * every scheme the app offers is OAuth and Composio manages none of them;
 * an app that also takes an API key (Shopify) is left to the click, where
 * Composio's own answer decides.
 */
export function needsOwnApp(item: {
  no_auth?: boolean | undefined;
  auth_schemes?: string[] | undefined;
  composio_managed_auth_schemes?: string[] | undefined;
}): boolean {
  const schemes = item.auth_schemes ?? [];
  return (
    item.no_auth !== true &&
    schemes.length > 0 &&
    schemes.every((scheme) => scheme.startsWith("OAUTH")) &&
    (item.composio_managed_auth_schemes ?? []).length === 0
  );
}

async function ownAppSlugs(client: ComposioLike): Promise<Set<string>> {
  const slugs = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await client.client.toolkits.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of batch.items) if (needsOwnApp(item)) slugs.add(item.slug.toLowerCase());
    cursor = batch.next_cursor ?? undefined;
    if (!cursor || batch.items.length === 0) break;
  }
  return slugs;
}

async function build(session: ComposioSessionLike, client: ComposioLike, path: string): Promise<void> {
  const items: CatalogueItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await session.toolkits({ limit: PAGE, cursor });
    for (const item of batch.items) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      items.push({ slug: item.slug, name: item.name, isNoAuth: item.isNoAuth, logo: item.logo });
    }
    cursor = batch.cursor;
    if (!cursor || batch.items.length === 0) break;
  }
  if (items.length === 0) return;
  // A failed flag walk still saves the catalogue, flags unset: without a
  // cache every dialog read would walk the whole catalogue again, and an
  // unflagged own-app row only degrades to the click-time answer.
  try {
    const own = await ownAppSlugs(client);
    for (const item of items) item.ownApp = own.has(item.slug.toLowerCase());
  } catch {
    // Left for the next build; the rows below carry no flag.
  }
  save(items, path);
}

/**
 * The cached catalogue as session toolkit items (without connection state),
 * or null when there is none yet. A missing or stale cache starts one build
 * in the background; the caller shows what it has meanwhile.
 */
export function readCatalogue(
  session: ComposioSessionLike,
  client: ComposioLike,
  path = cataloguePath(),
): CatalogueItem[] | null {
  const current = load(path);
  const stale = !current || Date.now() - current.fetchedAt > TTL_MS;
  if (stale && !building.has(path)) {
    const pending = build(session, client, path)
      .catch(() => undefined)
      .finally(() => {
        building.delete(path);
      });
    building.set(path, pending);
  }
  return current?.items ?? null;
}

/**
 * The slugs the cache already holds, or null when there is no cache. A plain
 * read: it never starts a walk, so a caller on an error path (naming the app
 * a tool belongs to) cannot turn a miss into twenty pages of API calls.
 */
export function catalogueSlugs(path = cataloguePath()): string[] | null {
  const current = load(path);
  return current ? current.items.map((item) => item.slug) : null;
}

/** Waits for a build in progress, for tests and the probe. */
export async function catalogueReady(): Promise<void> {
  await Promise.all([...building.values()]);
}

/** Drops the in-memory copy so the next read goes to disk. Tests only. */
export function resetCatalogueMemo(): void {
  memo.clear();
}

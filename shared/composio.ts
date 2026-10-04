import { Composio } from "@composio/core";
import { cataloguePath, catalogueSlugs, readCatalogue } from "./composio-catalogue.ts";
import {
  connectorsPath,
  isToolkitSlug,
  readConnectorsStore,
  setConnectedToolkits,
  updateConnectorsStore,
  type ConnectorsStore,
} from "./connectors-store.ts";

/**
 * The one place that talks to the Composio SDK. The web route and the agent
 * tools call these functions; nothing else imports @composio/core.
 *
 * One Tool Router session per store. Its id is persisted so every process
 * reuses it; a session Composio no longer knows (deleted, expired, new key)
 * is replaced and the new id written back. The session is created without a
 * toolkit filter so the catalogue listing stays complete; the agent tools
 * restrict themselves to the connected toolkits instead.
 */

export interface ConnectorToolkit {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
  /** Connect needs the owner's own OAuth app; see composio-catalogue.ts. */
  ownApp: boolean;
  connected: boolean;
  accountId: string | null;
  status: string | null;
}

/** One credential the owner's own app supplies (client id, client secret, ...). */
export interface OwnAppField {
  name: string;
  label: string;
  description: string;
  /** Rendered as a password field. */
  secret: boolean;
}

/** What the dialog needs to collect an app's own OAuth credentials. */
export interface OwnAppForm {
  toolkit: string;
  authScheme: string;
  fields: OwnAppField[];
  /** The redirect URI the owner registers in the provider's developer portal. */
  redirectUri: string;
}

export interface ConnectorSearchHit {
  toolkit: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

export interface ConnectorSearchResult {
  tools: ConnectorSearchHit[];
  guidance: string[];
  notConnected: string[];
}

/** The slice of a Composio session this module uses. Tests stub it. */
export interface ComposioSessionLike {
  sessionId: string;
  authorize(
    toolkit: string,
    options?: { callbackUrl?: string },
  ): Promise<{ id: string; redirectUrl?: string | null }>;
  toolkits(options?: {
    search?: string;
    limit?: number;
    cursor?: string;
    isConnected?: boolean;
    toolkits?: string[];
  }): Promise<{
    items: Array<{
      slug: string;
      name: string;
      isNoAuth: boolean;
      logo?: string | undefined;
      connection?: {
        isActive: boolean;
        connectedAccount?: { status: string; id: string } | undefined;
      } | undefined;
    }>;
    cursor: string | undefined;
  }>;
  search(params: { query: string; toolkits?: string[] }): Promise<unknown>;
  execute(toolSlug: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ComposioLike {
  sessions: {
    create(userId: string, config: Record<string, unknown>): Promise<ComposioSessionLike>;
    use(id: string): Promise<ComposioSessionLike>;
  };
  connectedAccounts: {
    list(query: { userIds: string[]; limit?: number; cursor?: string }): Promise<{
      items: Array<{ id: string; toolkit?: { slug: string } }>;
      nextCursor?: string | null | undefined;
    }>;
    delete(id: string): Promise<unknown>;
  };
  toolkits: {
    get(slug: string): Promise<{
      slug: string;
      composioManagedAuthSchemes?: string[] | undefined;
      authConfigDetails?: Array<{
        mode: string;
        fields?: {
          authConfigCreation?: {
            required?: Array<{ name: string; displayName?: string; description?: string }> | undefined;
          } | undefined;
        } | undefined;
      }> | undefined;
    }>;
  };
  authConfigs: {
    list(query: { toolkit?: string; limit?: number }): Promise<{
      items: Array<{ id: string; name: string; isComposioManaged?: boolean | undefined }>;
    }>;
    create(
      toolkit: string,
      options: {
        type: "use_custom_auth";
        authScheme: string;
        name: string;
        isEnabledForToolRouter: boolean;
        credentials: Record<string, string>;
      },
    ): Promise<{ id: string }>;
    delete(id: string): Promise<unknown>;
  };
  /** The raw REST client under the SDK: the plain toolkit list carries the auth flags. */
  client: {
    toolkits: {
      list(query: { limit?: number; cursor?: string }): Promise<{
        items: Array<{
          slug: string;
          no_auth?: boolean | undefined;
          auth_schemes?: string[] | undefined;
          composio_managed_auth_schemes?: string[] | undefined;
        }>;
        next_cursor?: string | null | undefined;
      }>;
    };
  };
  tools: {
    getRawComposioTools(params: { toolkits?: string[]; search?: string; limit?: number }): Promise<
      Array<{
        slug: string;
        description?: string;
        inputParameters?: Record<string, unknown>;
        toolkit?: { slug: string };
      }>
    >;
  };
}

/** One page of the catalogue for the dialog. */
export interface ConnectorPage {
  rows: ConnectorToolkit[];
  total: number;
  nextOffset: number | null;
}

export type ComposioFactory = (apiKey: string) => ComposioLike;

const DEFAULT_FACTORY: ComposioFactory = (apiKey) =>
  new Composio({ apiKey, allowTracking: false }) as unknown as ComposioLike;

let factory: ComposioFactory = DEFAULT_FACTORY;
let cached: { apiKey: string; sessionId: string; session: ComposioSessionLike } | null = null;

/** Tests swap the SDK for a stub. Passing nothing restores the real one. */
export function setComposioFactory(next: ComposioFactory | null): void {
  factory = next ?? DEFAULT_FACTORY;
  cached = null;
}

/** Composio refuses a page larger than this. */
const PAGE_MAX = 50;
/** Composio refuses a search shorter than this; shorter ones filter locally. */
const SEARCH_MIN = 3;

/**
 * What the dialog shows before any search: the apps most people reach for,
 * in this order, after whatever is already connected. Everything else follows
 * alphabetically from the catalogue, and search covers the rest.
 */
export const FEATURED_TOOLKITS = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googlesheets",
  "googledocs",
  "slack",
  "notion",
  "github",
  "linear",
  "outlook",
  "microsoft_teams",
  "whatsapp",
  "telegram",
  "discord",
  "hubspot",
  "salesforce",
  "jira",
  "confluence",
  "asana",
  "trello",
  "clickup",
  "todoist",
  "airtable",
  "calendly",
  "zoom",
  "stripe",
  "shopify",
  "dropbox",
  "figma",
  "canva",
  "linkedin",
  "twitter",
  "youtube",
  "reddit",
  "mailchimp",
  "zendesk",
  "intercom",
  "apollo",
  "spotify",
];

export const SESSION_CONFIG = {
  manageConnections: { enable: false },
  sandbox: { enable: false },
} as const;

/**
 * Where Composio's hosted sign-in sends the provider back when the owner's
 * own OAuth app is in use. The owner registers it in the provider's developer
 * portal; it is fixed by Composio, not by this app.
 */
export const OWN_APP_REDIRECT_URI = "https://backend.composio.dev/api/v3/toolkits/auth/callback";

/** The name this app gives the auth configs it creates, so it can find them again. */
const OWN_APP_CONFIG_NAME = "Useful Bot";

/**
 * The connected toolkit a tool slug belongs to, or null. Toolkit slugs can
 * carry underscores (microsoft_teams), so the match is longest-first and on a
 * whole segment: GMAIL_SEND_EMAIL -> gmail, MICROSOFT_TEAMS_SEND -> microsoft_teams,
 * and a slug that merely starts with the letters of a toolkit matches nothing.
 */
export function toolkitOf(toolSlug: string, known: readonly string[]): string | null {
  const slug = toolSlug.trim().toLowerCase();
  for (const toolkit of [...known].sort((a, b) => b.length - a.length)) {
    if (slug === toolkit || slug.startsWith(`${toolkit}_`)) return toolkit;
  }
  return null;
}

/**
 * The app a tool slug belongs to, for an error that has to name one. The
 * cached catalogue is asked first because it holds every toolkit Composio
 * has, multi-word slugs included; the featured list covers a machine with no
 * cache yet. Only when neither knows the app does this fall back to dropping
 * the slug's last word, which is right for `ASANA_CREATE_TASK` and wrong for
 * every toolkit whose own name has more than one: `ZOHO_MAIL_SEND_EMAIL`
 * named `zoho_mail_send`, an app that does not exist, and the model then
 * asked the owner to connect it.
 */
export function toolkitHint(toolSlug: string, path = cataloguePath()): string {
  const known = catalogueSlugs(path);
  const match = (known ? toolkitOf(toolSlug, known) : null) ?? toolkitOf(toolSlug, FEATURED_TOOLKITS);
  if (match) return match;
  return toolSlug.toLowerCase().split("_").slice(0, -1).join("_") || "unknown";
}

/**
 * Composio's own error record, wherever the SDK put it. A refused request
 * carries `{ error: { code, slug, message } }` under `error`; older paths
 * put the same record one level up.
 */
function composioError(err: unknown): { code?: unknown; slug?: unknown } | null {
  const rec = err as { error?: { error?: unknown } | null } | null;
  if (!rec || typeof rec !== "object" || !rec.error || typeof rec.error !== "object") return null;
  const inner = (rec.error as { error?: unknown }).error;
  const body = inner && typeof inner === "object" ? inner : rec.error;
  return body as { code?: unknown; slug?: unknown };
}

/**
 * Composio has no OAuth app of its own for this toolkit and the project has
 * no usable auth config: the owner has to bring their own developer app.
 */
export function isNoManagedAuth(err: unknown): boolean {
  const body = composioError(err);
  return Boolean(body && (body.code === 4308 || body.slug === "ToolRouterV2_NoManagedAuth"));
}

/** Composio refused the credentials an auth config was created with. */
export function isAuthConfigRejected(err: unknown): boolean {
  const body = composioError(err);
  return Boolean(body && body.slug === "Auth_Config_ValidationError");
}

/** Composio answered 401: the stored key is not one it knows. */
export function isKeyRejected(err: unknown): boolean {
  const rec = err as { statusCode?: unknown; status?: unknown } | null;
  return Boolean(rec && typeof rec === "object" && (rec.statusCode === 401 || rec.status === 401));
}

function requireKey(store: ConnectorsStore): string {
  if (!store.apiKey) throw new Error("connectors_no_key");
  return store.apiKey;
}

/** A session Composio does not know any more: deleted, expired, or never ours. */
export function isSessionGone(err: unknown): boolean {
  const rec = err as { statusCode?: unknown; status?: unknown; code?: unknown } | null;
  if (!rec || typeof rec !== "object") return false;
  return rec.statusCode === 404 || rec.statusCode === 410 || rec.status === 404 || rec.status === 410 ||
    rec.code === "NOT_FOUND";
}

async function createSession(client: ComposioLike, store: ConnectorsStore, path: string): Promise<ComposioSessionLike> {
  const session = await client.sessions.create(store.userId, { ...SESSION_CONFIG });
  updateConnectorsStore((scratch) => {
    // Only pin the id if the key is still the one it was created under.
    if (scratch.apiKey === store.apiKey) scratch.sessionId = session.sessionId;
  }, path);
  return session;
}

/** The store's session, resumed or created. */
export async function connectorsSession(path = connectorsPath()): Promise<ComposioSessionLike> {
  const store = readConnectorsStore(path);
  const apiKey = requireKey(store);
  if (cached && cached.apiKey === apiKey && cached.sessionId === store.sessionId) return cached.session;
  const client = factory(apiKey);
  let session: ComposioSessionLike;
  if (store.sessionId) {
    try {
      session = await client.sessions.use(store.sessionId);
    } catch (err) {
      if (!isSessionGone(err)) throw err;
      session = await createSession(client, store, path);
    }
  } else {
    session = await createSession(client, store, path);
  }
  cached = { apiKey, sessionId: session.sessionId, session };
  return session;
}

/**
 * Runs one operation on the session. A session that died after it was cached
 * (Composio expired it, the owner deleted it in the dashboard) is dropped and
 * recreated once, then the operation is retried on the new one.
 */
async function withSession<T>(
  path: string,
  op: (session: ComposioSessionLike) => Promise<T>,
  retry = true,
): Promise<T> {
  const session = await connectorsSession(path);
  try {
    return await op(session);
  } catch (err) {
    if (!isSessionGone(err)) throw err;
    cached = null;
    updateConnectorsStore((scratch) => {
      if (scratch.sessionId === session.sessionId) scratch.sessionId = null;
    }, path);
    if (!retry) throw new Error("session_expired");
    return op(await connectorsSession(path));
  }
}

type ToolkitItem = Awaited<ReturnType<ComposioSessionLike["toolkits"]>>["items"][number];

/**
 * The connected page, live but memoised for a couple of seconds: every
 * keystroke in the search box and every poll during an OAuth flow asks for
 * it, and it does not change between two keystrokes.
 */
const CONNECTED_TTL_MS = 2000;
let connectedMemo: { at: number; sessionId: string; rows: ConnectorToolkit[] } | null = null;

async function connectedRows(session: ComposioSessionLike, path: string): Promise<ConnectorToolkit[]> {
  if (connectedMemo && connectedMemo.sessionId === session.sessionId && Date.now() - connectedMemo.at < CONNECTED_TTL_MS) {
    return connectedMemo.rows;
  }
  const rows: ConnectorToolkit[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const connected = await session.toolkits({ isConnected: true, limit: PAGE_MAX, cursor });
    for (const item of connected.items) rows.push(toRow(item));
    cursor = connected.cursor;
    if (!cursor || connected.items.length === 0) break;
  }
  const connectedSlugs = rows.filter((row) => row.connected).map((row) => row.slug);
  updateConnectorsStore((store) => setConnectedToolkits(store, connectedSlugs), path);
  connectedMemo = { at: Date.now(), sessionId: session.sessionId, rows };
  return rows;
}

/** Drops the connected memo, for right after a connect or disconnect. */
export function forgetConnected(): void {
  connectedMemo = null;
}

/**
 * Catalogue page for the dialog. Order: connected apps, then the popular
 * set in its fixed order, then everything else by name. The catalogue itself
 * comes from a local cache (see composio-catalogue.ts) so paging and search
 * are instant; only the connection state is asked of Composio, and that is
 * memoised briefly. Before the cache exists, the popular set is shown and a
 * search of three characters or more is sent to Composio directly.
 *
 * MCP variants of an app (notion_mcp beside notion) are Composio's endpoints
 * for MCP clients. They list beside the plain app; on a tie the plain app
 * sorts first by name, so "Notion" comes before "Notion MCP".
 */
export async function listConnectorToolkits(
  options: { search?: string; offset?: number; limit?: number } = {},
  path = connectorsPath(),
): Promise<ConnectorPage> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = options.search?.trim().toLowerCase() || undefined;
  return withSession(path, async (session) => {
    const rows = new Map<string, ConnectorToolkit>();
    for (const row of await connectedRows(session, path)) rows.set(row.slug, row);
    const add = (items: Array<ToolkitItem & { ownApp?: boolean | undefined }>) => {
      for (const item of items) if (!rows.has(item.slug)) rows.set(item.slug, toRow(item));
    };
    const catalogue = readCatalogue(session, factory(requireKey(readConnectorsStore(path))));
    if (catalogue) {
      add(catalogue);
    } else {
      add((await session.toolkits({ toolkits: FEATURED_TOOLKITS, limit: PAGE_MAX })).items);
      if (search && search.length >= SEARCH_MIN) add((await session.toolkits({ search, limit: PAGE_MAX })).items);
    }
    const list = [...rows.values()].filter(
      (row) => !row.noAuth && (!search || score(row, search) > 0),
    );
    const rank = new Map(FEATURED_TOOLKITS.map((slug, index) => [slug, index]));
    const tier = (row: ConnectorToolkit) => (row.connected ? 0 : rank.has(row.slug) ? 1 : 2);
    list.sort((a, b) => {
      if (search) {
        const byScore = score(b, search) - score(a, search);
        if (byScore !== 0) return byScore;
      }
      return (
        tier(a) - tier(b) ||
        (tier(a) === 1 ? (rank.get(a.slug) ?? 0) - (rank.get(b.slug) ?? 0) : a.name.localeCompare(b.name))
      );
    });
    const page = list.slice(offset, offset + limit);
    return { rows: page, total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null };
  });
}

/**
 * Search relevance: a name that starts with the query beats a slug that
 * does, which beats a word inside the name, which beats any other
 * substring. Zero means no match. Connected apps get a nudge so "goog"
 * shows a connected Google app before the rest.
 */
function score(row: ConnectorToolkit, search: string): number {
  const name = row.name.toLowerCase();
  const slug = row.slug.replace(/_/g, " ");
  let base = 0;
  // The exact slug outranks everything: the agent tools and the connect pump
  // look a toolkit up by slug, underscores included.
  if (row.slug === search) base = 50;
  else if (name.startsWith(search)) base = 40;
  else if (slug.startsWith(search)) base = 35;
  else if (name.split(/\s+/).some((word) => word.startsWith(search))) base = 30;
  else if (name.includes(search) || slug.includes(search)) base = 20;
  else {
    const words = search.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every((word) => name.includes(word) || slug.includes(word))) base = 15;
  }
  if (base === 0) return 0;
  return base + (row.connected ? 5 : 0) + (FEATURED_TOOLKITS.includes(row.slug) ? 2 : 0);
}

function toRow(item: ToolkitItem & { ownApp?: boolean | undefined }): ConnectorToolkit {
  const account = item.connection?.connectedAccount;
  const connected = item.connection?.isActive === true && account?.status === "ACTIVE";
  return {
    slug: item.slug,
    name: item.name,
    logo: item.logo ?? null,
    noAuth: item.isNoAuth,
    ownApp: item.ownApp === true,
    connected,
    accountId: account?.id ?? null,
    status: account?.status ?? null,
  };
}

/**
 * Starts the hosted OAuth flow. The URL goes to the browser, never the model.
 * An app Composio has no OAuth app for is reported as `connector_needs_own_app`
 * so the dialog can ask for the owner's own credentials instead of saying
 * only that it failed.
 */
export async function authorizeConnector(
  toolkit: string,
  callbackUrl: string,
  path = connectorsPath(),
): Promise<{ redirectUrl: string; accountId: string }> {
  if (!isToolkitSlug(toolkit)) throw new Error("toolkit_invalid");
  return withSession(path, async (session) => {
    let request: Awaited<ReturnType<ComposioSessionLike["authorize"]>>;
    try {
      request = await session.authorize(toolkit, { callbackUrl });
    } catch (err) {
      if (isNoManagedAuth(err)) throw new Error("connector_needs_own_app");
      throw err;
    }
    if (!request.redirectUrl) throw new Error("authorize_no_redirect");
    forgetConnected();
    return { redirectUrl: request.redirectUrl, accountId: request.id };
  });
}

/** Field names that hold a credential and are typed hidden. */
const SECRET_FIELD = /secret|token|password|key/i;
/** Composio's own callback field; this app sets it, the owner never types it. */
const REDIRECT_FIELD = "oauth_redirect_uri";
const OWN_APP_VALUE_MAX = 4096;

/**
 * The credentials an app needs from the owner's own OAuth app, read from
 * Composio's description of the toolkit: TikTok wants a client id and
 * secret, X wants those and an application bearer token. The OAuth2 scheme
 * is preferred when the app offers more than one.
 */
export async function describeOwnApp(toolkit: string, path = connectorsPath()): Promise<OwnAppForm> {
  if (!isToolkitSlug(toolkit)) throw new Error("toolkit_invalid");
  const client = factory(requireKey(readConnectorsStore(path)));
  const info = await client.toolkits.get(toolkit);
  const details = info.authConfigDetails ?? [];
  const scheme = details.find((item) => item.mode === "OAUTH2") ?? details.find((item) => item.mode.startsWith("OAUTH"));
  if (!scheme) throw new Error("own_app_unsupported");
  const fields: OwnAppField[] = (scheme.fields?.authConfigCreation?.required ?? [])
    .filter((field) => field.name !== REDIRECT_FIELD)
    .map((field) => ({
      name: field.name,
      label: field.displayName || field.name,
      description: field.description ?? "",
      secret: SECRET_FIELD.test(`${field.name} ${field.displayName ?? ""}`),
    }));
  if (fields.length === 0) throw new Error("own_app_unsupported");
  return { toolkit, authScheme: scheme.mode, fields, redirectUri: OWN_APP_REDIRECT_URI };
}

/**
 * Registers the owner's own OAuth app with Composio and starts the sign-in.
 * The credentials go straight to Composio and are never written here. Only
 * the fields Composio asked for are accepted, every one of them, so a typo
 * in a field name cannot slip through as an extra credential. An earlier
 * config this app created for the same toolkit is replaced, so a retry after
 * a wrong secret does not leave Composio choosing between two.
 */
export async function connectOwnApp(
  toolkit: string,
  credentials: Record<string, unknown>,
  callbackUrl: string,
  path = connectorsPath(),
): Promise<{ redirectUrl: string; accountId: string }> {
  const form = await describeOwnApp(toolkit, path);
  const wanted = new Set(form.fields.map((field) => field.name));
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (!wanted.has(name)) throw new Error("own_app_fields");
    if (typeof value !== "string" || !value.trim() || value.length > OWN_APP_VALUE_MAX) throw new Error("own_app_fields");
    clean[name] = value.trim();
  }
  for (const name of wanted) if (!(name in clean)) throw new Error("own_app_fields");
  if (form.authScheme.startsWith("OAUTH")) clean[REDIRECT_FIELD] = OWN_APP_REDIRECT_URI;
  const client = factory(requireKey(readConnectorsStore(path)));
  const existing = await client.authConfigs.list({ toolkit, limit: 50 });
  for (const item of existing.items) {
    if (item.isComposioManaged !== true && item.name === OWN_APP_CONFIG_NAME) await client.authConfigs.delete(item.id);
  }
  try {
    // Tool Router sessions only see a config flagged for them; without the
    // flag Composio still answers "no managed auth" after the config exists.
    await client.authConfigs.create(toolkit, {
      type: "use_custom_auth",
      authScheme: form.authScheme,
      name: OWN_APP_CONFIG_NAME,
      isEnabledForToolRouter: true,
      credentials: clean,
    });
  } catch (err) {
    if (isAuthConfigRejected(err)) throw new Error("own_app_rejected");
    throw err;
  }
  return authorizeConnector(toolkit, callbackUrl, path);
}

/**
 * Revokes one connected account. Ownership is proven by listing this store's
 * user's accounts and finding the id there; an id that is not in that list
 * is refused, whatever Composio would say about it.
 */
/**
 * Pages to walk looking for the account being disconnected. Ownership is
 * proved by finding the id under this store's user, so a single page made an
 * owner with more than one page of accounts unable to disconnect anything
 * past it: the lookup missed and the call refused as `account_foreign`. The
 * ceiling is here so a paging bug cannot loop forever; at a hundred a page it
 * is four thousand accounts, well past anything an owner has.
 */
const ACCOUNT_PAGE = 100;
const ACCOUNT_PAGE_MAX = 40;

export async function disconnectConnector(accountId: string, path = connectorsPath()): Promise<void> {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(accountId)) throw new Error("account_invalid");
  const store = readConnectorsStore(path);
  const client = factory(requireKey(store));
  let account: { id: string; toolkit?: { slug: string } } | undefined;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < ACCOUNT_PAGE_MAX; page++) {
    const mine = await client.connectedAccounts.list({
      userIds: [store.userId],
      limit: ACCOUNT_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    account = mine.items.find((item) => item.id === accountId);
    if (account) break;
    const next = mine.nextCursor;
    // A server that keeps handing back the same cursor would page forever.
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  if (!account) throw new Error("account_foreign");
  await client.connectedAccounts.delete(accountId);
  cached = null;
  forgetConnected();
  const slug = account.toolkit?.slug;
  if (slug) {
    updateConnectorsStore((scratch) => {
      setConnectedToolkits(scratch, scratch.connectedToolkits.filter((item) => item !== slug));
    }, path);
  }
}

/**
 * Tools for a use case in the connected apps, trimmed for the model. Two
 * sources merged: Composio's semantic search, which ranks well but ignores
 * the toolkit filter and maps an MCP variant to its plain app, and a direct
 * listing of the connected toolkits' own tools, which is exact. Only tools
 * of connected toolkits are returned.
 */
export async function searchConnectorTools(
  useCase: string,
  path = connectorsPath(),
): Promise<ConnectorSearchResult> {
  const store = readConnectorsStore(path);
  if (store.connectedToolkits.length === 0) throw new Error("no_connectors");
  const allowed = new Set(store.connectedToolkits);
  const client = factory(requireKey(store));
  const [raw, direct] = await Promise.all([
    withSession(path, (session) => session.search({ query: useCase, toolkits: store.connectedToolkits })) as Promise<{
      results?: Array<{ primaryToolSlugs?: string[]; relatedToolSlugs?: string[]; executionGuidance?: string; knownPitfalls?: string[] }>;
      toolSchemas?: Record<string, { toolkit: string; toolSlug: string; description?: string; inputSchema?: Record<string, unknown> }>;
      toolkitConnectionStatuses?: Array<{ toolkit: string; hasActiveConnection: boolean }>;
    }>,
    client.tools.getRawComposioTools({ toolkits: store.connectedToolkits, search: useCase, limit: 15 }).catch(() => null),
  ]);
  const wanted = new Set<string>();
  const guidance: string[] = [];
  for (const result of raw.results ?? []) {
    for (const slug of result.primaryToolSlugs ?? []) wanted.add(slug);
    for (const slug of result.relatedToolSlugs ?? []) wanted.add(slug);
    if (result.executionGuidance) guidance.push(result.executionGuidance);
    for (const pitfall of result.knownPitfalls ?? []) guidance.push(pitfall);
  }
  const tools = new Map<string, ConnectorSearchHit>();
  for (const [slug, schema] of Object.entries(raw.toolSchemas ?? {})) {
    if (!wanted.has(slug) && wanted.size > 0) continue;
    const toolkit = schema.toolkit.toLowerCase();
    if (!allowed.has(toolkit)) continue;
    tools.set(schema.toolSlug, {
      toolkit,
      tool: schema.toolSlug,
      description: schema.description ?? "",
      inputSchema: schema.inputSchema ?? null,
    });
  }
  // A failed direct listing is said out loud rather than passed off as a
  // complete answer: the model then knows a missing tool may still exist.
  if (direct === null) guidance.push("The direct tool listing failed, so this list may be incomplete. Search again if a tool you expect is missing.");
  for (const tool of direct ?? []) {
    const toolkit = tool.toolkit?.slug.toLowerCase() ?? toolkitOf(tool.slug, store.connectedToolkits) ?? "";
    if (!allowed.has(toolkit) || tools.has(tool.slug)) continue;
    tools.set(tool.slug, {
      toolkit,
      tool: tool.slug,
      description: tool.description ?? "",
      inputSchema: tool.inputParameters ?? null,
    });
  }
  // A plain app reported unconnected while its MCP variant is connected is
  // not a missing connection; the variant's tools are in the list above.
  const notConnected = (raw.toolkitConnectionStatuses ?? [])
    .filter((item) => !item.hasActiveConnection)
    .map((item) => item.toolkit.toLowerCase())
    .filter((toolkit) => !allowed.has(toolkit) && !allowed.has(`${toolkit}_mcp`));
  return { tools: [...tools.values()], guidance: guidance.slice(0, 8), notConnected };
}

/**
 * How many tools one toolkit publishes, for the connect card. Best effort:
 * any failure is null, never a thrown error, because the count decorates a
 * card that is already connected.
 */
export async function countToolkitTools(slug: string, path = connectorsPath()): Promise<number | null> {
  if (!isToolkitSlug(slug)) return null;
  try {
    const client = factory(requireKey(readConnectorsStore(path)));
    const tools = await client.tools.getRawComposioTools({ toolkits: [slug], limit: 200 });
    if (!Array.isArray(tools)) return null;
    return tools.filter((tool) => (tool.toolkit?.slug ?? toolkitOf(tool.slug, [slug]) ?? "").toLowerCase() === slug).length;
  } catch {
    return null;
  }
}

const TOOL_LIST_TTL_MS = 60_000;
const toolListCache = new Map<string, { at: number; tools: Array<{ name: string; description: string }> }>();

/** Tests start from an empty tool-list cache. */
export function forgetToolLists(): void {
  toolListCache.clear();
}

/**
 * The tools one connected toolkit publishes, for the Connectors detail view.
 * A toolkit that isn't connected is refused. Cached for a minute per toolkit.
 */
export async function listToolkitTools(
  slug: string,
  path = connectorsPath(),
): Promise<Array<{ name: string; description: string }>> {
  if (!isToolkitSlug(slug)) throw new Error("toolkit_invalid");
  const store = readConnectorsStore(path);
  if (!store.connectedToolkits.includes(slug)) throw new Error("not_connected");
  const hit = toolListCache.get(slug);
  if (hit && Date.now() - hit.at < TOOL_LIST_TTL_MS) return hit.tools;
  const client = factory(requireKey(store));
  const raw = await client.tools.getRawComposioTools({ toolkits: [slug], limit: 200 });
  if (!Array.isArray(raw)) throw new Error("tools_unavailable");
  const tools = raw
    .filter((tool) => (tool.toolkit?.slug ?? toolkitOf(tool.slug, [slug]) ?? "").toLowerCase() === slug)
    .map((tool) => ({ name: tool.slug, description: (tool.description ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) }));
  toolListCache.set(slug, { at: Date.now(), tools });
  return tools;
}

/** Executes one tool. The caller has already decided the approval question. */
export async function executeConnectorTool(
  toolSlug: string,
  args: Record<string, unknown>,
  path = connectorsPath(),
): Promise<unknown> {
  const store = readConnectorsStore(path);
  if (store.connectedToolkits.length === 0) throw new Error("no_connectors");
  const toolkit = toolkitOf(toolSlug, store.connectedToolkits);
  if (!toolkit) {
    const err = new Error("not_connected") as Error & { toolkit: string };
    // The whole toolkit prefix, so MICROSOFT_TEAMS_* names microsoft_teams
    // and not microsoft.
    err.toolkit = toolkitHint(toolSlug);
    throw err;
  }
  // Never replay an execute: a write that the owner approved once must not
  // run twice on a recreated session. The caller sees session_expired and the
  // model asks again, which mints a fresh card.
  return withSession(path, (session) => session.execute(toolSlug, args), false);
}

import { rmSync } from "node:fs";
import { parseBundle, refreshLockPath, withRefreshLock } from "./connection-auth.ts";
import { cancelDiscovery, discoverConnection, discoveryRunning, settleAllDiscoveries } from "./connection-tools.ts";
import { connectionIcon, removeConnectionIcon, settleIcons, startDueIcons } from "./connection-icons.ts";
import { reauthorizeProposalId } from "./connection-flow.ts";
import {
  connectionIndex,
  connectionStatus,
  listingIsDue,
  removeConnectionIndex,
  type ConnectionState,
} from "./connection-tools-store.ts";
import {
  EXCALIDRAW_CONNECTION,
  findConnectionById,
  readConnectionsStore,
  removeConnection,
  type ConnectionAuthKind,
  type ConnectionEntry,
  type ConnectionKind,
} from "./connections-store.ts";
import { connectionSecretService, keychainDel, keychainGet } from "./keychain.ts";
import { dropOauthPendingForProposal, startMcpOAuth } from "./mcp-oauth.ts";

/**
 * What the Connectors page can do with a direct (MCP or OpenAPI) connection:
 * read it, list it again, sign it in again, remove it. The route is a thin
 * layer over these so they can be exercised without a signed-in session.
 * Nothing here returns a token, a header or the Keychain item.
 */

export type PublicConnection = {
  id: string;
  name: string;
  url: string;
  kind: ConnectionKind;
  authKind: ConnectionAuthKind;
  /** Seeded with the app. It cannot be removed. */
  builtin: boolean;
  state: ConnectionState;
  lastError: { code: string; message: string } | null;
  checkedAt: string | null;
  toolCount: number | null;
  tools: Array<{ name: string; description: string }>;
  /** A data: URI found once for the server's site, or null. */
  icon: string | null;
};

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/** The URL as the list shows it: a key or a token in the query, or a fragment, is not the owner's to see again. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function publicConnection(entry: ConnectionEntry): PublicConnection {
  const status = connectionStatus(entry.id);
  const index = connectionIndex(entry.id);
  // A row from before status was kept is described by what its listing holds.
  const state: ConnectionState = status?.state
    ?? (index ? (index.failed ? "discovery_failed" : index.tools.length > 0 ? "ready" : "zero_tools") : "pending");
  return {
    id: entry.id,
    name: entry.name,
    url: displayUrl(entry.url),
    kind: entry.kind,
    authKind: entry.authKind,
    builtin: entry.id === EXCALIDRAW_CONNECTION.id,
    state,
    lastError: status?.lastError ?? null,
    checkedAt: status?.checkedAt ?? index?.fetchedAt ?? null,
    toolCount: status?.toolCount ?? (index && !index.failed ? index.tools.length : null),
    tools: (index?.tools ?? []).map((tool) => ({ name: tool.name, description: oneLine(tool.description, 200) })),
    icon: connectionIcon(entry.id),
  };
}

export function listPublicConnections(): PublicConnection[] {
  return readConnectionsStore().connections.map(publicConnection);
}

/**
 * Start discovery in the background for every row whose listing is missing or
 * due, one run per id at a time (`discoverConnection` shares a running one).
 * Never awaited by the caller: a slow server must not hold the list. The row
 * shows as checking until the run lands.
 */
export function startDueDiscoveries(): void {
  for (const entry of readConnectionsStore().connections) {
    if (discoveryRunning(entry.id)) continue;
    if (!listingIsDue(connectionIndex(entry.id), connectionStatus(entry.id), Date.now(), entry.id)) continue;
    discoverConnection(entry)
      .catch((err) => console.error(`[connections] discovery for ${entry.id} failed: ${err instanceof Error ? err.message : "unknown"}`));
  }
}

/** Look up, in the background, the icon of every connection that has none yet. */
export function startDueIconLookups(): void {
  startDueIcons(readConnectionsStore().connections);
}

/** Resolves when every discovery and icon lookup now running has finished. */
export async function settleDiscoveries(): Promise<void> {
  await settleAllDiscoveries();
  await settleIcons();
}

export async function refreshConnection(id: string): Promise<PublicConnection> {
  const entry = findConnectionById(id);
  if (!entry) throw new Error("connection_missing");
  // Reads the credential itself; one it cannot find comes back in the status.
  await discoverConnection(entry);
  return publicConnection(entry);
}

/**
 * Start the sign-in again for a connection that is already registered. The
 * pending state is keyed to the connection, not to a card, and the callback
 * route stores the new tokens under the same id.
 */
export async function reauthorizeConnection(
  id: string,
  callbackUrl: string,
): Promise<{ authorizeUrl: string; redirectHost: string }> {
  const entry = findConnectionById(id);
  if (!entry) throw new Error("connection_missing");
  if (entry.kind !== "mcp" || entry.authKind !== "oauth") throw new Error("not_oauth");
  // The credential this connection already holds says which sign-in server it
  // trusts; a server that now points somewhere else is not followed.
  const bundle = parseBundle(keychainGet(connectionSecretService(entry.id)));
  if (!bundle || typeof bundle.tokenEndpoint !== "string" || bundle.tokenEndpoint === "") {
    throw new Error("credential_missing");
  }
  const { authorizeUrl, redirectHost } = await startMcpOAuth({
    reauthorize: true,
    expectedTokenEndpoint: bundle.tokenEndpoint,
    expectedPin: bundle.pin,
    mcpUrl: entry.url,
    name: entry.name,
    proposalId: reauthorizeProposalId(entry.id),
    connectionId: entry.id,
    redirectUri: callbackUrl,
  });
  return { authorizeUrl, redirectHost };
}

/**
 * Remove the row, its Keychain item, its listing, its status and any sign-in
 * still open for it.
 */
export async function deleteConnection(id: string): Promise<void> {
  if (id === EXCALIDRAW_CONNECTION.id) throw new Error("connection_builtin");
  if (!findConnectionById(id)) throw new Error("connection_missing");
  // A discovery still out would write its answer for a connection that is no
  // longer there. Stopped and waited for first.
  while (discoveryRunning(id)) await cancelDiscovery(id);
  // Under the refresh lock: a refresh that is out (here or in another
  // process) would otherwise store its bundle after the secret was deleted.
  // The credential first: if this throws the row is still there to retry
  // against, where a row removed first would leave the secret with no way to
  // find it again. Deleting an item that was never stored is not an error.
  await withRefreshLock(id, () => {
    keychainDel(connectionSecretService(id));
    removeConnection(id);
  });
  // The lock's own file is the connection's alone, and has no use now.
  const lockFile = `${refreshLockPath(id)}.sqlite`;
  for (const file of [lockFile, `${lockFile}-journal`]) rmSync(file, { force: true });
  removeConnectionIndex(id);
  removeConnectionIcon(id);
  dropOauthPendingForProposal(reauthorizeProposalId(id));
}

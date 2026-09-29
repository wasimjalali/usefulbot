import {
  defineDynamic,
  defineMcpClientConnection,
  defineOpenAPIConnection,
} from "eve/connections";
import { isAuthHeaderName, type ConnectionEntry } from "../../shared/connections-store.ts";
import { bearerFromKeychain, oauthToken } from "../../shared/connection-auth.ts";
import { eagerConnections, ensureMeasured, isEagerConnection } from "../../shared/connection-tools.ts";
import { readConnectionsStore } from "../../shared/connections-store.ts";

function definitionFor(entry: ConnectionEntry) {
  const tools = entry.toolsAllow ? { allow: entry.toolsAllow } : undefined;
  if (entry.kind === "openapi") {
    if (entry.authKind === "none") {
      return defineOpenAPIConnection({ spec: entry.url, description: entry.description });
    }
    if (entry.authKind === "apiKey") {
      const header = isAuthHeaderName(entry.authHeader) ? entry.authHeader : "X-Api-Key";
      return defineOpenAPIConnection({
        spec: entry.url,
        description: entry.description,
        headers: { [header]: async () => (await bearerFromKeychain(entry.id)).token },
      });
    }
    if (entry.authKind === "oauth") {
      return defineOpenAPIConnection({
        spec: entry.url,
        description: entry.description,
        instanceKey: entry.id,
        auth: { getToken: () => oauthToken(entry) },
      });
    }
    return defineOpenAPIConnection({
      spec: entry.url,
      description: entry.description,
      instanceKey: entry.id,
      auth: { getToken: () => bearerFromKeychain(entry.id) },
    });
  }
  if (entry.authKind === "none") {
    return defineMcpClientConnection({
      url: entry.url,
      description: entry.description,
      tools,
    });
  }
  if (entry.authKind === "apiKey") {
    const header = isAuthHeaderName(entry.authHeader) ? entry.authHeader : "X-Api-Key";
    return defineMcpClientConnection({
      url: entry.url,
      description: entry.description,
      instanceKey: entry.id,
      headers: { [header]: async () => (await bearerFromKeychain(entry.id)).token },
      tools,
    });
  }
  if (entry.authKind === "oauth") {
    return defineMcpClientConnection({
      url: entry.url,
      description: entry.description,
      instanceKey: entry.id,
      auth: { getToken: () => oauthToken(entry) },
      tools,
    });
  }
  return defineMcpClientConnection({
    url: entry.url,
    description: entry.description,
    instanceKey: entry.id,
    auth: { getToken: () => bearerFromKeychain(entry.id) },
    tools,
  });
}

/**
 * Only OpenAPI connections are mounted for every turn: eve owns spec parsing
 * and there is no other way to reach one. Every MCP server waits to be asked,
 * through `find_tools` in `agent/tools/connection_tools.ts`, which mounts what
 * it hands over under the same `<connectionId>__<toolName>` names this would
 * have used.
 */
export default defineDynamic({
  events: {
    "turn.started": async () => {
      // A row nobody has measured is not mounted, so this is what keeps one
      // that predates the count from staying off for good: count it once,
      // write it down, and it is mountable from here on.
      await ensureMeasured(readConnectionsStore().connections.filter(isEagerConnection));
      const entries = eagerConnections();
      if (entries.length === 0) return null;
      return Object.fromEntries(entries.map((entry) => [entry.id, definitionFor(entry)]));
    },
  },
});

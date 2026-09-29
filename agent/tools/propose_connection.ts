import { defineTool } from "eve/tools";
import { z } from "zod";
import { activeBotId } from "../lib/active-bot.ts";
import {
  appendAgentEvent,
  createProposal,
  listPendingProposals,
  releaseSend,
  reserveSend,
  threadIdFor,
} from "../../shared/agent-store.ts";
import { assertConnectionUrl, connectionHost, ConnectionUrlError } from "../../shared/connection-url.ts";
import {
  allocateConnectionId,
  findConnectionByUrl,
  type ConnectionAuthKind,
  type ConnectionKind,
} from "../../shared/connections-store.ts";
import { readShell } from "../../shared/shell-io.ts";

const AUTH = z.enum(["none", "apiKey", "bearer", "oauth"]);
const KIND = z.enum(["mcp", "openapi"]);

/**
 * Ask the owner to connect an MCP or OpenAPI server that is not in the
 * Composio catalogue. Writes a connectServer card. The tool never starts
 * OAuth and never sees a secret.
 */
export default defineTool({
  description:
    "Ask the owner to connect an MCP server or OpenAPI document that is not in the Composio catalogue. Shows a card. Propose one server per turn, then end your turn. Prefer propose_connector when the app is in the catalogue.",
  inputSchema: z.object({
    kind: KIND,
    url: z.string().min(8).max(2048),
    name: z.string().min(1).max(80),
    description: z.string().min(3).max(400),
    authKind: AUTH,
    authHeader: z.string().min(1).max(64).optional(),
    purpose: z.string().min(3).max(120),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    let url: string;
    try {
      url = assertConnectionUrl(input.url);
    } catch (err) {
      const code = err instanceof ConnectionUrlError ? err.message : "url_invalid";
      return { status: "invalid_url", error: code };
    }
    const name = input.name.trim();
    const description = input.description.trim();
    const purpose = input.purpose.trim();
    if (name.length < 1) return { status: "invalid_name" };
    if (description.length < 3) return { status: "invalid_description" };
    if (purpose.length < 3) return { status: "invalid_purpose", error: "purpose must say what you will do there" };
    const authKind = input.authKind as ConnectionAuthKind;
    const kind = input.kind as ConnectionKind;
    let authHeader: string | null = null;
    if (authKind === "apiKey") {
      const header = (input.authHeader ?? "X-Api-Key").trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) return { status: "invalid_header" };
      authHeader = header;
    }
    const existing = findConnectionByUrl(url);
    if (existing) return { status: "already_connected", id: existing.id, name: existing.name };

    const shell = readShell();
    const botId = activeBotId(shell, ctx);
    const threadId = threadIdFor(botId);
    const open = listPendingProposals(threadId).find(
      (item) => item.kind === "connectServer" && (item.phase === "proposed" || item.phase === "waiting"),
    );
    if (open && open.kind === "connectServer") {
      return { status: "duplicate", openId: open.connectionId, openName: open.name };
    }

    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    try {
      const connectionId = allocateConnectionId(name);
      const proposal = createProposal({
        kind: "connectServer",
        connectionKind: kind,
        connectionId,
        name,
        description,
        url,
        urlHost: connectionHost(url),
        purpose,
        authKind,
        authHeader,
        sourceBotId: botId,
        threadId,
        phase: "proposed",
        redirectHost: null,
        waitingSince: null,
        toolCount: null,
        handoffId: null,
      });
      const bot = shell.bots.find((item) => item.id === botId);
      appendAgentEvent(threadId, {
        kind: "proposal",
        text: `Asked to connect ${name}`,
        proposalId: proposal.id,
        authorBotId: botId,
        authorName: bot?.name ?? null,
      });
      return { status: "awaiting_owner_confirmation", proposalId: proposal.id, id: connectionId, name };
    } catch (err) {
      if (requestId) releaseSend("proposal", requestId);
      throw err;
    }
  },
});

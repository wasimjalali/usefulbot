import { defineTool } from "../lib/tool.ts";
import { z } from "zod";
import { createProposal, listPendingProposals, threadIdFor } from "../../shared/agent-store.ts";
import { assertConnectionUrl, connectionHost, ConnectionUrlError } from "../../shared/connection-url.ts";
import { allocateConnectionId, findConnectionByUrl } from "../../shared/connections-store.ts";
import { hasLineBreak } from "../../shared/untrusted.ts";

/**
 * Ask the owner to connect an MCP server that is not in the Composio
 * catalogue. Writes a connectServer card the owner authorizes in the chat.
 * The tool never starts OAuth and never sees a secret.
 */
export default defineTool({
  name: "connect_server",
  description:
    "Ask the owner to connect an MCP server outside the app catalogue; shows a Connect server card. Use only a URL the owner gave or an official source documents, never a placeholder; ask for it when missing. One server per turn, then end the turn. Prefer apps connect for catalogue apps. Afterwards find_tools reaches its tools.",
  inputSchema: z.object({
    url: z.string().min(8).max(2048).describe("The server's https URL."),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(3).max(400).optional(),
    auth: z.enum(["none", "oauth", "apiKey", "bearer"]).optional().describe("How it signs in; oauth when unsure."),
  }),
  sequential: true,
  async execute(input, ctx) {
    let url: string;
    try {
      url = assertConnectionUrl(input.url);
    } catch (err) {
      const code = err instanceof ConnectionUrlError ? err.message : "url_invalid";
      return { status: "invalid_url", error: code };
    }
    const host = connectionHost(url);
    const name = (input.name ?? host).trim();
    const description = (input.description ?? `${name} MCP server`).trim();
    if (name.length < 1 || hasLineBreak(name)) return { status: "invalid_name" };
    if (description.length < 3) return { status: "invalid_description" };
    const existing = findConnectionByUrl(url);
    if (existing) return { status: "already_connected", id: existing.id, name: existing.name };

    const threadId = threadIdFor(ctx.botId);
    const open = listPendingProposals(threadId).find(
      (item) => item.kind === "connectServer" && (item.phase === "proposed" || item.phase === "waiting"),
    );
    if (open && open.kind === "connectServer") {
      return { status: "duplicate", openId: open.connectionId, openName: open.name };
    }
    const connectionId = allocateConnectionId(name);
    const proposal = createProposal({
      kind: "connectServer",
      connectionKind: "mcp",
      connectionId,
      name,
      description,
      url,
      urlHost: host,
      purpose: `Use ${name}'s tools`,
      authKind: input.auth ?? "oauth",
      authHeader: null,
      sourceBotId: ctx.botId,
      threadId,
      phase: "proposed",
      redirectHost: null,
      waitingSince: null,
      toolCount: null,
      handoffId: null,
    });
    await ctx.appendRow({ key: `card:${proposal.id}`, kind: "card", proposalId: proposal.id });
    return { status: "awaiting_owner_confirmation", proposalId: proposal.id, id: connectionId, name };
  },
});

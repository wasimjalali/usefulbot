import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf, SUB_AGENT_BLOCKED } from "../lib/permission.ts";
import { isSubAgent } from "../lib/active-bot.ts";
import {
  appendAgentEvent,
  createProposal,
  listPendingProposals,
  releaseSend,
  reserveSend,
  threadIdFor,
} from "../../shared/agent-store.ts";
import { listConnectorToolkits } from "../../shared/composio.ts";
import { isToolkitSlug, readConnectorsStore } from "../../shared/connectors-store.ts";
import { readShell } from "../../shared/shell-io.ts";

/**
 * Ask the owner to connect one app. Writes a connectApp card the owner
 * authorizes in the chat; when Composio reports the account active, the
 * server hands this bot a turn to continue. The tool never starts OAuth and
 * never sees a URL or a key.
 */
export default defineTool({
  description:
    "Ask the owner to connect a catalogue app; shows an Authorize card. Call connector_catalog first. One app per turn, then end your turn with one line, and never propose a different app instead.",
  inputSchema: z.object({
    slug: z.string().min(1).max(80),
    purpose: z.string().min(3).max(120),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    if (isSubAgent(ctx)) return SUB_AGENT_BLOCKED;
    const store = readConnectorsStore();
    if (!store.apiKey) return { status: "blocked", error: "connectors_not_set_up" };
    const slug = input.slug.trim().toLowerCase();
    if (!isToolkitSlug(slug)) return { status: "unknown_app", slug };
    // Validate what is stored, not the raw input: the resume turn quotes it.
    const purpose = input.purpose.trim();
    if (purpose.length < 3) return { status: "invalid_purpose", error: "purpose must say what you will do there" };
    let row;
    try {
      const page = await listConnectorToolkits({ search: slug, limit: 20 });
      row = page.rows.find((item) => item.slug === slug);
    } catch (err) {
      return { status: "error", error: String((err as Error).message ?? "failed").slice(0, 200) };
    }
    if (!row) return { status: "unknown_app", slug };
    if (row.connected) return { status: "already_connected", slug, name: row.name };

    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const botId = who.caller.id;
    const threadId = threadIdFor(botId);
    // One open connect card per bot: the instructions say one app per turn,
    // and this is what makes a second proposal in the same turn a no-op
    // instead of a stack of cards for the owner to clear.
    const open = listPendingProposals(threadId).find(
      (item) => item.kind === "connectApp" && (item.phase === "proposed" || item.phase === "waiting"),
    );
    if (open && open.kind === "connectApp") {
      return { status: "duplicate", slug, name: row.name, openSlug: open.slug, openName: open.name };
    }

    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    try {
      const proposal = createProposal({
        kind: "connectApp",
        slug,
        name: row.name,
        logo: row.logo,
        purpose,
        sourceBotId: botId,
        threadId,
        phase: "proposed",
        accountId: null,
        waitingSince: null,
        toolCount: null,
        handoffId: null,
      });
      const bot = shell.bots.find((item) => item.id === botId);
      appendAgentEvent(threadId, {
        kind: "proposal",
        text: `Asked to connect ${row.name}`,
        proposalId: proposal.id,
        authorBotId: botId,
        authorName: bot?.name ?? null,
      });
      return { status: "awaiting_owner_confirmation", proposalId: proposal.id, slug, name: row.name };
    } catch (err) {
      if (requestId) releaseSend("proposal", requestId);
      throw err;
    }
  },
});

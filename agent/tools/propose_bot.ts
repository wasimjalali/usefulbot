import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf, notAvailable, ORCHESTRATOR_ONLY_HINT } from "../lib/permission.ts";
import {
  appendAgentEvent,
  createProposal,
  nextPetname,
  releaseSend,
  reserveSend,
  threadIdFor,
} from "../../shared/agent-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { PROPOSE_DESCRIPTION_MAX } from "../../shared/shell-store.ts";

export default defineTool({
  description:
    "Propose a new teammate bot when a job needs a long-lived owner. Only the main bot can. Writes a profile card the owner must confirm; it never creates the bot itself. Name it for the job and put standing rules and boundaries in description. Confirm once with the owner before proposing several.",
  inputSchema: z.object({
    name: z.string().min(1).max(80),
    title: z.string().max(24).optional(),
    description: z.string().max(PROPOSE_DESCRIPTION_MAX).optional(),
    brief: z.string().max(1000).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    // Proposing a new bot is the orchestrator's alone.
    if (who.caller.role !== "orchestrator") return notAvailable(ORCHESTRATOR_ONLY_HINT);
    const source = who.caller.bot;
    const sourceBotId = source.id;
    const threadId = threadIdFor(sourceBotId);
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    let proposal;
    try {
      proposal = createProposal({
        kind: "createBot",
        proposerId: who.caller.id,
        name: input.name.trim(),
        petname: nextPetname(shell),
        title: (input.title ?? "").trim(),
        description: (input.description ?? "").trim(),
        sectionId: null,
        sourceBotId,
        threadId,
        brief: (input.brief ?? "").trim(),
      });
      appendAgentEvent(sourceBotId, {
        kind: "proposal",
        text: `Proposed teammate ${proposal.name}`,
        proposalId: proposal.id,
        authorBotId: sourceBotId,
        authorName: source.name,
      });
    } catch (err) {
      if (requestId) releaseSend("proposal", requestId);
      throw err;
    }
    return {
      status: "awaiting_owner_confirmation",
      proposalId: proposal.id,
      name: proposal.name,
      title: proposal.title,
      description: proposal.description,
      note: "The owner sees a profile card in this chat. Do not claim the bot exists until they confirm.",
    };
  },
});

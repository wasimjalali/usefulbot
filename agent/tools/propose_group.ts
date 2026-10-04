import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf, notAvailable, ORCHESTRATOR_ONLY_HINT, orchestratorId } from "../lib/permission.ts";
import { appendAgentEvent, createProposal, releaseSend, reserveSend } from "../../shared/agent-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { DESCRIPTION_MAX, GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS, DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { groupMembers, speakersFrom } from "../../shared/threads.ts";

export default defineTool({
  description:
    "Propose a group chat of 2 to 6 teammate bots (only the main bot can), for work that should happen in the open (a kickoff, who owns what). The owner confirms the card before the room exists. The main bot orchestrates but is never a member.",
  inputSchema: z.object({
    name: z.string().min(1).max(80),
    memberIds: z.array(z.string().min(1).max(80)).min(GROUP_MIN_MEMBERS).max(GROUP_MAX_MEMBERS),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    // Proposing a group is the orchestrator's alone.
    if (who.caller.role !== "orchestrator") return notAvailable(ORCHESTRATOR_ONLY_HINT);
    // The orchestrator answers untargeted group turns, so it is never a member.
    const orchestrator = orchestratorId(shell);
    const members = groupMembers(speakersFrom(shell.bots), input.memberIds)
      .filter((member) => member.id !== orchestrator);
    if (members.length < GROUP_MIN_MEMBERS) {
      return {
        status: "invalid",
        error: `a group needs ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS} real bots; matched ${members.length}`,
        hint: "Call list_bots for exact ids. Groups cannot contain another group.",
      };
    }
    const source = who.caller.bot;
    const sourceBotId = source.id !== DEFAULT_BOT_ID ? source.id : null;
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    let proposal;
    try {
      proposal = createProposal({
        kind: "createGroup",
        proposerId: who.caller.id,
        name: input.name.trim(),
        memberIds: members.map((member) => member.id),
        description: (input.description ?? "").trim(),
        sourceBotId,
        threadId: sourceBotId ?? who.caller.id,
      });
      appendAgentEvent(sourceBotId ?? who.caller.id, {
        kind: "proposal",
        text: `Proposed group ${proposal.name} with ${members.map((member) => member.name).join(", ")}`,
        proposalId: proposal.id,
        authorBotId: sourceBotId,
        authorName: source?.name ?? null,
        targetBotIds: proposal.memberIds,
      });
    } catch (err) {
      if (requestId) releaseSend("proposal", requestId);
      throw err;
    }
    return {
      status: "awaiting_owner_confirmation",
      proposalId: proposal.id,
      name: proposal.name,
      members: members.map((member) => ({ id: member.id, name: member.name })),
      note: "The owner confirms the card in this chat before the group is created.",
    };
  },
});

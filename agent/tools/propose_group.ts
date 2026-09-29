import { defineTool } from "eve/tools";
import { z } from "zod";
import { activeBotId } from "../lib/active-bot.ts";
import { appendAgentEvent, createProposal, releaseSend, reserveSend } from "../../shared/agent-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS, DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { groupMembers, speakersFrom } from "../../shared/threads.ts";

export default defineTool({
  description:
    "Propose a group chat with 2 to 6 teammate bots. Use it when work should happen in the open instead of in one bot's chat, for example a kickoff with who owns what. The owner confirms the card before the room exists.",
  inputSchema: z.object({
    name: z.string().min(1).max(80),
    memberIds: z.array(z.string().min(1).max(80)).min(GROUP_MIN_MEMBERS).max(GROUP_MAX_MEMBERS),
    description: z.string().max(500).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  execute(input, ctx) {
    const shell = readShell();
    const members = groupMembers(speakersFrom(shell.bots), input.memberIds);
    if (members.length < GROUP_MIN_MEMBERS) {
      return {
        status: "invalid",
        error: `a group needs ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS} real bots; matched ${members.length}`,
        hint: "Call listBots for exact ids. Groups cannot contain another group.",
      };
    }
    const sourceId = activeBotId(shell, ctx);
    const source = shell.bots.find((bot) => bot.id === sourceId) ?? null;
    const sourceBotId = source && source.id !== DEFAULT_BOT_ID ? source.id : null;
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    let proposal;
    try {
      proposal = createProposal({
        kind: "createGroup",
        name: input.name.trim(),
        memberIds: members.map((member) => member.id),
        sourceBotId,
        threadId: sourceBotId ?? shell.selectedBotId,
      });
      appendAgentEvent(sourceBotId ?? shell.selectedBotId, {
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

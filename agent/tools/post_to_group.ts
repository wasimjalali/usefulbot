import { defineTool } from "eve/tools";
import { z } from "zod";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission } from "../lib/permission.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { appendAgentEvent, createProposal, releaseSend, reserveSend } from "../../shared/agent-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID, GROUP_MIN_MEMBERS } from "../../shared/shell-store.ts";
import { groupMembers, speakersFrom } from "../../shared/threads.ts";

export default defineTool({
  description:
    "Post one message to a group chat. Every member bot receives it and the owner confirms the fan-out before anything is delivered, because this wakes several bots at once. Use it for kickoffs, status pushes and shared decisions. Confirm with the owner in chat first when the group is large.",
  inputSchema: z.object({
    groupId: z.string().min(1).max(80),
    message: z.string().min(1).max(2000),
    requestId: z.string().min(1).max(120).optional(),
  }),
  execute(input, ctx) {
    // A handoff or a run starts a teammate turn and writes transcripts, so
    // Read only refuses it like every other change inside the app.
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    const shell = readShell();
    const requested = input.groupId.trim();
    const group = shell.bots.find((bot) => (
      bot.kind === "group"
      && (bot.id === requested || bot.name.toLowerCase() === requested.toLowerCase())
    )) ?? null;
    if (!group) {
      return { status: "not_found", error: `no group matches ${requested}`, hint: "Call listBots for groups." };
    }
    const members = groupMembers(speakersFrom(shell.bots), group.memberIds);
    if (members.length < GROUP_MIN_MEMBERS) {
      return {
        status: "invalid",
        error: `that group has ${members.length} member bot${members.length === 1 ? "" : "s"}; a post needs ${GROUP_MIN_MEMBERS}`,
        hint: "Add a member in the group settings first.",
      };
    }
    const sourceId = activeBotId(shell, ctx);
    const source = shell.bots.find((bot) => bot.id === sourceId) ?? null;
    const sourceBotId = source && source.id !== DEFAULT_BOT_ID ? source.id : null;
    const message = input.message.trim();
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    let proposal;
    try {
      proposal = createProposal({
        kind: "fanout",
        message,
        targetIds: members.map((member) => member.id),
        groupId: group.id,
        sourceBotId,
        threadId: group.id,
      });
    } catch (err) {
      // Nothing durable was written, so the requestId stays usable.
      if (requestId && !proposal) releaseSend("proposal", requestId);
      throw err;
    }
    try {
      appendAgentEvent(group.id, {
        kind: "proposal",
        threadKind: "group",
        text: message,
        authorBotId: sourceBotId,
        authorName: source?.name ?? null,
        proposalId: proposal.id,
        targetBotIds: members.map((member) => member.id),
      });
    } catch {
      // The proposal is durable now, so a transcript miss is non-fatal:
      // releasing here would let a retry propose the fan-out a second time.
    }
    return {
      status: "awaiting_owner_confirmation",
      proposalId: proposal.id,
      group: { id: group.id, name: group.name },
      members: members.map((member) => ({ id: member.id, name: member.name })),
      note: "The owner sees a fan-out card in this group. Nothing is delivered until they confirm.",
    };
  },
});

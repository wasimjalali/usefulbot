import { defineTool } from "eve/tools";
import { z } from "zod";
import { activeBotId } from "../lib/active-bot.ts";
import {
  appendAgentEvent,
  createProposal,
  releaseSend,
  reserveSend,
  threadIdFor,
} from "../../shared/agent-store.ts";
import { AVATAR_COLORS, AVATAR_SHAPES, isAvatarColor, isAvatarShape } from "../../shared/bot-face.ts";
import { readShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";

export default defineTool({
  description:
    "Propose edits to a bot profile (name, title, description, avatar). Use this when the owner asks you to shape a bot or fix its standing instructions. The owner confirms the card in the chat before anything is written. Prefer one focused proposal over a rewrite of standing rules they did not ask for.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80).optional(),
    name: z.string().min(1).max(80).optional(),
    title: z.string().max(24).optional(),
    description: z.string().max(500).optional(),
    avatarShape: z.string().max(20).optional(),
    avatarColor: z.string().max(20).optional(),
    reason: z.string().max(300).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  execute(input, ctx) {
    const shell = readShell();
    const requested = input.botId ?? activeBotId(shell, ctx);
    const target = shell.bots.find((bot) => bot.id === requested) ?? null;
    if (!target) {
      return { status: "not_found", error: `no bot with id ${requested}` };
    }
    if (input.avatarShape !== undefined && !isAvatarShape(input.avatarShape)) {
      return { status: "invalid", error: "unknown avatarShape", allowed: [...AVATAR_SHAPES] };
    }
    if (input.avatarColor !== undefined && !isAvatarColor(input.avatarColor)) {
      return { status: "invalid", error: "unknown avatarColor", allowed: [...AVATAR_COLORS] };
    }
    const sourceId = activeBotId(shell, ctx);
    const source = shell.bots.find((bot) => bot.id === sourceId) ?? null;
    const sourceBotId = source && source.id !== DEFAULT_BOT_ID ? source.id : null;
    const patch = {
      name: (input.name ?? target.name).trim(),
      // Profile edits keep the existing name; petname is only used while a new
      // bot is being onboarded.
      petname: target.petname ?? "",
      title: (input.title ?? target.label).trim(),
      description: (input.description ?? target.description).trim(),
      avatarShape: input.avatarShape ?? null,
      avatarColor: input.avatarColor ?? null,
    };
    const changed = patch.name !== target.name
      || patch.title !== target.label
      || patch.description !== target.description
      || patch.avatarShape !== null
      || patch.avatarColor !== null;
    if (!changed) {
      return { status: "no_change", botId: target.id, note: "The profile already matches that." };
    }
    const threadId = threadIdFor(sourceBotId ?? target.id);
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("proposal", requestId)) {
      return { status: "duplicate", error: "that requestId was already proposed", requestId };
    }
    let proposal;
    try {
      proposal = createProposal({
        kind: "updateBotProfile",
        botId: target.id,
        patch,
        sourceBotId,
        threadId,
      });
      appendAgentEvent(sourceBotId ?? target.id, {
        kind: "proposal",
        text: `Proposed profile edit for ${target.name}${input.reason ? `: ${input.reason.trim()}` : ""}`,
        proposalId: proposal.id,
        authorBotId: sourceBotId,
        authorName: source?.name ?? null,
      });
    } catch (err) {
      if (requestId) releaseSend("proposal", requestId);
      throw err;
    }
    return {
      status: "awaiting_owner_confirmation",
      proposalId: proposal.id,
      botId: target.id,
      before: { name: target.name, title: target.label, description: target.description },
      after: patch,
      note: "Nothing is written until the owner confirms the card.",
    };
  },
});

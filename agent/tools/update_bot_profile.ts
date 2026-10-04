import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf, mayActOn, notAvailable, SELF_ONLY_HINT } from "../lib/permission.ts";
import {
  appendAgentEvent,
  createProfileProposalOnce,
  releaseSend,
  reserveSend,
  threadIdFor,
} from "../../shared/agent-store.ts";
import { AVATAR_COLORS, AVATAR_SHAPES, isAvatarColor, isAvatarShape } from "../../shared/bot-face.ts";
import { readShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID, DESCRIPTION_MAX } from "../../shared/shell-store.ts";

export default defineTool({
  description:
    "Propose edits to a bot's name, title, description (its standing instructions) or avatar, when the owner asks you to shape a bot or fix its instructions. The owner confirms the card before anything is written. Prefer one focused change over rewriting rules they didn't ask about.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80).optional(),
    name: z.string().min(1).max(80).optional(),
    title: z.string().max(24).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    avatarShape: z.string().max(20).optional(),
    avatarColor: z.string().max(20).optional(),
    reason: z.string().max(300).optional(),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const requested = input.botId ?? who.caller.id;
    const target = shell.bots.find((bot) => bot.id === requested) ?? null;
    if (!target) {
      return { status: "not_found", error: `no bot with id ${requested}` };
    }
    // A plain bot or a group proposes edits to its own profile only.
    if (!mayActOn(who.caller, target.id)) return notAvailable(SELF_ONLY_HINT);
    if (input.avatarShape !== undefined && !isAvatarShape(input.avatarShape)) {
      return { status: "invalid", error: "unknown avatarShape", allowed: [...AVATAR_SHAPES] };
    }
    if (input.avatarColor !== undefined && !isAvatarColor(input.avatarColor)) {
      return { status: "invalid", error: "unknown avatarColor", allowed: [...AVATAR_COLORS] };
    }
    const source = who.caller.bot;
    const sourceBotId = source.id !== DEFAULT_BOT_ID ? source.id : null;
    const patch = {
      name: (input.name ?? target.name).trim(),
      // Profile edits keep the existing name; petname is only used while a new
      // bot is being onboarded.
      petname: target.petname ?? "",
      title: (input.title ?? target.label).trim(),
      // Only a description the proposal changes goes in the card: an
      // unchanged one (even an over-cap stored one) is left out, so a rename
      // still confirms.
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      avatarShape: input.avatarShape ?? null,
      avatarColor: input.avatarColor ?? null,
    };
    const changed = patch.name !== target.name
      || patch.title !== target.label
      || (patch.description !== undefined && patch.description !== target.description)
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
      // One pending profile proposal per bot, checked with the write under one
      // lock. The card is bound to the revision it was raised against.
      proposal = createProfileProposalOnce({
        kind: "updateBotProfile",
        proposerId: who.caller.id,
        botId: target.id,
        patch,
        baseRevision: target.profileRevision,
        sourceBotId,
        threadId,
      });
      if (!proposal) {
        if (requestId) releaseSend("proposal", requestId);
        return {
          status: "refused",
          error: "profile_proposal_pending",
          hint: "That bot already has a profile card waiting for the owner. Ask them to confirm or dismiss it first.",
        };
      }
      appendAgentEvent(sourceBotId ?? target.id, {
        kind: "proposal",
        text: `Proposed profile edit for ${target.name}${input.reason ? `: ${input.reason.trim()}` : ""}`,
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
      botId: target.id,
      before: { name: target.name, title: target.label, description: target.description },
      after: patch,
      note: "Nothing is written until the owner confirms the card.",
    };
  },
});

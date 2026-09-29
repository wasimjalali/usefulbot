import { defineTool } from "eve/tools";
import { z } from "zod";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission } from "../lib/permission.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { sendHandoff } from "../../shared/agents-send.ts";
import { listThreadEvents, releaseSend, reserveSend } from "../../shared/agent-store.ts";
import { HANDOFF_DEPTH_MAX, pendingHandoffCycle, readHandoff, waitForHandoff } from "../../shared/handoffs.ts";
import { readShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { groupMembers, speakersFrom } from "../../shared/threads.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

/** How long sendToBot waits for the teammate. Tests set this to 0. */
const HANDOFF_WAIT_DEFAULT_MS = 180_000;

export default defineTool({
  description:
    "Message one teammate bot and wait for their reply. The question lands in their chat as an incoming message, they work (including while the owner is in another chat), and their answer comes back here as this tool's result and as a message in both transcripts. Use it when another bot owns the deliverable or should review your work. One recipient only: use postToGroup for several at once, which asks the owner first.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80),
    message: z.string().min(1).max(4000),
    requestId: z.string().min(1).max(120).optional(),
  }),
  async execute(input, ctx) {
    // A handoff or a run starts a teammate turn and writes transcripts, so
    // Read only refuses it like every other change inside the app.
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    const shell = readShell();
    const requested = input.botId.trim();
    const exact = shell.bots.find((bot) => bot.id === requested) ?? null;
    const named = exact
      ? []
      : shell.bots.filter((bot) => (
        bot.name.toLowerCase() === requested.toLowerCase()
        || bot.label.toLowerCase() === requested.toLowerCase()
      ));
    if (named.length > 1) {
      return {
        status: "ambiguous",
        error: `several teammates match ${requested}; use an exact id`,
        matches: named.map((bot) => ({ id: bot.id, name: bot.name })),
      };
    }
    const target = exact ?? named[0] ?? null;
    if (!target) {
      return {
        status: "not_found",
        error: `no teammate matches ${requested}`,
        hint: "Call listBots for exact ids.",
      };
    }
    if (target.hidden) {
      return { status: "invalid", error: `${target.name} is hidden; it cannot receive a handoff` };
    }
    const sourceId = activeBotId(shell, ctx);
    if (target.id === sourceId) {
      return { status: "invalid", error: "that is this bot; answer directly instead" };
    }
    const source = shell.bots.find((bot) => bot.id === sourceId) ?? null;
    // A one-member group is still a group: the handoff carries the group so
    // the reply lands in the group thread instead of flipping its kind to a
    // plain bot chat.
    let handoffGroup: { id: string; name: string } | null = null;
    if (target.kind === "group") {
      const members = groupMembers(speakersFrom(shell.bots), target.memberIds);
      if (members.length === 0) {
        return { status: "invalid", error: "that group has no member bots" };
      }
      if (members.length > 1) {
        return {
          status: "needs_post_to_group",
          error: "groups need postToGroup so the owner confirms the fan-out",
          memberCount: members.length,
        };
      }
      handoffGroup = { id: target.id, name: target.name };
    }
    // Forwarding a handoff this bot just received increments the hop count; a
    // chain that bounces back and forth is refused rather than run forever.
    let depth = 0;
    const incoming = listThreadEvents(sourceId)
      .filter((event) => event.kind === "post" && event.handoffId)
      .at(-1);
    if (incoming?.handoffId) {
      const prior = readHandoff(incoming.handoffId);
      if (prior && prior.targetBotId === sourceId) depth = prior.depth + 1;
    }
    if (depth > HANDOFF_DEPTH_MAX) {
      return {
        status: "loop_refused",
        error: `handoff chain is ${depth} hops deep; answer in this chat instead`,
      };
    }
    const requestId = input.requestId?.trim();
    if (requestId && !reserveSend("handoff", requestId)) {
      return { status: "duplicate", error: "that requestId was already sent", requestId };
    }
    let record;
    try {
      record = sendHandoff({
        source: source && source.id !== DEFAULT_BOT_ID ? { id: source.id, name: source.name } : null,
        target: { id: target.id, name: target.name },
        group: handoffGroup,
        message: input.message.trim(),
        depth,
      });
    } catch (err) {
      // sendHandoff only throws before the durable write; a queued record
      // reports a transcript miss on its return instead. A crash between
      // reserve and queue must not burn the requestId.
      if (requestId && !record) releaseSend("handoff", requestId);
      throw err;
    }
    const waitMs = Number(process.env.UB_HANDOFF_WAIT_MS ?? HANDOFF_WAIT_DEFAULT_MS);
    const budget = Number.isFinite(waitMs) ? waitMs : HANDOFF_WAIT_DEFAULT_MS;
    // If the target already has a pending handoff to us, waiting would
    // deadlock both turns until the timeout. Queue and let the pump finish.
    const cycle = pendingHandoffCycle(sourceId, target.id, record.id);
    if (budget <= 0 || cycle) {
      return {
        status: "queued",
        handoffId: record.id,
        to: { id: target.id, name: target.name },
        note: cycle
          ? "The teammate is already waiting on this chat. Their reply will land in both transcripts."
          : "The teammate runs on its own. Their reply will land in both chats.",
      };
    }
    // eve aborts this signal when the turn is cancelled. Without it a Stop
    // left the poll running for the rest of the budget, three minutes by
    // default, on a turn nobody is waiting for any more.
    const done = await waitForHandoff(record.id, budget, undefined, undefined, ctx.abortSignal);
    if (ctx.abortSignal?.aborted && done?.status !== "delivered" && done?.status !== "failed") {
      return {
        status: "queued",
        handoffId: record.id,
        to: { id: target.id, name: target.name },
        note: "This turn was stopped. The teammate keeps working and their reply will land in both chats.",
      };
    }
    if (done?.status === "delivered") {
      if (!done.response) {
        return {
          status: "delivered",
          handoffId: record.id,
          to: { id: target.id, name: target.name },
          reply: "",
          note: "The teammate finished with no reply.",
        };
      }
      return {
        status: "delivered",
        handoffId: record.id,
        to: { id: target.id, name: target.name },
        reply: wrapUntrusted(`handoff:${target.name}`, done.response),
        note: "The teammate answered. Use their reply here; do not ask the owner to switch chats.",
      };
    }
    if (done?.status === "failed") {
      return {
        status: "failed",
        handoffId: record.id,
        to: { id: target.id, name: target.name },
        error: done.lastError || "handoff_failed",
      };
    }
    return {
      status: "queued",
      handoffId: record.id,
      to: { id: target.id, name: target.name },
      note: "The teammate is still working. Their reply will land in both chats.",
    };
  },
});

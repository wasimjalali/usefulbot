import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import {
  callerOf,
  callerRole,
  inAppGate,
  mayActOn,
  notAvailable,
  ORCHESTRATOR_ONLY_HINT,
  READ_ONLY_BLOCKED,
  SELF_ONLY_HINT,
  sessionPermission,
  settle,
} from "../lib/permission.ts";
import { clearThread } from "../../shared/agent-store.ts";
import { readShell, updateShell } from "../../shared/shell-io.ts";
import { applyShellAction } from "../../shared/shell-store.ts";

/**
 * Clear a chat: this bot's, a teammate's, or every bot's.
 *
 * Same two stores the rail's own "Clear chat" writes. The roster row drops its
 * session pointer, so the next turn starts a fresh eve session, and the durable
 * thread (notes, proposals, handoffs) is emptied. The messages do not come
 * back, which is why the owner approves the exact set of chats first.
 */
export default defineTool({
  description:
    "Empty a chat's messages: this bot's, another bot's (botId) or every bot's (all: true). Irreversible: in Auto the owner approves a card listing the exact chats, Full access clears at once, Read only refuses. Name the chats back to them before calling. Only the main bot can clear other bots' chats or all; a teammate can clear only its own.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80).optional(),
    all: z.boolean().optional(),
    reason: z.string().max(300).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const caller = who.caller;
    const selfId = caller.id;
    if (input.all === true && input.botId) {
      return {
        status: "refused",
        error: "pass either all or botId, not both",
        hint: "Call clear_history with all: true for every chat, or with one botId.",
      };
    }

    let targets: typeof shell.bots;
    if (input.all === true) {
      if (caller.role !== "orchestrator") return notAvailable(ORCHESTRATOR_ONLY_HINT);
      targets = shell.bots;
    } else {
      const requested = (input.botId ?? selfId ?? "").trim();
      if (!requested) {
        return { status: "not_found", error: "no bot to clear", hint: "Call list_bots for exact ids." };
      }
      // An id is exact; a name is not. Two bots may share a name up to case,
      // and this erases messages, so an ambiguous match asks rather than picks.
      const byId = shell.bots.find((bot) => bot.id === requested) ?? null;
      const byName = byId
        ? []
        : shell.bots.filter((bot) => bot.name.toLowerCase() === requested.toLowerCase());
      if (byName.length > 1) {
        return {
          status: "ambiguous",
          error: `${byName.length} bots are named ${requested}`,
          hint: `Call clear_history again with one of these ids: ${byName.map((bot) => bot.id).join(", ")}.`,
        };
      }
      const target = byId ?? byName[0] ?? null;
      if (!target) {
        return { status: "not_found", error: `no bot matches ${requested}`, hint: "Call list_bots for exact ids." };
      }
      // A plain bot or a group clears only its own chat.
      if (!mayActOn(caller, target.id)) return notAvailable(SELF_ONLY_HINT);
      targets = [target];
    }
    if (targets.length === 0) {
      return { status: "refused", error: "there are no chats to clear" };
    }

    // The hash binds the approval to this exact set of chats at this exact
    // revision, so a card approved for one chat cannot be spent on another,
    // and a chat that moved on while the owner decided is not cleared blind.
    const signature = targets
      .map((bot) => `${bot.id}@${bot.updatedAt}`)
      .sort()
      .join(",");
    const hash = actionSha256({
      tool: "clear_history",
      canonicalArgs: JSON.stringify({ bots: signature }),
      cwd: "shell",
      targetRevision: signature,
      backend: "shell-store",
      toolVersion: "1",
    });
    const names = targets.map((bot) => `${bot.name} (${bot.id})`);
    const preview = targets.length === 1
      ? `clear the chat history of ${names[0]}`
      : `clear the chat history of ${targets.length} chats: ${names.join(", ")}`;
    // A cleared chat is gone for good, so Auto still shows the card; Full
    // access runs it; Read only refuses.
    const permission = sessionPermission(ctx);
    const gate = inAppGate(permission, true);
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "clear_history",
      actionSha256: hash,
      preview,
    });
    await settle(store, record.id, hash, gate, ctx, permission);
    return executeIfApproved(store, record.id, hash, () => {
      // Re-read under the store lock: the roster can have changed while the
      // owner was deciding, and the approval belongs to the revisions on the
      // card. A chat that took a new turn in that window is left alone.
      const cleared: string[] = [];
      updateShell((current) => {
        // The caller's class is re-read with the roster, so a card raised by
        // the orchestrator is not spent after it lost that role.
        const actor = current.bots.find((bot) => bot.id === caller.id);
        if (!actor) throw new Error("bot_missing");
        const role = callerRole(current, actor);
        if (input.all === true ? role !== "orchestrator" : !(role === "orchestrator" || actor.id === targets[0].id)) {
          throw new Error("not_available_for_this_bot");
        }
        let next = current;
        for (const target of targets) {
          const live = next.bots.find((bot) => bot.id === target.id);
          if (!live) throw new Error("bot_missing");
          if (live.updatedAt !== target.updatedAt) throw new Error("chat_changed");
          next = applyShellAction(next, { type: "clearThread", botId: target.id }).store;
          cleared.push(target.id);
        }
        return next;
      });
      // The durable thread lives in its own store and its lock cannot be held
      // with the roster's, so it follows. A failure here is reported, never
      // swallowed: the owner needs to know a log survived the clear.
      const errors: string[] = [];
      for (const botId of cleared) {
        try {
          clearThread(botId);
        } catch (err) {
          const code = (err instanceof Error ? err.message : "clear_failed")
            .replaceAll(",", " ")
            .slice(0, 80);
          errors.push(`${botId}:${code}`);
        }
      }
      return {
        status: "cleared",
        bots: targets.map((bot) => ({ id: bot.id, name: bot.name })),
        clearedCount: cleared.length,
        threadError: errors.length > 0 ? errors.join(",") : null,
      };
    });
  },
});

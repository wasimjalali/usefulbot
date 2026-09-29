import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { deleteThread } from "../../shared/agent-store.ts";
import { deleteRoutinesForBot } from "../../shared/routines-store.ts";
import { readShell, updateShell } from "../../shared/shell-io.ts";
import { applyShellAction, DEFAULT_BOT_ID } from "../../shared/shell-store.ts";
import { removeSessionGrant } from "../../shared/workspace-store.ts";

export default defineTool({
  description:
    "Delete a teammate bot or group chat when the owner asks for it. It cannot be undone, so in Auto the owner sees an approval card and nothing is removed until they approve it; Full access deletes at once; Read only refuses. This also removes that bot's routines and recent chats, and it cannot be undone, so confirm which bot they mean before calling it. The section it sat in stays; call railAction removeSection to tidy an emptied one.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80),
    reason: z.string().max(300).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const requested = input.botId.trim();
    // An id is exact. A name is not: the roster allows two bots whose names
    // differ only in case, and this call deletes something, so an ambiguous
    // match has to come back as a question rather than a coin toss.
    const byId = shell.bots.find((bot) => bot.id === requested) ?? null;
    const byName = byId
      ? []
      : shell.bots.filter((bot) => bot.name.toLowerCase() === requested.toLowerCase());
    if (byName.length > 1) {
      return {
        status: "ambiguous",
        error: `${byName.length} bots are named ${requested}`,
        hint: `Call delete_bot again with one of these ids: ${byName.map((bot) => bot.id).join(", ")}.`,
      };
    }
    const target = byId ?? byName[0] ?? null;
    if (!target) {
      return { status: "not_found", error: `no bot matches ${requested}`, hint: "Call listBots for exact ids." };
    }
    if (target.id === DEFAULT_BOT_ID) {
      return { status: "refused", error: "the default Useful Bot runs this app and cannot be deleted" };
    }
    const selfId = activeBotId(shell, ctx);
    if (target.id === selfId) {
      return { status: "refused", error: "that is this bot; the owner deletes it from the rail" };
    }
    if (shell.bots.length <= 1) {
      return { status: "refused", error: "the last bot cannot be deleted" };
    }

    // A bot takes its chat, memory and routines with it and nothing brings
    // them back, so Auto still shows the card; Full access runs it; Read
    // only refuses.
    const permission = sessionPermission(ctx);
    const gate = inAppGate(permission, true);
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    // The hash binds the approval to this exact bot, so a card the owner
    // approved cannot be spent on a different one.
    const hash = actionSha256({
      tool: "delete_bot",
      canonicalArgs: JSON.stringify({ botId: target.id }),
      cwd: "shell",
      targetRevision: target.updatedAt,
      backend: "shell-store",
      toolVersion: "1",
    });
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "delete_bot",
      actionSha256: hash,
      // The id is in the preview because a bot's name is editable; the owner
      // has to be able to tell two similarly named cards apart.
      preview: `delete ${target.kind === "group" ? "group" : "bot"} ${target.name} (${target.id})`,
    });
    await settle(store, record.id, hash, gate, ctx, permission);
    return executeIfApproved(store, record.id, hash, () => {
      // Re-read under the store lock: the roster can have changed while the
      // owner was deciding. The approval belongs to the revision on the card,
      // so a bot renamed or re-profiled in the meantime is not deleted.
      const next = updateShell((current) => {
        const live = current.bots.find((bot) => bot.id === target.id);
        if (!live) throw new Error("bot_missing");
        if (live.updatedAt !== target.updatedAt) throw new Error("bot_changed");
        return applyShellAction(current, { type: "deleteBot", botId: target.id }).store;
      });
      // The web route revokes on its own delete path; this one commits
      // straight to the roster, so a folder grant would outlive the bot that
      // held it. Best effort: the roster is the authority and the grant window
      // is capped either way, but a capability with no owner should not sit
      // in the store waiting for the prune.
      if (target.sessionId) {
        try {
          removeSessionGrant(target.sessionId);
        } catch {
          /* the store's own prune is the backstop */
        }
      }
      // Routines and the transcript outlive their bot in their own stores, and
      // none of the three locks can be taken together. So the roster commits
      // first and this follows: tearing down ahead of it would destroy the
      // data of a bot the revision check then refuses to delete. A failure
      // here is reported rather than swallowed, and the tick's sweep clears
      // anything this could not.
      let routines = 0;
      const errors: string[] = [];
      // A short code, never the raw message: internal text does not belong in
      // a tool result, and a comma in one would break the framing below.
      const code = (err: unknown) => (err instanceof Error ? err.message : "detach_failed")
        .replaceAll(",", " ")
        .slice(0, 80);
      // Independently: a locked routines store is no reason to leave the
      // transcript behind too, and the owner needs to hear about both.
      try {
        routines = deleteRoutinesForBot(target.id);
      } catch (err) {
        errors.push(`routines:${code(err)}`);
      }
      try {
        deleteThread(target.id);
      } catch (err) {
        errors.push(`transcript:${code(err)}`);
      }
      const detachError = errors.length > 0 ? errors.join(",") : null;
      return {
        status: "deleted",
        botId: target.id,
        name: target.name,
        routinesRemoved: routines,
        detachError,
        remaining: next.bots.length,
      };
    });
  },
});

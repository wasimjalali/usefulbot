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
  orchestratorId,
  READ_ONLY_BLOCKED,
  SELF_ONLY_HINT,
  sessionPermission,
  settle,
} from "../lib/permission.ts";
import { readShell, updateShell } from "../../shared/shell-io.ts";
import { applyShellAction, type ShellAction, type ShellStore } from "../../shared/shell-store.ts";

/**
 * The rail actions the owner can take from a bot row or a section header.
 * Pin, hide, move, create and rename are reversible, so they write straight
 * through. Removing a section is not: the section id is gone for good, so it
 * asks the owner first, the way `deleteBot` does, and only an empty section
 * can go. Deleting a bot is not one of them; that is `deleteBot`.
 */
export default defineTool({
  description:
    "Organise the sidebar: pin, unpin, hide or unhide a bot, move it into a section by sectionId (null takes it out), create a section, rename one (updateSection) or remove an empty one (removeSection, refused while a bot is in it). Applies at once in Auto and Full access, refused in Read only. delete_bot leaves an emptied section: call removeSection after it. Call list_bots first for ids. Only the main bot can change other bots or sections; a teammate acts only on itself and can't hide itself.",
  inputSchema: z.object({
    action: z.enum([
      "pin",
      "unpin",
      "hide",
      "unhide",
      "move",
      "createSection",
      "renameSection",
      "updateSection",
      "removeSection",
    ]),
    botId: z.string().min(1).max(80).optional(),
    /** Target section for `move`, or the section to rename or remove. Null unassigns. */
    sectionId: z.string().min(1).max(80).nullable().optional(),
    /** New name for `createSection`, `renameSection` and `updateSection`. */
    name: z.string().min(1).max(80).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const who = await callerOf(shell, ctx);
    if (!who.ok) return who.result;
    const caller = who.caller;
    const sectionOnly = input.action === "createSection"
      || input.action === "renameSection"
      || input.action === "updateSection"
      || input.action === "removeSection";
    let botId = "";
    // Authority is judged again against the live roster inside every write:
    // the caller can have lost the orchestrator role, or the target's
    // protection can have changed, between the check above and the commit.
    const assertStillAllowed = (current: ShellStore) => {
      const actor = current.bots.find((bot) => bot.id === caller.id);
      if (!actor) throw new Error("bot_missing");
      const role = callerRole(current, actor);
      if (sectionOnly) {
        if (role !== "orchestrator") throw new Error("not_available_for_this_bot");
        return;
      }
      if (role !== "orchestrator" && actor.id !== botId) throw new Error("not_available_for_this_bot");
      if (input.action === "hide" && (botId === orchestratorId(current) || botId === caller.id)) {
        throw new Error("hide_refused");
      }
    };
    if (!sectionOnly) {
      const requested = input.botId?.trim() ?? "";
      if (!requested) return { status: "invalid", error: `${input.action} needs a botId` };
      // An id is exact. A name is not: the roster allows two bots whose names
      // differ only in case, so an ambiguous match comes back as a question
      // rather than a coin toss, the way `deleteBot` does.
      const byId = shell.bots.find((bot) => bot.id === requested) ?? null;
      const byName = byId
        ? []
        : shell.bots.filter((bot) => bot.name.toLowerCase() === requested.toLowerCase());
      if (byName.length > 1) {
        return {
          status: "ambiguous",
          error: `${byName.length} bots are named ${requested}`,
          hint: `Call rail_action again with one of these ids: ${byName.map((bot) => bot.id).join(", ")}.`,
        };
      }
      const target = byId ?? byName[0] ?? null;
      if (!target) {
        return { status: "not_found", error: `no bot matches ${requested}`, hint: "Call list_bots for exact ids." };
      }
      botId = target.id;
      // A plain bot or a group arranges only its own row; the rest of the
      // sidebar is the orchestrator's.
      if (!mayActOn(caller, botId)) return notAvailable(SELF_ONLY_HINT);
    } else if (caller.role !== "orchestrator") {
      // Sections are shared by every row, so no one but the orchestrator
      // creates, renames or removes one.
      return notAvailable(ORCHESTRATOR_ONLY_HINT);
    }

    if (input.action === "removeSection") {
      const sectionId = input.sectionId ?? "";
      const section = shell.sections.find((item) => item.id === sectionId) ?? null;
      if (!section) {
        return { status: "not_found", error: `no section with id ${sectionId}`, hint: "Call list_bots for exact ids." };
      }
      // Every bot in the section counts, hidden and pinned ones too: the
      // store would unassign them all, and the owner asked for an empty
      // section to go, not for its bots to be scattered.
      const members = shell.bots.filter((bot) => bot.sectionId === section.id);
      if (members.length > 0) {
        return {
          status: "refused",
          error: `section ${section.name} still has ${members.length} bot${members.length === 1 ? "" : "s"}`,
          memberBotIds: members.map((bot) => bot.id),
          hint: "Move them out with action move (sectionId null) and call removeSection again.",
        };
      }
      // Read only changes nothing on the rail; Auto and Full access remove
      // an empty section at once, since the owner asked and a section is
      // recreated in one step. The approval record still binds the action.
      const gate = inAppGate(sessionPermission(ctx));
      if (gate === "refuse") return READ_ONLY_BLOCKED;
      // The hash binds the approval to this exact section by id and name, so
      // a card the owner approved cannot be spent on a renamed or different one.
      const hash = actionSha256({
        tool: "remove_section",
        canonicalArgs: JSON.stringify({ action: "removeSection", sectionId: section.id, name: section.name }),
        cwd: "shell",
        targetRevision: null,
        backend: "shell-store",
        toolVersion: "1",
      });
      const store = getApprovalStore();
      const record = store.request({
        ...approvalActor(ctx),
        tool: "remove_section",
        actionSha256: hash,
        // The id is on the card because a section's name is editable; the
        // owner has to be able to tell two similarly named cards apart.
        preview: `remove section ${section.name} (${section.id})`,
      });
      await settle(store, record.id, hash, gate);
      return executeIfApproved(store, record.id, hash, () => {
        // Re-read under the store lock: the rail can have changed while the
        // owner was deciding. The approval belongs to the empty section on the
        // card, so one that gained a bot or a new name is not removed.
        updateShell((current) => {
          assertStillAllowed(current);
          const live = current.sections.find((item) => item.id === section.id);
          if (!live) throw new Error("section_missing");
          if (live.name !== section.name) throw new Error("section_changed");
          if (current.bots.some((bot) => bot.sectionId === section.id)) throw new Error("section_not_empty");
          return applyShellAction(current, { type: "deleteSection", sectionId: section.id }).store;
        });
        return { status: "removed", action: "removeSection", sectionId: section.id, name: section.name };
      });
    }

    // Every other rail change is reversible and applies at once, unless the
    // owner set Read only, which means the bot changes nothing.
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    let action: ShellAction;
    switch (input.action) {
      case "pin":
        action = { type: "pin", botId, pinned: true };
        break;
      case "unpin":
        action = { type: "pin", botId, pinned: false };
        break;
      case "hide":
        if (botId === orchestratorId(shell)) {
          // The orchestrator answers untargeted group turns and owns the app's
          // own chat; hiding it also makes handoffs to it fail.
          return { status: "refused", error: "the default Useful Bot cannot be hidden" };
        }
        if (botId === caller.id) {
          // Hiding the chat the owner is standing in takes the thread they are
          // talking to off the rail mid-conversation. `delete_bot` refuses the
          // same move for the same reason.
          return { status: "refused", error: "that is this bot; the owner hides it from the rail" };
        }
        action = { type: "hide", botId, hidden: true };
        break;
      case "unhide":
        action = { type: "hide", botId, hidden: false };
        break;
      case "move": {
        const sectionId = input.sectionId ?? null;
        if (sectionId && !shell.sections.some((section) => section.id === sectionId)) {
          return {
            status: "not_found",
            error: `no section with id ${sectionId}`,
            hint: "Create it first with action createSection.",
          };
        }
        action = { type: "move", botId, sectionId };
        break;
      }
      case "createSection": {
        const name = input.name?.trim();
        if (!name) return { status: "invalid", error: "createSection needs a name" };
        action = { type: "createSection", name };
        break;
      }
      case "renameSection":
      case "updateSection": {
        // updateSection is the same one-step rename by id under the name the
        // owner's brief used; both stay so an older prompt keeps working.
        const name = input.name?.trim();
        const sectionId = input.sectionId ?? "";
        if (!name) return { status: "invalid", error: `${input.action} needs a name` };
        if (!shell.sections.some((section) => section.id === sectionId)) {
          return { status: "not_found", error: `no section with id ${sectionId}` };
        }
        action = { type: "renameSection", sectionId, name };
        break;
      }
      default:
        return { status: "invalid", error: `unknown action ${String(input.action)}` };
    }

    let createdId: string | undefined;
    updateShell((current) => {
      assertStillAllowed(current);
      const result = applyShellAction(current, action);
      createdId = result.createdId;
      return result.store;
    });
    return {
      status: "applied",
      action: input.action,
      botId: botId || null,
      sectionId: createdId ?? input.sectionId ?? null,
    };
  },
});

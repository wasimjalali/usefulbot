import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { activeBotId } from "../lib/active-bot.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import {
  createRoutine,
  hostTimeZone,
  isValidTimeZone,
  parseSchedules,
  routineNextRun,
} from "../../shared/routines-store.ts";
import { readShell } from "../../shared/shell-io.ts";

const PREVIEW_MAX = 240;

/** Fit an instruction onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}...` : flat;
}

const schedule = z.object({
  kind: z.enum(["weekly", "daily", "once"]),
  /** 0 is Sunday through 6 is Saturday. Weekly only. */
  days: z.array(z.number().int().min(0).max(6)).optional(),
  /** Wall clock in the routine's timezone, 24 hour, "HH:MM". */
  time: z.string().min(5).max(5),
  /** "YYYY-MM-DD" for a one-shot run. */
  date: z.string().min(10).max(10).optional(),
});

export default defineTool({
  description:
    "Create a routine: a standing instruction a bot runs on a schedule. Use it when the owner asks for recurring work (\"check this every Monday morning\"). Times are wall clock in the routine's timezone, so 09:00 stays 09:00 across a clock change. Defaults to this bot. It applies at once in Auto and Full access and is refused in Read only; after that they can pause or edit it in the chat details pane.",
  inputSchema: z.object({
    name: z.string().min(1).max(80),
    instruction: z.string().min(1).max(4000),
    schedules: z.array(schedule).min(1).max(10),
    botId: z.string().min(1).max(80).optional(),
    /** IANA zone, for example Europe/Berlin. Defaults to this Mac's zone. */
    timezone: z.string().max(80).optional(),
  }),
  async execute(input, ctx) {
    const shell = readShell();
    const botId = input.botId?.trim() || activeBotId(shell, ctx);
    const bot = shell.bots.find((item) => item.id === botId) ?? null;
    if (!bot) {
      return { status: "not_found", error: `no bot with id ${botId}`, hint: "Call listBots for exact ids." };
    }
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      return { status: "invalid", error: `${input.timezone} is not an IANA timezone`, hint: "For example Europe/Berlin." };
    }
    // Validate here rather than letting the store silently drop a bad row: a
    // routine with no schedule would never run and would look like it works.
    const schedules = parseSchedules(input.schedules);
    if (schedules.length !== input.schedules.length) {
      return {
        status: "invalid",
        error: "a schedule was malformed",
        hint: 'time must be "HH:MM" 24 hour, weekly needs days 0-6, once needs date "YYYY-MM-DD".',
      };
    }
    const timezone = input.timezone ?? hostTimeZone();
    // A routine is a standing instruction that runs on its own afterwards, the
    // same class of change as a bot profile, so the owner confirms it first.
    const draft = {
      botId: bot.id,
      name: input.name.trim(),
      instruction: input.instruction.trim(),
      schedules,
      timezone,
    };
    // Read only refuses; Auto and Full access create the routine at once:
    // the owner asked for it, sees it in the pane, and can pause or delete it.
    const gate = inAppGate(sessionPermission(ctx));
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const hash = actionSha256({
      tool: "create_routine",
      canonicalArgs: JSON.stringify(draft),
      cwd: "routines",
      targetRevision: null,
      backend: "routines-store",
      toolVersion: "1",
    });
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "create_routine",
      actionSha256: hash,
      // The instruction is what the owner is actually authorising, so it goes
      // on the card; without it they would be approving only a name.
      preview: `create routine ${draft.name} on ${bot.name}, running: ${clipPreview(draft.instruction)}`,
    });
    await settle(store, record.id, hash, gate);
    return executeIfApproved(store, record.id, hash, () => {
      // The bot can be deleted while the owner is deciding; a routine for a
      // bot that no longer exists would fail on every tick forever. Its profile
      // revision is deliberately not checked: the routine binds to the id, so
      // a rename in the meantime changes nothing about what was approved.
      if (!readShell().bots.some((item) => item.id === bot.id)) {
        return { status: "not_found", error: `no bot with id ${bot.id}` };
      }
      let routine;
      try {
        routine = createRoutine(draft);
      } catch (err) {
        const code = err instanceof Error ? err.message : "routine_create_failed";
        return { status: "invalid", error: code };
      }
      return {
        status: "created",
        routineId: routine.id,
        bot: { id: bot.id, name: bot.name },
        name: routine.name,
        timezone: routine.timezone,
        nextRunAt: routineNextRun(routine, new Date())?.toISOString() ?? null,
        note: "The owner sees this routine in the chat details pane and can pause or delete it there.",
      };
    });
  },
});

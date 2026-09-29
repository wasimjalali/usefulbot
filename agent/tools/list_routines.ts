import { defineTool } from "eve/tools";
import { z } from "zod";
import { activeBotId } from "../lib/active-bot.ts";
import { listRoutines, routineNextRun } from "../../shared/routines-store.ts";
import { readShell } from "../../shared/shell-io.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

export default defineTool({
  description:
    "List the routines a bot runs on a schedule, with their next run time and the outcome of the last few runs. Read only, needs no approval. Defaults to this bot. Call it before updating or deleting a routine so you use the right id.",
  inputSchema: z.object({
    botId: z.string().min(1).max(80).optional(),
  }),
  execute(input, ctx) {
    const shell = readShell();
    const botId = input.botId?.trim() || activeBotId(shell, ctx);
    const bot = shell.bots.find((item) => item.id === botId) ?? null;
    if (!bot) {
      return { status: "not_found", error: `no bot with id ${botId}`, hint: "Call listBots for exact ids." };
    }
    const now = new Date();
    return {
      status: "ok",
      bot: { id: bot.id, name: bot.name },
      routines: listRoutines(bot.id).map((routine) => ({
        id: routine.id,
        // The name and instruction are owner text and may carry instructions
        // aimed at a model; they are data here, not orders.
        name: wrapUntrusted(`routine:${routine.id} name`, routine.name),
        instruction: wrapUntrusted(`routine:${routine.id} instruction`, routine.instruction),
        schedules: routine.schedules,
        timezone: routine.timezone,
        active: routine.active,
        lastRunAt: routine.lastRunAt,
        nextRunAt: routine.active
          ? routineNextRun(routine, routine.lastRunAt ? new Date(routine.lastRunAt) : now)?.toISOString() ?? null
          : null,
        runHistory: routine.runHistory.slice(-5).map((run) => ({
          at: run.at,
          status: run.status,
          error: run.error,
        })),
      })),
    };
  },
});

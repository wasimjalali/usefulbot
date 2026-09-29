import { defineTool } from "eve/tools";
import { z } from "zod";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission } from "../lib/permission.ts";
import { readRoutine, requestRoutineRun } from "../../shared/routines-store.ts";

export default defineTool({
  description:
    "Run a routine now, outside its schedule, the way the owner's Test run button does. The run starts within a few seconds and lands as a turn in the owning bot's chat, so do not wait for it here. A manual run does not consume the next scheduled slot. A paused routine stays paused from here: ask the owner to resume it rather than promising them a run. Call listRoutines for the id.",
  inputSchema: z.object({
    routineId: z.string().min(1).max(120),
  }),
  execute(input, ctx) {
    // A run starts a teammate turn and writes transcripts, so Read only
    // refuses it like every other change inside the app.
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    const routine = readRoutine(input.routineId);
    if (!routine) {
      return { status: "not_found", error: `no routine with id ${input.routineId}`, hint: "Call listRoutines." };
    }
    if (!routine.active) {
      // Paused means paused for the agent path. The owner's own Test run
      // button is an explicit click on that routine; a model deciding to wake
      // a routine the owner switched off is not the same thing.
      return {
        status: "paused",
        routineId: routine.id,
        error: "that routine is paused",
        hint: "Ask the owner to resume it, or call updateRoutine with active true once they agree.",
      };
    }
    // The web server owns delivery; this only raises the request flag, which
    // the next tick claims. A second call while one is waiting is a no-op.
    if (!requestRoutineRun(routine.id)) {
      return { status: "duplicate", routineId: routine.id, error: "a run is already queued for that routine" };
    }
    return {
      status: "queued",
      routineId: routine.id,
      name: routine.name,
      botId: routine.botId,
      note: "The result appears in that bot's chat and in the routine's run history.",
    };
  },
});

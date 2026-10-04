import { defineTool } from "eve/tools";
import { z } from "zod";
import { callerOf, inAppGate, mayActOn, notAvailable, READ_ONLY_BLOCKED, SELF_ONLY_HINT, sessionPermission } from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";
import { readRoutine, requestRoutineRun } from "../../shared/routines-store.ts";

export default defineTool({
  description:
    "Run an active routine now, outside its schedule. It starts within seconds and answers in the owning bot's chat, so don't wait for it. It doesn't use up the next scheduled slot. A paused routine is refused: ask the owner to resume it. Call list_routines for the id.",
  inputSchema: z.object({
    routineId: z.string().min(1).max(120),
  }),
  async execute(input, ctx) {
    // A run starts a teammate turn and writes transcripts, so Read only
    // refuses it like every other change inside the app.
    const who = await callerOf(readShell(), ctx);
    if (!who.ok) return who.result;
    if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
    const routine = readRoutine(input.routineId);
    if (!routine) {
      return { status: "not_found", error: `no routine with id ${input.routineId}`, hint: "Call list_routines." };
    }
    // A routine resolves to its owner: a plain bot runs only its own.
    if (!mayActOn(who.caller, routine.botId)) return notAvailable(SELF_ONLY_HINT);
    if (!routine.active) {
      // Paused means paused for the agent path. The owner's own Test run
      // button is an explicit click on that routine; a model deciding to wake
      // a routine the owner switched off is not the same thing.
      return {
        status: "paused",
        routineId: routine.id,
        error: "that routine is paused",
        hint: "Ask the owner to resume it, or call update_routine with active true once they agree.",
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

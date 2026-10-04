import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import {
  callerOf,
  inAppGate,
  mayActOn,
  mayStillActOn,
  notAvailable,
  READ_ONLY_BLOCKED,
  SELF_ONLY_HINT,
  sessionPermission,
  settle,
} from "../lib/permission.ts";
import { readShell } from "../../shared/shell-io.ts";
import {
  isValidTimeZone,
  parseSchedules,
  readRoutine,
  routineNextRun,
  updateRoutine,
} from "../../shared/routines-store.ts";

const PREVIEW_MAX = 240;

/** Fit an instruction onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}...` : flat;
}

const schedule = z.object({
  kind: z.enum(["weekly", "daily", "once"]),
  days: z.array(z.number().int().min(0).max(6)).optional(),
  time: z.string().min(5).max(5),
  date: z.string().min(10).max(10).optional(),
});

export default defineTool({
  description:
    "Edit one routine, only when the owner asks: rename it, change its instruction or schedule, or pause and resume with active. Applies at once in Auto and Full access, refused in Read only. `schedules` replaces the whole list: send every schedule to keep. Call list_routines first for the id and current schedule.",
  inputSchema: z.object({
    routineId: z.string().min(1).max(120),
    name: z.string().min(1).max(80).optional(),
    instruction: z.string().min(1).max(4000).optional(),
    schedules: z.array(schedule).max(10).optional(),
    /** false pauses the routine without deleting it. */
    active: z.boolean().optional(),
    timezone: z.string().max(80).optional(),
  }),
  async execute(input, ctx) {
    const who = await callerOf(readShell(), ctx);
    if (!who.ok) return who.result;
    const existing = readRoutine(input.routineId);
    if (!existing) {
      return { status: "not_found", error: `no routine with id ${input.routineId}`, hint: "Call list_routines." };
    }
    // A routine resolves to its owner: a plain bot edits only its own.
    if (!mayActOn(who.caller, existing.botId)) return notAvailable(SELF_ONLY_HINT);
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      return { status: "invalid", error: `${input.timezone} is not an IANA timezone` };
    }
    if (input.schedules !== undefined) {
      const parsed = parseSchedules(input.schedules);
      if (parsed.length !== input.schedules.length) {
        return {
          status: "invalid",
          error: "a schedule was malformed",
          hint: 'time must be "HH:MM" 24 hour, weekly needs days 0-6, once needs date "YYYY-MM-DD".',
        };
      }
    }
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.instruction !== undefined) patch.instruction = input.instruction;
    if (input.schedules !== undefined) patch.schedules = input.schedules;
    if (input.active !== undefined) patch.active = input.active;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (Object.keys(patch).length === 0) {
      return { status: "no_change", routineId: existing.id, note: "Nothing to change." };
    }

    const apply = () => {
      let routine;
      try {
        routine = updateRoutine(existing.id, patch);
      } catch (err) {
        return { status: "invalid", error: err instanceof Error ? err.message : "routine_update_failed" };
      }
      return {
        status: "updated",
        routineId: routine.id,
        name: routine.name,
        active: routine.active,
        schedules: routine.schedules,
        nextRunAt: routine.active
          ? routineNextRun(routine, routine.lastRunAt ? new Date(routine.lastRunAt) : new Date())?.toISOString() ?? null
          : null,
      };
    };

    // Rewriting the instruction and resuming a paused routine put it back
    // to running something unattended, so they go through the approval
    // record (bound, replay-refused) even though Auto settles it at once;
    // renaming, rescheduling and pausing write straight through.
    const gate = inAppGate(sessionPermission(ctx));
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    const rewrite = typeof patch.instruction === "string" && patch.instruction.trim() !== existing.instruction;
    const resume = patch.active === true && !existing.active;
    if (!rewrite && !resume) {
      if (!mayStillActOn(who.caller.id, existing.botId)) return notAvailable(SELF_ONLY_HINT);
      return apply();
    }

    const reasons = [
      rewrite ? `running: ${clipPreview(String(patch.instruction))}` : "",
      resume ? "resumed" : "",
    ].filter(Boolean).join("; ");
    // The whole patch is hashed, not just the gated field: the owner approves
    // every change this call makes, not a rewrite with a schedule riding along.
    const hash = actionSha256({
      tool: "update_routine",
      canonicalArgs: JSON.stringify({ routineId: existing.id, patch }),
      cwd: "routines",
      targetRevision: existing.updatedAt,
      backend: "routines-store",
      toolVersion: "1",
    });
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "update_routine",
      actionSha256: hash,
      preview: `update routine ${existing.name} (${existing.id}), ${reasons}`,
    });
    await settle(store, record.id, hash, gate);
    return executeIfApproved(store, record.id, hash, () => {
      // The approval belongs to the revision on the card; a routine edited in
      // the meantime is not silently overwritten.
      if (!mayStillActOn(who.caller.id, existing.botId)) return notAvailable(SELF_ONLY_HINT);
      const current = readRoutine(existing.id);
      if (!current) return { status: "not_found", error: `no routine with id ${existing.id}` };
      if (current.updatedAt !== existing.updatedAt) throw new Error("routine_changed");
      return apply();
    });
  },
});

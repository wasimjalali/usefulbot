import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { deleteRoutine, readRoutine } from "../../shared/routines-store.ts";

export default defineTool({
  description:
    "Delete a routine for good, including its run history. It applies at once in Auto and Full access and is refused in Read only. Prefer updateRoutine with active false when the owner only wants it paused.",
  inputSchema: z.object({
    routineId: z.string().min(1).max(120),
    reason: z.string().max(300).optional(),
  }),
  async execute(input, ctx) {
    const routine = readRoutine(input.routineId);
    if (!routine) {
      return { status: "not_found", error: `no routine with id ${input.routineId}`, hint: "Call listRoutines." };
    }
    // A routine is recreated in one call, so Auto removes it when asked;
    // Read only refuses.
    const gate = inAppGate(sessionPermission(ctx));
    if (gate === "refuse") return READ_ONLY_BLOCKED;
    // The hash binds the approval to this routine at this revision, so a card
    // the owner approved cannot be spent on another routine.
    const hash = actionSha256({
      tool: "delete_routine",
      canonicalArgs: JSON.stringify({ routineId: routine.id }),
      cwd: "routines",
      targetRevision: routine.updatedAt,
      backend: "routines-store",
      toolVersion: "1",
    });
    const store = getApprovalStore();
    const record = store.request({
      ...approvalActor(ctx),
      tool: "delete_routine",
      actionSha256: hash,
      // The id is in the preview because a routine's name is editable by a
      // tool; the owner has to be able to tell two "Weekly report" cards apart.
      preview: `delete routine ${routine.name} (${routine.id})`,
    });
    await settle(store, record.id, hash, gate);
    return executeIfApproved(store, record.id, hash, () => {
      // The routine could have been edited while the owner was reading the
      // card; the approval belongs to the revision they saw, not to the id.
      const current = readRoutine(routine.id);
      if (!current) return { status: "already_gone", routineId: routine.id, name: routine.name };
      if (current.updatedAt !== routine.updatedAt) throw new Error("routine_changed");
      const removed = deleteRoutine(routine.id);
      return {
        status: removed ? "deleted" : "already_gone",
        routineId: routine.id,
        name: routine.name,
      };
    });
  },
});

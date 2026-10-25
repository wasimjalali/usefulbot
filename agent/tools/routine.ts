import { defineTool, type ToolCtx } from "../lib/tool.ts";
import { z } from "zod";
import { actionSha256, approvalActor, executeIfApproved } from "../lib/approvals.ts";
import { getApprovalStore } from "../lib/write.ts";
import { inAppGate, READ_ONLY_BLOCKED, sessionPermission, settle } from "../lib/permission.ts";
import { engineApi } from "../engine/api.ts";
import {
  createRoutine,
  deleteRoutine,
  hostTimeZone,
  isValidTimeZone,
  listRoutines,
  parseSchedules,
  readRoutine,
  routineNextRun,
  updateRoutine,
  type Routine,
} from "../../shared/routines-store.ts";
import { flatLine, wrapUntrusted } from "../../shared/untrusted.ts";

const PREVIEW_MAX = 240;

/** Fit an instruction onto the approval card without hiding that it was cut. */
function clipPreview(value: string): string {
  const flat = flatLine(value).replace(/\s+/g, " ");
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

const input = z.object({
  action: z.enum(["list", "create", "update", "delete", "run"]),
  routineId: z.string().min(1).max(120).optional().describe("update, delete, run: the id from list."),
  name: z.string().min(1).max(80).optional(),
  instruction: z.string().min(1).max(4000).optional(),
  schedules: z.array(schedule).max(10).optional().describe("create: at least one. update: replaces the whole list."),
  /** false pauses the routine without deleting it. */
  active: z.boolean().optional(),
  /** IANA zone, for example Europe/Berlin. Defaults to this Mac's zone. */
  timezone: z.string().max(80).optional(),
});

type Input = z.output<typeof input>;

const MALFORMED = {
  status: "invalid",
  error: "a schedule was malformed",
  hint: 'time must be "HH:MM" 24 hour, weekly needs days 0-6, once needs date "YYYY-MM-DD".',
} as const;

export default defineTool({
  name: "routine",
  description:
    "Routines, standing instructions that run on a schedule in their own chat. action list (call first for ids), create (name, instruction, schedules), update (routineId plus what changes; active false pauses), delete, run (now, outside the schedule; answers in the routine's chat). Create, update and delete only when the owner asks. Times are wall clock in the routine's timezone. Changes apply at once in Auto and Full access, refused in Read only.",
  inputSchema: input,
  sequential: true,
  async execute(args, ctx) {
    switch (args.action) {
      case "list": return list(ctx);
      case "create": return create(args, ctx);
      case "update": return update(args, ctx);
      case "delete": return remove(args, ctx);
      case "run": return run(args, ctx);
    }
  },
});

/** A routine belongs to the bot; one that belongs to no bot of this chat reads as missing. */
function ownRoutine(args: Input, ctx: ToolCtx): { routine: Routine } | { result: Record<string, unknown> } {
  if (!args.routineId) return { result: { status: "invalid", error: "routineId_required", hint: "Call routine list for the id." } };
  const routine = readRoutine(args.routineId);
  if (!routine || routine.botId !== ctx.botId) {
    return { result: { status: "not_found", error: `no routine with id ${args.routineId}`, hint: "Call routine list." } };
  }
  return { routine };
}

function list(ctx: ToolCtx) {
  const now = new Date();
  return {
    status: "ok",
    routines: listRoutines(ctx.botId).map((routine) => ({
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
      runHistory: routine.runHistory.slice(-5).map((entry) => ({
        at: entry.at,
        status: entry.status,
        // A failure message can carry text from the page or server that failed.
        error: entry.error ? wrapUntrusted(`routine:${routine.id} run error`, entry.error) : entry.error,
      })),
    })),
  };
}

async function create(args: Input, ctx: ToolCtx) {
  if (!args.name) return { status: "invalid", error: "name_required" };
  if (!args.instruction) return { status: "invalid", error: "instruction_required" };
  if (!args.schedules || args.schedules.length === 0) return { status: "invalid", error: "schedules_required", hint: "Give at least one schedule." };
  if (args.timezone !== undefined && !isValidTimeZone(args.timezone)) {
    return { status: "invalid", error: `${args.timezone} is not an IANA timezone`, hint: "For example Europe/Berlin." };
  }
  // Validate here rather than letting the store silently drop a bad row: a
  // routine with no schedule would never run and would look like it works.
  const schedules = parseSchedules(args.schedules);
  if (schedules.length !== args.schedules.length) return MALFORMED;
  const draft = {
    botId: ctx.botId,
    name: args.name.trim(),
    instruction: args.instruction.trim(),
    schedules,
    timezone: args.timezone ?? hostTimeZone(),
  };
  // Read only refuses; Auto and Full access create the routine at once:
  // the owner asked for it, sees it on the Routines page, and can pause or delete it.
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
    preview: `create routine ${flatLine(draft.name)}, running: ${clipPreview(draft.instruction)}`,
  });
  await settle(store, record.id, hash, gate, ctx);
  return executeIfApproved(store, record.id, hash, () => {
    let routine;
    try {
      routine = createRoutine(draft);
    } catch (err) {
      return { status: "invalid", error: err instanceof Error ? err.message : "routine_create_failed" };
    }
    return {
      status: "created",
      routineId: routine.id,
      name: routine.name,
      timezone: routine.timezone,
      nextRunAt: routineNextRun(routine, new Date())?.toISOString() ?? null,
      note: "The owner sees this routine on the Routines page and can pause or delete it there.",
    };
  });
}

async function update(args: Input, ctx: ToolCtx) {
  const found = ownRoutine(args, ctx);
  if ("result" in found) return found.result;
  const existing = found.routine;
  if (args.timezone !== undefined && !isValidTimeZone(args.timezone)) {
    return { status: "invalid", error: `${args.timezone} is not an IANA timezone` };
  }
  if (args.schedules !== undefined && parseSchedules(args.schedules).length !== args.schedules.length) return MALFORMED;
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.instruction !== undefined) patch.instruction = args.instruction;
  if (args.schedules !== undefined) patch.schedules = args.schedules;
  if (args.active !== undefined) patch.active = args.active;
  if (args.timezone !== undefined) patch.timezone = args.timezone;
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
  if (!rewrite && !resume) return apply();

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
    preview: `update routine ${flatLine(existing.name)} (${existing.id}), ${reasons}`,
  });
  await settle(store, record.id, hash, gate, ctx);
  return executeIfApproved(store, record.id, hash, () => {
    // The approval belongs to the revision on the card; a routine edited in
    // the meantime is not silently overwritten.
    const current = readRoutine(existing.id);
    if (!current) return { status: "not_found", error: `no routine with id ${existing.id}` };
    if (current.updatedAt !== existing.updatedAt) throw new Error("routine_changed");
    return apply();
  });
}

async function remove(args: Input, ctx: ToolCtx) {
  const found = ownRoutine(args, ctx);
  if ("result" in found) return found.result;
  const routine = found.routine;
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
    preview: `delete routine ${flatLine(routine.name)} (${routine.id})`,
  });
  await settle(store, record.id, hash, gate, ctx);
  return executeIfApproved(store, record.id, hash, () => {
    // The routine could have been edited while the owner was reading the
    // card; the approval belongs to the revision they saw, not to the id.
    const current = readRoutine(routine.id);
    if (!current) return { status: "already_gone", routineId: routine.id, name: routine.name };
    if (current.updatedAt !== routine.updatedAt) throw new Error("routine_changed");
    const removed = deleteRoutine(routine.id);
    return { status: removed ? "deleted" : "already_gone", routineId: routine.id, name: routine.name };
  });
}

async function run(args: Input, ctx: ToolCtx) {
  // A run starts a bot turn and writes a chat, so Read only refuses it like
  // every other change inside the app.
  if (inAppGate(sessionPermission(ctx)) === "refuse") return READ_ONLY_BLOCKED;
  const found = ownRoutine(args, ctx);
  if ("result" in found) return found.result;
  const routine = found.routine;
  if (!routine.active) {
    // Paused means paused for the agent path. The owner's own Test run
    // button is an explicit click on that routine; a model deciding to wake
    // a routine the owner switched off is not the same thing.
    return {
      status: "paused",
      routineId: routine.id,
      error: "that routine is paused",
      hint: "Ask the owner to resume it, or call routine update with active true once they agree.",
    };
  }
  const started = await engineApi().runRoutine(routine.id);
  return {
    status: started.queued ? "queued" : "started",
    routineId: routine.id,
    name: routine.name,
    note: "It runs in the routine's own chat and shows in its run history. Don't wait for it.",
  };
}

import { defineDynamic, defineInstructions } from "eve/instructions";
import { renderContext } from "../../shared/context-blocks.ts";
import { turnIdOf } from "../lib/router-identity.ts";
import { ensureTurnSnapshot, markSnapshotFailed } from "../lib/turn-snapshot.ts";

/**
 * The bot's context for this turn: Running the team (the Generalist's own
 * chat), Your bot, This turn, rendered from the one snapshot the turn's model
 * and list_models also read. A throwing instruction resolver is skipped by eve
 * without failing the turn, so a failure here is recorded on the snapshot and
 * the `step.started` model resolver (agent/agent.ts) refuses the turn.
 */
export default defineDynamic({
  events: {
    "turn.started": async (event, ctx) => {
      const turnId = turnIdOf(event);
      try {
        const snapshot = await ensureTurnSnapshot(ctx, turnId, true);
        // Unbound or mismatched: nothing to render, and the model resolver refuses the turn.
        if (!snapshot || snapshot.status !== "ok") return null;
        return defineInstructions({ content: renderContext(snapshot.context) });
      } catch (err) {
        console.error("[instructions] bot context failed", err instanceof Error ? err.message : err);
        markSnapshotFailed(ctx.session.id, turnId);
        return null;
      }
    },
  },
});

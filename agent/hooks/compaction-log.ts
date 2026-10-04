import { defineHook } from "eve/hooks";
import { frozenTurnFor } from "../lib/session-model.ts";

// eve compacts at this share of the window (agent/agent.ts `thresholdPercent`).
const THRESHOLD_PERCENT = 0.75;

/**
 * One JSON line per compaction event on the agent's stdout. A summary replaces
 * the history for good, and until now nothing recorded when it ran, which model
 * wrote it, or how big the prompt was. The model and window are the ones the
 * turn froze at its first step (session-model.ts), so the line says what the
 * turn actually ran on, not what is selected now.
 */
function line(kind: "requested" | "completed", sessionId: string, turnId: string, usageInputTokens: number | null): void {
  const frozen = frozenTurnFor(sessionId);
  // Only a turn the agent froze is described as frozen: a line for another
  // turn id would pin this turn's compaction to a selection it never ran on.
  const own = frozen && frozen.turnId === turnId ? frozen.selection : null;
  console.log(JSON.stringify({
    event: `compaction.${kind}`,
    sessionId,
    turnId,
    connectionId: own?.connectionId ?? null,
    modelId: own?.modelId ?? null,
    windowTokens: own?.windowTokens ?? null,
    usageInputTokens,
    reason: "threshold",
    thresholdPercent: THRESHOLD_PERCENT,
    thresholdTokens: own ? Math.floor(own.windowTokens * THRESHOLD_PERCENT) : null,
  }));
}

export default defineHook({
  events: {
    "compaction.requested": (event) => {
      line("requested", event.data.sessionId, event.data.turnId, event.data.usageInputTokens);
    },
    "compaction.completed": (event) => {
      line("completed", event.data.sessionId, event.data.turnId, null);
    },
  },
});

import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Fixture for the S2 spike, which needs a tool it can prove eve executed.
 *
 * Live sessions must not see it. `disableTool()` is not the way: the slot
 * belongs to this repo rather than to an extension or a built-in default, and
 * eve refuses it there, which took the agent down at boot in PR 59. A dynamic
 * tool may return `null` for no tool at all, so the slot resolves to nothing
 * unless the probe's own environment is set. `spikes/s2/probe.mjs` passes
 * `UB_S2_FIXTURE=1` to the eve process it starts, which is the same flag
 * `agent/agent.ts` reads to swap the model for the fixture.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      process.env.UB_S2_FIXTURE === "1"
        ? defineTool({
            description: "Return the S2 planted token. Spike fixture only.",
            inputSchema: z.object({}),
            execute: () => ({ token: "S2-TOOL-PLANT-001" }),
          })
        : null,
  },
});

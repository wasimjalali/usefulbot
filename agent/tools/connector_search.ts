import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchConnectorTools } from "../../shared/composio.ts";
import { readConnectorsStore } from "../../shared/connectors-store.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";

const SCHEMA_MAX_BYTES = 6 * 1024;

/**
 * Finds tools in the owner's connected apps for a use case. Read-only and
 * never carded. Returns slugs with trimmed input schemas so the model can
 * call connector_execute without guessing an argument shape.
 */
export default defineTool({
  description:
    "Find tools in the owner's connected apps (Gmail, Slack, GitHub and others) for a use case. Call this before connector_execute; never guess a tool slug.",
  inputSchema: z.object({
    use_case: z.string().min(3).max(300),
  }),
  async execute(input) {
    const store = readConnectorsStore();
    if (!store.apiKey) return { status: "blocked", error: "connectors_not_set_up" };
    if (store.connectedToolkits.length === 0) return { status: "blocked", error: "no_connectors" };
    try {
      const result = await searchConnectorTools(input.use_case);
      return {
        status: "ok",
        connected: store.connectedToolkits,
        tools: result.tools.map((hit) => ({
          tool: hit.tool,
          toolkit: hit.toolkit,
          description: wrapUntrusted(`connector:${hit.tool} description`, hit.description),
          inputSchema: hit.inputSchema
            ? wrapUntrusted(`connector:${hit.tool} input schema`, clipSchema(hit.inputSchema))
            : null,
        })),
        guidance: result.guidance.map((line) => wrapUntrusted("connector guidance", line)),
        notConnected: result.notConnected,
      };
    } catch (err) {
      return { status: "error", error: wrapUntrusted("connector search error", String((err as Error).message ?? "failed")) };
    }
  },
});

/**
 * The schema is JSON text for the model, marked untrusted like every other
 * string an app publishes: property descriptions and enums come from the
 * integration, not from the owner.
 */
function clipSchema(schema: Record<string, unknown>): string {
  const text = JSON.stringify(schema);
  if (text.length <= SCHEMA_MAX_BYTES) return text;
  const props = schema.properties;
  if (props && typeof props === "object") {
    const names = Object.keys(props as Record<string, unknown>);
    const required = Array.isArray(schema.required) ? schema.required : [];
    return JSON.stringify({ properties: names, required, note: "schema clipped; property names only" });
  }
  return `${text.slice(0, SCHEMA_MAX_BYTES)}…`;
}

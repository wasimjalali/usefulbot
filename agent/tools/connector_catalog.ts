import { defineTool } from "eve/tools";
import { z } from "zod";
import { listConnectorToolkits } from "../../shared/composio.ts";
import { readConnectorsStore } from "../../shared/connectors-store.ts";
import { wrapUntrusted } from "../../shared/untrusted.ts";
import { markOutside } from "../lib/outside-content.ts";

/**
 * Search the whole Composio catalogue, connected or not. Read-only and never
 * carded. This is how a bot finds out whether an app exists and whether the
 * owner has connected it, before proposing a connection.
 */
export default defineTool({
  description:
    "Search the catalogue of apps the owner can connect (Gmail, Notion, Slack, GitHub and 1500 more); says whether each is connected. Many list twice, a plain connector and an MCP variant: prefer the plain one unless the owner asks for MCP or its tools fall short. Call before propose_connector.",
  inputSchema: z.object({
    query: z.string().min(3).max(80),
  }),
  async execute(input, ctx) {
    markOutside(ctx);
    const store = readConnectorsStore();
    if (!store.apiKey) return { status: "blocked", error: "connectors_not_set_up" };
    try {
      const page = await listConnectorToolkits({ search: input.query, limit: 8 });
      // Names are published by the apps, not the owner: one untrusted block
      // for the list, slugs stay bare because propose_connector needs them.
      return {
        status: "ok",
        hasKey: true,
        apps: page.rows.map((row) => ({ slug: row.slug, connected: row.connected })),
        names: wrapUntrusted("connector catalogue names", page.rows.map((row) => `${row.slug}: ${row.name}`).join("\n")),
      };
    } catch (err) {
      return { status: "error", error: String((err as Error).message ?? "failed").slice(0, 200) };
    }
  },
});

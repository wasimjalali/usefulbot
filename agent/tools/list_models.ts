import { defineTool } from "eve/tools";
import { z } from "zod";
import { publicProviders, readProviderStore } from "../../shared/providers.ts";

const DEFAULT_LIMIT = 50;

type Row = { id: string; label: string; connectionId: string; connectionLabel: string };

function matches(row: Row, query: string): boolean {
  const q = query.toLowerCase();
  return row.id.toLowerCase().includes(q) || row.label.toLowerCase().includes(q) || row.connectionLabel.toLowerCase().includes(q);
}

function page(rows: Row[], query: string | undefined, limit: number) {
  const hits = query ? rows.filter((row) => matches(row, query)) : rows;
  return {
    total: hits.length,
    models: hits.slice(0, limit).map((row) => ({
      id: row.id,
      label: row.label,
      provider: row.connectionLabel,
      connectionId: row.connectionId,
    })),
  };
}

export default defineTool({
  description:
    "List the models on the owner's connected providers: chat models (and which one runs you right now) and image models (and which one generate_image uses by default). Read-only. Filter with `kind` and a `query` such as a vendor or family name; long lists come back capped with a total. You cannot switch your own chat model: the owner picks it in the composer. To draw with an image model other than the default, pass its id to generate_image as `model` (and its connectionId when two providers offer the same id).",
  inputSchema: z.object({
    kind: z.enum(["chat", "image", "all"]).optional(),
    query: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async execute(input) {
    const roles = publicProviders(readProviderStore()).roles;
    const kind = input.kind ?? "all";
    const limit = input.limit ?? DEFAULT_LIMIT;
    const query = input.query?.trim() || undefined;
    return {
      current: {
        chat: roles.default.modelId
          ? { id: roles.default.modelId, label: roles.default.modelLabel, provider: roles.default.connectionLabel, connectionId: roles.default.connectionId }
          : null,
        image: roles.image.modelId
          ? { id: roles.image.modelId, label: roles.image.modelLabel, provider: roles.image.connectionLabel, connectionId: roles.image.connectionId }
          : null,
      },
      ...(kind === "image" ? {} : { chat: page(roles.default.models, query, limit) }),
      ...(kind === "chat" ? {} : { image: page(roles.image.models, query, limit) }),
    };
  },
});

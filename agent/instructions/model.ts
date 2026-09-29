import { defineDynamic, defineInstructions } from "eve/instructions";
import { publicProviders, readProviderStore } from "../../shared/providers.ts";

/**
 * Which model runs this bot, read fresh each turn: the owner can switch it in
 * the composer between two messages, and a static line would go stale. The
 * store read is the same one the router makes, so the bot names the model the
 * turn actually goes to.
 */
export function modelContext(): string | null {
  const roles = publicProviders(readProviderStore()).roles;
  if (!roles.default.modelId) return null;
  const chat = `${roles.default.modelLabel} (${roles.default.modelId}) through ${roles.default.connectionLabel}`;
  const image = roles.image.modelId
    ? `generate_image draws with ${roles.image.modelLabel} (${roles.image.modelId}) through ${roles.image.connectionLabel} unless you pass another image model.`
    : "No image model is connected, so generate_image is unavailable.";
  return [
    "# Your model",
    "",
    `This turn runs on ${chat}. When someone asks what model or AI powers you, say you are Useful Bot running on that model. The owner picks it in the composer and can change it between turns, so answer from this line rather than from memory.`,
    image,
    "Call list_models to see every chat and image model the owner has connected.",
  ].join("\n");
}

export default defineDynamic({
  events: {
    "turn.started": () => {
      try {
        const content = modelContext();
        return content ? defineInstructions({ content }) : null;
      } catch (error) {
        // A store the resolver cannot read must not fail the turn; the bot
        // just does not know its model this turn, and the log says why.
        console.error("[instructions] model context unavailable", error);
        return null;
      }
    },
  },
});

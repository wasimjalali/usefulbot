import { selectionAvailability, type ProviderStore } from "../../shared/providers.ts";
import { botSelection } from "../../shared/session-selection.ts";
import type { ShellBot } from "../../shared/shell-store.ts";

/**
 * Why a send to this bot cannot be carried, or null when it can: its route is
 * retired, or its connection is gone or its model is no longer listed. Never a
 * quiet switch to another model. Pure: the caller reads `store` before the
 * roster the bot came from, so a fresh store never pairs with an older roster.
 */

export type SelectionRefusal = {
  code: "provider_route_retired" | "model_selection_unavailable";
  message: string;
  status: 409;
};

export const MODEL_SELECTION_UNAVAILABLE_TEXT = "This bot's model or its connection is no longer available. Pick a model for it again.";

export function selectionRefusal(bot: Pick<ShellBot, "model">, store: ProviderStore): SelectionRefusal | null {
  const available = selectionAvailability(store, botSelection(bot, store));
  if (available.available) return null;
  if (available.reason === "route_retired") {
    return { code: "provider_route_retired", message: available.message, status: 409 };
  }
  return { code: "model_selection_unavailable", message: MODEL_SELECTION_UNAVAILABLE_TEXT, status: 409 };
}

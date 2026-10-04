import { catalogFor } from "../../shared/live-models.ts";
import { exactModelOption } from "../../shared/models.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../../shared/policy.ts";
import type { ModelSelection } from "../../shared/session-selection.ts";

/**
 * The context window of one selected model, from the catalog row for exactly
 * that connection and model. No stand-in row: a model the catalog does not
 * list, or lists without a window, is unknown, and unknown is 32,768.
 */
export function windowTokensFor(selection: ModelSelection): number {
  const tokens = exactModelOption(selection.modelId, catalogFor(selection.connectionId))?.contextTokens;
  return Number.isInteger(tokens) && (tokens as number) > 0 ? (tokens as number) : UNKNOWN_WINDOW_TOKENS;
}

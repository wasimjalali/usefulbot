import { parseSelectionHeader } from "../../shared/session-selection.ts";

/** The `x-useful-selection` header as the router reads it. Throws when it does not parse. */
export function decodeSelectionHeader(raw: string | undefined) {
  const parsed = parseSelectionHeader(raw ?? null);
  if (!parsed) throw new Error("selection_header_invalid");
  return parsed;
}

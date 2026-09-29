import { catalogFor } from "../../shared/live-models.ts";
import { modelOption } from "../../shared/models.ts";
import { POLICY_WINDOW_TOKENS } from "../../shared/policy.ts";
import { readProviderStore, resolveUpstream } from "../../shared/providers.ts";

/**
 * The context window of the model the router will actually call for the
 * workhorse alias right now. The router resolves the provider and model per
 * request from the providers store, so this reads the same store the same
 * way and looks the model up in the cached catalog. eve sizes compaction
 * from this number; a fixed 128k here made every model look that small.
 * Falls back to the policy window when the store, the credential or the
 * catalog cannot say.
 */
export function currentWindowTokens(): number {
  try {
    const resolved = resolveUpstream(readProviderStore(), "workhorse");
    const model = modelOption(resolved.providerId, resolved.modelId, catalogFor(resolved.connection.id));
    const tokens = model?.contextTokens;
    return Number.isInteger(tokens) && (tokens as number) > 0 ? (tokens as number) : POLICY_WINDOW_TOKENS;
  } catch {
    return POLICY_WINDOW_TOKENS;
  }
}

import { refreshChatGptCredential } from "./chatgpt-signin.ts";
import { isLegacyChatGptCredential, type Credential } from "./providers.ts";

/**
 * Credential refresh and token choice for OAuth sign-ins. The only sign-in
 * left is ChatGPT, a browser flow in shared/chatgpt-signin.ts (the GitHub
 * Copilot device flow was removed with its route, UB-015).
 */

type FetchFn = typeof fetch;

/** Refresh an OAuth credential: openai (Sign in with ChatGPT) uses the refresh_token grant in shared/chatgpt-signin.ts. */
export async function refreshCredential(
  providerId: string,
  credential: Credential,
  fetchImpl: FetchFn = fetch,
): Promise<Credential> {
  if (credential.kind !== "oauth") throw new Error("provider_oauth");
  // The impersonated Codex sign-in has no issued client id and cannot refresh.
  if (providerId === "openai") return await refreshChatGptCredential(credential, fetchImpl);
  throw new Error("provider_oauth");
}

/**
 * The token to send for one call. A ChatGPT sign-in made through the old Codex
 * route (no issued client id) reports expired, so it is never sent anywhere.
 */
export function accessTokenFor(
  providerId: string,
  credential: Credential,
): { token: string; expired: boolean; headers: Record<string, string> } {
  if (credential.kind === "key") return { token: credential.key, expired: false, headers: {} };
  if (credential.kind === "none") return { token: "", expired: false, headers: {} };
  if (isLegacyChatGptCredential(providerId, "oauth", credential)) {
    return { token: credential.accessToken, expired: true, headers: {} };
  }
  const expired = credential.expiresAt !== null && credential.expiresAt <= Date.now();
  return { token: credential.accessToken, expired, headers: {} };
}

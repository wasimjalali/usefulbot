import { runtimeConfig } from "./auth";

/**
 * Where Composio sends the browser back (S6). A phone session gets the
 * configured tailnet origin so the return lands back through Serve; desktop
 * keeps the loopback origin the service binds. Never derived from the
 * request, so a crafted Host header cannot point the OAuth redirect anywhere
 * else.
 */
export function connectorsCallbackUrl(profile: string): string {
  const tailnet = profile === "phone" ? runtimeConfig()?.tailnet : null;
  const base = tailnet?.httpsOrigin || process.env.UB_WEB_BASE_URL || "http://127.0.0.1:4320";
  return new URL("/api/connectors/callback", base).toString();
}

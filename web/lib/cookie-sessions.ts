import { cookies } from "next/headers";
import { dropBrowserSession, getBrowserSession, type BrowserSession } from "../../shared/web-sessions.ts";
import { COOKIE } from "./auth.ts";

/** Read the live browser session from the request cookie jar. */
export async function readSession(): Promise<BrowserSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  return getBrowserSession(token);
}

/** Drop the caller's browser session record. The cookie itself is cleared by
 * the caller's `clearSessionCookie()` response header. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) dropBrowserSession(token);
}

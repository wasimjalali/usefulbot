import { completeChatGptSignIn, revokeChatGptCredential } from "../../../../shared/chatgpt-signin.ts";
import { connectionId } from "../../../../shared/provider-catalog.ts";
import { requestIsLoopback } from "../../../../shared/origin.ts";
import { setActiveConnection, setOAuthCredential, updateProviderStore, type Credential, type ProviderStore } from "../../../../shared/providers.ts";
import { errorCode } from "../../../lib/api-guard";
import { activeUsable } from "../../../lib/providers-write";
import { syncProviderModels } from "../../../lib/sync-models";

export const runtime = "nodejs";

const PAGE = (heading: string, detail: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Useful Bot</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1b1a17; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #6b675f; }
  @media (prefers-color-scheme: dark) { body { background: #141311; color: #f1efe9; } p { color: #a7a29a; } }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  <p>${detail}</p>
</main>
</body>
</html>
`;

function html(heading: string, detail: string, status = 200) {
  return new Response(PAGE(heading, detail), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

const FAILED = "Sign-in failed";
const CLOSE = "You can close this tab and try again in Useful Bot.";

/** One plain sentence per error code. The code is all that is read from the sign-in server's answer. */
const FAILURES: Record<string, string> = {
  chatgpt_plan_not_enabled: "ChatGPT plan use isn't allowed for Useful Bot yet. Allow it in the sign-in screen, then try again in Useful Bot.",
  chatgpt_account_mismatch: "That is a different ChatGPT account from the saved one. Sign in with the saved account, or add this one as another account in Useful Bot.",
};

/**
 * OpenAI's Sign in with ChatGPT lands here on the numeric loopback. Only the
 * Mac that started the attempt can reach it, and the attempt's own state, kept
 * in the 0600 sign-in file, is what authorizes the result: a callback for any
 * other state is refused and leaves the live attempt alone.
 */
export async function GET(request: Request) {
  if (!requestIsLoopback(request.url)) {
    return html(FAILED, "The sign-in could not finish. You can close this tab and try again in Useful Bot.", 403);
  }
  const query = new URL(request.url).searchParams;
  try {
    // The credential is stored inside the attempt (before it settles complete),
    // so the poll can never report a sign-in that is not in the store.
    let replaced: Credential | undefined;
    let store: ProviderStore | undefined;
    const outcome = await completeChatGptSignIn({
      state: query.get("state"),
      code: query.get("code"),
      error: query.get("error"),
      clientId: query.get("client_id"),
    }, fetch, (credential) => {
      store = updateProviderStore((current) => {
        replaced = current.connections["openai:oauth"]?.credential;
        let next = setOAuthCredential(current, "openai", credential);
        if (!activeUsable(next)) next = setActiveConnection(next, connectionId("openai", "oauth"));
        return next;
      });
    });
    if (outcome.status === "repeat") {
      return html("You're signed in to ChatGPT", "You can close this tab and return to Useful Bot.");
    }
    if (outcome.status === "refused") {
      return html(FAILED, "This sign-in link is not the current one. You can close this tab and try again in Useful Bot.", 400);
    }
    if (outcome.status === "denied") {
      return html("Sign-in declined", "You declined the sign-in. You can close this tab; nothing was connected.");
    }
    if (outcome.status === "expired") {
      return html(FAILED, "The sign-in took too long. You can close this tab and try again in Useful Bot.");
    }
    if (outcome.status === "error") {
      return html(FAILED, FAILURES[outcome.error] ?? CLOSE);
    }
    // Another issued client replaced the stored sign-in (another account or
    // workspace): end the old session too. The same client signing in again
    // keeps its registration and is not revoked.
    if (replaced && replaced.kind === "oauth" && outcome.credential.kind === "oauth" && replaced.clientId
      && replaced.clientId !== outcome.credential.clientId && replaced.refreshToken) {
      if (!(await revokeChatGptCredential(replaced))) console.error("[useful-bot] chatgpt sign-in: revoke_unconfirmed");
    }
    try {
      if (store) await syncProviderModels(store, { force: true, alsoAwait: connectionId("openai", "oauth") });
    } catch (err) {
      // The sign-in is stored; the model list fills in on the next refresh.
      console.error(`[useful-bot] ChatGPT model list did not load: ${errorCode(err, "unknown")}`);
    }
    return html("You're signed in to ChatGPT", "You can close this tab and return to Useful Bot.");
  } catch (err) {
    // The code only: an error's own text can carry a piece of what the sign-in server answered.
    console.error(`[useful-bot] ChatGPT sign-in did not finish: ${errorCode(err, "unknown")}`);
    return html(FAILED, CLOSE, 400);
  }
}

import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../../../lib/desktop-gate";
import { errorCode, rateLimited } from "../../../../../lib/api-guard";
import { syncProviderModels } from "../../../../../lib/sync-models";
import {
  connectionId,
  parseConnectionId,
} from "../../../../../../shared/provider-catalog.ts";
import { activeUsable } from "../../../../../lib/providers-write";
import { cancelChatGptSignIn, isChatGptPollId, pollChatGptSignIn } from "../../../../../../shared/chatgpt-signin.ts";
import { cancelDeviceFlow, pollDeviceFlow } from "../../../../../../shared/provider-oauth.ts";
import {
  composerState,
  legacyProviders,
  publicProviders,
  readProviderStore,
  setActiveConnection,
  setOAuthCredential,
  updateProviderStore,
  type ProviderStore,
} from "../../../../../../shared/providers.ts";

export const runtime = "nodejs";

function legacyActiveId(store: ProviderStore): string | null {
  if (!store.activeConnectionId) return null;
  try {
    return parseConnectionId(store.activeConnectionId).providerId;
  } catch {
    return null;
  }
}

function payload(store: ProviderStore) {
  return {
    ok: true as const,
    ...publicProviders(store),
    composer: composerState(store),
    providers: legacyProviders(store),
    activeProviderId: legacyActiveId(store),
  };
}

/**
 * The poll route needs the provider of a pending device flow to store its
 * credential. The contract keeps pending entries in
 * ~/.useful-bot/provider-oauth.json (written by startDeviceFlow), so read the
 * matching entry out of that file without assuming one exact layout.
 */

/** Completing the flow writes the credential, so the poll is a POST with the CSRF header like every other write. */
export async function POST(request: Request, context: { params: Promise<{ pollId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`providers-oauth:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const { pollId } = await context.params;
  try {
    if (isChatGptPollId(pollId)) {
      // The loopback callback route already wrote the credential; this only
      // reports how the attempt ended.
      const result = pollChatGptSignIn(pollId);
      // An attempt settles complete only after the callback stored the credential.
      if (result.status === "complete") return NextResponse.json({ ...payload(readProviderStore()), status: "complete" });
      return NextResponse.json({
        ok: true,
        status: result.status,
        intervalMs: 1000,
        ...(result.error ? { error: result.error } : {}),
        ...(result.retryClientId ? { retryClientId: result.retryClientId } : {}),
      });
    }
    const result = await pollDeviceFlow(pollId);
    if (result.status === "complete" && result.credential) {
      const { providerId, credential } = result;
      if (!providerId) throw new Error("oauth_poll_unknown");
      const store = updateProviderStore((current) => {
        let next = setOAuthCredential(current, providerId, credential);
        if (!activeUsable(next)) next = setActiveConnection(next, connectionId(providerId, "oauth"));
        return next;
      });
      await syncProviderModels(store, { force: true, alsoAwait: connectionId(providerId, "oauth") });
      return NextResponse.json({ ...payload(store), status: "complete" });
    }
    return NextResponse.json({ ok: true, status: result.status, intervalMs: result.intervalMs ?? null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ pollId: string }> }) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`providers-oauth:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const { pollId } = await context.params;
  try {
    if (isChatGptPollId(pollId)) cancelChatGptSignIn(pollId);
    else cancelDeviceFlow(pollId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

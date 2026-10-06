import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { keyRejectedFor, syncProviderModels } from "../../../lib/sync-models";
import { cancelPendingChatGptSignIn, revokeChatGptCredential } from "../../../../shared/chatgpt-signin.ts";
import { connectionId, parseConnectionId } from "../../../../shared/provider-catalog.ts";
import { readShell } from "../../../../shared/shell-io.ts";
import type { ShellBot } from "../../../../shared/shell-store.ts";
import { botComposer } from "../../../../shared/session-selection.ts";
import {
  composerState,
  legacyProviders,
  ProviderRouteRetiredError,
  publicProviders,
  readProviderStore,
  type ProviderStore,
} from "../../../../shared/providers.ts";
import {
  applyProvidersDeleteCapturing,
  CONNECTION_REMOVED_BOTS_PINNED,
  applyProvidersPut,
  isStringRecord,
  legacyMode,
  type ProvidersPutBody,
} from "../../../lib/providers-write";

function legacyActiveId(store: ProviderStore): string | null {
  if (!store.activeConnectionId) return null;
  try {
    return parseConnectionId(store.activeConnectionId).providerId;
  } catch {
    return null;
  }
}

/**
 * The body every call answers with. With a bot, `composer` describes that
 * bot's own selection (its model, effort, speed and connection) and says
 * whether it can still run; without one it is the last pick, as before.
 */
function payload(store: ProviderStore, bot: ShellBot | null = null) {
  return {
    ok: true as const,
    ...publicProviders(store),
    composer: bot ? botComposer(bot, store) : composerState(store),
    providers: legacyProviders(store),
    activeProviderId: legacyActiveId(store),
  };
}

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (rateLimited(`providers:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const botId = new URL(request.url).searchParams.get("botId");
  let bot: ShellBot | null = null;
  if (botId !== null) {
    bot = readShell().bots.find((item) => item.id === botId) ?? null;
    if (!bot) return NextResponse.json({ ok: false, error: "shell_bot_missing" }, { status: 404 });
  }
  const store = readProviderStore();
  await syncProviderModels(store);
  return NextResponse.json(payload(store, bot));
}

export async function PUT(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`providers:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: ProvidersPutBody;
  try {
    body = await readJson(request) as ProvidersPutBody;
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (body.botId !== undefined && (typeof body.botId !== "string" || !body.botId)) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  // A pasted key is put to the vendor before it is stored, so one it turns
  // down never replaces a working key or shows as connected.
  if (typeof body.providerId === "string" && typeof body.key === "string" && body.key.trim()) {
    const mode = body.mode === undefined ? legacyMode(body.providerId) : body.mode;
    if (mode === "api" || mode === "plan") {
      try {
        const fields = isStringRecord(body.fields) ? body.fields : {};
        if (await keyRejectedFor(body.providerId, mode, body.key.trim(), fields)) {
          return NextResponse.json({ ok: false, error: "upstream_auth_failed" }, { status: 400 });
        }
      } catch (err) {
        return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
      }
    }
  }
  try {
    const { store, bot: answeredFor } = applyProvidersPut(body);
    // A key or field written to a connection that is not the active one needs
    // its list fetched with the new credential now, not on the cache TTL.
    const written = typeof body.providerId === "string"
      ? connectionId(body.providerId, body.mode === undefined ? legacyMode(body.providerId) : body.mode as "api" | "plan" | "local")
      : undefined;
    await syncProviderModels(store, { force: true, alsoAwait: written });
    return NextResponse.json(payload(store, answeredFor));
  } catch (err) {
    if (err instanceof ProviderRouteRetiredError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: 409 });
    }
    const code = errorCode(err);
    return NextResponse.json({ ok: false, error: code }, { status: code === "shell_bot_missing" ? 404 : 400 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`providers:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  let body: { connectionId?: unknown; providerId?: unknown };
  try {
    body = await readJson(request) as typeof body;
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    // Signing out of ChatGPT: first drop any sign-in still pending, so a
    // callback mid-exchange is refused and cannot bring the connection back.
    // Then delete, and only once the connection is gone end the renewable
    // session (best effort, bounded). A failed delete revokes nothing. The
    // saved account registrations stay for the next sign-in.
    if (body.connectionId === "openai:oauth" || body.providerId === "openai") cancelPendingChatGptSignIn();
    // The credential that was really removed, captured inside the delete's own
    // store transaction, is the one revoked.
    const { store, removedChatGpt: held } = applyProvidersDeleteCapturing(body);
    let notice: "chatgpt_revoke_unconfirmed" | undefined;
    if (held && held.kind === "oauth" && held.clientId && held.refreshToken) {
      if (!(await revokeChatGptCredential(held))) notice = "chatgpt_revoke_unconfirmed";
    }
    await syncProviderModels(store, { force: true });
    return NextResponse.json({ ...payload(store), ...(notice ? { notice } : {}) });
  } catch (err) {
    if (err instanceof Error && err.message === CONNECTION_REMOVED_BOTS_PINNED) {
      return NextResponse.json(
        { ok: false, error: "connection_removed_bots_pinned", message: CONNECTION_REMOVED_BOTS_PINNED },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

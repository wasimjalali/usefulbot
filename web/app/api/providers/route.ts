import { NextResponse } from "next/server";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { keyRejectedFor, syncProviderModels } from "../../../lib/sync-models";
import { isEffortId, isSpeedId } from "../../../../shared/models.ts";
import {
  connectionId,
  parseConnectionId,
  providerDef,
} from "../../../../shared/provider-catalog.ts";
import {
  clearConnection,
  clearProviderKey,
  composerState,
  legacyProviders,
  pickComposerModel,
  publicProviders,
  readProviderStore,
  setActiveConnection,
  setComposer,
  setProviderKey,
  setRole,
  updateProviderStore,
  type ProviderId,
  type ProviderStore,
} from "../../../../shared/providers.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Legacy provider ids map to their api connection, opencode-go to its plan. */
function legacyMode(providerId: string): "plan" | "api" {
  return providerId === "opencode-go" ? "plan" : "api";
}

function legacyConnectionId(providerId: string): string {
  return providerId === "opencode-go" ? "opencode-go:plan" : `${providerId}:api`;
}

/** Connected means a credential, or a local server that needs none. */
function connectionUsable(store: ProviderStore, id: string): boolean {
  const conn = store.connections[id];
  if (!conn) return false;
  return conn.credential.kind !== "none" || conn.mode === "local";
}

/**
 * The chat connection is usable when the stored active connection carries a
 * credential. A missing or Go-plan entry falls back to the implicit env key.
 */
function activeUsable(store: ProviderStore): boolean {
  const id = store.activeConnectionId;
  if (id && connectionUsable(store, id)) return true;
  if (id && id !== "opencode-go:plan") return false;
  return Boolean(process.env.UB_OPENCODE_GO_KEY);
}

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

export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  if (rateLimited(`providers:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  const store = readProviderStore();
  await syncProviderModels(store);
  return NextResponse.json(payload(store));
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
  let body: {
    providerId?: unknown;
    mode?: unknown;
    key?: unknown;
    fields?: unknown;
    activeConnectionId?: unknown;
    activeProviderId?: unknown;
    modelId?: unknown;
    effort?: unknown;
    speed?: unknown;
    roles?: unknown;
  };
  try {
    body = await readJson(request) as typeof body;
  } catch (err) {
    return apiError(err) ?? NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
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
    const store = updateProviderStore((current) => {
    let store = current;
    if (body.providerId !== undefined) {
      if (typeof body.providerId !== "string" || !body.providerId) throw new Error("provider_unknown");
      providerDef(body.providerId);
      const mode = body.mode === undefined ? legacyMode(body.providerId) : body.mode;
      if (mode !== "api" && mode !== "plan" && mode !== "local") throw new Error("provider_mode_unknown");
      if (body.fields !== undefined && !isStringRecord(body.fields)) throw new Error("provider_field");
      const key = typeof body.key === "string" ? body.key : undefined;
      store = setProviderKey(store, body.providerId, mode, key, isStringRecord(body.fields) ? body.fields : undefined);
      // Connect and Use are separate actions: only take over when the active
      // connection has no usable credential of its own.
      if (!activeUsable(store)) store = setActiveConnection(store, connectionId(body.providerId, mode));
    }
    if (body.activeConnectionId !== undefined || body.activeProviderId !== undefined) {
      const target = body.activeConnectionId !== undefined
        ? (typeof body.activeConnectionId === "string" ? body.activeConnectionId : "")
        : (typeof body.activeProviderId === "string" ? legacyConnectionId(body.activeProviderId) : "");
      store = setActiveConnection(store, target);
    }
    if (typeof body.modelId === "string") {
      // "<connectionId>::<modelId>" switches connection and model in one write.
      store = pickComposerModel(store, body.modelId);
    }
    if (body.effort !== undefined || body.speed !== undefined) {
      store = setComposer(store, {
        effort: body.effort === null || isEffortId(body.effort) ? body.effort : undefined,
        speed: isSpeedId(body.speed) ? body.speed : undefined,
      });
    }
    if (body.roles !== undefined) {
      if (!isRecord(body.roles)) throw new Error("invalid");
      for (const role of ["reviewer", "image"] as const) {
        const selection = body.roles[role];
        if (selection === null) {
          store = setRole(store, role, null);
        } else if (selection !== undefined) {
          if (!isRecord(selection) || typeof selection.connectionId !== "string" || typeof selection.modelId !== "string") {
            throw new Error("invalid");
          }
          store = setRole(store, role, {
            connectionId: selection.connectionId,
            modelId: selection.modelId,
            effort: isEffortId(selection.effort) ? selection.effort : null,
          });
        }
      }
    }
    return store;
    });
    // A key or field written to a connection that is not the active one needs
    // its list fetched with the new credential now, not on the cache TTL.
    const written = typeof body.providerId === "string"
      ? connectionId(body.providerId, body.mode === undefined ? legacyMode(body.providerId) : body.mode as "api" | "plan" | "local")
      : undefined;
    await syncProviderModels(store, { force: true, alsoAwait: written });
    return NextResponse.json(payload(store));
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
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
    const store = updateProviderStore((current) => {
      if (typeof body.connectionId === "string" && body.connectionId) {
        return clearConnection(current, body.connectionId);
      }
      if (typeof body.providerId === "string" && body.providerId) {
        providerDef(body.providerId);
        return clearProviderKey(current, body.providerId as ProviderId);
      }
      throw new Error("invalid");
    });
    await syncProviderModels(store, { force: true });
    return NextResponse.json(payload(store));
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

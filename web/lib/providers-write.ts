import { isEffortId, isSpeedId } from "../../shared/models.ts";
import {
  connectionId,
  providerDef,
} from "../../shared/provider-catalog.ts";
import { botSelection } from "../../shared/session-selection.ts";
import { readShell, updateShell } from "../../shared/shell-io.ts";
import { clearConnectionSelections, withBotSelection, type ShellBot, type ShellStore } from "../../shared/shell-store.ts";
import {
  applyBotPick,
  clearConnection,
  clearProviderKey,
  pickComposerModel,
  setActiveConnection,
  setComposer,
  setProviderKey,
  setRole,
  updateProviderStore,
  type ProviderId,
  type ProviderStore,
} from "../../shared/providers.ts";
import { ensureBotSelections } from "./agent-exec.ts";

/**
 * The write half of /api/providers, kept out of the route file so a test can
 * drive it without the Next request and cookie gate. The route owns the gate,
 * the vendor key check and the model list sync; this owns the stores.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Legacy provider ids map to their api connection, opencode-go to its plan. */
export function legacyMode(providerId: string): "plan" | "api" {
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
export function activeUsable(store: ProviderStore): boolean {
  const id = store.activeConnectionId;
  if (id && connectionUsable(store, id)) return true;
  if (id && id !== "opencode-go:plan") return false;
  return Boolean(process.env.UB_OPENCODE_GO_KEY);
}

export interface ProvidersPutBody {
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
  botId?: unknown;
}

/**
 * Apply one PUT. Returns the new store and, when the call named a bot, that
 * bot as it is now. Throws an error whose message is the API code; an unknown
 * bot throws `shell_bot_missing` before anything is written.
 */
export function applyProvidersPut(body: ProvidersPutBody): { store: ProviderStore; bot: ShellBot | null } {
  if (body.botId !== undefined && (typeof body.botId !== "string" || !body.botId)) throw new Error("invalid");
  const botId = body.botId as string | undefined;
  // A per-bot pick with an effort or speed that is not one of the known ids is
  // refused up front, not silently dropped to "unchanged".
  if (botId !== undefined) {
    if (body.effort !== undefined && body.effort !== null && !isEffortId(body.effort)) throw new Error("invalid_request");
    if (body.speed !== undefined && !isSpeedId(body.speed)) throw new Error("invalid_request");
    // A present modelId that is not a usable string would be skipped below and
    // the call would answer ok having changed nothing.
    if (body.modelId !== undefined && (typeof body.modelId !== "string" || !body.modelId)) throw new Error("invalid_request");
  }
  // Before the providers lock and before any write: an unknown bot changes nothing.
  if (botId !== undefined && !readShell().bots.some((item) => item.id === botId)) {
    throw new Error("shell_bot_missing");
  }
  const store = updateProviderStore((current) => {
    let store = current;
    let botPick: { botId: string; selection: ReturnType<typeof botSelection> } | null = null;
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
    if (botId !== undefined && (typeof body.modelId === "string" || body.effort !== undefined || body.speed !== undefined)) {
      // One bot's pick: that bot's selection changes, and the last pick follows
      // it. Stored exactly as asked, or refused with nothing written.
      const bot = readShell().bots.find((item) => item.id === botId);
      if (!bot) throw new Error("shell_bot_missing");
      const applied = applyBotPick(store, botSelection(bot, store), {
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        effort: body.effort === null || isEffortId(body.effort) ? body.effort : undefined,
        speed: isSpeedId(body.speed) ? body.speed : undefined,
      });
      store = applied.store;
      botPick = { botId, selection: applied.selection };
    } else {
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
    // Last, so a body that fails above (a bad pick, a bad role) leaves every
    // bot as it was. Bots that inherit the default are pinned to it here, from
    // `current` (the store before this pick moves the last pick), because this
    // per-bot pick is the one write that would otherwise move them. A connect,
    // a default-model change or a role write is not: those bots keep following
    // the default, as the old global chip did. A failure here aborts the
    // providers write too. The shell pins go BEFORE the providers write on
    // purpose: if that write fails after the pins, only bot B keeps its new
    // pick and nobody follows a moved default. The reverse order could let
    // null bots follow B's pick.
    if (botPick) {
      const { botId: pickedId, selection } = botPick;
      ensureBotSelections(current);
      updateShell((shell) => withBotSelection(shell, pickedId, selection));
    }
    return store;
  });
  const bot = botId === undefined ? null : readShell().bots.find((item) => item.id === botId) ?? null;
  if (botId !== undefined && !bot) throw new Error("shell_bot_missing");
  return { store, bot };
}

/** The DELETE error when resetting the bots that name a removed connection failed twice; the connection stays. */
export const CONNECTION_REMOVED_BOTS_PINNED =
  "The connection could not be removed because some bots that name it could not be reset. Try again.";

/**
 * Apply one DELETE. Bots pinned to a connection that goes away are reset to
 * inherit the default BEFORE the providers write, inside its update callback
 * (the same order as the PUT pins): a freeze can then never see "connection
 * gone, bot still pinned". An explicit owner action on the connection, visible
 * on every affected chip, not a substitution inside a running turn. If the
 * providers write then fails, the reset bots just inherit the unchanged default.
 * Every removed id is reset in ONE shell write (one retry), so a failure leaves
 * the roster exactly as it was, and the error is raised before the providers
 * write, so nothing is left half done.
 */
export function applyProvidersDelete(body: { connectionId?: unknown; providerId?: unknown }): ProviderStore {
  return updateProviderStore((current) => {
    let next: ProviderStore;
    if (typeof body.connectionId === "string" && body.connectionId) {
      next = clearConnection(current, body.connectionId);
    } else if (typeof body.providerId === "string" && body.providerId) {
      providerDef(body.providerId);
      next = clearProviderKey(current, body.providerId as ProviderId);
    } else {
      throw new Error("invalid");
    }
    const removed = Object.keys(current.connections).filter((id) => !next.connections[id]);
    if (removed.length > 0) {
      // One write for all ids: two writes could land the first and fail the
      // second, leaving some bots reset and the connections still there.
      const reset = (shell: ShellStore) => removed.reduce(clearConnectionSelections, shell);
      try {
        updateShell(reset);
      } catch {
        try {
          updateShell(reset);
        } catch {
          throw new Error(CONNECTION_REMOVED_BOTS_PINNED);
        }
      }
    }
    return next;
  });
}

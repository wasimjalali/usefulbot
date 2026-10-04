import { isEffortId, isSpeedId, type EffortId, type SpeedId } from "./models.ts";
import { parseConnectionId, providerMode } from "./provider-catalog.ts";
import { botComposerState, effectiveDefault, type ProviderStore } from "./providers.ts";
import type { ComposerPublic } from "./models.ts";

/**
 * What one bot runs on: the connection, the model and how hard it thinks.
 *
 * The owner picks it per bot (a group is a bot too). The global provider
 * store only keeps the LAST pick, as the default for a bot that has chosen
 * nothing yet. Nothing here reads a store at call time except `botSelection`,
 * so a turn that holds a selection cannot be moved by a later pick.
 */
export interface ModelSelection {
  connectionId: string;
  modelId: string;
  effort: EffortId | null;
  speed: SpeedId;
}

/** The selection a turn froze at its first step, with the window it sized compaction from. */
export interface TurnSelection extends ModelSelection {
  /** Context window the agent sized compaction from; set by the agent when it freezes the turn. */
  windowTokens: number;
}

/** Sent by the agent on every workhorse request of a turn; the router resolves it instead of the last pick. */
export const SELECTION_HEADER = "x-useful-selection";

/** Header values are bounded: a connection id, a model id and two short words. */
const HEADER_MAX = 2048;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("selection_header_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Strict: the caller built this selection, so anything off about it is a bug
 * to surface, not a value to repair.
 */
function assertSelection(raw: unknown): ModelSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("selection_header_invalid");
  const rec = raw as Record<string, unknown>;
  if (typeof rec.connectionId !== "string" || !rec.connectionId || rec.connectionId.length > 200) {
    throw new Error("selection_header_invalid");
  }
  if (typeof rec.modelId !== "string" || !rec.modelId || rec.modelId.length > 400) {
    throw new Error("selection_header_invalid");
  }
  if (rec.effort !== null && !isEffortId(rec.effort)) throw new Error("selection_header_invalid");
  if (!isSpeedId(rec.speed)) throw new Error("selection_header_invalid");
  return { connectionId: rec.connectionId, modelId: rec.modelId, effort: rec.effort, speed: rec.speed };
}

export function encodeSelectionHeader(sel: ModelSelection): string {
  const checked = assertSelection(sel);
  return toBase64Url(JSON.stringify({
    connectionId: checked.connectionId,
    modelId: checked.modelId,
    effort: checked.effort,
    speed: checked.speed,
  }));
}

/**
 * Absent header: null, today's behaviour (the last pick). A header that is
 * present and wrong throws: the router must refuse it, not guess a model.
 */
export function parseSelectionHeader(raw: string | null): ModelSelection | null {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > HEADER_MAX) throw new Error("selection_header_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw new Error("selection_header_invalid");
  }
  return assertSelection(parsed);
}

/**
 * Tolerant parse for the stores: a malformed `model` field on a bot or grant
 * reads as "no selection" (the bot then follows the last pick until it is
 * frozen) rather than making the whole roster unreadable.
 */
export function parseModelSelection(raw: unknown): ModelSelection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.connectionId !== "string" || !rec.connectionId || rec.connectionId.length > 200) return null;
  if (typeof rec.modelId !== "string" || !rec.modelId || rec.modelId.length > 400) return null;
  // The connection id is not checked against the catalogue on purpose: a
  // selection naming a vendor this build dropped must stay the bot's choice and
  // be refused as unavailable, not read as "none" and follow the last pick.
  return {
    connectionId: rec.connectionId,
    modelId: rec.modelId,
    effort: isEffortId(rec.effort) ? rec.effort : null,
    speed: isSpeedId(rec.speed) ? rec.speed : "standard",
  };
}

/**
 * What a bot with no model of its own runs on, and what a new bot starts with:
 * the model the old global chip showed (`effectiveDefault`: the last pick as
 * the composer resolves it, including its list-first stand-in for a stored
 * model that left a live list and the env Go plan fallback). When that cannot
 * carry a turn (nothing connected yet) it falls back to the raw stored pick,
 * with the Go plan's everyday model for holes, so a bot reads as unavailable
 * rather than as no selection.
 */
export function lastPick(store: ProviderStore): ModelSelection {
  const resolved = effectiveDefault(store);
  if (resolved) return resolved;
  const connectionId = store.activeConnectionId ?? "opencode-go:plan";
  const { providerId, mode } = parseConnectionId(connectionId);
  return {
    connectionId,
    modelId: store.selectedModel ?? providerMode(providerId, mode).defaults.workhorse,
    effort: store.effort,
    speed: store.speed,
  };
}

/** A bot's own selection, else the effective default (a bot that has not chosen follows it). */
export function botSelection(bot: { model: ModelSelection | null }, store: ProviderStore): ModelSelection {
  return bot.model ?? lastPick(store);
}

/**
 * The composer a bot's chip shows. A bot that never chose a model, with no
 * provider connected at all, has no model to name: the built-in default would
 * read as the owner's pick, so the label is blank (the chip says "Model") and
 * it stays unavailable. A chosen model that is gone keeps its name.
 */
export function botComposer(bot: { model: ModelSelection | null }, store: ProviderStore): ComposerPublic {
  const composer = botComposerState(store, botSelection(bot, store));
  if (bot.model || composer.groups.length > 0) return composer;
  return { ...composer, modelId: "", modelLabel: "" };
}

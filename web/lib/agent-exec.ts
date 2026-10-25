import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { libraryDrawingIds } from "../../shared/media-store.ts";
import { listWidgets, sweepOrphanWidgets } from "../../shared/widgets-store.ts";
import { sweepOrphanRoutines } from "../../shared/routines-store.ts";
import { peekShell, readShell, shellWasReseeded, updateShell } from "../../shared/shell-io.ts";
import { readWorkspaceStore, removeSessionGrant, upsertSessionGrant } from "../../shared/workspace-store.ts";
import { DESCRIPTION_MAX, freezeNullSelections, GENERALIST_SEED_V3, type ShellBot } from "../../shared/shell-store.ts";
import { botSelection, type ModelSelection } from "../../shared/session-selection.ts";
import { effectiveDefault, readProviderStore, type ProviderStore } from "../../shared/providers.ts";
import { seedFor, windowFor } from "../../shared/admission.ts";
import { statePath } from "../../shared/stack.ts";
import { engineBotContext } from "../../shared/engine-client.ts";

/**
 * What the web service still does for the engine's chats: re-stamp a grant
 * when the owner changes the folder or the permission, report the Settings
 * counter, and sweep the state a
 * deleted chat or bot leaves behind. The turns themselves, routines and the
 * resume after a connect card all run in the engine now.
 */

/**
 * What the Settings counter shows for one bot (GET /api/bots/context): its
 * instructions' length, the fixed envelope of a turn against the model's
 * window, and for the Generalist the shipped text with whether the saved one
 * differs. The envelope and the window come from the engine, which measures
 * its own prompt and tools. Null when the bot is not on the roster. Throws
 * `EngineUnavailableError` when the engine is down. Providers first, then the
 * roster, the order the freeze reads them in.
 */
export async function botContextReport(botId: string) {
  const store = readProviderStore();
  const shell = readShell();
  const bot = shell.bots.find((item) => item.id === botId);
  if (!bot) return null;
  const answer = await engineBotContext(botId);
  if (!answer.ok) throw new Error(typeof answer.body.error === "string" ? answer.body.error : "engine_error");
  const { windowTokens, envelopeTokens } = answer.body as { windowTokens?: unknown; envelopeTokens?: unknown };
  if (typeof windowTokens !== "number" || typeof envelopeTokens !== "number") throw new Error("engine_context_invalid");
  // The model's label only; the engine's own envelope and window are the numbers.
  const selection = botSelection(bot, store);
  const { modelLabel } = windowFor(selection.connectionId, selection.modelId);
  const descriptionChars = bot.description.length;
  return {
    descriptionChars,
    max: DESCRIPTION_MAX,
    envelopeTokens,
    windowTokens,
    modelLabel,
    fits: envelopeTokens <= windowTokens && descriptionChars <= DESCRIPTION_MAX,
    seed: seedFor(bot, GENERALIST_SEED_V3),
  };
}

/**
 * Stamp, or revoke, the workspace grant a chat's tools read. The engine writes
 * it at the start of every turn; this is for the moment the owner changes the
 * folder or the permission while a turn runs, so the capability follows the
 * owner's decision at once. The grant carries the model too, so one read gives
 * the tools both.
 */
export function syncSessionWorkspace(
  chatId: string,
  bot: ShellBot,
  // A caller that read the roster passes a store read taken BEFORE that roster
  // read: the same order the engine freezes in.
  store: ProviderStore = readProviderStore(),
  // A permission or folder change mid-turn re-stamps the grant but must not
  // move the turn's model. Such callers pass the selection the turn start
  // stamped, read before anything revoked the grant (a detach revokes it first).
  options: { keptSelection?: ModelSelection } = {},
): void {
  if (!chatId) return;
  // Always stamped: the permission is the bot's whether or not a folder is
  // attached. No folder means the bot works under the owner's home.
  upsertSessionGrant({
    chatId,
    path: bot.workspace?.path ?? null,
    permission: bot.permission,
    selection: options.keptSelection ?? botSelection(bot, store),
  });
}

/**
 * A permission or folder change takes effect now, not at the next turn, in
 * every chat: a turn or routine running in another chat re-reads its own
 * grant before it spends a card, so it must see the Read only the owner just
 * picked. The permission and folder are the bot's, and there is one bot, so
 * every grant is restamped. The selection each running turn was stamped with
 * is kept, so the change cannot move an in-flight turn's model. A grant that
 * can't be restamped is revoked: no grant reads as Read only (fail closed),
 * and the next turn's stamp restores it.
 */
export function restampWorkspaceGrants(botId: string): void {
  // Providers store first, then the roster, the order the turn freeze uses:
  // a per-bot pick pins this bot before it moves the default, so a store read
  // first never pairs with an older roster.
  const store = readProviderStore();
  const bot = readShell().bots.find((item) => item.id === botId);
  for (const grant of readWorkspaceStore().grants) {
    try {
      if (!bot) removeSessionGrant(grant.chatId);
      else syncSessionWorkspace(grant.chatId, bot, store, { keptSelection: grant.selection });
    } catch {
      try {
        removeSessionGrant(grant.chatId);
      } catch {
        /* a store locked twice in a row: the next turn's stamp settles it */
      }
    }
  }
}

/**
 * Pin every bot that has no model of its own to the effective default as it
 * stands now, so the per-bot pick that follows moves one bot only.
 *
 * A null bot inherits the default (the last pick, as the old global chip
 * resolved it), which is right until a pick would move it. This runs ONLY at
 * the start of a PUT /api/providers that carries a botId and any per-bot pick
 * (model, effort or speed), inside the providers lock, with the store that
 * call holds. Connect, sign-out, a
 * default-model change and the turn start leave null bots alone: they keep
 * inheriting, exactly as before. The pin is the effective default (the model
 * `composerState` resolves, with its snapped effort and speed), not the raw
 * stored model, so it is what the owner's chip showed. When that default is
 * not usable (nothing connected yet) nothing is pinned and the bots stay null,
 * by design: they had no running selection, so they follow the next usable pick.
 * Idempotent: bots that already chose are untouched.
 */
export function ensureBotSelections(providerStore: ProviderStore = readProviderStore()): void {
  if (!readShell().bots.some((bot) => bot.model === null)) return;
  const pick = effectiveDefault(providerStore);
  if (!pick) return;
  updateShell((current) => freezeNullSelections(current, pick));
}

/**
 * The chats the engine still has, by id, or null when its index cannot be read.
 * Read from `<stateRoot>/engine/chats.json` (SPEC 5.4): a chat counts while its
 * session file exists. A chat that has not written its first message has no
 * file yet and does not count, which is why a widget younger than the sweep's
 * grace window is never swept.
 */
function chatsWithSessionFile(): Set<string> | null {
  const path = statePath("engine", "chats.json");
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { chats?: unknown } | null;
    if (!raw || !Array.isArray(raw.chats)) return null;
    const live = new Set<string>();
    // The engine stores sessionFile relative to its own folder; this service's
    // working directory is elsewhere, so resolve against that folder.
    const engineDir = statePath("engine");
    for (const row of raw.chats) {
      const chat = row as { chatId?: unknown; sessionFile?: unknown } | null;
      if (typeof chat?.chatId === "string" && typeof chat.sessionFile === "string" && existsSync(resolve(engineDir, chat.sessionFile))) {
        live.add(chat.chatId);
      }
    }
    return live;
  } catch {
    return null;
  }
}

/**
 * Drop the routines of bots the roster no longer has, and the widget records
 * nothing keeps. Deleting a bot sweeps its own, but the roster and the routines
 * have separate locks: a delete that failed between them leaves work nothing
 * can ever complete. The tick calls this, which makes that state temporary.
 *
 * Returns the routine ids it dropped.
 */
export function sweepOrphanState(): string[] {
  // Under the test runner the sweep only runs against a temp widgets folder.
  // A test that isolated the stores but not the media folders once deleted
  // every real image and drawing on each run, so a miss fails the test
  // instead. Images are no longer swept at all (shared/media-store.ts).
  if (process.env.NODE_TEST_CONTEXT && (!process.env.UB_WIDGETS_DIR || !process.env.UB_MEDIA_INDEX_PATH)) {
    throw new Error("sweep under test needs UB_WIDGETS_DIR and UB_MEDIA_INDEX_PATH");
  }
  try {
    // `peekShell`, never `readShell`. A roster this process could not parse is
    // reseeded by `readShell` to a single default bot, and sweeping against
    // that would read every other bot's routines as orphans and delete all of
    // them. No roster means no sweep, and neither does a roster another
    // process already replaced with that stub: a reseed leaves valid JSON, so
    // only the marker can tell the two apart.
    //
    // While the mark stands the routines are left alone: the earlier bots are
    // archived records on the backup, not on the stub, and their routines must
    // survive until the owner restores it, however long that takes.
    const stub = shellWasReseeded();
    const shell = peekShell();
    if (!shell) return [];
    const live = shell.bots.map((bot) => bot.id);
    const routines = stub ? [] : sweepOrphanRoutines(live);
    // A widget stays while its chat's session file exists or the Library holds
    // the drawing. A null set means the index or the Library would not parse:
    // sweeping on that would read every drawing on the machine as an orphan,
    // so this tick does not sweep at all.
    const chats = chatsWithSessionFile();
    const inLibrary = libraryDrawingIds();
    if (chats && inLibrary) {
      const kept = listWidgets()
        .filter((record) => record.chatId && chats.has(record.chatId))
        .map((record) => record.id);
      sweepOrphanWidgets([...kept, ...inLibrary]);
    }
    return routines;
  } catch {
    // A locked or unreadable store is the next tick's problem, never this
    // tick's failure: the sweep is maintenance, not the work.
    return [];
  }
}

/**
 * The sweep the tick runs, at most once a minute. It is maintenance, not the
 * work, and at 6 ms of file reads per call it cost the event loop 145 ms a
 * minute at the tick's 2.5 s cadence. Direct deletion still cleans up at its
 * own call sites; this only decides how long a leftover can linger, which is
 * now a minute rather than a tick. The first tick after a start sweeps.
 */
export const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt: number | null = null;

export function sweepOrphanStateIfDue(now = Date.now()): string[] {
  if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) return [];
  lastSweepAt = now;
  return sweepOrphanState();
}

/** Test hook: the next tick sweeps again. */
export function resetSweepClock(): void {
  lastSweepAt = null;
}

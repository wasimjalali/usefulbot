import { basename } from "node:path";
import type { ContextSnapshot } from "../../shared/context-blocks.ts";
import { accountFullName, ownerName } from "../../shared/operator.ts";
import { botComposerState, publicProviders, readProviderStore, type ProviderStore } from "../../shared/providers.ts";
import { botSelection, type TurnSelection } from "../../shared/session-selection.ts";
import { peekShell } from "../../shared/shell-io.ts";
import type { ShellStore } from "../../shared/shell-store.ts";
import { readSessionGrant, type WorkspacePermission } from "../../shared/workspace-store.ts";
import { windowTokensFor } from "./model-window.ts";

/**
 * What one turn runs on, read once at turn start and held for the whole turn,
 * so the model, the context block and the tools all see one consistent pick.
 * `sessionId` holds the chat id (tools read it as `ctx.session.id`).
 */
export type OkSnapshot = {
  status: "ok";
  sessionId: string;
  turnId: string | undefined;
  botId: string;
  /** The selection every request of the turn sends, and the window compaction is sized from. */
  selection: TurnSelection;
  permission: WorkspacePermission;
  folder: string | null;
  /** What "This turn" says about the model. */
  model: { label: string; id: string; connection: string; connectionId: string };
  image: { label: string; id: string; provider: string; connectionId: string | null } | null;
  /** What the context block renders, read in the same pass as the selection. */
  context: ContextSnapshot;
};

let cachedOwner: string | undefined;

/**
 * The owner by the account's own name. Only a name read from the account is
 * kept: a fallback from a slow directory at login is tried again next turn.
 */
function ownerNames(): { owner: string; first: string } {
  cachedOwner ??= accountFullName() ?? undefined;
  const owner = cachedOwner ?? ownerName();
  return { owner, first: owner.split(/\s+/)[0] || owner };
}

export type SnapshotOptions = {
  /** True while the bot has no finished turn in any chat ("This is the owner's first chat with you"). */
  firstChat?: boolean;
  now?: Date;
  reads?: { store: () => ProviderStore; shell: () => ShellStore | null };
};

/**
 * One consistent read for one turn: the providers store FIRST, then the
 * shell (the web process moves a pick in the shell before the default in the
 * store, so store-first never pairs a fresh default with a stale pin). Throws
 * when the shell is unreadable or no longer has the bot. The caller stamps the
 * chat's workspace grant before this, because the grant is what the tools
 * enforce and so what the turn shows.
 */
export function buildSnapshot(
  botId: string,
  chatId: string,
  turnId: string | undefined,
  options: SnapshotOptions = {},
): OkSnapshot {
  const reads = options.reads ?? { store: readProviderStore, shell: peekShell };
  const store = reads.store();
  const shell = reads.shell();
  if (!shell) throw new Error("shell_unreadable");
  const bot = shell.bots.find((item) => item.id === botId);
  if (!bot) throw new Error("bot_missing");

  const picked = botSelection(bot, store);
  const selection: TurnSelection = { ...picked, windowTokens: windowTokensFor(picked) };
  const composer = botComposerState(store, picked);
  const image = publicProviders(store).roles.image;

  // What the tools enforce is the chat's grant (agent/lib/workspace.ts,
  // permission.ts), so that is what the turn shows: a chat with no grant is
  // Read only there, and the folder is the one the grant attached.
  const grant = readSessionGrant(chatId);
  const permission: WorkspacePermission = grant?.permission ?? "read_only";
  const folder = grant?.path ? basename(grant.path) : null;
  const { owner, first } = ownerNames();
  const model = {
    label: composer.modelLabel || picked.modelId,
    id: picked.modelId,
    connection: composer.providerName || picked.connectionId,
    connectionId: picked.connectionId,
  };
  const imageModel = image.modelId
    ? { label: image.modelLabel, id: image.modelId, provider: image.connectionLabel, connectionId: image.connectionId }
    : null;
  return {
    status: "ok",
    sessionId: chatId,
    turnId,
    botId,
    selection,
    permission,
    folder,
    model,
    image: imageModel,
    context: {
      bot: { name: bot.name, label: bot.label, description: bot.description },
      turn: {
        owner,
        first,
        date: options.now ?? new Date(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        permission,
        folder,
        model: { label: model.label, id: model.id, connection: model.connection },
        image: imageModel ? { label: imageModel.label, id: imageModel.id } : null,
        firstChat: options.firstChat ?? false,
      },
    },
  };
}

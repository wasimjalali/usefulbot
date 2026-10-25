import { parseModelSelection, type ModelSelection } from "./session-selection.ts";
import { foldPath } from "./fold-path.ts";
import { APP_STATE_DIR, isAppStateSegment, isRuntimeInstallPath } from "./stack.ts";

/** Client-safe: this file must never pull in node builtins. */
export type WorkspacePermission = "read_only" | "auto" | "full_access";

/**
 * "guard" is what Auto was called before this build; a store written then
 * still reads as the same posture instead of dropping the grant.
 */
export function parseWorkspacePermission(value: unknown): WorkspacePermission | null {
  if (value === "guard") return "auto";
  return value === "read_only" || value === "auto" || value === "full_access" ? value : null;
}

/**
 * Version 2 (SPEC 5.4): a bot keeps only its current `chatId`. The chat list
 * lives with the engine. A file of any other version does not parse, and
 * `readShell` reseeds it.
 */
export const SHELL_SCHEMA = 2;
export const DEFAULT_BOT_ID = "bot-useful";
export const PREVIEW_MAX = 160;

const NAME_MAX = 80;
const LABEL_MAX = 24;
/** A bot's standing instructions. Over this is refused, never clipped. */
export const DESCRIPTION_MAX = 8000;

/**
 * The folder this conversation works in. The path is a folder the owner
 * picked in a desktop picker; the permission decides what the agent may do
 * inside it (see `agent/lib/workspace.ts`).
 */
export type BotWorkspace = {
  path: string;
  permission: WorkspacePermission;
};

export type ShellBot = {
  id: string;
  name: string;
  label: string;
  description: string;
  notify: boolean;
  /** The bot's current chat (an engine chat id), or null before its first one. */
  chatId: string | null;
  lastPreview: string;
  lastAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * What this bot may do on this Mac: in the attached folder when there is
   * one, otherwise under the owner's home. The folder is where; this is how
   * much. `workspace.permission` mirrors it for older readers.
   */
  permission: WorkspacePermission;
  workspace: BotWorkspace | null;
  /**
   * The model, connection, effort and speed this bot runs on. Null means it
   * inherits the default (the last pick, as the old global chip resolved it).
   * A bot is pinned only where a pick would otherwise move it: a per-bot chip
   * pick pins every null bot first (ensureBotSelections). Every create path
   * leaves it null, and so does a roster from before this field.
   */
  model: ModelSelection | null;
};

export type BotProfilePatch = Partial<
  Pick<
    ShellBot,
    | "name"
    | "label"
    | "description"
    | "notify"
    | "lastPreview"
  >
>;

export type ShellStore = {
  schemaVersion: 2;
  selectedBotId: string;
  bots: ShellBot[];
};

export type ShellAction =
  | { type: "renameBot"; botId: string; name: string }
  | {
      type: "updateBot";
      botId: string;
      patch: BotProfilePatch;
    }
  | {
      type: "setWorkspace";
      botId: string;
      workspace: BotWorkspace | null;
    }
  | { type: "setPermission"; botId: string; permission: WorkspacePermission };

const ACTION_TYPES = {
  renameBot: true,
  updateBot: true,
  setWorkspace: true,
  setPermission: true,
} satisfies Record<ShellAction["type"], true>;

/**
 * Whether `value` names an action this build takes: one `applyShellAction`
 * runs, or one of the two card confirms (`connectApp`, `connectServer`) the
 * shell route handles itself. Anything else, a removed action included, is
 * refused by the route as `invalid`.
 */
export function isShellActionType(value: unknown): boolean {
  return typeof value === "string"
    && (Object.hasOwn(ACTION_TYPES, value) || value === "connectApp" || value === "connectServer");
}

export function nowIso(at = new Date()): string {
  return at.toISOString();
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * The one check every write path runs on a description. Returns the trimmed
 * text and throws `shell_description_too_long` over the cap: a silent clip
 * would change the owner's instructions without telling anyone.
 */
export function checkDescription(value: string, max = DESCRIPTION_MAX): string {
  const text = value.trim();
  if (text.length > max) throw new Error("shell_description_too_long");
  return text;
}

function requireName(value: string, max = NAME_MAX): string {
  const name = clip(value, max);
  if (!name) throw new Error("shell_name_required");
  return name;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

/** The Generalist's shipped instructions today (`generalist-v3`). Owner-editable. */
export const GENERALIST_SEED_V3 = `You're the owner's main assistant on this Mac: research, writing, files, small scripts, diagrams and work in their connected apps.

How to help:
- Start by doing. Ask one question only when the goal or the target is unclear.
- On longer work, keep the owner posted in short lines, then give the result on its own.
- Be direct and brief. Say plainly when something failed or isn't possible, and what would help.

Preferences:
- Show a draft before anything goes out in the owner's name.
- Say what you'll change before a large edit.
- When the owner is new, explain the app only as far as their task needs.`;

/** The one bot's name. It is fixed: the owner can't rename it. */
export const DEFAULT_BOT_NAME = "Useful Bot";

function assertNameNotFixed(botId: string): void {
  if (botId === DEFAULT_BOT_ID) throw new Error("shell_bot_name_fixed");
}

export function seedStore(at = new Date()): ShellStore {
  const stamp = nowIso(at);
  return {
    schemaVersion: 2,
    selectedBotId: DEFAULT_BOT_ID,
    bots: [
      {
        id: DEFAULT_BOT_ID,
        name: DEFAULT_BOT_NAME,
        label: "",
        description: GENERALIST_SEED_V3,
        notify: false,
        chatId: null,
        lastPreview: "",
        lastAt: null,
        createdAt: stamp,
        updatedAt: stamp,
        permission: "auto",
        workspace: null,
        model: null,
      },
    ],
  };
}

function parseBot(raw: unknown): ShellBot {
  if (!raw || typeof raw !== "object") throw new Error("shell_bot_invalid");
  const rec = raw as Record<string, unknown>;
  // Unknown fields are ignored so a newer build's store stays readable here;
  // a full-store overwrite is no longer accepted over the API.
  if (!isId(rec.id)) throw new Error("shell_bot_id");
  if (typeof rec.name !== "string") throw new Error("shell_bot_name");
  if (typeof rec.label !== "string") throw new Error("shell_bot_label");
  if (typeof rec.description !== "string") throw new Error("shell_bot_description");
  if (typeof rec.notify !== "boolean") throw new Error("shell_bot_notify");
  if (rec.chatId !== undefined && rec.chatId !== null && !isId(rec.chatId)) throw new Error("shell_bot_chat");
  if (typeof rec.createdAt !== "string" || typeof rec.updatedAt !== "string") {
    throw new Error("shell_bot_dates");
  }
  if (rec.lastPreview !== undefined && typeof rec.lastPreview !== "string") {
    throw new Error("shell_bot_preview");
  }
  if (rec.lastAt !== undefined && rec.lastAt !== null && typeof rec.lastAt !== "string") {
    throw new Error("shell_bot_last_at");
  }
  return {
    id: rec.id,
    name: clip(rec.name, NAME_MAX) || rec.id,
    label: clip(rec.label, LABEL_MAX),
    // Kept verbatim, whatever the length. A throw here makes readShell reseed
    // the whole store; the cap is enforced when a description is written and
    // when a turn is sent, not when the file is read.
    description: rec.description.trim(),
    notify: rec.notify,
    chatId: typeof rec.chatId === "string" ? rec.chatId : null,
    lastPreview: typeof rec.lastPreview === "string" ? clip(rec.lastPreview, PREVIEW_MAX) : "",
    lastAt: typeof rec.lastAt === "string" ? rec.lastAt : null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    // A roster written before the permission lived on the bot carried it on
    // the folder; that value is kept rather than reset to the default.
    permission: parseWorkspacePermission(rec.permission)
      ?? parseWorkspace(rec.workspace)?.permission
      ?? "auto",
    workspace: parseWorkspace(rec.workspace),
    model: parseModelSelection(rec.model),
  };
}

/**
 * Tolerant: a malformed workspace field is no workspace, never a failure.
 *
 * Screened the same way a write is. A hand-edited roster naming `/` or a
 * credential folder would otherwise parse into a bot field the grants store
 * then refuses, which turns one bot's chat into a turn that cannot start.
 * Reading it as no folder is the honest answer: the owner reattaches.
 */
function parseWorkspace(raw: unknown): BotWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.path !== "string" || !isGrantableRootPath(rec.path)) return null;
  const permission = parseWorkspacePermission(rec.permission);
  if (!permission) return null;
  return { path: rec.path, permission };
}

/**
 * A grant path is a capability root: absolute, bounded, and not a folder whose
 * own name says it holds credentials. The route validates the filesystem side
 * (real directory, not a symlink); this is the shape rule, and it is the same
 * rule the grants store applies, so a bot field can never carry a path the
 * grant built from it would reject.
 */
function assertGrantableRootPath(path: unknown): string {
  if (typeof path !== "string" || path.length > 1024 || !isGrantableRootPath(path)) {
    throw new Error("workspace_path_invalid");
  }
  return path;
}

/**
 * Strict on writes: an unknown permission word must fail the action, not
 * silently become Auto. The read path above stays tolerant — a newer build's
 * store stays readable — but a write with a value this build does not know is
 * a caller bug.
 */
function parseWorkspacePermissionStrict(value: unknown): WorkspacePermission {
  const parsed = parseWorkspacePermission(value);
  if (!parsed) throw new Error("workspace_permission_invalid");
  return parsed;
}

export function isGrantableRootPath(path: string): boolean {
  if (!path.startsWith("/") || path.length > 1024) return false;
  // The filesystem root has no segments to screen, so every check below would
  // pass it while it covers every credential store on the machine. A grant is
  // a folder the owner picked, never the whole disk.
  if (path.replace(/\/+$/, "") === "") return false;
  // The runtime install folders span three segments (Library/Application
  // Support/Useful Bot[ Dev]), so they cannot be a per-segment name.
  if (isRuntimeInstallPath(path)) return false;
  for (const segment of path.split("/")) {
    if (!segment) continue;
    if (segment === "..") return false;
    const lowered = foldPath(segment);
    if (isForbiddenGrantSegment(lowered)) return false;
  }
  return true;
}

/**
 * Credential stores with one exact name. Screened per path segment rather than
 * as a substring, so `.dockerignore` at a project root stays readable while
 * `.docker/config.json` does not. Used for the grant root and, in
 * `resolveWorkspacePath`, for everything under it.
 */
const FORBIDDEN_CHILD_SEGMENTS = new Set([
  // The app's own stores: approvals, the roster, the grants. A bot that
  // could edit these could approve itself. This is the exact name only;
  // `isForbiddenChildSegment` adds the dashed siblings (.useful-bot-dev,
  // .useful-bot-dev-app), so go through it rather than `.has()`.
  APP_STATE_DIR,
  // Shell startup files: a line planted in one runs in the owner's own
  // shell next time they open a terminal, outside every gate here.
  ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
  ".bash_profile", ".bashrc", ".bash_login", ".bash_logout", ".profile",
  ".inputrc", ".hushlogin", "config.fish",
  ".docker",
  ".kube",
  ".pypirc",
  ".authinfo",
  ".netrc",
  ".npmrc",
  "keychains",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
]);

/** A segment that is a credential store or one of the app's own state folders. */
export function isForbiddenChildSegment(lowered: string): boolean {
  return FORBIDDEN_CHILD_SEGMENTS.has(lowered) || isAppStateSegment(lowered);
}

const FORBIDDEN_GRANT_SEGMENTS = new Set([
  ...FORBIDDEN_CHILD_SEGMENTS,
  ".env",
  ".ssh",
  ".aws",
  ".gnupg",
  ".git",
  "auth.json",
  "secrets",
  "launchagents",
  // Only the root gets these: `keychain` and `cookies` name real stores on
  // macOS, and a folder called either is not a project. Under the root the
  // substring screen already covers `Library/Keychains` and `Library/Cookies`
  // without refusing a `cookies` directory in someone's source tree.
  "keychain",
  "netrc",
  "cookies",
]);

function isForbiddenGrantSegment(lowered: string): boolean {
  return FORBIDDEN_GRANT_SEGMENTS.has(lowered) || isAppStateSegment(lowered);
}

export function parseShell(raw: unknown): ShellStore {
  if (!raw || typeof raw !== "object") throw new Error("shell_invalid");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== SHELL_SCHEMA) throw new Error("shell_schema");
  if (!Array.isArray(rec.bots)) throw new Error("shell_shape");
  const bots = rec.bots.map(parseBot);
  if (bots.length === 0) throw new Error("shell_empty");
  const botIds = new Set(bots.map((bot) => bot.id));
  if (botIds.size !== bots.length) throw new Error("shell_bot_duplicate");
  const selectedBotId = isId(rec.selectedBotId) && bots.some((bot) => bot.id === rec.selectedBotId)
    ? rec.selectedBotId
    : (bots.find((bot) => bot.id === DEFAULT_BOT_ID) ?? bots[0]).id;
  return { schemaVersion: 2, selectedBotId, bots };
}

function touch(bot: ShellBot, at: string, patch: Partial<ShellBot>): ShellBot {
  return { ...bot, ...patch, updatedAt: at };
}

export function applyShellAction(
  store: ShellStore,
  action: ShellAction,
  at = new Date(),
): { store: ShellStore } {
  const stamp = nowIso(at);
  switch (action.type) {
    case "renameBot": {
      assertNameNotFixed(action.botId);
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId ? touch(bot, stamp, { name: requireName(action.name) }) : bot
          )),
        },
      };
    }
    case "updateBot": {
      const patch: Partial<ShellBot> = {};
      if (action.patch.name !== undefined) {
        if (action.botId === DEFAULT_BOT_ID && clip(action.patch.name, NAME_MAX) !== DEFAULT_BOT_NAME) assertNameNotFixed(action.botId);
        const name = clip(action.patch.name, NAME_MAX);
        if (name) patch.name = name;
      }
      if (action.patch.label !== undefined) patch.label = clip(action.patch.label, LABEL_MAX);
      if (action.patch.description !== undefined) patch.description = checkDescription(action.patch.description);
      if (action.patch.notify !== undefined) patch.notify = action.patch.notify;
      if (action.patch.lastPreview !== undefined) {
        patch.lastPreview = clip(action.patch.lastPreview, PREVIEW_MAX);
        patch.lastAt = stamp;
      }
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (bot.id === action.botId ? touch(bot, stamp, patch) : bot)),
        },
      };
    }
    case "setWorkspace": {
      if (!store.bots.some((bot) => bot.id === action.botId)) throw new Error("shell_bot_missing");
      // The route validates the folder exists before calling; the store only
      // enforces shape. An explicit null detaches the folder.
      const workspace = action.workspace === null ? null : {
        path: assertGrantableRootPath(action.workspace.path),
        permission: parseWorkspacePermissionStrict(action.workspace.permission),
      } satisfies BotWorkspace | null;
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId
              // The folder carries the same permission as the bot: one value,
              // written in both places, so neither reader can disagree.
              ? touch(bot, stamp, { workspace, ...(workspace ? { permission: workspace.permission } : {}) })
              : bot
          )),
        },
      };
    }
    case "setPermission": {
      if (!store.bots.some((bot) => bot.id === action.botId)) throw new Error("shell_bot_missing");
      const permission = parseWorkspacePermissionStrict(action.permission);
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId
              ? touch(bot, stamp, {
                permission,
                workspace: bot.workspace ? { ...bot.workspace, permission } : null,
              })
              : bot
          )),
        },
      };
    }
    default:
      throw new Error("shell_action_unknown");
  }
}

/**
 * Give every bot that has no selection the one passed in (the last pick as it
 * stands now). Bots that already chose are untouched, so it is idempotent.
 */
export function freezeNullSelections(store: ShellStore, pick: ModelSelection): ShellStore {
  if (!store.bots.some((bot) => bot.model === null)) return store;
  return {
    ...store,
    bots: store.bots.map((bot) => (bot.model === null ? { ...bot, model: { ...pick } } : bot)),
  };
}

/**
 * Reset every bot pinned to one connection back to "inherit the default"
 * (null). Used when the owner signs that connection out: the bot's chip then
 * shows the new default instead of an unavailable model.
 */
export function clearConnectionSelections(store: ShellStore, connectionId: string): ShellStore {
  if (!store.bots.some((bot) => bot.model?.connectionId === connectionId)) return store;
  return {
    ...store,
    bots: store.bots.map((bot) => (bot.model?.connectionId === connectionId ? { ...bot, model: null } : bot)),
  };
}

/** Set one bot's selection. Only that row changes, so a pick never moves another bot. */
export function withBotSelection(store: ShellStore, botId: string, selection: ModelSelection): ShellStore {
  if (!store.bots.some((bot) => bot.id === botId)) throw new Error("shell_bot_missing");
  return {
    ...store,
    bots: store.bots.map((bot) => (bot.id === botId ? { ...bot, model: { ...selection } } : bot)),
  };
}

/**
 * Records a bot's current chat and its last preview when a turn settles or a
 * chat is made current (SPEC 5.4). The engine calls it under the shell lock
 * through `updateShell`. A null preview leaves the last preview as it is.
 */
export function setBotChat(store: ShellStore, botId: string, chatId: string | null, preview: string | null, at: string): ShellStore {
  if (chatId !== null && !isId(chatId)) throw new Error("shell_bot_chat");
  if (!store.bots.some((bot) => bot.id === botId)) throw new Error("shell_bot_missing");
  return {
    ...store,
    bots: store.bots.map((bot) => (
      bot.id === botId
        ? touch(bot, at, {
          chatId,
          ...(preview === null ? {} : { lastPreview: clip(preview, PREVIEW_MAX) }),
          lastAt: at,
        })
        : bot
    )),
  };
}

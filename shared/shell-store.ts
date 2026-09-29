import {
  defaultFaceFor,
  isAvatarColor,
  isAvatarShape,
  parseAvatarImage,
  type AvatarColor,
  type AvatarShape,
} from "./bot-face.ts";

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

export const SHELL_SCHEMA = 1;
export const DEFAULT_BOT_ID = "bot-useful";
export const UNASSIGNED_SECTION = "unassigned";
export const HIDDEN_SECTION = "hidden";
export const RECENTS_MAX = 40;
export const PREVIEW_MAX = 160;
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;

const NAME_MAX = 80;
const LABEL_MAX = 24;
const DESCRIPTION_MAX = 500;

export type BotKind = "bot" | "group";

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
  kind: BotKind;
  name: string;
  /** Name while the bot is still being onboarded. Cleared once it has a real one. */
  petname: string | null;
  label: string;
  description: string;
  notify: boolean;
  pinned: boolean;
  hidden: boolean;
  sectionId: string | null;
  sessionId: string | null;
  /**
   * Sessions this bot's chat was carried over from, newest first, recorded
   * only when a replacement session was opened with a brief of the old one
   * (see continuation-brief.ts). The proxy checks a `continueFrom` against
   * the live pointer and this list before it reads an old session. A new
   * chat or an opened recent is a deliberate fresh start and is not recorded.
   */
  previousSessionIds?: string[];
  /** The session the last carry-over opened. */
  continuedSessionId?: string;
  /**
   * True once that session has finished a turn, so its brief is in eve's
   * history. Until then a step-zero failure can have dropped the message that
   * carried it, and sends into the session attach the brief again.
   */
  continuationSettled?: boolean;
  memberIds: string[];
  lastPreview: string;
  lastAt: string | null;
  createdAt: string;
  updatedAt: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  avatarImage: string | null;
  avatarCustom: boolean;
  /**
   * What this bot may do on this Mac: in the attached folder when there is
   * one, otherwise under the owner's home. The folder is where; this is how
   * much. `workspace.permission` mirrors it for older readers.
   */
  permission: WorkspacePermission;
  workspace: BotWorkspace | null;
};

export type BotProfilePatch = Partial<
  Pick<
    ShellBot,
    | "name"
    | "petname"
    | "label"
    | "description"
    | "notify"
    | "memberIds"
    | "lastPreview"
    | "avatarShape"
    | "avatarColor"
    | "avatarImage"
    | "avatarCustom"
  >
>;

export type ShellRecent = {
  id: string;
  botId: string;
  title: string;
  sessionId: string | null;
  preview: string;
  updatedAt: string;
};

export type ShellSection = {
  id: string;
  name: string;
  collapsed: boolean;
  order: number;
};

export type ShellStore = {
  schemaVersion: 1;
  selectedBotId: string;
  collapsedUnassigned: boolean;
  collapsedHidden: boolean;
  bots: ShellBot[];
  sections: ShellSection[];
  recents: ShellRecent[];
};

export type ShellAction =
  | { type: "select"; botId: string }
  | {
      type: "createBot";
      name: string;
      petname?: string;
      label?: string;
      description?: string;
      sectionId?: string | null;
      kind?: BotKind;
    }
  | {
      type: "createGroup";
      name: string;
      memberIds: string[];
      label?: string;
      description?: string;
      sectionId?: string | null;
    }
  | { type: "createSection"; name: string }
  | { type: "renameBot"; botId: string; name: string }
  | { type: "nameBot"; botId: string; name: string; label?: string; description?: string; avatarShape?: string; avatarColor?: string }
  | { type: "renameSection"; sectionId: string; name: string }
  | {
      type: "updateBot";
      botId: string;
      patch: BotProfilePatch;
    }
  | { type: "pin"; botId: string; pinned?: boolean }
  | { type: "hide"; botId: string; hidden?: boolean }
  | { type: "deleteBot"; botId: string }
  | { type: "deleteSection"; sectionId: string }
  | { type: "move"; botId: string; sectionId: string | null }
  | { type: "setSession"; botId: string; sessionId: string | null }
  | {
      type: "setWorkspace";
      botId: string;
      workspace: BotWorkspace | null;
    }
  | { type: "setPermission"; botId: string; permission: WorkspacePermission }
  | { type: "sendToBot"; botId: string; message: string; sourceBotId?: string | null }
  | { type: "touchChat"; botId: string; preview: string; sessionId?: string | null }
  | { type: "newChat"; botId?: string }
  | { type: "clearThread"; botId: string }
  | { type: "openRecent"; recentId: string }
  | { type: "toggleSection"; sectionId: string };

export function nowIso(at = new Date()): string {
  return at.toISOString();
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function requireName(value: string, max = NAME_MAX): string {
  const name = clip(value, max);
  if (!name) throw new Error("shell_name_required");
  return name;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

export function seedStore(at = new Date()): ShellStore {
  const stamp = nowIso(at);
  return {
    schemaVersion: 1,
    selectedBotId: DEFAULT_BOT_ID,
    collapsedUnassigned: false,
    collapsedHidden: true,
    sections: [],
    bots: [
      {
        id: DEFAULT_BOT_ID,
        kind: "bot",
        name: "Generalist",
        petname: null,
        label: "",
        description: "The starter bot. General work on this Mac, and creates other bots with a name and instructions.",
        notify: false,
        pinned: false,
        hidden: false,
        sectionId: null,
        sessionId: null,
        memberIds: [],
        lastPreview: "",
        lastAt: null,
        createdAt: stamp,
        updatedAt: stamp,
        avatarShape: "circle",
        avatarColor: "ink",
        avatarImage: null,
        avatarCustom: false,
        permission: "auto",
        workspace: null,
      },
    ],
    recents: [],
  };
}

function parseBot(raw: unknown): ShellBot {
  if (!raw || typeof raw !== "object") throw new Error("shell_bot_invalid");
  const rec = raw as Record<string, unknown>;
  // Unknown fields are ignored so a newer build's store stays readable here;
  // a full-store overwrite is no longer accepted over the API.
  if (!isId(rec.id)) throw new Error("shell_bot_id");
  if (rec.kind !== "bot" && rec.kind !== "group") throw new Error("shell_bot_kind");
  if (typeof rec.name !== "string") throw new Error("shell_bot_name");
  if (typeof rec.label !== "string") throw new Error("shell_bot_label");
  if (typeof rec.description !== "string") throw new Error("shell_bot_description");
  if (typeof rec.notify !== "boolean") throw new Error("shell_bot_notify");
  if (typeof rec.pinned !== "boolean") throw new Error("shell_bot_pinned");
  if (typeof rec.hidden !== "boolean") throw new Error("shell_bot_hidden");
  if (rec.sectionId !== null && !isId(rec.sectionId)) throw new Error("shell_bot_section");
  if (rec.sessionId !== null && typeof rec.sessionId !== "string") throw new Error("shell_bot_session");
  if (!Array.isArray(rec.memberIds) || rec.memberIds.some((id) => typeof id !== "string")) {
    throw new Error("shell_bot_members");
  }
  if (typeof rec.createdAt !== "string" || typeof rec.updatedAt !== "string") {
    throw new Error("shell_bot_dates");
  }
  if (rec.lastPreview !== undefined && typeof rec.lastPreview !== "string") {
    throw new Error("shell_bot_preview");
  }
  if (rec.lastAt !== undefined && rec.lastAt !== null && typeof rec.lastAt !== "string") {
    throw new Error("shell_bot_last_at");
  }
  const face = defaultFaceFor(rec.id);
  return {
    id: rec.id,
    kind: rec.kind,
    name: clip(rec.name, NAME_MAX) || rec.id,
    petname: typeof rec.petname === "string" ? clip(rec.petname, NAME_MAX) || null : null,
    label: clip(rec.label, LABEL_MAX),
    description: clip(rec.description, DESCRIPTION_MAX),
    notify: rec.notify,
    pinned: rec.pinned,
    hidden: rec.hidden,
    sectionId: rec.sectionId,
    sessionId: rec.sessionId,
    ...(Array.isArray(rec.previousSessionIds)
      ? {
        previousSessionIds: rec.previousSessionIds
          .filter((id): id is string => typeof id === "string" && SESSION_ID.test(id))
          .slice(0, PREVIOUS_SESSIONS_MAX),
      }
      : {}),
    ...(typeof rec.continuedSessionId === "string" && SESSION_ID.test(rec.continuedSessionId)
      ? { continuedSessionId: rec.continuedSessionId }
      : {}),
    ...(rec.continuationSettled === true ? { continuationSettled: true } : {}),
    memberIds: rec.memberIds.filter((id, index, all) => all.indexOf(id) === index),
    lastPreview: typeof rec.lastPreview === "string" ? clip(rec.lastPreview, PREVIEW_MAX) : "",
    lastAt: typeof rec.lastAt === "string" ? rec.lastAt : null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    avatarShape: isAvatarShape(rec.avatarShape) ? rec.avatarShape : face.shape,
    avatarColor: isAvatarColor(rec.avatarColor) ? rec.avatarColor : face.color,
    avatarImage: parseAvatarImage(rec.avatarImage),
    avatarCustom: typeof rec.avatarCustom === "boolean" ? rec.avatarCustom : rec.id !== DEFAULT_BOT_ID,
    // A roster written before the permission lived on the bot carried it on
    // the folder; that value is kept rather than reset to the default.
    permission: parseWorkspacePermission(rec.permission)
      ?? parseWorkspace(rec.workspace)?.permission
      ?? "auto",
    workspace: parseWorkspace(rec.workspace),
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

/**
 * Screen a folder root by PATH SEGMENT before it becomes a grant. A folder
 * named `my.github-project` is fine; one whose own name is `.ssh`, `secrets`
 * or `auth.json` is where credentials live, so it is refused at attach time.
 * Anything under the granted root keeps the substring screen in
 * `resolveWorkspacePath`.
 */
/**
 * The session ids whose folder grant an action just invalidated.
 *
 * A grant is keyed by eve session id, so it stops being the owner's decision
 * the moment a bot stops holding that session. Rather than listing the actions
 * that do it — `newChat`, `clearThread`, `deleteBot`, but also `sendToBot`,
 * `touchChat`, `setSession` and `openRecent`, which rotate a session quietly —
 * this diffs the roster: every session id a bot held before the commit and
 * nobody holds after it. A session that simply moved between bots is still
 * held, so it survives. A detach keeps its session id, which the diff cannot
 * see, so that one case is named.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIOUS_SESSIONS_MAX = 5;

/**
 * Whether a turn may be carried over from `sessionId`:
 * - "allowed": it is the bot's live session, or the session the last
 *   carry-over opened (the client may hold that one before its pointer write
 *   lands).
 * - "moved": it was already carried over into a newer session. Carrying it
 *   over again would fork the chat, so the client is told to catch up.
 * - "refused": anything else. Fails closed, so a crafted id cannot read
 *   another bot's conversation.
 */
export function continueFromVerdict(bot: ShellBot, sessionId: string): "allowed" | "moved" | "refused" {
  if (!SESSION_ID.test(sessionId)) return "refused";
  // First: a session already carried over stays moved even while some
  // client's pointer still names it.
  if ((bot.previousSessionIds ?? []).includes(sessionId)) return "moved";
  if (bot.sessionId === sessionId || bot.continuedSessionId === sessionId) return "allowed";
  return "refused";
}

/**
 * Record that `botId`'s chat moved on from `previous` into `continued`,
 * newest first, bounded, and move the live pointer in the same locked write:
 * a gap between the lineage and the pointer let a second client carry the
 * same session over again and fork the chat.
 */
export function recordSessionLineage(store: ShellStore, botId: string, previous: string, continued: string): ShellStore {
  return {
    ...store,
    bots: store.bots.map((bot) => {
      if (bot.id !== botId) return bot;
      const rest = (bot.previousSessionIds ?? []).filter((id) => id !== previous);
      return {
        ...bot,
        sessionId: continued,
        previousSessionIds: [previous, ...rest].slice(0, PREVIOUS_SESSIONS_MAX),
        continuedSessionId: continued,
        continuationSettled: false,
      };
    }),
  };
}

/**
 * Record a verified carry-over, unless another one got there first: the
 * pointer no longer names the session this one came from. Then nothing is
 * recorded and `lost` says so, so the caller can answer `session_moved`
 * instead of handing back a session the chat will not use.
 */
export function carryOverLineage(
  store: ShellStore,
  botId: string,
  previous: string,
  created: string,
): { store: ShellStore; lost: boolean } {
  const now = store.bots.find((item) => item.id === botId);
  if (now && now.sessionId && now.sessionId !== previous) return { store, lost: true };
  return { store: recordSessionLineage(store, botId, previous, created), lost: false };
}

/** The carried-over session finished a turn: its brief is in eve's history. */
export function settleContinuation(store: ShellStore, botId: string, sessionId: string): ShellStore {
  return {
    ...store,
    bots: store.bots.map((bot) => (
      bot.id === botId && bot.continuedSessionId === sessionId ? { ...bot, continuationSettled: true } : bot
    )),
  };
}

export function staleSessionIds(
  action: ShellAction | undefined,
  before: ShellStore,
  after: ShellStore,
): string[] {
  if (!action) return [];
  const stale = new Set<string>();
  const held = new Set(
    after.bots.map((bot) => bot.sessionId).filter((id): id is string => Boolean(id)),
  );
  for (const bot of before.bots) {
    if (bot.sessionId && !held.has(bot.sessionId)) stale.add(bot.sessionId);
  }
  if (action.type === "setWorkspace" && !action.workspace) {
    const session = after.bots.find((bot) => bot.id === action.botId)?.sessionId;
    if (session) stale.add(session);
  }
  return [...stale];
}

export function isGrantableRootPath(path: string): boolean {
  if (!path.startsWith("/") || path.length > 1024) return false;
  // The filesystem root has no segments to screen, so every check below would
  // pass it while it covers every credential store on the machine. A grant is
  // a folder the owner picked, never the whole disk.
  if (path.replace(/\/+$/, "") === "") return false;
  for (const segment of path.split("/")) {
    if (!segment) continue;
    if (segment === "..") return false;
    const lowered = segment.toLowerCase();
    if (FORBIDDEN_GRANT_SEGMENTS.has(lowered)) return false;
  }
  return true;
}

/**
 * Credential stores with one exact name. Screened per path segment rather than
 * as a substring, so `.dockerignore` at a project root stays readable while
 * `.docker/config.json` does not. Used for the grant root and, in
 * `resolveWorkspacePath`, for everything under it.
 */
export const FORBIDDEN_CHILD_SEGMENTS = new Set([
  // The app's own stores: approvals, the roster, the grants. A bot that
  // could edit these could approve itself.
  ".useful-bot",
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

function parseRecent(raw: unknown): ShellRecent {
  if (!raw || typeof raw !== "object") throw new Error("shell_recent_invalid");
  const rec = raw as Record<string, unknown>;
  if (!isId(rec.id)) throw new Error("shell_recent_id");
  if (!isId(rec.botId)) throw new Error("shell_recent_bot");
  if (typeof rec.title !== "string") throw new Error("shell_recent_title");
  if (rec.sessionId !== null && typeof rec.sessionId !== "string") throw new Error("shell_recent_session");
  if (typeof rec.preview !== "string") throw new Error("shell_recent_preview");
  if (typeof rec.updatedAt !== "string") throw new Error("shell_recent_date");
  return {
    id: rec.id,
    botId: rec.botId,
    title: clip(rec.title, NAME_MAX) || "Chat",
    sessionId: rec.sessionId,
    preview: clip(rec.preview, PREVIEW_MAX),
    updatedAt: rec.updatedAt,
  };
}

function parseSection(raw: unknown): ShellSection {
  if (!raw || typeof raw !== "object") throw new Error("shell_section_invalid");
  const rec = raw as Record<string, unknown>;
  if (!isId(rec.id) || rec.id === UNASSIGNED_SECTION || rec.id === HIDDEN_SECTION) {
    throw new Error("shell_section_id");
  }
  if (typeof rec.name !== "string") throw new Error("shell_section_name");
  if (typeof rec.collapsed !== "boolean") throw new Error("shell_section_collapsed");
  if (typeof rec.order !== "number" || !Number.isInteger(rec.order)) throw new Error("shell_section_order");
  return {
    id: rec.id,
    name: clip(rec.name, NAME_MAX) || "Section",
    collapsed: rec.collapsed,
    order: rec.order,
  };
}

export function parseShell(raw: unknown): ShellStore {
  if (!raw || typeof raw !== "object") throw new Error("shell_invalid");
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== SHELL_SCHEMA) throw new Error("shell_schema");
  if (!Array.isArray(rec.bots) || !Array.isArray(rec.sections)) throw new Error("shell_shape");
  if (rec.recents !== undefined && !Array.isArray(rec.recents)) throw new Error("shell_recents");
  const bots = rec.bots.map(parseBot);
  const sections = rec.sections.map(parseSection);
  const recents = (rec.recents ?? []).map(parseRecent);
  if (bots.length === 0) throw new Error("shell_empty");
  const botIds = new Set(bots.map((bot) => bot.id));
  if (botIds.size !== bots.length) throw new Error("shell_bot_duplicate");
  const sectionIds = new Set(sections.map((section) => section.id));
  if (sectionIds.size !== sections.length) throw new Error("shell_section_duplicate");
  for (const bot of bots) {
    if (bot.sectionId && !sectionIds.has(bot.sectionId)) bot.sectionId = null;
    bot.memberIds = bot.memberIds.filter((id) => botIds.has(id) && id !== bot.id);
  }
  const selectedBotId = isId(rec.selectedBotId) && botIds.has(rec.selectedBotId)
    ? rec.selectedBotId
    : bots[0].id;
  return {
    schemaVersion: 1,
    selectedBotId,
    collapsedUnassigned: rec.collapsedUnassigned === true,
    collapsedHidden: rec.collapsedHidden !== false,
    bots,
    sections: sections.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    recents: recents.filter((item, index, all) => {
      if (!botIds.has(item.botId)) return false;
      return all.findIndex((other) => other.id === item.id) === index;
    }).slice(0, RECENTS_MAX),
  };
}

function touch(bot: ShellBot, at: string, patch: Partial<ShellBot>): ShellBot {
  return { ...bot, ...patch, updatedAt: at };
}

function uniqueName(store: ShellStore, base: string): string {
  const names = new Set(store.bots.map((bot) => bot.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let n = 2;
  while (names.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

function nextOrder(store: ShellStore): number {
  return store.sections.reduce((max, section) => Math.max(max, section.order), -1) + 1;
}

/**
 * A group member must be a real 1:1 bot: not the group itself, not the default
 * Useful Bot (which answers untargeted group turns), not another group, and not
 * a hidden bot. Order follows the caller so the roster stays stable.
 */
export function normalizeMembers(
  store: ShellStore,
  memberIds: string[],
  selfId: string,
): string[] {
  const out: string[] = [];
  for (const id of memberIds) {
    if (out.includes(id) || id === selfId) continue;
    const bot = store.bots.find((item) => item.id === id);
    if (!bot || bot.kind !== "bot" || bot.id === DEFAULT_BOT_ID || bot.hidden) continue;
    out.push(id);
    if (out.length >= GROUP_MAX_MEMBERS) break;
  }
  return out;
}

function selectFallback(store: ShellStore, removedId: string): string {
  if (store.selectedBotId !== removedId && store.bots.some((bot) => bot.id === store.selectedBotId)) {
    return store.selectedBotId;
  }
  const visible = store.bots.find((bot) => !bot.hidden);
  return (visible ?? store.bots[0]).id;
}

function pushRecent(store: ShellStore, bot: ShellBot, stamp: string): ShellRecent[] {
  if (!bot.sessionId && !bot.lastPreview) return store.recents;
  const next: ShellRecent = {
    id: crypto.randomUUID(),
    botId: bot.id,
    title: clip(bot.lastPreview, NAME_MAX) || bot.name,
    sessionId: bot.sessionId,
    preview: clip(bot.lastPreview, PREVIEW_MAX),
    updatedAt: bot.lastAt ?? stamp,
  };
  const recents = store.recents.filter((item) => (
    !(item.botId === bot.id && item.sessionId === bot.sessionId)
  ));
  return [next, ...recents].slice(0, RECENTS_MAX);
}

export function applyShellAction(
  store: ShellStore,
  action: ShellAction,
  at = new Date(),
): { store: ShellStore; createdId?: string } {
  const stamp = nowIso(at);
  switch (action.type) {
    case "select": {
      if (!store.bots.some((bot) => bot.id === action.botId)) throw new Error("shell_bot_missing");
      return { store: { ...store, selectedBotId: action.botId } };
    }
    case "createBot": {
      // Groups are built through createGroup, which enforces the member
      // minimum; a createBot action carrying kind "group" would seed a
      // memberless one.
      if (action.kind === "group") throw new Error("shell_group_members");
      const id = crypto.randomUUID();
      const face = defaultFaceFor(id);
      const bot: ShellBot = {
        id,
        kind: "bot",
        name: uniqueName(store, requireName(action.name)),
        petname: action.petname !== undefined ? clip(action.petname, NAME_MAX) || null : null,
        label: clip(action.label ?? "", LABEL_MAX),
        description: clip(action.description ?? "", DESCRIPTION_MAX),
        notify: false,
        pinned: false,
        hidden: false,
        sectionId: action.sectionId && store.sections.some((section) => section.id === action.sectionId)
          ? action.sectionId
          : null,
        sessionId: null,
        memberIds: [],
        lastPreview: "",
        lastAt: null,
        createdAt: stamp,
        updatedAt: stamp,
        avatarShape: face.shape,
        avatarColor: face.color,
        avatarImage: null,
        avatarCustom: true,
        permission: "auto",
        workspace: null,
      };
      return {
        store: { ...store, selectedBotId: id, bots: [bot, ...store.bots] },
        createdId: id,
      };
    }
    case "createGroup": {
      const id = crypto.randomUUID();
      const members = normalizeMembers(store, action.memberIds, id);
      if (members.length < GROUP_MIN_MEMBERS) throw new Error("shell_group_members");
      const face = defaultFaceFor(id);
      const group: ShellBot = {
        id,
        kind: "group",
        name: uniqueName(store, requireName(action.name)),
        petname: null,
        label: action.label !== undefined ? clip(action.label, LABEL_MAX) : "Group",
        description: clip(action.description ?? "", DESCRIPTION_MAX),
        notify: false,
        pinned: false,
        hidden: false,
        sectionId: action.sectionId && store.sections.some((section) => section.id === action.sectionId)
          ? action.sectionId
          : null,
        sessionId: null,
        memberIds: members,
        lastPreview: "",
        lastAt: null,
        createdAt: stamp,
        updatedAt: stamp,
        avatarShape: face.shape,
        avatarColor: face.color,
        avatarImage: null,
        avatarCustom: true,
        permission: "auto",
        workspace: null,
      };
      return {
        store: { ...store, selectedBotId: id, bots: [group, ...store.bots] },
        createdId: id,
      };
    }
    case "createSection": {
      const id = crypto.randomUUID();
      const section: ShellSection = {
        id,
        name: requireName(action.name),
        collapsed: false,
        order: nextOrder(store),
      };
      return { store: { ...store, sections: [...store.sections, section] }, createdId: id };
    }
    case "nameBot": {
      const name = clip(action.name, NAME_MAX);
      if (!name) throw new Error("shell_name_required");
      const patch: Partial<ShellBot> = { name };
      if (action.label !== undefined) patch.label = clip(action.label, LABEL_MAX);
      if (action.description !== undefined) patch.description = clip(action.description, DESCRIPTION_MAX);
      if (action.avatarShape !== undefined && isAvatarShape(action.avatarShape)) {
        patch.avatarShape = action.avatarShape;
        patch.avatarCustom = true;
      }
      if (action.avatarColor !== undefined && isAvatarColor(action.avatarColor)) {
        patch.avatarColor = action.avatarColor;
        patch.avatarCustom = true;
      }
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (bot.id === action.botId ? touch(bot, stamp, patch) : bot)),
        },
      };
    }
    case "renameBot": {
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId ? touch(bot, stamp, { name: requireName(action.name) }) : bot
          )),
        },
      };
    }
    case "renameSection": {
      return {
        store: {
          ...store,
          sections: store.sections.map((section) => (
            section.id === action.sectionId ? { ...section, name: requireName(action.name) } : section
          )),
        },
      };
    }
    case "updateBot": {
      const patch: Partial<ShellBot> = {};
      if (action.patch.name !== undefined) {
        const name = clip(action.patch.name, NAME_MAX);
        if (name) patch.name = name;
      }
      if (action.patch.petname !== undefined) {
        patch.petname = typeof action.patch.petname === "string"
          ? clip(action.patch.petname, NAME_MAX) || null
          : null;
      }
      if (action.patch.label !== undefined) patch.label = clip(action.patch.label, LABEL_MAX);
      if (action.patch.description !== undefined) patch.description = clip(action.patch.description, DESCRIPTION_MAX);
      if (action.patch.notify !== undefined) patch.notify = action.patch.notify;
      if (action.patch.lastPreview !== undefined) {
        patch.lastPreview = clip(action.patch.lastPreview, PREVIEW_MAX);
        patch.lastAt = stamp;
      }
      if (action.patch.memberIds !== undefined) {
        const bot = store.bots.find((item) => item.id === action.botId);
        if (!bot) throw new Error("shell_bot_missing");
        const members = normalizeMembers(store, action.patch.memberIds, action.botId);
        if (members.length < GROUP_MIN_MEMBERS) throw new Error("shell_group_members");
        patch.memberIds = members;
      }
      if (action.patch.avatarShape !== undefined && isAvatarShape(action.patch.avatarShape)) {
        patch.avatarShape = action.patch.avatarShape;
      }
      if (action.patch.avatarColor !== undefined && isAvatarColor(action.patch.avatarColor)) {
        patch.avatarColor = action.patch.avatarColor;
      }
      if (action.patch.avatarImage !== undefined) {
        patch.avatarImage = parseAvatarImage(action.patch.avatarImage);
      }
      if (action.patch.avatarCustom !== undefined) patch.avatarCustom = action.patch.avatarCustom;
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (bot.id === action.botId ? touch(bot, stamp, patch) : bot)),
        },
      };
    }
    case "pin": {
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId
              ? touch(bot, stamp, { pinned: action.pinned ?? !bot.pinned, hidden: false })
              : bot
          )),
        },
      };
    }
    case "hide": {
      const nextHidden = action.hidden ?? true;
      const bots = store.bots.map((bot) => (
        bot.id === action.botId
          ? touch(bot, stamp, { hidden: nextHidden, pinned: nextHidden ? false : bot.pinned })
          : bot
      ));
      const next = { ...store, bots };
      if (nextHidden) next.selectedBotId = selectFallback(next, action.botId);
      return { store: next };
    }
    case "deleteBot": {
      if (store.bots.length <= 1) throw new Error("shell_last_bot");
      if (!store.bots.some((bot) => bot.id === action.botId)) throw new Error("shell_bot_missing");
      const bots = store.bots
        .filter((bot) => bot.id !== action.botId)
        .map((bot) => (
          bot.memberIds.includes(action.botId)
            ? touch(bot, stamp, { memberIds: bot.memberIds.filter((id) => id !== action.botId) })
            : bot
        ));
      const next = { ...store, bots };
      next.selectedBotId = selectFallback(next, action.botId);
      next.recents = store.recents.filter((item) => item.botId !== action.botId);
      return { store: next };
    }
    case "deleteSection": {
      return {
        store: {
          ...store,
          sections: store.sections.filter((section) => section.id !== action.sectionId),
          bots: store.bots.map((bot) => (
            bot.sectionId === action.sectionId ? touch(bot, stamp, { sectionId: null }) : bot
          )),
        },
      };
    }
    case "move": {
      const sectionId = action.sectionId
        && store.sections.some((section) => section.id === action.sectionId)
        ? action.sectionId
        : null;
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId ? touch(bot, stamp, { sectionId, hidden: false }) : bot
          )),
        },
      };
    }
    case "setSession": {
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            // A page loaded before a carry-over names the retired session in
            // its address; it must not put that back over the live one.
            bot.id === action.botId
              ? touch(bot, stamp, {
                sessionId: action.sessionId && (bot.previousSessionIds ?? []).includes(action.sessionId)
                  ? bot.sessionId
                  : action.sessionId,
              })
              : bot
          )),
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
    case "sendToBot": {
      const target = store.bots.find((bot) => bot.id === action.botId);
      if (!target) throw new Error("shell_bot_missing");
      const preview = clip(action.message, PREVIEW_MAX);
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => {
            if (bot.id === action.botId) {
              return touch(bot, stamp, { lastPreview: preview, lastAt: stamp, sessionId: null });
            }
            if (action.sourceBotId && bot.id === action.sourceBotId) {
              return touch(bot, stamp, { lastPreview: `Handed off to ${target.name}`, lastAt: stamp });
            }
            return bot;
          }),
          recents: pushRecent(
            store,
            { ...target, lastPreview: preview, lastAt: stamp, sessionId: null },
            stamp,
          ),
        },
      };
    }
    case "touchChat": {
      const preview = clip(action.preview, PREVIEW_MAX);
      return {
        store: {
          ...store,
          bots: store.bots.map((bot) => (
            bot.id === action.botId
              ? touch(bot, stamp, {
                lastPreview: preview,
                lastAt: stamp,
                // A session the chat was carried over from is behind it for
                // good: a late write naming one must not pull the pointer
                // back off the newer session.
                sessionId: action.sessionId !== undefined
                  && !(action.sessionId && (bot.previousSessionIds ?? []).includes(action.sessionId))
                  ? action.sessionId
                  : bot.sessionId,
              })
              : bot
          )),
        },
      };
    }
    case "newChat": {
      const botId = action.botId ?? store.selectedBotId;
      const bot = store.bots.find((item) => item.id === botId);
      if (!bot) throw new Error("shell_bot_missing");
      const recents = pushRecent(store, bot, stamp);
      // "New chat" clears the bot row, but the bot's agent transcript is the
      // durable handoff log and is cleared separately.
      return {
        store: {
          ...store,
          selectedBotId: botId,
          recents,
          bots: store.bots.map((item) => (
            item.id === botId ? touch(item, stamp, { sessionId: null, lastPreview: "", lastAt: null }) : item
          )),
        },
      };
    }
    case "clearThread": {
      const bot = store.bots.find((item) => item.id === action.botId);
      if (!bot) throw new Error("shell_bot_missing");
      const recents = pushRecent(store, bot, stamp);
      return {
        store: {
          ...store,
          recents,
          bots: store.bots.map((item) => (
            item.id === action.botId
              ? touch(item, stamp, { sessionId: null, lastPreview: "", lastAt: null })
              : item
          )),
        },
      };
    }
    case "openRecent": {      const recent = store.recents.find((item) => item.id === action.recentId);
      if (!recent) throw new Error("shell_recent_missing");
      const bot = store.bots.find((item) => item.id === recent.botId);
      if (!bot) {
        return { store: { ...store, recents: store.recents.filter((item) => item.id !== action.recentId) } };
      }
      let recents = store.recents;
      if (bot.sessionId && bot.sessionId !== recent.sessionId) {
        recents = pushRecent(store, bot, stamp);
      }
      return {
        store: {
          ...store,
          selectedBotId: bot.id,
          recents,
          bots: store.bots.map((item) => (
            item.id === bot.id
              ? touch(item, stamp, {
                sessionId: recent.sessionId,
                lastPreview: recent.preview,
                lastAt: recent.updatedAt,
              })
              : item
          )),
        },
      };
    }
    case "toggleSection": {
      if (action.sectionId === UNASSIGNED_SECTION) {
        return { store: { ...store, collapsedUnassigned: !store.collapsedUnassigned } };
      }
      if (action.sectionId === HIDDEN_SECTION) {
        return { store: { ...store, collapsedHidden: !store.collapsedHidden } };
      }
      return {
        store: {
          ...store,
          sections: store.sections.map((section) => (
            section.id === action.sectionId ? { ...section, collapsed: !section.collapsed } : section
          )),
        },
      };
    }
    default:
      throw new Error("shell_action_unknown");
  }
}

export function selectedBot(store: ShellStore): ShellBot {
  return store.bots.find((bot) => bot.id === store.selectedBotId) ?? store.bots[0];
}

export function pinnedBots(store: ShellStore): ShellBot[] {
  return store.bots.filter((bot) => bot.pinned && !bot.hidden);
}

export function sectionBots(store: ShellStore, sectionId: string | null): ShellBot[] {
  return store.bots.filter((bot) => !bot.hidden && !bot.pinned && bot.sectionId === sectionId);
}

export function hiddenBots(store: ShellStore): ShellBot[] {
  return store.bots.filter((bot) => bot.hidden);
}

export function searchBots(store: ShellStore, query: string): ShellBot[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return store.bots.filter((bot) => !bot.hidden);
  return store.bots.filter((bot) => {
    const hay = `${bot.name} ${bot.label} ${bot.description} ${bot.lastPreview}`.toLowerCase();
    return hay.includes(needle);
  });
}

export type ShellSearchHit =
  | { kind: "new-chat" }
  | { kind: "recent"; recent: ShellRecent; bot: ShellBot | null }
  | { kind: "bot"; bot: ShellBot };

export type SearchTab =
  | "all"
  | "messages"
  | "bots"
  | "groups"
  | "files"
  | "links"
  | "routines"
  | "actions";

function matchesNeedle(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

export function searchShell(store: ShellStore, query: string, tab: SearchTab = "all"): ShellSearchHit[] {
  const needle = query.trim().toLowerCase();
  const hits: ShellSearchHit[] = [];
  if (tab === "all") hits.push({ kind: "new-chat" });

  if (tab === "all" || tab === "messages") {
    const recents = store.recents.filter((recent) => {
      if (!needle) return true;
      const bot = store.bots.find((item) => item.id === recent.botId);
      return matchesNeedle(`${recent.title} ${recent.preview} ${bot?.name ?? ""} ${bot?.label ?? ""}`, needle);
    });
    const recentCap = needle ? recents : recents.slice(0, 8);
    for (const recent of recentCap) {
      hits.push({
        kind: "recent",
        recent,
        bot: store.bots.find((item) => item.id === recent.botId) ?? null,
      });
    }
  }

  if (tab === "files" || tab === "links" || tab === "routines" || tab === "actions") {
    return hits;
  }

  if (tab === "all" || tab === "bots" || tab === "groups") {
    const bots = store.bots.filter((bot) => {
      if (tab === "bots" && bot.kind !== "bot") return false;
      if (tab === "groups" && bot.kind !== "group") return false;
      if (!needle) return !bot.hidden;
      return matchesNeedle(`${bot.name} ${bot.label} ${bot.description} ${bot.lastPreview}`, needle);
    });
    for (const bot of bots) hits.push({ kind: "bot", bot });
  }
  return hits;
}

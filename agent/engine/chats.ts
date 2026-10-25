import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { EngineError, type TurnOutcome } from "./protocol.ts";

/**
 * The chat index (SPEC 5.4): `<stateRoot>/engine/chats.json`, one writer (the
 * engine), written whole through a temp file and a rename. A chat is one Pi
 * session file under `<stateRoot>/engine/sessions/<botId>/`; the index holds
 * what the sidebar lists so it never has to open a session file.
 */

export const TITLE_MAX = 60;
export const PREVIEW_MAX = 120;
export const TRASH_DAYS = 30;

export type LastTurn = { turnId: string; outcome: TurnOutcome; endedAt: string };

export type ChatMeta = {
  chatId: string;
  botId: string;
  sessionFile: string | null;
  title: string;
  titleSetByOwner: boolean;
  preview: string;
  routineId: string | null;
  fixture: boolean;
  createdAt: string;
  updatedAt: string;
  /** The newest settled turn, so the status poll can report a failure after a restart. */
  lastTurn: LastTurn | null;
  /** A question from `ask` is waiting for the owner's next message (kept here so the status poll needs no session file). */
  questionOpen: boolean;
};

type IndexFile = { schemaVersion: 1; chats: ChatMeta[] };

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function isMeta(value: unknown): value is ChatMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return typeof meta.chatId === "string" && typeof meta.botId === "string"
    && typeof meta.title === "string" && typeof meta.updatedAt === "string";
}

export class ChatIndex {
  private chats = new Map<string, ChatMeta>();
  readonly engineDir: string;
  private readonly now: () => Date;

  constructor(engineDir: string, now: () => Date = () => new Date()) {
    this.engineDir = engineDir;
    this.now = now;
    this.load();
  }

  get indexPath(): string {
    return join(this.engineDir, "chats.json");
  }

  get trashDir(): string {
    return join(this.engineDir, "trash");
  }

  sessionDir(botId: string): string {
    return join(this.engineDir, "sessions", botId);
  }

  private load(): void {
    this.chats.clear();
    if (!existsSync(this.indexPath)) return;
    // A file that does not parse is a store that is gone: fail loud, never start empty over it.
    const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<IndexFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.chats)) throw new Error("chat_index_unreadable");
    for (const item of parsed.chats) {
      if (!isMeta(item)) throw new Error("chat_index_unreadable");
      this.chats.set(item.chatId, {
        ...item,
        // Stored relative to the engine folder, so the state root can move with its files.
        sessionFile: item.sessionFile ? resolve(this.engineDir, item.sessionFile) : null,
        titleSetByOwner: item.titleSetByOwner === true,
        preview: item.preview ?? "",
        routineId: item.routineId ?? null,
        fixture: item.fixture === true,
        createdAt: item.createdAt ?? item.updatedAt,
        lastTurn: item.lastTurn ?? null,
        questionOpen: item.questionOpen === true,
      });
    }
  }

  private save(): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const file: IndexFile = {
      schemaVersion: 1,
      chats: [...this.chats.values()].map((meta) => ({
        ...meta,
        sessionFile: meta.sessionFile ? relative(this.engineDir, meta.sessionFile) : null,
      })),
    };
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  get(chatId: string): ChatMeta | undefined {
    return this.chats.get(chatId);
  }

  require(chatId: string): ChatMeta {
    const meta = this.chats.get(chatId);
    if (!meta) throw new EngineError(404, "chat_not_found");
    return meta;
  }

  all(): ChatMeta[] {
    return [...this.chats.values()];
  }

  create(input: { botId: string; chatId?: string; title?: string; routineId?: string | null; fixture?: boolean }): ChatMeta {
    const stamp = this.now().toISOString();
    const meta: ChatMeta = {
      chatId: input.chatId ?? randomUUID(),
      botId: input.botId,
      sessionFile: null,
      title: clip(input.title ?? "New chat", TITLE_MAX) || "New chat",
      titleSetByOwner: false,
      preview: "",
      routineId: input.routineId ?? null,
      fixture: input.fixture === true,
      createdAt: stamp,
      updatedAt: stamp,
      lastTurn: null,
      questionOpen: false,
    };
    if (this.chats.has(meta.chatId)) throw new Error("chat_exists");
    this.chats.set(meta.chatId, meta);
    this.save();
    return meta;
  }

  /** Applies a patch and saves. `updatedAt` moves unless the patch is only a rename. */
  update(chatId: string, patch: Partial<Omit<ChatMeta, "chatId" | "botId" | "createdAt">>, options: { touch?: boolean } = {}): ChatMeta {
    const meta = this.require(chatId);
    Object.assign(meta, patch);
    if (options.touch !== false && patch.updatedAt === undefined) meta.updatedAt = this.now().toISOString();
    this.save();
    return meta;
  }

  rename(chatId: string, title: string): ChatMeta {
    const clean = clip(title, TITLE_MAX);
    if (clean === "") throw new EngineError(400, "title_invalid");
    return this.update(chatId, { title: clean, titleSetByOwner: true }, { touch: false });
  }

  /**
   * A page of one bot's chats, newest `updatedAt` first. `before` is the chat
   * id the previous page ended with. Fixture chats are listed only on request.
   */
  list(options: { botId?: string; before?: string; limit?: number; includeFixtures?: boolean }): { chats: ChatMeta[]; nextBefore: string | null } {
    const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
    const sorted = this.all()
      .filter((meta) => (options.botId === undefined || meta.botId === options.botId) && (options.includeFixtures || !meta.fixture))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.chatId.localeCompare(left.chatId));
    let start = 0;
    if (options.before) {
      const at = sorted.findIndex((meta) => meta.chatId === options.before);
      if (at === -1) throw new EngineError(400, "before_unknown");
      start = at + 1;
    }
    const page = sorted.slice(start, start + limit);
    const more = start + limit < sorted.length;
    return { chats: page, nextBefore: more && page.length > 0 ? page[page.length - 1].chatId : null };
  }

  /** The newest remaining chat of a bot, or null. */
  newest(botId: string): ChatMeta | null {
    return this.list({ botId, limit: 1 }).chats[0] ?? null;
  }

  /**
   * Removes a chat from the index and moves its session file into the trash
   * with a `deletedAt` stamp in the name. The caller has already refused a
   * running turn and expired its approval cards.
   */
  remove(chatId: string): ChatMeta {
    const meta = this.require(chatId);
    if (meta.sessionFile && existsSync(meta.sessionFile)) {
      mkdirSync(this.trashDir, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      renameSync(meta.sessionFile, join(this.trashDir, `${stamp}__${basename(meta.sessionFile)}`));
    }
    this.chats.delete(chatId);
    this.save();
    return meta;
  }

  /** Deletes trashed session files older than TRASH_DAYS. Returns how many went. */
  purgeTrash(): number {
    if (!existsSync(this.trashDir)) return 0;
    const cutoff = this.now().getTime() - TRASH_DAYS * 86_400_000;
    let purged = 0;
    for (const name of readdirSync(this.trashDir)) {
      const path = join(this.trashDir, name);
      const stamped = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)__/.exec(name);
      const deletedAt = stamped
        ? Date.parse(stamped[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z"))
        : statSync(path).mtimeMs;
      if (Number.isFinite(deletedAt) && deletedAt < cutoff) {
        unlinkSync(path);
        purged += 1;
      }
    }
    return purged;
  }
}

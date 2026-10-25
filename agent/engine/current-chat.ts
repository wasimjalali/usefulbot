import type { Deps } from "./deps.ts";

/**
 * The chat each bot has open (`shell.json`), written without ever stalling the
 * engine. The shell file's lock can be held by another process for seconds, and
 * the engine writes it on create, open and settle, on the request path and in
 * the settle that frees a chat. A write that finds the lock busy is parked here
 * (the newest one per bot wins) and retried every `retryMs`; until it lands,
 * reads answer from what is parked, so the engine never disagrees with itself.
 */

type Parked = { chatId: string | null; preview: string; tries: number };

export class CurrentChat {
  private readonly deps: Pick<Deps, "currentChat" | "setCurrentChat">;
  private readonly parked = new Map<string, Parked>();
  private timer: NodeJS.Timeout | null = null;
  private readonly retryMs: number;
  private readonly maxTries: number;

  constructor(deps: Pick<Deps, "currentChat" | "setCurrentChat">, options: { retryMs?: number; maxTries?: number } = {}) {
    this.deps = deps;
    this.retryMs = options.retryMs ?? 250;
    // 5 minutes at the default rate; past that the lock is not coming back and the write is dropped, loudly.
    this.maxTries = options.maxTries ?? 1_200;
  }

  get(botId: string): string | null {
    const parked = this.parked.get(botId);
    return parked ? parked.chatId : this.deps.currentChat(botId);
  }

  set(botId: string, chatId: string | null, preview: string): void {
    this.parked.delete(botId);
    try {
      this.deps.setCurrentChat(botId, chatId, preview);
    } catch (error) {
      console.error(JSON.stringify({ event: "current_chat_parked", botId, chatId, error: error instanceof Error ? error.message : String(error) }));
      this.parked.set(botId, { chatId, preview, tries: 0 });
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer || this.parked.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
      this.schedule();
    }, this.retryMs);
    this.timer.unref();
  }

  /** One attempt at every parked write. */
  flush(): void {
    for (const [botId, parked] of [...this.parked]) {
      try {
        this.deps.setCurrentChat(botId, parked.chatId, parked.preview);
        this.parked.delete(botId);
      } catch (error) {
        parked.tries += 1;
        if (parked.tries >= this.maxTries) {
          this.parked.delete(botId);
          console.error(JSON.stringify({ event: "current_chat_dropped", botId, chatId: parked.chatId, error: error instanceof Error ? error.message : String(error) }));
        }
      }
    }
  }

  /** Shutdown: one last attempt, then nothing is retried. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.parked.clear();
  }
}

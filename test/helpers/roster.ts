import { DEFAULT_BOT_ID, seedStore, type ShellBot, type ShellStore } from "../../shared/shell-store.ts";

let seq = 0;

/**
 * A roster with more bots than the app makes any more. `createBot` is gone, so
 * tests that need a second bot build it as a copy of the Generalist under
 * another id, with the given fields on top.
 */
export function withBot(
  store: ShellStore,
  name: string,
  patch: Partial<ShellBot> = {},
): { store: ShellStore; id: string } {
  seq += 1;
  const id = patch.id ?? `bot-test-${seq}`;
  const base = store.bots.find((bot) => bot.id === DEFAULT_BOT_ID) ?? seedStore().bots[0];
  const at = new Date().toISOString();
  const bot: ShellBot = {
    ...base,
    id,
    name,
    label: "",
    description: "",
    chatId: null,
    lastPreview: "",
    lastAt: null,
    createdAt: at,
    updatedAt: at,
    workspace: null,
    model: null,
    ...patch,
  };
  return { store: { ...store, bots: [...store.bots, bot] }, id };
}

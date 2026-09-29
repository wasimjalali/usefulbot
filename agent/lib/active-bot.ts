import type { ShellStore } from "../../shared/shell-store.ts";

/** The subset of an eve ToolContext the active-bot resolution needs. */
interface ActiveBotContext {
  session?: { id?: string };
}

/**
 * Which bot is acting. The eve session is the reliable identity: every bot's
 * chat carries its own session id in the shell, while the selected bot is only
 * where the owner last looked, which is the wrong answer when a routine or a
 * handoff runs outside the rail. UB_ACTIVE_BOT_ID stays ahead of the shell so
 * tests can pin a bot without a session.
 */
export function activeBotId(shell: ShellStore, ctx?: ActiveBotContext): string {
  const sessionId = ctx?.session?.id ?? null;
  if (sessionId) {
    const bySession = shell.bots.find((bot) => bot.sessionId === sessionId);
    if (bySession) return bySession.id;
  }
  return process.env.UB_ACTIVE_BOT_ID ?? shell.selectedBotId;
}

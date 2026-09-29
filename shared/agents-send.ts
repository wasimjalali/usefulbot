import { appendAgentEvent, type ThreadKind } from "./agent-store.ts";
import { queueHandoff, type HandoffRecord } from "./handoffs.ts";

/**
 * One bot messages one teammate. Both transcripts get a visible entry: the
 * sender side shows an outgoing handoff, the receiver side shows the message
 * queued for it. Delivery happens later (see web/lib/agent-exec.ts) so the
 * sender's turn never blocks on the receiver.
 */
export function sendHandoff(input: {
  source: { id: string; name: string } | null;
  target: { id: string; name: string };
  message: string;
  group?: { id: string; name: string } | null;
  /**
   * Where the visible "message received" entry goes. Defaults to the group so a
   * fan-out shows one card in the room plus one copy per member thread.
   */
  receiver?: { id: string; name: string } | null;
  /** Hop count; callers forwarding a received handoff increment it. */
  depth?: number;
}): HandoffRecord & { transcriptMiss?: string } {
  const sourceId = input.source?.id ?? "bot-useful";
  const sourceName = input.source?.name ?? "Useful Bot";
  const receiver = input.receiver ?? input.group ?? input.target;
  const threadKind: ThreadKind = receiver.id === input.group?.id ? "group" : "bot";
  const record = queueHandoff({
    sourceBotId: sourceId,
    sourceName,
    targetBotId: input.target.id,
    targetName: input.target.name,
    groupId: input.group?.id ?? null,
    groupName: input.group?.name ?? null,
    threadKind,
    message: input.message,
    depth: input.depth,
  });
  // The record is durable now, so a transcript miss is non-fatal: throwing
  // here would release the requestId reserve and queue a second handoff on
  // retry. Report the miss on the return instead and still wake the pump.
  let transcriptMiss = "";
  try {
    appendAgentEvent(sourceId, {
      kind: "handoff",
      text: input.message,
      authorBotId: sourceId,
      authorName: sourceName,
      targetBotIds: [input.target.id],
      handoffId: record.id,
    });
  } catch (err) {
    transcriptMiss = err instanceof Error ? err.message : "transcript_miss";
  }
  try {
    appendAgentEvent(receiver.id, {
      kind: "post",
      threadKind,
      text: input.message,
      authorBotId: sourceId,
      authorName: sourceName,
      targetBotIds: [input.target.id],
      handoffId: record.id,
    });
  } catch (err) {
    transcriptMiss = transcriptMiss || (err instanceof Error ? err.message : "transcript_miss");
  }
  wakePump();
  return transcriptMiss ? { ...record, transcriptMiss } : record;
}

/**
 * After the receiver answers, both transcripts get the reply: the receiver
 * as an assistant turn, the sender as a message from that teammate. The
 * sending tool also returns the same text, so the model can bring it back
 * without the owner switching chats.
 */
export function writeHandoffReply(input: {
  handoff: HandoffRecord;
  reply: string;
  sessionId: string;
  receiverId: string;
  threadKind: ThreadKind;
  sourceThreadKind?: ThreadKind;
}): void {
  const sourceKind = input.sourceThreadKind ?? "bot";
  if (!input.reply) {
    const note = `${input.handoff.targetName} finished with no reply.`;
    appendAgentEvent(input.receiverId, {
      kind: "note",
      threadKind: input.threadKind,
      sessionId: input.sessionId,
      text: note,
      authorBotId: input.handoff.targetBotId,
      authorName: input.handoff.targetName,
      handoffId: input.handoff.id,
    });
    if (input.handoff.sourceBotId && input.handoff.sourceBotId !== input.receiverId) {
      appendAgentEvent(input.handoff.sourceBotId, {
        kind: "note",
        threadKind: sourceKind,
        text: note,
        authorBotId: input.handoff.targetBotId,
        authorName: input.handoff.targetName,
        handoffId: input.handoff.id,
      });
    }
    return;
  }
  appendAgentEvent(input.receiverId, {
    kind: "assistant",
    threadKind: input.threadKind,
    sessionId: input.sessionId,
    text: input.reply,
    authorBotId: input.handoff.targetBotId,
    authorName: input.handoff.targetName,
    handoffId: input.handoff.id,
  });
  if (input.handoff.sourceBotId && input.handoff.sourceBotId !== input.receiverId) {
    appendAgentEvent(input.handoff.sourceBotId, {
      kind: "post",
      threadKind: sourceKind,
      text: input.reply,
      authorBotId: input.handoff.targetBotId,
      authorName: input.handoff.targetName,
      handoffId: input.handoff.id,
    });
  }
}

/**
 * Ask the web server to start delivering queued handoffs now. Best effort by
 * design: the UI poll drains the same queue, so a failed wake-up costs latency
 * only, and the tool never needs the channel credential to be present.
 */
function wakePump(): void {
  const base = process.env.UB_WEB_BASE_URL;
  const key = process.env.UB_CHANNEL_JWT ?? process.env.UB_CHANNEL_JWT_SECRET;
  if (!base || !key) return;
  try {
    void fetch(`${base}/api/agent/tick?limit=1`, {
      method: "POST",
      headers: { "x-ub-agent-key": key },
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  } catch {
    /* the UI poll picks the handoff up instead */
  }
}

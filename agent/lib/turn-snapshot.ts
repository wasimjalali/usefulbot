import { basename } from "node:path";
import type { ContextSnapshot } from "../../shared/context-blocks.ts";
import { accountFullName, ownerName } from "../../shared/operator.ts";
import { botComposerState, publicProviders, readProviderStore, type ProviderStore } from "../../shared/providers.ts";
import { botSelection, type TurnSelection } from "../../shared/session-selection.ts";
import { bindSession, readSessionParent, resolveSessionBot } from "../../shared/session-bindings.ts";
import { readSubagentStops } from "../../shared/subagent-stops.ts";
import { peekShell } from "../../shared/shell-io.ts";
import { DEFAULT_BOT_ID, orchestratorId, type BotKind, type ShellStore } from "../../shared/shell-store.ts";
import { readSessionGrant, type WorkspacePermission } from "../../shared/workspace-store.ts";
import { BINDING_WAIT_MS, isBotContextMissing, subAgentRoot } from "./active-bot.ts";
import { windowTokensFor } from "./model-window.ts";
import { clearRootOutside, noteRootReport } from "./outside-content.ts";

/** The slice of an eve resolver, hook or tool context the snapshot reads. */
export type SnapshotCtx = {
  session: {
    id: string;
    parent?: unknown;
    auth?: { current?: { attributes?: Readonly<Record<string, unknown>> } | null } | null;
  };
  /** eve's dynamic resolvers carry no `session.parent`; there a sub-agent's child is known by `kind: "subagent"`. */
  channel?: { kind?: unknown } | null;
  messages?: readonly { role?: string; kind?: unknown; content?: unknown }[];
};

export type OkSnapshot = {
  status: "ok";
  sessionId: string;
  turnId: string | undefined;
  botId: string;
  kind: BotKind;
  profileRevision: number;
  /** The selection every request of the turn sends, and the window compaction is sized from. */
  selection: TurnSelection;
  /** Null for a sub-agent whose chat is not known: it holds its root's grant, which this turn cannot name. */
  permission: WorkspacePermission | null;
  folder: string | null;
  /** True when the turn is a handoff: its input is another bot's text, so the turn starts after outside content. */
  outside: boolean;
  /** What "This turn" says about the model, and what list_models reports as current. */
  model: { label: string; id: string; connection: string; connectionId: string };
  image: { label: string; id: string; provider: string; connectionId: string | null } | null;
  /** What the context block renders, read in the same pass as the selection. */
  context: ContextSnapshot;
};

export type FailedSnapshot = {
  status: "failed";
  sessionId: string;
  turnId: string | undefined;
  botId: string | null;
};

export type TurnSnapshot = OkSnapshot | FailedSnapshot;

/**
 * Snapshots per session and turn, readable from any module in this process.
 * eve may load an authored file as its own module instance, so a Map local to
 * this file could be empty in another (see session-model.ts): the registry
 * lives under a Symbol.for key.
 */
const REGISTRY_KEY = Symbol.for("useful-bot.turn-snapshots");
const REGISTRY_CAP = 256;

type Registry = { byTurn: Map<string, TurnSnapshot>; latest: Map<string, string> };

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[REGISTRY_KEY] ??= { byTurn: new Map(), latest: new Map() });
}

function keyOf(sessionId: string, turnId: string | undefined): string {
  return `${sessionId}\u0000${turnId ?? ""}`;
}

function remember(snapshot: TurnSnapshot): void {
  const reg = registry();
  const key = keyOf(snapshot.sessionId, snapshot.turnId);
  // Insertion order is age, so the oldest key is the idlest turn.
  reg.byTurn.delete(key);
  reg.byTurn.set(key, snapshot);
  reg.latest.delete(snapshot.sessionId);
  reg.latest.set(snapshot.sessionId, key);
  if (reg.byTurn.size > REGISTRY_CAP) reg.byTurn.delete(reg.byTurn.keys().next().value as string);
  if (reg.latest.size > REGISTRY_CAP) reg.latest.delete(reg.latest.keys().next().value as string);
}

/** A read keeps the turn alive: eviction drops the idlest, not the oldest written. */
function touch(key: string, snapshot: TurnSnapshot): void {
  const byTurn = registry().byTurn;
  byTurn.delete(key);
  byTurn.set(key, snapshot);
}

/**
 * The snapshot of one turn, or the session's latest when no turn id is given
 * (a tool whose context carries none). A failed snapshot is returned as it is:
 * callers check `status`.
 */
export function turnSnapshot(sessionId: string, turnId?: string): TurnSnapshot | null {
  const reg = registry();
  const key = turnId !== undefined ? keyOf(sessionId, turnId) : reg.latest.get(sessionId);
  const held = key ? reg.byTurn.get(key) : undefined;
  if (!held) return null;
  touch(key as string, held);
  return held;
}

/** Record that this turn's context could not be built, so the model resolver refuses the turn. */
export function markSnapshotFailed(sessionId: string, turnId: string | undefined, botId: string | null = null): void {
  remember({ status: "failed", sessionId, turnId, botId });
}

/** The string `botId` claim of the current request, or null. eve projects only string claims. */
export function claimedBotId(ctx: SnapshotCtx): string | null {
  const value = ctx.session.auth?.current?.attributes?.botId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** How the current request was delivered, from the `delivery` claim. */
export function deliveryClaim(ctx: SnapshotCtx): "owner" | "handoff" | "routine" | null {
  const value = ctx.session.auth?.current?.attributes?.delivery;
  return value === "owner" || value === "handoff" || value === "routine" ? value : null;
}

function refusal(sessionId: string, reason: string): null {
  console.warn(JSON.stringify({ event: "bot_context_refused", sessionId, reason }));
  return null;
}

/**
 * The bot a turn is for. The request's claim comes first, then the durable
 * session binding. A claim and a binding that name different bots, a child
 * session whose root cannot be shown, and a session with neither are refused (null). A claim with no
 * binding yet binds the session to the claimed bot (a create's first turn can
 * run before the proxy writes the row), unless it is a sub-agent's child. With
 * no claim at all (a turn eve starts itself on a session from before claims),
 * the binding is waited for, bounded.
 */
export async function boundBotId(
  ctx: SnapshotCtx,
  timeoutMs = Number(process.env.UB_BINDING_WAIT_MS ?? BINDING_WAIT_MS),
): Promise<string | null> {
  const sessionId = ctx.session.id;
  if (ctx.session.parent) {
    // A tool or hook context of a sub-agent's child: its bot is its verified
    // root session's (see subAgentRoot), or it is refused.
    try {
      const root = subAgentRoot(ctx);
      return root ? root.botId : refusal(sessionId, "child_session");
    } catch (err) {
      if (isBotContextMissing(err)) return refusal(sessionId, "child_session");
      throw err;
    }
  }
  const claim = claimedBotId(ctx);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : BINDING_WAIT_MS);
  for (;;) {
    const bound = resolveSessionBot(sessionId);
    if (claim) {
      if (bound === null) {
        // A child is never bound as a root: the proxy binds it under its
        // parent once it has verified the parent delegated it, and refuses
        // to read a child that is already bound as a root.
        if (ctx.channel?.kind === "subagent") return claim;
        try {
          bindSession(sessionId, claim);
        } catch (err) {
          console.error("[turn-snapshot] could not bind the session to its claim", err instanceof Error ? err.message : err);
          return refusal(sessionId, "claim_unbindable");
        }
        return claim;
      }
      return bound === claim ? claim : refusal(sessionId, "claim_binding_mismatch");
    }
    if (bound) return bound;
    if (Date.now() >= deadline) return refusal(sessionId, "unbound");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

/**
 * The session whose grant a turn shows, or null when it cannot be named. A
 * sub-agent's child holds its root session's grant, never one of its own. A
 * tool or hook context names the root (verified); eve's dynamic resolvers do
 * not, so the child's recorded parent is used. A child with no recorded parent
 * is null: the turn then shows the grant as unknown rather than reading the
 * child's own row or guessing from the bot's current chat. The tools enforce
 * the verified root either way.
 */
function grantSessionFor(ctx: SnapshotCtx): string | null {
  if (ctx.session.parent) {
    const root = subAgentRoot(ctx);
    if (!root) throw new Error("bot_context_missing");
    return root.rootSessionId;
  }
  if (ctx.channel?.kind !== "subagent") return ctx.session.id;
  return readSessionParent(ctx.session.id);
}

/** eve's own kind on the input of a turn it starts for a background task (scripts/patch-eve.mjs forwards the same mark on the stream). */
const REPORT_KIND = "execution.background_task";

/** eve's wording for a turn it starts when a background task reports, the fallback signal (see isSubAgentReport). */
const REPORT_TEXT = /^\s*(?:Background task task_[A-Za-z0-9]+\b|\[Task state\])/;

/**
 * Whether the turn's input is a sub-agent's report. The structural signal is
 * eve's message `kind` (`execution.background_task`, and its `[Task state]`
 * context); the wording is only a second signal. Every user message after the
 * last assistant message counts, because eve may merge a report with other
 * input in one turn: any report among them makes the turn one.
 */
export function isSubAgentReport(messages: SnapshotCtx["messages"]): boolean {
  return turnInputs(messages).some((message) => message.kind === REPORT_KIND || reportText(message));
}

/** The user messages after the last assistant message: what this turn was started with. */
function turnInputs(messages: SnapshotCtx["messages"]): NonNullable<SnapshotCtx["messages"]>[number][] {
  const all = messages ?? [];
  let from = all.length;
  while (from > 0 && all[from - 1].role !== "assistant") from -= 1;
  return all.slice(from).filter((message) => message.role === "user");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}

function reportText(message: { content?: unknown }): boolean {
  const text = textOf(message.content);
  return REPORT_TEXT.test(text) || /(?:^|\n\n)Background task task_[A-Za-z0-9]+\b/.test(text);
}

/** eve reports a cancelled child as a failed task with this error, or as "is cancelled". */
const CANCELLED_REPORT = /The agent invocation was cancelled|^Background task task_[A-Za-z0-9]+(?: \([^\n]*?\))? is cancelled\./m;

/**
 * The sub-agent sessions the owner stopped, when this turn is started by a
 * cancelled report: the root's unexpired owner stops (shared/subagent-stops.ts).
 * A report names a task, not a session, so any recent stop under the root
 * counts. A genuinely failed report, or a turn with no report, names none.
 */
function stoppedByOwner(ctx: SnapshotCtx): string[] {
  if (ctx.session.parent || ctx.channel?.kind === "subagent") return [];
  const cancelled = turnInputs(ctx.messages).some((message) => CANCELLED_REPORT.test(textOf(message.content)));
  if (!cancelled) return [];
  try {
    return readSubagentStops(ctx.session.id).map((stop) => stop.agentId ?? stop.childSessionId);
  } catch (err) {
    console.error("[turn-snapshot] owner stops could not be read", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * One consistent read for one turn: the providers store FIRST, then the
 * roster (the web process moves a pick in the shell before the default in the
 * store, so store-first never pairs a fresh default with a stale pin). Throws
 * when the roster is unreadable or no longer has the bot.
 */
export function buildSnapshot(
  botId: string,
  ctx: SnapshotCtx,
  turnId: string | undefined,
  now = new Date(),
  reads: { store: () => ProviderStore; shell: () => ShellStore | null } = { store: readProviderStore, shell: peekShell },
): OkSnapshot {
  const sessionId = ctx.session.id;
  const store = reads.store();
  const shell = reads.shell();
  if (!shell) throw new Error("shell_unreadable");
  const bot = shell.bots.find((item) => item.id === botId);
  if (!bot) throw new Error("bot_missing");

  // A step with no turn id cannot be told from the turn before it, so it
  // re-reads. That re-read prefers the grant (written once, at turn start)
  // over the owner's live pick, so a pick made mid-turn cannot split the turn.
  const grantSession = grantSessionFor(ctx);
  const grant = grantSession === null ? null : readSessionGrant(grantSession);
  const grantPick = turnId === undefined ? grant?.selection ?? null : null;
  const picked = grantPick ?? botSelection(bot, store);
  const selection: TurnSelection = { ...picked, windowTokens: windowTokensFor(picked) };
  const composer = botComposerState(store, picked);
  const image = publicProviders(store).roles.image;

  // What the tools enforce is the session grant (agent/lib/workspace.ts,
  // permission.ts), so that is what the turn shows: a session with no grant is
  // Read only there, and the folder is the one the grant attached.
  const permission: WorkspacePermission | null = grantSession === null ? null : grant?.permission ?? "read_only";
  const folder = grant?.path ? basename(grant.path) : null;
  const isGroup = bot.kind === "group";
  const members = isGroup
    ? bot.memberIds.flatMap((id) => {
        const member = shell.bots.find((item) => item.id === id);
        return member ? [{ name: member.name, label: member.label }] : [];
      })
    : null;
  const { owner, first } = ownerNames();
  const firstChat = !(ctx.messages ?? []).some((message) => message.role === "assistant")
    && (bot.previousSessionIds ?? []).length === 0;
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
    sessionId,
    turnId,
    botId,
    kind: bot.kind,
    profileRevision: bot.profileRevision,
    selection,
    permission,
    folder,
    outside: deliveryClaim(ctx) === "handoff" || isSubAgentReport(ctx.messages),
    model,
    image: imageModel,
    context: {
      running: !isGroup && botId === orchestratorId(shell) ? { fallback: botId !== DEFAULT_BOT_ID } : null,
      bot: { name: bot.name, label: bot.label, description: bot.description },
      groupMembers: members,
      turn: {
        owner,
        first,
        date: now,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        permission,
        folder,
        model: { label: model.label, id: model.id, connection: model.connection },
        image: imageModel ? { label: imageModel.label, id: imageModel.id } : null,
        firstChat,
        stopped: stoppedByOwner(ctx),
      },
    },
  };
}

/**
 * The snapshot of a turn for a bot already known, built once per session and
 * turn and then held (so a pick made mid-turn waits for the next turn and the
 * block, the model and list_models all read one selection). A turn with no id
 * is rebuilt every call. A build that throws is recorded as failed and logged:
 * the model resolver then refuses the turn.
 */
export function snapshotForBot(
  botId: string,
  ctx: SnapshotCtx,
  turnId: string | undefined,
  turnStart = false,
): TurnSnapshot {
  const sessionId = ctx.session.id;
  const held = registry().byTurn.get(keyOf(sessionId, turnId));
  if (turnId !== undefined) {
    if (held) {
      touch(keyOf(sessionId, turnId), held);
      return held;
    }
  } else if (held?.status === "failed" && !turnStart) {
    // With no turn id a failure mark can't be told from the next turn's, so it
    // sticks until the next turn.started (`turnStart`) instead of being rebuilt away.
    return held;
  }
  let snapshot: TurnSnapshot;
  try {
    snapshot = buildSnapshot(botId, ctx, turnId);
  } catch (err) {
    console.error("[turn-snapshot] could not build the turn snapshot", err instanceof Error ? err.message : err);
    snapshot = { status: "failed", sessionId, turnId, botId };
  }
  remember(snapshot);
  // Built once, at the turn's start. A report turn means what a sub-agent read
  // has been delivered; only a turn that is positively the owner's (the claim
  // says so and it is not a report) may clear that mark, and only when nothing
  // is still out (see clearRootOutside).
  if (snapshot.status === "ok" && turnId !== undefined) {
    if (isSubAgentReport(ctx.messages)) noteRootReport(sessionId);
    else if (!snapshot.outside && deliveryClaim(ctx) === "owner") clearRootOutside(sessionId);
  }
  return snapshot;
}

/**
 * The turn's snapshot for whoever the request is for: null when the session is
 * unbound, the claim and the binding disagree, or it is a child session. This
 * is the one entry point for the context block, the model resolver and the
 * tools, and it rebuilds a missing snapshot (a process restart mid-turn).
 */
export async function ensureTurnSnapshot(
  ctx: SnapshotCtx,
  turnId: string | undefined,
  turnStart = false,
): Promise<TurnSnapshot | null> {
  const botId = await boundBotId(ctx);
  if (!botId) return null;
  return snapshotForBot(botId, ctx, turnId, turnStart);
}

/** The frozen selection of a turn the resolver already ensured. Throws `bot_context_missing` otherwise. */
export function frozenSelection(sessionId: string, turnId: string | undefined): TurnSelection {
  const snapshot = turnSnapshot(sessionId, turnId);
  if (!snapshot || snapshot.status !== "ok") throw new Error("bot_context_missing");
  return snapshot.selection;
}

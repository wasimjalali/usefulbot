import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./stack.ts";

/**
 * Sub-agents the owner stopped (Stop on a running child). eve reports a
 * cancelled child to its parent as a failure, and the parent model would start
 * it again, so the proxy records each owner stop here and the parent's next
 * turn is told (agent/lib/turn-snapshot.ts). Kept for an hour, newest 64.
 * 0600 JSON under ~/.useful-bot, written atomically; the web process writes and
 * the agent reads. Unreadable means no stops known, which only drops a hint.
 */
export type SubagentStop = { rootSessionId: string; childSessionId: string; agentId: string | null; at: number };

export const STOP_TTL_MS = 60 * 60 * 1000;
const STOP_CAP = 64;

export function defaultSubagentStopsPath(): string {
  return statePath("subagent-stops.json");
}

function live(rows: unknown, now: number): SubagentStop[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is SubagentStop =>
    Boolean(row) && typeof row.rootSessionId === "string" && typeof row.childSessionId === "string"
    && typeof row.at === "number" && now - row.at < STOP_TTL_MS);
}

function load(path: string, now: number): SubagentStop[] {
  if (!existsSync(path)) return [];
  return live((JSON.parse(readFileSync(path, "utf8")) as { stops?: unknown }).stops, now);
}

export function recordSubagentStop(
  stop: Omit<SubagentStop, "at">,
  now = Date.now(),
  path = defaultSubagentStopsPath(),
): void {
  const stops = load(path, now).filter((row) => row.childSessionId !== stop.childSessionId);
  stops.push({ ...stop, at: now });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ stops: stops.slice(-STOP_CAP) })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** The unexpired stops under a root session. Throws on a file it cannot parse. */
export function readSubagentStops(rootSessionId: string, now = Date.now(), path = defaultSubagentStopsPath()): SubagentStop[] {
  return load(path, now).filter((row) => row.rootSessionId === rootSessionId);
}

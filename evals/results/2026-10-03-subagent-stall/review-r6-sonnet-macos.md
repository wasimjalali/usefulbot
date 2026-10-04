# PR #178 review round 6: Sonnet 5.5 (sonnet-sweeper, high), macOS area (at cbca2ad)

Round 5: all 8 fixed. New: no critical, high or medium. 2 low: per-card clock not restarted when another card leaves working (SubagentCard.swift:128); background sessionEnded drop left the on-disk snapshot (AppModel.swift:2973). Both fixed by the orchestrator (onChange of the chat cards; removeSnapshot).

DISMISSED: unused parentBusy argument, liveCardIds on reset, awaiting-card ticking while busy, app-wide parentIdleSince, unreachable fallback paths, planner lastHeard, follow retry paths, defer sync, rail timer cost, dismissed requests un-parking, idempotent noteParentIdle, composer copy, rail precedence, cut ordering, replay window reset, answerRequest failures, snapshot unchanged, reload-from-zero dismissal, buttons while parked.

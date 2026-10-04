# PR #178 review round 1: Sonnet 5.5 (sonnet-sweeper, high), macOS area

macos/test.sh passed (675 tests). Not runtime-verified by the reviewer.

| # | Severity | Finding | File |
|---|----------|---------|------|
| 1 | high | followChild counts the 3 s idle-watchdog stop and clean ends as failures; a child silent ~45 s gives up and nothing re-arms it, so a healthy sub-agent later reads "No progress". | AppModel.swift:2945 |
| 2 | medium | A loadGeneration bump (reload) orphans follow tasks; childFollows keeps a dead entry. | AppModel.swift:2894 |
| 3 | medium | A refused child stream (403) triggers the macOS re-sign-in on every attempt. | AppModel.swift:2943 |
| 4 | medium | The old working row is hidden whenever any card exists, even a finished one. | ChatView.swift:709 |
| 5 | medium | attachReplay misses a replay merged into a report turn and any text difference, then drops delivered rows and duplicates. | EveStream.swift:1575 |
| 6 | low | "Send to <Bot>" has no sent state; double send possible. | SubagentCard.swift:365 |
| 7 | low | Child streams replay from index 0 on every open; each tracker keeps a full projection. | AppModel.swift:2937 |
| 8 | low | ChildTracker ignores turn.failed / session.failed / cancelled. | SubagentCard.swift:37 |
| 9 | low | plainFailure substring checks misfire ("rate"+"limit", bare "429"). | SubagentCard.swift:169 |
| 10 | low | A card anchored to a row with no block renders nowhere. | ChatView.swift:692 |
| 11 | low | Dropped row "Send again" never clears the dropped state. | ChatView.swift:666 |
| 12 | low | answerRequest maps every failure to one message; a zero-option request has no way out. | AppModel.swift:2830 |
| 13 | low | Stop drop is local only; replay diverges (eve's Stop is turn.cancelled, not session.completed). | EveStream.swift:2249 |
| 14 | low | Card header counts "not delivered" as done and "stopped" as failed. | SubagentCard.swift:192 |

DISMISSED (summary of the reviewer's list): duplicate switch cases, queued-flag equality, tag placement,
snapshot versioning, relaunch handling, receipt grouping, abandonRuns, notDelivered false positives
under batching, queued marking rules, optimistic-row folding, duplicate receipts, per-event republish,
publish cost, TimelineView ticking, rail state, hide/unhide, cancelled-follow races, cross-chat leaks
(except finding 2), answerInput re-auth, busy flag, accessibility, eve-native approvals as cards,
bookkeeping growth.

Decision: all 14 sent for fixing in one pass (lows included to save a round).

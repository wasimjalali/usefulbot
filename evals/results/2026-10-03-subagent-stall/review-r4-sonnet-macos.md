# PR #178 review round 4: Sonnet 5.5 (sonnet-sweeper, high), macOS area (at 4ae3da3)

Round 3: all fixed. New: 2 medium (follow cap starved by stale working runs, planner caps before filtering, SubagentCard.swift:307; notDelivered judged per launching-turn card while eve may batch per session, SubagentCard.swift:171), 7 low (transient notDelivered between a long turn and the report turn; never-settling working run with no progress keeps a timer and suppression; background rail flags never recomputed; merged report body swallows replayed owner text; failed/cancelled durations use report arrival; relaunch timers count from the first start; sessionEnded drop only on the open chat).

DISMISSED: session switches, localTurnIds, answerInput batch, input.resolved outcomes, report-only origins, attachReplay false matches, >8 paragraph holds, markQueued edge cases, mintId collisions, groupAnchors growth, rowId fallback, follow lifecycle, tail arithmetic, quiet reopen cadence, sendFromCard, row equality, resolveAll unwrap, clock churn, toggle publishes, spent one-shots, hidden nil-anchor cards, snapshot reproduction, session.failed under ignored, tool-approval raisedRequest, NSApplication in init, clock skew.

Decision: fix all; notDelivered becomes chat-wide (no run in any batch working), the conservative reading of eve batching.

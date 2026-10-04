# PR #178 review round 5: Sonnet 5.5 (sonnet-sweeper, high), macOS area (at 9054032)

Round 4: all fixed. New: 2 medium (notDelivered ignores an open pending request, so held reports read as not delivered and Send would duplicate, SubagentCard.swift:205; rail filters relaunched runs by first start, AppModel.swift:2853), 6 low (planner vs status patience anchors; ChatView not observing the progress store; background sessionEnded drop lost to the stash snapshot; rail timer never cancelled; report body cut without an open replay; chat-wide clock re-renders settled cards).

DISMISSED: app-wide parentIdleSince, 409/5xx retry paths, nil calledAt, stream index vs journal, stale childCall on relaunch, overlapping follows, newest-first starvation, follow set growth, unused parentBusy parameter, nil-start noWord, all-noWord header, last-finish including reports, duration override, snapshot 11, answerInput errors, held/queued/dropped logic, FailureRow and QueuedTag, cut ordering, retry timers, republish throttle, background rail, composer and rail copy, busy-disabled buttons, clockStopped, quiet reopen cadence.

Decision: fix all.

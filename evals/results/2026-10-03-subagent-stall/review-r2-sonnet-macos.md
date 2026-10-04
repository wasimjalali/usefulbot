# PR #178 review round 2: Sonnet 5.5 (sonnet-sweeper, high), macOS area

Round 1: all 14 fixed (#2, #5, #10, #12 with follow-ups below). New: 3 medium, 13 low.

Medium: (1) reload leaves an orphaned child follow that nothing restarts, AppModel.swift:2990; (2) the anchor fix sends cards of old turns outside the window to the tail, ChatView.swift:599; (3) attachReplay claims replayTurn before matching, so a report turn can drop held rows and the real replay duplicates, EveStream.swift:1582.

Low: header timer counts forever for settled/lost batches; queued tag from unfiltered requests after dismiss/dead session; Send again keyed by unstable row id and reset on chat switch; relaunched run suppresses the working row via an off-screen card; no backoff for non-HTTP follow errors; two ISO8601 formatters per child event; lastEventAt is arrival time; tail read can attribute an old task end to a relaunch; within-replay substring match; origin-only held row dropped only at an unrelated later turn (owner decision: drop at a non-Stop resolve); request state survives a session switch; option-less copy promises a reply answers it; rail shows SUB-AGENTS WORKING for a lost report and no state for a parked bot.

DISMISSED: Stop shape (verified against eve createInputResolvedEvent), switch cases, sawStep reuse, markQueued false positives, notDelivered under batching, follow cap, child 403 re-auth, error pattern, tail arithmetic, follow-token races, retry timers, TimelineView, per-event republish, tracker reset, snapshot replay, format bump, empty-text match, Stop via turn.cancelled, row equality, sendFromCard guards, accessibility, busy buttons, camelCase codes, nil startedAt, group ids, composer/rail copy.

Decision (orchestrator): fix all; owner decisions taken as routine (drop the origin row at a non-Stop resolve, since eve never replays it, seen live twice; rail shows a waiting state for a parked bot).

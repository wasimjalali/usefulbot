# PR #178 review round 3: Sonnet 5.5 (sonnet-sweeper, high), macOS area

Round 2: all 3 medium and 13 low fixed. New: 1 medium (card of an evicted launching turn drawn at the tail; stale working run suppresses working rows, ChatView.swift:595), 5 low (multi-paragraph held text never matches in a merged report turn; clock branch swap collapses an open report; composer placeholder contradicts the option-less card; resent ids not persisted while dropped ids are; rail flags stale when a background projection is gone).

DISMISSED: activeSession on late events, dropped marker on durable twins, hasEnded vs taskStartedAt race, HTTP backoff bounds, follow generations and recursion, tracker reset, origin drop rules, session.completed, unmatched rows staying held, clockStopped, republish cost, hasActiveCard, row equality, one-shots after failed sends, answer POST errors, snapshot format 9, step.started adoption, accessibility, notDelivered false positives, tail cursor arithmetic, watchdog reopen, follow cap, background rail inconsistency.

Decision: fix all, plus a short retry for the server's new 409 child_session_pending.

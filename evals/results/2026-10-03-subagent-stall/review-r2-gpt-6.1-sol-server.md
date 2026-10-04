[
  {
    "finding": "A stream ending before its advertised tail still commits complete=true and advances next to header+1. Unread delegation events are then permanently skipped. Reproduced with tail=1 and only event 0 returned: both the initial check and a retry against a healthy source return false, with starts [-100, 2]. Require consumed===total before committing the cursor or completeness.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 229
  },
  {
    "finding": "The negative startIndex is resolved against a different tail from the response header. Installed eve reads getStreamTailIndex(), then separately opens getEventStream() using the negative index. Events appended between those operations shift the window. If the advertised history fits inside the window, first is calculated as zero and complete becomes true despite missing the earliest events. Reproduced using eve's actual createSessionStreamResponse with windowEvents=2: a valid child remains unverifiable on subsequent requests. Obtain the tail first, then scan from an absolute index.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 177
  },
  {
    "finding": "A cancelled scan remains in inflight while waiting for the semaphore, and attempt() lets replacement callers join its already-aborted controller. When a slot opens, the replacement receives 'aborted' without fetching eve, and that cancellation is cached as an upstream failure for 10 seconds. Reproduced with maxConcurrent=1, a blocked scan, a cancelled queued caller and a replacement: both replacement and retry fail with zero fetches. Remove cancelled queued scans and refuse to join aborted entries; don't negative-cache another caller's cancellation.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 264
  }
]

DISMISSED

- Round 1 delayed-body write bypass: authorization checks child status after reading the body, and the route checks again immediately before forwarding.
- Round 1 whole-history replay for every new child: tail-window and incremental reads address the normal case; cursor failures are reported above.
- Round 1 unlimited active verification scans: the semaphore limits active reads, concurrent callers share scans and misses are cached; cancellation replacement remains defective as reported.
- Cross-bot body spoofing: existing-session authorization pins botId to the durable owner and rejects conflicting claims.
- Reading an arbitrary child: only an exact parent-originated `subagent.called` event supplies delegation evidence.
- Reading another bot’s bound child: ownership and parent comparisons reject it.
- Reclassifying an existing root as a child: authorization rejects roots, and the locked binding mutation repeats the conflict check.
- Nested or self-parented access: child parents and identical parent/child IDs are refused.
- Reading a recorded child without parent: the ordinary GET path refuses it.
- POST, inputResponses or cancel into a recorded child: authorization and the final forwarding guard refuse writes.
- Reset bypass: reset remains outside the proxy allowlist.
- Text, files or control-field smuggling through inputResponses: strict keys and reconstruction exclude them.
- Malformed inputResponses becoming a normal turn: presence detection selects strict validation.
- inputResponses during session creation: the create path refuses them.
- Path traversal or duplicate-parent ambiguity: path allowlists and query validation reject them.
- Concurrent binding writes replacing ownership: mutation rechecks ownership and parent under the shared lock.
- Agent creating a root binding for its subagent: the subagent-channel branch returns the inherited claim without writing a root binding.
- Cache hits bypassing ownership checks: parent and child binding checks precede the success-cache lookup.
- Unbounded retained verification evidence: parent records, child sets, success cache and miss cache have explicit caps.
- Malformed events granting access: parsing failures and mismatched event fields provide no delegation evidence.
- Internal upstream errors exposed to clients: route failures use fixed public error codes.
- Healthy streams retaining the three-minute deadline: headers clear that timer; the fifteen-minute backstop remains.
- Header timer surviving upstream failure: the catch disposes it.
- Removing the session input cap bypassing spend protection: router reservations and budget enforcement remain.
- Verification: all 33 authorization, proxy-guard and request-signal tests passed. Three in-memory probes reproduced the findings. Store-writing tests were skipped to preserve read-only operation.
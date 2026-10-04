```json
[
  {
    "finding": "Short-read handling still commits a truncated final event. At EOF, scan(buf) increments consumed before parsing, so an incomplete JSON payload can satisfy the advertised event count and advance next past the missing delegation. Reproduced with tail=1, event 0 complete and event 1 truncated: the initial check and a retry against healthy data both return false, with starts [0,2]. Reject an incomplete final payload before committing the cursor.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 241
  },
  {
    "finding": "Evicting child evidence leaves complete=true and the cursor beyond the evicted delegation, permanently preventing its verification while the parent record remains cached. Reproduced with 4,097 valid child events: the newest child verifies, but child 0 and its retry return false, with reads [-1,0,4097,4097]. Once the separate success cache also evicts that pair, authorizeChildStream refuses it even if its durable child binding exists. Provide a bounded recovery path for evicted evidence.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 253
  },
  {
    "finding": "Cancellation removes an inflight entry but does not remove its semaphore queue entry or settle runScan. Each cancelled queued request retains its promise, closures and hard timer until a slot opens, and replacement requests can enqueue additional scans for the same parent. Reproduced while holding one active scan: 1,000 cancelled requests left 1,001 hard timers outstanding despite only one upstream fetch. Make semaphore acquisition abort-aware and bound pending work.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 154
  }
]
```

DISMISSED

- Round 2 missing-whole-event short read: now throws before committing and isn't cached; partial final payload remains defective above.
- Round 2 moving-tail race: negative indexes are confined to the tail probe; event scans use absolute indexes.
- Round 2 joining cancelled scans: aborted entries are removed or replaced, and cancellations aren't negative-cached; queue retention remains defective above.
- Cross-bot body spoofing: authorization pins the body and JWT to the durable session owner.
- Arbitrary child reads: access requires an exact parent-originated `subagent.called` event.
- Foreign children, conflicting parents and roots presented as children: ownership and parent checks refuse them.
- Nested and self-parented access: authorization rejects both.
- Child reads without a parent: the ordinary GET path refuses recorded children.
- Delayed-body child writes: authorization checks after body reading, with another check immediately before forwarding.
- POST, inputResponses and cancel into recorded children: the shared write guard refuses them.
- Unbound-child cancellation: the existing unbound-cancel exception is deliberate; other unbound operations remain refused.
- Reset bypass: reset isn't in the proxy allowlist.
- Text, files and control-field smuggling through inputResponses: strict key validation and reconstruction exclude them.
- Malformed inputResponses falling through as a turn: key-presence detection selects strict validation.
- Input responses on session creation: explicitly refused.
- Path traversal and duplicate-parent ambiguity: path allowlists and query validation reject them.
- Binding ownership races: locked mutations recheck bot and parent before writing.
- Child-to-root conversion: bindSession preserves an existing child row.
- Agent/proxy binding conflict: an unbound subagent returns its inherited claim without creating a root binding; later steps accept the matching child binding.
- Carrying over a recorded child: sessionCarriesOverFor refuses it.
- Cache hits bypassing ownership: binding checks precede the success-cache lookup.
- Unbounded retained evidence: record and cache sizes are capped; eviction correctness is reported above.
- Malformed events granting access: parsing failure supplies no delegation evidence.
- Unhandled cancelled-scan rejection: scan promises have rejection handlers.
- Internal upstream errors reaching clients: route failures return fixed public error codes.
- Healthy streams hitting the old three-minute deadline: headers clear the timer; idle limits and the fifteen-minute backstop remain.
- Header timer surviving upstream failure: the catch disposes it.
- Removing the session input cap removing spend protection: router reservations and budget enforcement remain.
- Verification: all 36 authorization, proxy-guard and request-signal tests passed. Three in-memory probes reproduced the findings. Store-writing tests were skipped to preserve read-only operation.

Decision (orchestrator): three rounds of medium findings in the stream-scanning verifier; replaced it with an agent hook that binds the child on the parent's subagent.called (eve's own event) and a proxy check of that durable binding. No scanning, caches or semaphores left.

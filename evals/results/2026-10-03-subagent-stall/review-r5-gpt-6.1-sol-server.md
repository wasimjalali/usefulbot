```json
[
  {
    "finding": "The 1 MB verification cap is checked after returning a complete payload. If the chunk that crosses maxBytes contains the terminating newline, an oversized event is accepted and passed to JSON.parse. Reproduced with the default 1,048,576-byte cap and 65,536-byte chunks: a 1,048,660-byte subagent.called payload was returned successfully. The existing overflow test only covers exceeding the cap before the newline arrives. Check the first event's byte length before returning it, including when its final chunk crosses the limit.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 154
  }
]
```

DISMISSED

- Forged `at` selecting another event: authorization still requires the exact event type, parent ID and child ID.
- Absolute indexes for existing events: inspected eve 0.54.3’s stream route and local stream implementation; an in-memory runtime probe returned event 2 first for `startIndex=2`.
- Appends shifting an existing index: non-negative indexes select the existing absolute position without a tail-relative calculation.
- Future indexes: eve’s local stream can deliver an append before the requested future position, but acceptance still proves a real delegation by the named parent.
- Truncated first event: EOF without a terminating newline returns null.
- Multi-line or malformed first event: the first nonempty payload is returned for validation; malformed JSON refuses authorization rather than scanning onward.
- Tool output impersonating delegation: eve serializes output inside its event envelope; text cannot become a top-level `subagent.called`.
- Foreign child or conflicting parent: existing ownership and parent comparisons refuse access before verification.
- Child bound elsewhere during verification: `bindChildSession` rechecks conflicts under the shared store lock.
- Root reclassified as child: both authorization and the locked mutation reject existing root bindings.
- Child reclassified as root: `bindSession` preserves the existing child row.
- Agent racing proxy binding: the subagent branch returns its inherited claim without creating a root binding; subsequent matching bindings remain acceptable.
- Caller forging the subagent channel: validated proxy bodies cannot set the runtime’s channel kind.
- Nested or self-parented reads: authorization rejects recorded child parents and identical parent/child IDs.
- Bound-child fast path bypassing evidence: the durable row retains the verified parent and bot, both checked before serving.
- Child read without `parent`: the ordinary GET path refuses recorded children.
- POST or input answers into a recorded child: authorization and the final forwarding guard refuse them.
- Delayed-body child writes: child status is checked after body reading and immediately before forwarding.
- Unbound-child cancellation: the existing unbound-cancel exception is deliberate; other unbound operations remain refused.
- Reset bypass: reset remains outside the POST allowlist.
- Carrying over a recorded child: `sessionCarriesOverFor` rejects it.
- Concurrent binding overwrites: locked mutations preserve ownership and reject conflicting rows.
- Unsafe stored parents: parsing rejects null, non-string and invalid session IDs.
- Prototype-key binding poisoning through this path: binding requires an eve-generated child ID backed by a genuine delegation event.
- Cross-bot body spoofing: existing-session authorization pins the durable owner and rejects conflicting `botId`.
- Text, files or control fields through input answers: exact key validation and reconstruction exclude them.
- Arbitrary request IDs becoming messages: they remain bounded response identifiers, never message or file fields.
- Malformed input answers falling through as turns: key-presence detection selects strict validation.
- Input answers on creation: explicitly refused.
- Input answers retaining revoked workspace permissions: permission and workspace changes already update or revoke grants immediately.
- Path traversal and duplicate query ambiguity: path allowlists and query validation reject them.
- Old verifier, caches, queues, hook or adapter remaining active: no corresponding implementation or registration remains; the eve channel uses its original configuration.
- Cache eviction, stale negative results and cancelled semaphore entries: those mechanisms are removed.
- Verification cancellation or timeout becoming an unhandled rejection: abort races have rejection handlers and cleanup cancels the reader.
- Internal verification errors reaching callers: the route returns fixed public error codes.
- Healthy router streams retaining the three-minute cap: successful upstream completion clears the header timer.
- Header timer surviving upstream failure: the catch disposes it.
- Streams running indefinitely: the fifteen-minute signal remains alongside idle timers and disconnect cancellation.
- Removing the session input cap bypassing spend controls: router reservations and budget checks still precede dispatch.
- Existing sessions remaining capped: eve fixes limits at creation; the PR documents this and supplies structured responses for existing pauses.
- Verification coverage: all 37 authorization, proxy guard and timer tests passed. Store-writing tests were skipped to preserve read-only operation. Probes ran in memory; no files were edited.
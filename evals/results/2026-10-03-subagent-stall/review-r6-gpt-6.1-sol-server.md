```json
[]
```

DISMISSED

- Round 5 overflow: fixed. The returned line and preceding lines count toward the cap before acceptance. In-memory probes accepted 1,048,576 bytes and rejected 1,048,577 and 1,048,660 bytes, including with multiple leading blank lines.
- Forged `at`: acceptance still requires `subagent.called` with the exact parent and child IDs.
- Index drift from appends: verification uses a non-negative absolute event index.
- Reading onward to find favorable evidence: the first complete payload is returned for validation; a mismatching event refuses authorization.
- Truncated or malformed evidence: incomplete lines return null; invalid JSON refuses authorization.
- Tool-output impersonation: output remains inside eve’s event envelope and cannot become a top-level delegation event.
- Unverified child reads: an unbound child requires verified delegation before its binding is written.
- Foreign child reads: existing child ownership and parent must both match.
- Root presented as child: authorization rejects an existing root binding.
- Child presented as root: ordinary stream reads refuse recorded children; `bindSession` preserves their parent.
- Nested or self-parented reads: child parents and identical parent/child IDs are refused.
- Stale verification cache: no verification cache remains.
- Durable fast path bypass: it requires the previously recorded parent and matching bot.
- Concurrent child-binding conflicts: `bindChildSession` rechecks ownership and parent under the shared store lock.
- Agent racing the proxy: a subagent channel returns its inherited claim without creating a root binding; a later matching child binding remains acceptable.
- Forged subagent channel: the validated proxy body cannot set the runtime channel kind.
- POST or input answers into recorded children: authorization and the final forwarding guard refuse them.
- Slow-body write bypass: child status is checked again after body reading and immediately before forwarding.
- Unbound-child cancellation: the existing unbound-cancel exception is deliberate; it does not authorize reads or message writes.
- Reset bypass: reset remains outside the POST allowlist.
- Carrying over children: `sessionCarriesOverFor` rejects recorded children.
- Binding-store poisoning through child IDs: the child ID must appear in genuine eve delegation evidence; conflicting rows cannot be overwritten.
- Unsafe parent values: parsing rejects null, non-string and invalid session IDs.
- Cross-bot input-answer spoofing: authorization pins the durable owner and rejects a conflicting body `botId`.
- Text, files or control fields through input answers: exact key validation rejects them, and forwarding reconstructs only the validated response fields.
- Arbitrary request IDs injecting messages: IDs remain bounded response identifiers; no message or file fields are forwarded.
- Malformed input answers falling through as turns: key-presence detection selects strict input-response validation.
- Input answers on session creation: explicitly refused.
- Stale workspace privileges through input answers: permission changes already update or revoke grants.
- Path traversal or ambiguous verification queries: path allowlists reject traversal; duplicate `parent` and `at` values cannot select evidence.
- Verification scan exhaustion: reads target one event and enforce a five-second deadline and 1 MB acceptance cap.
- Verification cancellation and rejection leaks: abort races have rejection handlers; cleanup aborts the fetch, cancels the reader and clears the timer.
- Internal verification errors reaching clients: the route returns fixed public error codes.
- Healthy streams cut at 180 seconds: successful upstream completion clears the header timer.
- Header timer surviving upstream failure: the catch disposes it.
- Streams running indefinitely: the fifteen-minute backstop remains, alongside idle timeouts and disconnect cancellation.
- Spend controls bypassed by disabling the session input cap: router reservations and budget checks still precede dispatch.
- Existing sessions remaining capped: eve stores limits at creation; the PR documents this and adds structured responses for existing pauses.

Verification: all 38 authorization, proxy-guard and timer tests passed. Store-writing binding and snapshot tests were inspected but not run to preserve read-only operation. No files were edited.
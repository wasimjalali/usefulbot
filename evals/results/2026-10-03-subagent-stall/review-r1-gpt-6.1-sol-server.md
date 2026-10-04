[
  {
    "finding": "The child write check runs before await readBody(). Start a POST to an unbound child and delay completing its body, then GET the child's stream with its verified parent. The GET creates the child binding. Completing the POST now passes authorizeEveCall(), which checks only bot ownership, and forwards a message, inputResponses or cancel into the child. Recheck child status after reading the body and enforce it during write authorization.",
    "severity": "high",
    "file": "web/app/eve/v1/[...path]/route.ts",
    "line": 115
  },
  {
    "finding": "Verification always replays the parent from startIndex=0 and refuses after 64 MiB. Once a long-lived parent's history exceeds that size before a new subagent.called event, its legitimate child cannot be verified or displayed. Repeated requests replay the same prefix and fail again. Use bounded incremental verification with retained trusted delegation evidence so history growth doesn't permanently disable progress.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 145
  },
  {
    "finding": "The verification limits apply per request, with no concurrency bound or in-flight deduplication. Concurrent cache misses each replay and parse the parent's history independently, including identical parent/child requests. GET requests aren't rate-limited, unsuccessful scans aren't cached and client disconnects don't abort verification. An authenticated caller can keep many scans running, exhausting local CPU, memory and eve stream resources despite the 512-entry success-cache cap. Bound concurrent scans, deduplicate identical work and propagate cancellation.",
    "severity": "medium",
    "file": "web/lib/eve-session-auth.ts",
    "line": 185
  }
]

DISMISSED

- Cross-bot body spoofing: existing-session authorization pins the bot to the durable binding and rejects a conflicting body botId.
- Reading an arbitrary unbound child: authorization requires an exact subagent.called event naming both the parent and child.
- Reading another bot's bound session as a child: the child-owner comparison rejects it before verification.
- Reclassifying an existing root as a child: authorization rejects bound roots and bindChildSession repeats the conflict check under the store lock.
- Nested or self-parented reads: authorization rejects child parents and identical parent/child IDs.
- Reading a recorded child without parent: the ordinary GET path explicitly refuses it.
- Writing an already-recorded child at request entry: the POST guard rejects it; the timing gap is reported above.
- Reset-path bypass: reset isn't on the proxy POST allowlist.
- Text or file smuggling through inputResponses: exact body/item keys, string validation and reconstruction exclude message, file and forwarding-control fields.
- Invalid inputResponses falling through as a turn: presence detection selects strict validation even when the value is malformed.
- Answering input on session creation: the create path rejects inputResponses.
- URL traversal or duplicate-parent ambiguity: suffix allowlists reject path characters and duplicate parent values are refused.
- Concurrent child bindings overwriting ownership: the locked mutation rechecks bot and parent, then refuses conflicts.
- Agent binding its subagent as a root: the new subagent-channel branch returns the inherited claim without creating a root binding.
- Cache hits bypassing binding checks: parent and child ownership checks run before cache lookup; the cache stays bounded.
- Truncated or malformed stream content inventing authorization: only an exact parsed delegation event grants access.
- Internal upstream errors reaching clients: proxy failures return fixed public error codes.
- Healthy router streams still hitting the old three-minute deadline: headersArrived clears that timer; idle handling and the fifteen-minute backstop remain.
- Header-timer leaks after upstream failure: the catch disposes the guard.
- Unlimited session input removing spend protection: the router's reservation and budget enforcement remain in the dispatch path.
- Verification coverage: all 14 existing proxy-guard and request-signal tests passed. Store-writing tests weren't executed under the read-only constraint.
```json
[
  {
    "finding": "Stop leaves approved but unconsumed child actions executable. If the owner approves a child card just before cancelling the child or root, expireSession skips it because it only expires pending records. The approval waiter can then consume it and execute the action after Stop; write_file and connector execution do not check cancellation before executing. An in-memory probe using request, waitUntilNotPending, decide, expireSession and executeIfApproved returned expired=0 and executedAfterStop=true. Expire both pending and approved matching records, leaving consumed records untouched. Add coverage for this approval-versus-Stop race.",
    "severity": "medium",
    "file": "agent/lib/approvals.ts",
    "line": 362
  }
]
```

DISMISSED

- **Round 1 resolver fallback:** Fixed. An unbound child shows unknown permission and folder. It never reads its own grant or guesses from the bot’s current chat.
- **Unknown snapshot remaining frozen after binding:** It gives no false permission or folder. Tools independently enforce the verified root.
- **Cross-bot escalation:** Child claims and existing bindings must agree with the root bot.
- **Forged or nested parents:** Tool metadata comes from eve. Invalid IDs, self-parenting, nested hops and roots recorded as children are refused.
- **Stale child binding:** A conflicting bot or parent is refused.
- **Pin or environment fallback:** Child verification precedes fallbacks and fails closed.
- **Stronger child grant:** Permission and workspace operations use the root session ID.
- **Forged `grantSessionId`:** It’s computed internally and absent from the tool schema.
- **Missing root grant:** Permission defaults to Read only.
- **Proxy binding race:** Matching bindings are idempotent. Conflicting bindings are rejected under the store lock.
- **Root rebinding:** Durable bindings are immutable. Moving a chat pointer doesn’t reassign the root.
- **Root deletion:** Subsequent child verification refuses an unbound root.
- **Child app mutations:** `callerOf` blocks verified children by default. Explicit read-only callers retain the root bot’s read scope.
- **Round 1 child cancel refusal:** Fixed in the server path. Only a verified child cancel bypasses the write refusal.
- **Cancel authorization bypass:** Malformed queries, wrong events, foreign parents and root targets are refused. Sends and input answers never receive the cancel exception.
- **Late child binding during a send:** The route rechecks child write restrictions immediately before forwarding.
- **Round 1 approval attribution:** Fixed. Records retain child identity, root identity and the sub-agent marker. The API resolves the root’s bot and name.
- **Round 1 pending child cards surviving root Stop:** Fixed for pending records. Approved records remain the finding above.
- **Round 1 outside-content propagation:** Child reads mark the root. Report turns also count as outside content independently of that mark.
- **Report wording changes:** Structural message kind is checked first. Wording and merged paragraphs provide fallback recognition.
- **Premature taint clearing:** Creation timestamps don’t prove individual completion, but current eve delivery batches cohort reports and recognized report turns independently remain outside. No concrete laundering path established.
- **Unreadable taint binding store:** The strict read retains the mark.
- **Owner-stop hint matching:** Matching any recent root stop is coarse, but it changes instructions rather than authority.
- **Failed stop-marker persistence or cancel response:** Errors are logged. These paths don’t authorize additional actions.
- **Stop-marker concurrency and eviction:** No concrete lost-update path established in the reviewed single-process write path. Markers are advisory.
- **Round 1 child HTML card:** Fixed. Child writes skip Library and chat filing.
- **Full-access connector writes:** Preserved owner decision. Children use the root permission.
- **Verification:** All 36 channel-auth and proxy-guard tests passed. Store-writing fixture suites were inspected but not run under the read-only brief. No files were changed and no agents were started.
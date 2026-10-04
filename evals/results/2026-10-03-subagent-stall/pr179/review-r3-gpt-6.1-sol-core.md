```json
[]
```

DISMISSED

- **Round 2 approved-but-unconsumed actions after Stop:** Fixed. `expireSession` expires both pending and approved records for the cancelled session. Replaying the original waiter/approve/expire/execute sequence returned `expired=1`, `executedAfterStop=false` and `approval_expired`.
- **Consumed approvals being retired:** Consumed records remain untouched. Expiration prevents future consumption; it cannot undo an action already consumed.
- **Root cancellation expiring unrelated child actions:** Expiration now matches the cancelled session only. Each child cancel retires that child’s cards. Sibling cards survive.
- **Round 1 resolver permission/folder mismatch:** Fixed. An unbound child shows an unknown grant. It neither reads its own grant nor guesses from the bot’s current chat.
- **Unknown resolver snapshot remaining frozen:** It asserts no false permission or folder. Tools independently resolve and enforce the verified root.
- **Child acting as another bot:** A conflicting bot claim, child binding or parent binding is refused.
- **Forged parent from tool arguments:** Parent metadata comes from eve’s context, outside the model-facing tool arguments.
- **Malformed, self-referencing or nested parent:** Invalid IDs, self-parenting, unequal immediate/root parents and roots recorded as children are refused.
- **Stale parent conflicting with durable ownership:** An existing child must match both the root bot and root session.
- **Pin/environment fallback for children:** Child verification runs before fallback resolution and fails closed.
- **Child receiving a stronger grant:** Permission, workspace and write rechecks use the verified root ID. Child grants are ignored.
- **Forged `grantSessionId`:** It is computed internally and absent from the tool schema.
- **Missing root grant:** Permissions default to Read only.
- **Missing-session Auto fallback:** Real tool contexts provide session IDs under the supplied eve facts. The fallback remains for bare test calls.
- **Proxy/tool binding race:** Matching child bindings are idempotent. Conflicting concurrent bindings are rejected under the binding-store lock.
- **Root rebinding through current-chat changes:** Durable ownership is immutable. Moving the bot’s chat pointer does not change the root binding.
- **Root deletion:** Subsequent child verification refuses an unbound root. No new deletion race introduced by this change was established.
- **Child app mutations through `callerOf`:** Verified children are blocked by default. Explicit read-only callers retain the root bot’s existing read scope.
- **Child file tools failing open:** Unverifiable children return structured `bot_context_missing` before workspace operations.
- **Child global installs through bash:** `needsPathWrite` commands are refused for children before approval or execution.
- **Round 1 child cancel refusal:** Fixed. Only a verified cancel into the child receives the write-refusal exception.
- **Cancel exception authorizing sends or input answers:** The exception requires POST to the exact cancel path. Other mutations remain refused.
- **Wrong parent, event index or cancellation target:** Verification rejects foreign parents, root targets and mismatching delegation events. Existing verified bindings must still match.
- **Child binding during request preparation:** The route rechecks child write restrictions immediately before forwarding.
- **New `agentId` granting authority:** It is validated and stripped before forwarding. It supplies an advisory stop label; child ownership determines cancellation authority.
- **Round 1 approval attribution:** Fixed. Records retain child identity, root identity and the sub-agent marker. `/api/approvals` returns the root session, bot ID and bot name.
- **Approval attribution fallback authorizing an unverifiable child:** Attribution does not authorize execution. Permission and workspace gates independently refuse the child.
- **Round 1 outside-content propagation:** Child reads mark the root. Report turns independently count as outside content.
- **Unverifiable-child taint fallback:** It conservatively marks a syntactically valid named root without granting access or mutation authority.
- **Report wording changes or merged inputs:** Structural message kind is checked first. Wording and merged-paragraph recognition provide fallbacks.
- **Premature taint clearing:** Binding timestamps cannot prove every child completed, but the supplied eve batching facts and independently tainted report turns leave no established laundering path.
- **Unreadable binding store clearing taint:** The strict read retains the root mark on failure.
- **Stop-marker concurrency, eviction or persistence failure:** No concrete lost-update path was established in the synchronous single-process writer. Markers are advisory and failures are logged.
- **Coarse owner-stop hint matching:** Recent stops are scoped to the root and shown on cancellation reports. They do not change tool authority.
- **Round 1 child HTML filing:** Fixed. Child writes skip Library and chat filing.
- **Full-access connector writes:** Preserved owner decision. Children use the root permission.
- **Verification limits:** All 37 channel-auth/proxy-guard tests and the selected in-memory approval regression passed. Store-writing fixture suites were inspected but not run under the read-only brief. No files were edited and no agents were started.
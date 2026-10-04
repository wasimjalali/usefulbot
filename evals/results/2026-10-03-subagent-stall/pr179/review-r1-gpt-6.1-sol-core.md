```json
[
  {
    "finding": "The resolver fallback can freeze a different permission and folder from those the child's tools enforce. Before the proxy or a tool records the child, grantSessionFor uses the bot's current chat, which need not be the delegating root. If that pointer is absent, it returns the child ID and buildSnapshot reads the child's own grant, contradicting the requirement to ignore child grants. A source-only probe confirmed both branches. With a known turn ID, snapshotForBot keeps this snapshot even after the correct parent is recorded. The child can therefore be told Read only while its root permits writes, or be shown a different attached folder while relative file operations target the root's folder. The added resolver test covers only an already-bound child and a current-chat pointer matching the root. Resolve the actual parent before presenting its grant, or represent it as unknown and refresh once verified; never read the child's own grant.",
    "severity": "medium",
    "file": "agent/lib/turn-snapshot.ts",
    "line": 208
  }
]
```

DISMISSED

- **Cross-bot claim escalation:** `subAgentRoot` rejects a nonempty bot claim that disagrees with the root binding.
- **Forged parent from model input:** parent metadata comes from eve, outside tool arguments. Malformed IDs, self-parenting, nested hops and roots recorded as children are refused.
- **Stale parent conflicting with the child binding:** an existing child must match both the root bot and parent ID.
- **Pin or environment fallback for children:** child verification runs before either fallback and throws on failure.
- **Stronger child grant in tools:** `authoritySessionId`, `sessionPermission` and `approvedWrite` use the verified root ID.
- **Missing root grant:** permissions default to Read only. Missing grants do not authorize writes.
- **Proxy binding race:** matching concurrent bindings are idempotent. Conflicting bindings are rechecked under the store lock and rejected.
- **Root rebinding:** existing bindings are immutable. Moving a bot’s current-chat pointer does not reassign an existing root.
- **Root deletion:** later child verification refuses an unbound root. Concurrent deletion during an already-authorized operation is not a new defect specific to this change.
- **Child mutations through `callerOf`:** verified children are blocked by default. Explicit `readOnly` callers retain the root bot’s existing read scope.
- **Forged `grantSessionId`:** it is an internal argument computed from tool context, absent from the model-facing schema.
- **Approval identity confusion:** approval records retain the child session and tool-call identity, while workspace authority uses the root grant. Pending writes recheck that grant.
- **Resolver permission mismatch as tool escalation:** the snapshot does not authorize tools. The finding concerns incorrect instructions and workspace expectations.
- **Missing session ID returning Auto:** real eve tool contexts supply an ID. This remains a test-only path under the stated runtime facts.
- **Test execution:** fixture tests write temporary stores, so they were not run under the read-only brief. Only the fallback function was exercised in memory.
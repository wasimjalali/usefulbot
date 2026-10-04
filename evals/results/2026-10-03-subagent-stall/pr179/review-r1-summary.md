# PR #179 review round 1: summary of Sonnet 5.5 (tools) and Opus 5.5 (attacker)

Opus verdict: no way past the root's permission found; identity, grants and in-app write gates hold.

- HIGH (Opus): Stop no longer stops running sub-agents (eve keeps admitted background tasks after the parent turn is cancelled; the proxy refuses cancels into children).
- MEDIUM (Sonnet + Opus): outside-content taint lost from child to parent; an injected report can become a model-sourced memory note shown in full every turn.
- MEDIUM (Opus): approval cards from a child carry no sub-agent or bot label and are not retired on Stop.
- LOW: resolver snapshot fallback (GPT rated medium); .html page card from a child; admission constants measured with agent/task_cancel off; stale UB-009 plan lines; dropped "Prefer steps that can be undone".
- Owner decision kept: under Full access a child may run connector/MCP/OpenAPI writes without a card, like its root bot.

Refuted (automated security scan): connector_execute and connection_tools lack child authorization (both gate on sessionPermission, which resolves to the root grant); seenOutside as a write gate (it only labels memory notes).

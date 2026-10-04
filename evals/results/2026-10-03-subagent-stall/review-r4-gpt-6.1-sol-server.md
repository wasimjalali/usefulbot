```json
[
  {
    "finding": "The new binding hook never runs for the agent tool's subagent.called events in pinned eve 0.54.3. subagentToolExecuteWorkflow calls invokeAgent, whose request reaches applyTaskAgentRequest and emitTaskSubagentCalledStep. That emitter calls callAdapterEventHandler and writes the stream event directly, without dispatchStreamEventHooks. agent/channels/eve.ts registers no corresponding channel handler. An in-memory probe of the installed emitter confirmed one channel callback and one stream write, but zero hook calls. Since boundBotId now leaves children unbound, their stream reads return child_session_pending indefinitely and live progress never loads. Connect binding to the runtime emission path that actually executes. The new tests miss this because they call bindSubagentChild directly.",
    "severity": "high",
    "file": "agent/hooks/subagent-binding.ts",
    "line": 7
  }
]
```

DISMISSED

- Model-forged delegation: eve constructs the event’s parent and child IDs from runtime session state and dispatch results, not model-supplied event JSON.
- Foreign agent-handle reuse: eve resolves resume requests against the parent’s known handles; unknown handles start a fresh child.
- Tool output impersonating an event: output remains action-result content and doesn’t dispatch arbitrary stream hooks.
- Forged channel or stream payload reaching this hook: the exposed proxy routes accept messages and validated input answers, not arbitrary events.
- Cross-bot child reassignment: an existing child with another bot or parent causes a locked ownership conflict.
- Root reclassified as child: `bindChildSession` refuses an existing root row.
- Child reclassified as root: `bindSession` preserves the existing child row’s `parentId`.
- Agent racing the child binding: the subagent-channel branch returns its claim without creating a root row; a later matching binding remains acceptable.
- Hook failure breaking a turn: binding and store exceptions are caught and logged; the production logger is synchronous.
- Mismatched hook context: the helper requires the event’s session ID to equal the context’s session ID.
- Nested or self-parented binding: the helper rejects child contexts, recorded child parents and identical parent/child IDs.
- Arbitrary unverified child reads: an absent binding returns 409 without forwarding or creating a binding.
- Reading a foreign child: authorization requires both the exact recorded parent and matching bot ownership.
- Reading a child without `parent`: the ordinary GET route refuses recorded children.
- POST, inputResponses or cancel into a recorded child: authorization and the final forwarding guard refuse them.
- Delayed-body write bypass: child status is checked after body reading and immediately before forwarding.
- Reset bypass: reset remains outside the proxy allowlist.
- Carrying a child into a replacement session: `sessionCarriesOverFor` rejects recorded children.
- Concurrent binding overwrites: mutations inspect the current child row under the shared store lock and reject conflicts.
- Unsafe parent values: parsing and binding validate the session ID alphabet; null and non-string stored parents are rejected.
- Text, files or control fields through inputResponses: exact key validation and reconstruction exclude them.
- Malformed inputResponses becoming a normal turn: key-presence detection selects strict validation.
- Input answers on creation: the create path explicitly refuses them.
- Cross-bot body spoofing: existing-session authorization rejects a conflicting botId and pins the durable owner.
- Path traversal or duplicate-parent ambiguity: path allowlists exclude traversal characters and duplicate parent parameters are refused.
- Deleted-verifier exhaustion and stale-cache failures: scan code, evidence caches and semaphores are removed.
- Internal errors reaching clients: proxy failures return fixed public codes rather than internal exception text.
- Healthy streams retaining the three-minute cap: successful upstream headers clear the header timer.
- Header timer surviving upstream failure: the catch disposes it.
- Streams continuing forever: the fifteen-minute total signal remains, alongside idle timers and client-disconnect cancellation.
- Removing the input cap bypassing spend controls: router reservations and budget checks still precede upstream dispatch.
- Verification: 29 authorization, proxy-guard and timer tests passed. Store-writing tests weren’t run under the read-only constraint. The emitter probe ran entirely in memory.
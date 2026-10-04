[
  {
    "finding": "expireSession's documentation still says a root Stop leaves child cards alone. This now contradicts the default behavior and describes the security gap this commit fixes. Update it to state that root cancellation includes child cards unless children:false is explicitly supplied.",
    "severity": "low",
    "file": "agent/lib/approvals.ts",
    "line": 356
  }
]

DISMISSED

- **Forging `scope=report` as a child:** The proxy requires an owner session and valid CSRF token. Bot channel credentials alone cannot invoke this exception.
- **Report cancellation undoing an owner Stop:** `children:false` only limits which records are expired. It cannot restore cards already expired by the ordinary root cancel.
- **Ordinary cancel accidentally excluding children:** `BackendClient.cancel` defaults to `reportOnly:false`. Only `guardStoppedReport` supplies `true`; `cancelChild` supplies no report scope.
- **Report scope changing eve’s cancellation semantics:** The query is forwarded, but installed eve 0.54.3’s cancel handler reads cancellation options from the request body. It does not interpret `scope`.
- **Expiring another root’s cards:** Retirement matches the requested session ID or records whose `rootSessionId` equals it. The tests cover isolation from another root and its child.
- **Approved cards surviving retirement:** Both pending and approved records are expired. The new test verifies that consuming a previously approved child card throws `approval_expired`.
- **Concurrent approval overwriting retirement:** Request, decision, consumption and retirement use the same store lock and reload before mutation. An expired record cannot subsequently be approved or consumed.
- **Consumed actions being revoked:** Consumed records remain unchanged intentionally. Retirement prevents spending outstanding approvals; it cannot reverse an action already admitted.
- **Child identity or grant escalation:** Tools verify eve’s parent metadata, reject conflicting bindings and claims, and use the root’s grant. Child grants, the selected bot and test overrides do not supersede verified child authority.
- **Proxy binding race or root rebinding:** Child binding rejects a conflicting bot, parent or existing root row. Root ownership is immutable, so normal rebinding cannot transfer a running child.
- **Resolver fallback overstating permission:** An unbound resolver child reports inherited permission without inventing a concrete grant. Once bound, it reads the recorded parent’s grant. Tool enforcement still verifies the root independently.
- **Other cancellation failures:** Failed upstream cancels, retirement-store errors and the app’s settled-root path remain existing limitations. This commit adds retirement coverage for successful root cancels and `session_not_active`; it does not introduce those failure paths.
- **Tests masking the changed semantics:** The assertions correctly distinguish child cancellation, report-only cancellation, ordinary root cancellation and approved-but-unconsumed cards. Tests were inspected, not executed, to preserve the read-only constraint.
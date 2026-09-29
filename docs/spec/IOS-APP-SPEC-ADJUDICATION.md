# Adjudication of GPT-6 Astra's findings on IOS-APP-SPEC.md

Finalizing editor: Fable 5.1, 2026-09-19. Input: `IOS-APP-SPEC-REVIEW-ASTRA.md` (25 findings,
12 verdicts, 4 addenda). Every code citation that changes the spec was re-read in the repository
before its verdict. Owner decisions D1 to D4 stand; no finding rose to a genuine blocker against
them. The one item marked "owner decision required" is the Apple Developer account (Q7), which
was already an owner question and blocks only distribution, not the build.

Verdict key: **accept** = merged as recommended; **modify** = merged with a narrower or different
fix, stated; **reject** = not merged, reason stated.

## Findings

| # | Sev | Finding | Verdict | Rationale and where it landed |
|---|-----|---------|---------|-------------------------------|
| 1 | Blocker | Revocation does not invalidate sessions | **Accept** | Confirmed: `getBrowserSession` checks only the record's expiry. Sessions now carry `credentialId` and are revalidated against the credential row on every gated request (§4.3, S9). |
| 2 | Blocker | Credential-free desktop bootstrap over the proxy | **Accept** | Confirmed: `GET /api/auth/session` trusts URL host plus Referer. One fail-closed ingress classifier; auto-session denied on any non-loopback ingress; desktop-profile sessions rejected on the tailnet path, resolving Q4 as reject (§4.2, S3, S8). |
| 3 | High | Biometric policy misses `full_access` sends, routines, connectors, spending limit | **Modify** | Confirmed at `bash.ts` auto-approve. Owner parity stands (D1). Exhaustive action class table added (§4.4). Instead of gating every send, sends and owner-question answers to a `full_access` bot require one biometric per foreground activation; that window is the single exception to "no grace window" and resets on background. Routines, connector admin, provider disconnect and limit changes are gated per action. |
| 4 | High | Approval payload lacks provenance | **Accept** | Confirmed. Server adds immutable `botId`, `botName`, `sessionId`, `cwd` to the pending approval record and payload (S10); client binds Face ID to the displayed `{id, actionSha256}`; expiry, other-device resolution and stale-card states specified (§9.2, §11). |
| 5 | High | Pairing is a repeatable plaintext export | **Modify** | Accepted in substance: `pairing.json` and default stdout export are removed; the token lives only in the Mac Keychain; reveal is the Devices pane QR rendered by CoreImage (no vendored encoder needed, resolving Q11). Kept a `--print` CLI path for the simulator dev loop, explicit and warned. Re-pairing always rotates; phone-scoped `--rotate-phone` and `--revoke-phone` leave other credentials alone (§6.1, S7). |
| 6 | High | Client endpoint policy missing; base URL silently replaced | **Accept** | Confirmed at `BackendClient.swift:258`. Endpoint policy specified (§4.7): canonical https origin, no path/query/fragment/credentials, https only except explicit loopback dev; iOS rejects instead of substituting. `LocalHost` block list gains the paired host, CGNAT, ULA and link-local ranges. |
| 7 | High | Concurrent clients fork sessions; lost send response is ambiguous | **Modify** | Confirmed. Full server-owned session attachment is too large for v1. Landed: `touchChat` becomes compare-and-set with `expectedSessionId` (S11, 409 on conflict, client adopts server pointer); a "sent, confirming" state that resolves by tail read before any retry; never auto-resend; never create a replacement session because a read failed (differs from Mac, stated). |
| 8 | High | Resume protocol can skip unseen events | **Modify** | Cursor rules accepted (§8.3): cursor per session and generation, advanced only with applied events, distinguished warm resume / cold replay / changed session / bad cache; incomplete snapshot fails rather than claims completeness. The "three quiet seconds" reading of the watchdog is not asserted in the spec; the code comment says it is a hung-connection backstop. Completeness is defined against the advertised tail instead. |
| 9 | High | OAuth needs more server changes and an app-return protocol | **Accept** | Confirmed: second callback builder in `connectors/route.ts`, loopback refusal in `connections/callback`. S6 covers all three builders and the MCP loopback check. Three state machines specified. `ASWebAuthenticationSession` dropped (https callbacks need iOS 17.4); flows open in `SFSafariViewController`, completion detected by the same polling the Mac uses, sheet dismissed by the app (§9.4). |
| 10 | High | Widgets contradict the one-host policy and assume desktop geometry | **Accept** | Confirmed at `mcp-app-host.ts`. Telemetry policy rewritten with two named exceptions (OAuth browser, widget frame) and the isolation properties written into the iOS contract. Host page takes platform and size from the caller (S12). "Honest deferral" removed: widgets ship in P4 under D3. |
| 11 | High | Routine editor specified against cron | **Accept** | Confirmed: `daily`, `weekly`, `once` with IANA zone. Structured editor mirrors the Mac; the phone always sends its current zone explicitly and shows it (§9.3). |
| 12 | High | Route matrix has wrong methods and missing mutations | **Accept** | Confirmed by reading the exports. Method-by-method matrix with auth, CSRF, biometric class (§5.1). Workspace attach hard-blocked on the `setWorkspace` shell action for phone sessions, resolving Q3 (S5). |
| 13 | High | Package split and P0/P1 boundary inconsistent; stale audit claims | **Accept** | Confirmed (`ServerConfig` reference, `ObservableObject`, bridge in `NativeTheme`). P0 now contains the complete split plus every shim needed to compile; iOS model is a new `@Observable` class by deliberate choice (§3.2, §3.4, PR-1). |
| 14 | High | Gates can skip web typecheck; Apple runner unproven | **Accept** | Confirmed: root tsconfig excludes `web/`. Gate runs `node scripts/verify-release.mjs` on server changes. P0 prerequisite: a macOS runner with pinned Xcode proves clean-clone build, test and screenshot before PR-1 opens. Gate record separates simulator, real route, real Serve, physical device; "unavailable" is red, never skipped (§17.0, §17.1). |
| 15 | High | Sign-out, unpair and cached data have no lifecycle | **Accept** | Four persisted states specified (§4.8, §13). Drafts treated as sensitive, in the protected container, excluded from backup. Unpair purges and bumps a data generation so late responses are dropped. |
| 16 | Medium | Copying Mac selection makes the two windows control each other | **Accept** | Confirmed: `select` writes `selectedBotId` server-side and the Mac adopts it on poll. Phone selection is device-local; the phone never sends `select`. Opening a past conversation is read-only browsing with an explicit "Continue this conversation" action (§3.4, §10). |
| 17 | Medium | `callerId: "phone"` does not give phone-attributed inference | **Accept** | Confirmed: eve uses the desktop router token; Usage sums the desktop caller. Spec now states one owner inference budget; the phone gets its own web rate buckets only; no per-device accounting in v1 (§4.6). |
| 18 | Medium | Auth limits and error semantics misstated | **Accept** | Confirmed: 30/min/source, no global bucket. Spec states the real limiter and adds a global bucket (S13). Client keeps 401 and 403 distinct; silent re-auth only on 401 (§8.4). |
| 19 | Medium | Tick pump not coalesced server-side | **Modify** | Confirmed that every tick schedules a pump. Server gate: one running plus at most one pending pump (S14). Scheduler ownership documented: whichever client is foregrounded ticks; neither guarantees schedules while both are away. Did not adopt a new scheduler owner for v1. |
| 20 | Medium | Reachability conflated with readiness | **Accept** | Confirmed: `/api/health` is static. Four readiness levels with distinct UI (§7.2, §11); management stays usable when only inference is down. |
| 21 | Medium | Light-only justified by a false claim about macOS | **Accept** | Confirmed (Appearance picker shipped in PR #101). Dark mode ships in v1, appearance is device-local, resolving Q5 (§12). |
| 22 | Medium | "Parity" hides undefined contracts | **Accept** | Explicit inventory: search is bot metadata plus recent titles; all provider modes; operator photo is device-local; rail rows have no previews and no unread indicator in v1 (§9). |
| 23 | Medium | Final-only measurement conflicts with Appendix B | **Modify** | The flagged 17.3 question is decided as a middle path: per-PR trap law stays; baseline measurements land in PR-3 (chat open, replay, idle) and PR-5 (widget and attachment memory) and repeat when those paths change; the full budget pass stays in PR-8. Budgets redefined with datasets, percentiles, memory accounting and send-accepted versus first-assistant-token (§16, §17.3). |
| 24 | Medium | Faint text fails 4.5:1; scroll law needs a minimum-OS plan | **Accept** | Confirmed: `inkFaint = #A3A3A3`, about 2.5:1 on white. Accessibility law takes precedence over literal token parity: readable text on iOS uses `inkMuted` or a new `inkFaintText` at 4.5:1; `inkFaint` stays decorative only. Full Dynamic Type range required. Scroll tracking specified for iOS 17 (§12, §15, Appendix A.7). Desktop has the same contrast gap; logged as a desktop follow-up, out of this spec. |
| 25 | Medium | Rollout is not additive; runtime config unvalidated | **Accept** | Confirmed: `loadRuntimeConfig` validates credentials only. S2 validates `phoneEnabled` and `tailnet`; deployment and rollback order specified; `/api/status` gains `apiVersion` for a compatibility check (S15, §19). |

## Verdicts on §20

| Q | Astra | Fable decision |
|---|-------|----------------|
| 1 | Accept parity, conditional | **Decided (owner, D1)**: owner parity stands; conditions from findings 1, 3, 4 are now spec law. |
| 2 | Keep `phone` | **Decided (Fable)**: keep `phone`. No phone row was ever minted by setup, so nothing inherits authority; S1 still requires fresh enrollment. |
| 3 | Hard-block workspace attach | **Decided (Fable)**: hard-block on the shell action for phone sessions. |
| 4 | Reject desktop sessions over tailnet | **Decided (Fable)**: reject, including locally minted cookies. Security model wins over the draft's "allow". |
| 5 | Ship dark | **Decided (Fable)**: dark ships in v1. |
| 6 | Accept SplitView unoptimized | **Decided (Fable)**: accepted, with navigation, keyboard, rotation and sheet checks in the visual gate. |
| 7 | Unverified | **Owner decision required**: Apple Developer account. Blocks TestFlight and installs beyond 7 days only. |
| 8 | Devices pane in scope | **Decided (Fable)**: in scope, desktop PR in P5. It is the sanctioned pairing reveal. |
| 9 | Keep `ios -> ../macos` | **Decided (Fable)**: keep for v1. |
| 10 | Accept `{decision, actionSha256}` | **Decided (Fable)**: accepted as the contract; provenance added by S10. |
| 11 | Local QR | **Decided (Fable)**: CoreImage `CIQRCodeGenerator` on macOS, zero dependencies; manual entry stays. |
| 12 | Keep 12 h | **Decided (Fable)**: keep, now bounded by credential validity. |

## Enhancement addenda

| # | Addendum | Verdict | Landed |
|---|----------|---------|--------|
| E1 | Normalize camera and photo attachments client-side | **Accept** | §9.2 attachments, PR-5. |
| E2 | One executable contract-fixture set for both Swift clients | **Accept** | §18, from PR-2 onward. |
| E3 | Offline draft editing, Send disabled | **Accept** | §11 offline state, PR-7. |
| E4 | Direct route to pending approvals from the Bots list | **Accept** | §10 screen 2, PR-4 after S10. |

## The 17.3 measurement question

Draft: per-PR law compliance plus one end-of-build measurement pass. Astra: measure earlier.
Decision: law compliance on every PR, instrumented baselines when the measurable surface first
exists (PR-3 for chat, replay and idle; PR-5 for widget and attachment memory), re-measured on any
PR that touches those paths, full budget pass in PR-8 on a physical device. Rationale: the macOS
audit found its worst trap (replay publishing per event) only by measuring the long chat, and
finding that at PR-8 would mean re-architecting the transcript after six PRs built on it.

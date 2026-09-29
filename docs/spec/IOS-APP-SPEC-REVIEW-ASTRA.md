# GPT-6 Astra critical analysis of IOS-APP-SPEC.md

Read-only repository review. No files were changed. Findings below distinguish source-confirmed problems from behavior that still requires live Tailscale, OAuth or device verification.

## Findings

1. **Blocker: credential revocation does not invalidate existing sessions.**

   **Spec:** §4.6, §5 S7, §6.2.

   The promised “digest-match failure” does not happen during session lookup. Credentials are checked only at sign-in. Browser sessions contain no credential ID or digest, and subsequent lookup checks only the session’s own expiry. A revoked, expired or rotated phone credential can therefore leave an existing session usable for up to 12 hours. See [auth.ts:30](/Users/wasimjalali/Desktop/useful-bot/web/lib/auth.ts:30), [web-sessions.ts:18](/Users/wasimjalali/Desktop/useful-bot/shared/web-sessions.ts:18) and [web-sessions.ts:126](/Users/wasimjalali/Desktop/useful-bot/shared/web-sessions.ts:126).

   **Fix:** Bind each device-backed session to its credential ID and generation or digest. Revalidate revocation, credential expiry and `phoneEnabled` on authenticated requests. Cap session expiry at credential expiry. Specify what happens to already-open phone streams and pending authorization flows. Add tests for revocation and rotation without restarting services.

2. **Blocker: the tailnet boundary leaves a conditional credential-free bootstrap path.**

   **Spec:** §4.2, §5 S3/S8, §20 Q4.

   `GET /api/auth/session` can mint a desktop session from a loopback request URL plus an allowed Origin or Referer. These are HTTP-level values, not proof of the connection’s origin. If Serve/Next presents the upstream loopback URL, a remote client supplying a loopback Referer could satisfy this test. The proposed rule then permits the resulting desktop cookie over tailnet. See [session/route.ts:24](/Users/wasimjalali/Desktop/useful-bot/web/app/api/auth/session/route.ts:24), [session/route.ts:52](/Users/wasimjalali/Desktop/useful-bot/web/app/api/auth/session/route.ts:52) and the explicit exception in [the spec:337](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:337).

   This is a conditional bypass, not a claim that the installed Serve configuration has been exploited. That configuration remains unverified.

   **Fix:** Deny desktop auto-session creation on every proxy-originated request. Reject desktop sessions on the tailnet path, including sessions minted locally. Define one fail-closed ingress classifier covering IPv4, IPv6, missing headers, duplicate headers and proxy header replacement. Treat user login as a user check; the per-device ACL must independently restrict the enrolled phone. Verify this through real Serve before enabling remote access.

3. **High: the biometric policy permits dangerous work through ungated entry points.**

   **Spec:** §4.1, §4.4, §9.3.

   Sending messages requires no biometric, but a bot already set to `full_access` automatically approves most shell commands. An unlocked phone can therefore request a destructive non-wipe action without encountering an approval card. The tool explicitly implements that behavior at [bash.ts:94](/Users/wasimjalali/Desktop/useful-bot/agent/tools/bash.ts:94) and [bash.ts:133](/Users/wasimjalali/Desktop/useful-bot/agent/tools/bash.ts:133).

   The gate list also omits routine creation/editing/manual execution, connector credential administration and spending-limit increases. Those are real mutation paths: [routine run:18](/Users/wasimjalali/Desktop/useful-bot/web/app/api/routines/[id]/run/route.ts:18), [connectors:72](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/route.ts:72) and [usage:101](/Users/wasimjalali/Desktop/useful-bot/web/app/api/usage/route.ts:101).

   **Fix:** Keep owner parity, but define an exhaustive action-to-authentication table. Cover execution initiated through chat, owner-question answers, routines and direct settings actions. Either gate execution-capable sends or explicitly accept an authenticated app-access window. Do not describe approval-card gating as covering all dangerous actions.

4. **High: approval cards lack the provenance needed for safe remote approval.**

   **Spec:** §9.2, §14, §15, §20 Q10.

   The public approval payload contains `id`, `tool`, `preview`, hash and timestamps. It omits session, bot and execution directory. The desktop renders the global approval list inside whichever chat is selected. See [approvals.ts:294](/Users/wasimjalali/Desktop/useful-bot/agent/lib/approvals.ts:294) and [ChatView.swift:115](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/ChatView.swift:115). Bash includes the directory in its hash, but its displayed preview is only the command and optional risk explanation: [bash.ts:86](/Users/wasimjalali/Desktop/useful-bot/agent/tools/bash.ts:86).

   Consequently, the phone cannot reliably identify the requesting bot, badge its rail row or explain where a relative command will execute. Face ID does not fix that ambiguity. The existing preview also has a six-line limit: [ChatView.swift:178](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/ChatView.swift:178).

   **Fix:** Add immutable approval provenance and a complete inspectable action preview. Resolve bot identity server-side and retain it when session pointers change. Bind the biometric confirmation to the displayed approval ID/hash. Specify expiry, another-device resolution and changed-workspace outcomes.

5. **High: pairing is described as a single reveal but creates a reusable plaintext credential export.**

   **Spec:** §4.1, §5 S7, §6.1, §9.6.

   The token is printed, retained in `pairing.json` until revocation and deliberately redisplayed from the Mac. That is repeatable disclosure of a 30-day owner credential, not a single reveal. The contradiction is explicit between [the spec:219](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:219) and [the spec:392](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:392). Mode `0600` does not remove terminal scrollback, accidental captures or the extra plaintext copy.

   Phone rotation also needs separate semantics: the current global `--rotate` remints credentials and reconstructs configuration with phone access disabled. See [setup-local.mjs:167](/Users/wasimjalali/Desktop/useful-bot/scripts/setup-local.mjs:167).

   **Fix:** Prefer local, explicit QR reveal directly from Keychain, with automatic dismissal and no routine stdout/file export. Rotate for re-pairing. If true one-time enrollment is intended, specify a short-lived redeemable enrollment secret instead. Define phone-only pairing/revocation/rotation that preserves unrelated credentials and configuration.

6. **High: the networking port omits the client’s endpoint security policy.**

   **Spec:** §3.2, §6.1, §7.3, §8.

   Replacing the Keychain `Process` call is insufficient. `BackendClient` silently replaces every non-loopback base URL with `ServerConfig.resolved().baseURL`: [BackendClient.swift:252](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:252). The specified tailnet URL therefore cannot work unchanged.

   Meanwhile, enrollment requires only a nonempty scheme/host, leaving the replacement policy underspecified. The existing link filter also does not recognize the paired `*.ts.net` hostname or CGNAT IPv4 range as local: [LocalHost.swift:29](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/LocalHost.swift:29) and [LocalHost.swift:115](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/LocalHost.swift:115).

   **Fix:** Specify canonical HTTPS-origin validation, allowed ports, rejection of URL credentials/query/fragment, origin-bound token storage and redirect handling. Allow plain HTTP only for the explicit simulator loopback configuration. Reject invalid endpoints visibly instead of substituting localhost. Block model-generated links to the paired Mac and internal address ranges.

7. **High: simultaneous clients and ambiguous send failures can fork or duplicate conversations.**

   **Spec:** §2.2, §3.4, §8.

   Session creation and saving the bot’s session pointer are separate requests. `send()` posts the turn; `touchChat()` later writes its session ID. Two clients seeing a bot without a session can create different sessions, after which the last pointer write wins. See [BackendClient.swift:968](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:968), [BackendClient.swift:1009](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:1009) and [shell-store.ts:870](/Users/wasimjalali/Desktop/useful-bot/shared/shell-store.ts:870).

   The send body has no client operation ID. If the server accepts a turn but the response is lost, the phone cannot reliably distinguish “not sent” from “accepted.” The Mac also falls back to creating a session when its history snapshot fails, which is risky over intermittent mobile connectivity: [AppModel.swift:1276](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:1276).

   **Fix:** Define idempotent send operations, server-owned session attachment and a conflict rule for concurrent session creation/replacement. Add an “acceptance unknown, reconciling” state. Never automatically resend or create a replacement session merely because a network read failed.

8. **High: the resume formula is correct, but the recovery protocol can skip unseen events.**

   **Spec:** §8, §13, Appendix A.4.

   `lastAppliedIndex + 1` is correct for a retained projection. The proxy only relays `x-eve-stream-tail-index`; individual event indexes are counted by the Swift reader, including payload lines it cannot decode. See [eve proxy:163](/Users/wasimjalali/Desktop/useful-bot/web/app/eve/v1/[...path]/route.ts:163), [BackendClient.swift:1412](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:1412) and [StreamCursorTests.swift:9](/Users/wasimjalali/Desktop/useful-bot/macos/Tests/UsefulBotCoreTests/StreamCursorTests.swift:9).

   “Re-attach at latest tail index” is unsafe after suspension: the server’s latest tail can include events the phone never applied. A 200-row rendered cache is also insufficient to reconstruct every in-flight projection. `historySnapshot()` collects IDs, not display state: [BackendClient.swift:1282](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:1282). Its shared reader can finish after three quiet seconds without proving it reached the advertised tail: [BackendClient.swift:1485](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:1485).

   **Fix:** Specify cursors per session and transcript generation, advanced only with applied state. Distinguish warm resume, cold replay, changed session and missing/corrupt cache. Persist a sufficient checkpoint or replay from a safe boundary. A stalled incomplete snapshot must fail, not claim completeness. Test suspension mid-message, unknown events, missing tail headers and session replacement.

9. **High: OAuth requires more server changes and a defined app-return protocol.**

   **Spec:** §5 S6, §9.4, §9.5.

   S6 changes only the shell route’s callback builders. Marketplace authorization has another loopback callback builder at [connectors/route.ts:32](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/route.ts:32), used at [connectors/route.ts:109](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/route.ts:109). MCP completion explicitly refuses a non-loopback request URL: [connections/callback:41](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connections/callback/route.ts:41).

   The callbacks also have different contracts. Composio’s callback is only a landing page; success comes from polling. MCP completion changes state using stored OAuth state and PKCE. See [connectors/callback:3](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/callback/route.ts:3), [connection-flow.ts:274](/Users/wasimjalali/Desktop/useful-bot/shared/connection-flow.ts:274) and [mcp-oauth.ts:238](/Users/wasimjalali/Desktop/useful-bot/shared/mcp-oauth.ts:238). Applying `requireOwner` uniformly would incorrectly assume the browser has the native client’s private cookie.

   **Fix:** Specify separate provider-device-flow, Composio and MCP state machines. Update every callback builder. Preserve callback-specific authorization and replay protection. Define precisely how `ASWebAuthenticationSession` completes or is dismissed on the minimum OS, including cancellation, reopening and completion after suspension. An HTTPS landing page alone is not an app-return contract.

10. **High: widget parity contradicts the single-host privacy policy and assumes desktop geometry.**

    **Spec:** §4.5, §9.2, Appendix B.10.

    The widget host permits scripts, fonts, images and connections to `esm.sh` plus resource-declared domains: [mcp-app-host.ts:12](/Users/wasimjalali/Desktop/useful-bot/shared/mcp-app-host.ts:12). It sends tool arguments/results into that frame and advertises `platform: "desktop"` with a 720×480 container: [mcp-app-host.ts:53](/Users/wasimjalali/Desktop/useful-bot/shared/mcp-app-host.ts:53). That conflicts with “no third-party network calls” and “exactly one host.”

    The desktop’s important isolation properties are not written into the iOS contract: nonpersistent WebKit storage, authenticated HTML fetching outside WebKit and restricted navigation. See [WidgetWebView.swift:45](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/WidgetWebView.swift:45) and [WidgetWebView.swift:109](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/WidgetWebView.swift:109).

    **Fix:** Decide the allowed network exceptions explicitly, including OAuth browsers and widgets. Preserve cookie isolation and the sandbox. Bound resource domains, prevent access to the paired Mac/internal network and forbid privileged native bridges by default. Supply actual mobile dimensions and define loading, failure, resizing and WebKit process-loss states. “Widget renders or honest deferral” cannot satisfy locked full-parity scope.

11. **High: the routine editor is specified against a nonexistent cron contract.**

    **Spec:** §9.3, §17 P5.

    The server accepts structured `daily`, `weekly` and `once` schedules with an IANA timezone, not cron expressions. See [routines-store.ts:50](/Users/wasimjalali/Desktop/useful-bot/shared/routines-store.ts:50) and [routines/route.ts:45](/Users/wasimjalali/Desktop/useful-bot/web/app/api/routines/route.ts:45).

    A direct UI port also introduces timezone ambiguity. The Mac editor defaults to `TimeZone.current`; the server defaults omitted zones to the Mac’s zone. Those are equivalent locally but can differ on a travelling phone. See [ChatDetailsPaneView.swift:273](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/ChatDetailsPaneView.swift:273) and [routines-store.ts:606](/Users/wasimjalali/Desktop/useful-bot/shared/routines-store.ts:606).

    **Fix:** Use the existing schedule types and constraints. Define whose timezone a new routine uses, display that zone and send it explicitly. Include DST behavior, multiple schedules, paused manual runs and run-history states.

12. **High: the “complete” route matrix contains incorrect methods and misses required mutations.**

    **Spec:** §5.1.

    | Surface | Repository contract |
    |---|---|
    | Workspace | `GET` reads project recents; `POST` adds/removes them. Actual workspace grants change through `PUT /api/shell`. [workspace:18](/Users/wasimjalali/Desktop/useful-bot/web/app/api/workspace/route.ts:18), [shell:305](/Users/wasimjalali/Desktop/useful-bot/web/app/api/shell/route.ts:305) |
    | Agent widget | Persistence is `POST`, not the listed `GET`. [widget:14](/Users/wasimjalali/Desktop/useful-bot/web/app/api/agent/widget/route.ts:14) |
    | Providers | Disconnect requires `DELETE`. [providers:181](/Users/wasimjalali/Desktop/useful-bot/web/app/api/providers/route.ts:181) |
    | Provider OAuth | Polling is `POST /[pollId]`; cancellation is `DELETE /[pollId]`. [OAuth poll:71](/Users/wasimjalali/Desktop/useful-bot/web/app/api/providers/oauth/[pollId]/route.ts:71) |
    | Connectors | Key configuration requires `PUT`; disconnect requires `DELETE`. [connectors:72](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/route.ts:72), [connectors:118](/Users/wasimjalali/Desktop/useful-bot/web/app/api/connectors/route.ts:118) |
    | Eve | GET permits only health, info and session streams; session creation/continuation/cancel are POST. [eve-proxy.ts:26](/Users/wasimjalali/Desktop/useful-bot/shared/eve-proxy.ts:26) |

    **Fix:** Freeze a method-by-method contract with request shape, authentication, CSRF, biometric class and errors. Make callbacks explicit exceptions. If workspace attachment remains Mac-only, enforce that on the shell action; hiding a picker or blocking the wrong endpoint does nothing.

13. **High: the package extraction and P0/P1 boundaries are internally inconsistent.**

    **Spec:** §3.2, §3.4, §17 P0/P1, §18.

    Moving `ServerConfig` out of Core leaves `BackendClient` referencing a type it no longer owns. Moving supervision types also breaks tests that import only Core and instantiate those types. See [BackendClient.swift:258](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:258), [Package.swift:8](/Users/wasimjalali/Desktop/useful-bot/macos/Package.swift:8) and [LocalServicesTests.swift:3](/Users/wasimjalali/Desktop/useful-bot/macos/Tests/UsefulBotCoreTests/LocalServicesTests.swift:3). P0 requires an iOS build while the `Process` shim is assigned to P1.

    Other audit claims are stale: `AppModel` is `ObservableObject` with `@Published`, not `@Observable`; the color bridge resides in `NativeTheme.swift`, not `DesignTokens.swift`. See [AppModel.swift:21](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:21) and [NativeTheme.swift:16](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/NativeTheme.swift:16).

    **Fix:** Give P0 a complete target/dependency/test split and every shim needed to compile. Run portable tests on both platforms and supervision tests on macOS. Describe observation migration as a deliberate change with verification, not an existing architecture.

14. **High: the verification gates can pass without checking the changed web code, and the Apple execution environment is unproven.**

    **Spec:** §17.1, §18, §19.

    Root `npx tsc --noEmit` explicitly excludes `web/`: [tsconfig.json:15](/Users/wasimjalali/Desktop/useful-bot/tsconfig.json:15). The repository’s release verifier separately checks root, web and router TypeScript projects and builds Next.js: [verify-release.mjs:77](/Users/wasimjalali/Desktop/useful-bot/scripts/verify-release.mjs:77).

    “Fully in Devin’s cloud environment” does not establish access to the macOS/Xcode runner, installed simulator runtime, Keychain fixtures or owner-assisted tailnet required by the gates. The existing verifier even records Swift macOS tests as skipped in its Linux workflow: [verify-release.mjs:67](/Users/wasimjalali/Desktop/useful-bot/scripts/verify-release.mjs:67).

    **Fix:** Make runner provisioning and a successful clean-clone build/test/screenshot demonstration a P0 prerequisite. Pin Xcode, schemes, working directories and destinations. Add web/router typechecks and the production web build for backend changes. Record simulator, real-route, real-Serve and physical-device gates separately; a stub must not substitute for an unavailable gate.

15. **High: sign-out, unpairing and cached-data privacy have no coherent lifecycle.**

    **Spec:** §4.5, §6.2, §13.

    Sign-out retains the device token, while launch automatically exchanges it for a new session. Without a persisted signed-out state, relaunch immediately undoes sign-out. The spec also refers to wiping a cookie jar from Keychain while elsewhere requiring that jar to be in memory. See [the spec:412](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:412).

    Drafts are declared nonsecret and backup exclusion unnecessary, followed by “Nothing goes to iCloud.” Arbitrary user input can contain sensitive data; that classification is unsound. Unpairing specifies token deletion but not clearing transcripts, drafts, attachments or pending tasks. See [the spec:640](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:640).

    **Fix:** Define explicit paired, signed-out, credential-invalid and unpaired states. Specify local sign-out when the Mac is unreachable, a genuine resume-sign-in action and a purge policy for all host-bound data. Treat drafts as sensitive and require a consistent backup policy. Prevent old in-flight responses from repopulating data after unpairing.

16. **Medium: copying Mac selection semantics makes the two windows control each other.**

    **Spec:** §3.4, §10.

    The selected bot is global server state. Mac selection writes it, and polling adopts a different server selection. See [shell-store.ts:564](/Users/wasimjalali/Desktop/useful-bot/shared/shell-store.ts:564), [AppModel.swift:596](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:596) and [AppModel.swift:2449](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:2449).

    A phone port using these semantics will move the Mac to whichever bot the phone opens. Opening a recent conversation also replaces the bot’s shared current session: [shell-store.ts:921](/Users/wasimjalali/Desktop/useful-bot/shared/shell-store.ts:921).

    **Fix:** Define device-local navigation separately from shared conversation state. Preserve each client’s valid selection. Specify whether opening history is read-only browsing or deliberately changes the shared active conversation. Test both clients open simultaneously.

17. **Medium: separate phone model accounting is not provided by `callerId: "phone"`.**

    **Spec:** §4.1, §4.6, §5.

    The phone’s web requests can have separate endpoint rate buckets, but all Eve model calls still use `UB_ROUTER_DESKTOP_TOKEN`: [agent.ts:147](/Users/wasimjalali/Desktop/useful-bot/agent/agent.ts:147). Usage explicitly summarizes the desktop caller: [usage/route.ts:50](/Users/wasimjalali/Desktop/useful-bot/web/app/api/usage/route.ts:50). Changing the phone profile’s limits does not create phone-attributed inference.

    Even the proposed policy parity is partial: phone search retains a lower separate cap, and the aggregate ceiling remains shared. See [policy.ts:47](/Users/wasimjalali/Desktop/useful-bot/shared/policy.ts:47).

    **Fix:** Retain one owner inference budget and describe it honestly. If device attribution is required, propagate trusted per-operation provenance and expose it in accounting. Do not switch a shared session’s mutable caller identity between devices.

18. **Medium: the existing auth limits and error semantics are misstated.**

    **Spec:** §4.3, §6.2, §8.

    The claimed failed-auth limits of five per source and fifty total are absent. POST uses a 30-per-minute source bucket, with no global bucket, and its source key comes from forwarded headers or Host: [session/route.ts:7](/Users/wasimjalali/Desktop/useful-bot/web/app/api/auth/session/route.ts:7) and [session/route.ts:80](/Users/wasimjalali/Desktop/useful-bot/web/app/api/auth/session/route.ts:80).

    The shared client retries authentication on both 401 and 403, then maps final 403 responses to unauthorized. That can misreport policy, origin or CSRF rejection as a bad credential: [BackendClient.swift:370](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:370) and [BackendClient.swift:1520](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:1520).

    **Fix:** Specify and implement the intended limiter, using trusted source classification. Preserve structured forbidden, origin, CSRF, rate-limit and credential errors. Restrict silent reauthentication to the defined recoverable cases and deduplicate it across streams and ordinary requests.

19. **Medium: `/api/agent/tick` is serialized, but polling work is not coalesced.**

    **Spec:** §3.4, §5.1, §8, §14.

    Every tick appends another pump run to a promise chain. The route returns immediately, so client-side `tickInFlight` cannot prevent the server queue from growing while an earlier delivery is slow. See [tick/route.ts:90](/Users/wasimjalali/Desktop/useful-bot/web/app/api/agent/tick/route.ts:90), [agent-exec.ts:516](/Users/wasimjalali/Desktop/useful-bot/web/lib/agent-exec.ts:516) and [agent-exec.ts:860](/Users/wasimjalali/Desktop/useful-bot/web/lib/agent-exec.ts:860).

    Routine scheduling also depends on ticks. The Mac continues ticking with hidden windows, but that depends on the app remaining alive: [AppModel.swift:472](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppModel.swift:472). An awake Mac with services running is not, by itself, the complete scheduling guarantee.

    **Fix:** Coalesce server pump requests into bounded pending work. Define scheduler ownership when the phone backgrounds and when the Mac app quits. Test two clients polling during slow runs, and clarify which tasks continue independently of either visible UI.

20. **Medium: reachability is conflated with backend readiness.**

    **Spec:** §7.2, §8, §11.

    `/api/health` always returns `{ok:true}`. It proves only that Next.js answered: [health/route.ts:3](/Users/wasimjalali/Desktop/useful-bot/web/app/api/health/route.ts:3). `/api/status` separately probes Eve, while tick can report missing agent credentials: [status/route.ts:9](/Users/wasimjalali/Desktop/useful-bot/web/app/api/status/route.ts:9) and [tick/route.ts:85](/Users/wasimjalali/Desktop/useful-bot/web/app/api/agent/tick/route.ts:85).

    **Fix:** Distinguish transport unreachable, authenticated API available, runtime unavailable and provider unavailable. Keep management operations available when only inference is down. Define live-versus-cached status for approvals and disable every unavailable mutation, not just the composer. Add explicit camera-denied, passcode-unavailable, permission-denied and operation-conflict states.

21. **Medium: light-only is justified by an incorrect claim about macOS.**

    **Spec:** §12, §20 Q5.

    macOS already exposes an appearance picker, supports system/light/dark and resolves tokens dynamically. See [AppSettingsView.swift:245](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/AppSettingsView.swift:245), [NativeTheme.swift:22](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/NativeTheme.swift:22) and [NativeTheme.swift:114](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/NativeTheme.swift:114). The server’s `theme: "light"` is not the native appearance authority.

    **Fix:** Include dark mode for actual native parity, or document light-only as an explicit approved reduction. Keep appearance device-local unless cross-device synchronization is deliberately added.

22. **Medium: “parity” hides several undefined feature contracts.**

    **Spec:** §9, §10.

    Concrete omissions or mismatches include:

    - Providers support OAuth, subscription-key, API-key and local modes, plus provider-specific fields. The screen description mostly covers device OAuth. [provider-catalog.ts:3](/Users/wasimjalali/Desktop/useful-bot/shared/provider-catalog.ts:3), [BackendClient.swift:500](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/BackendClient.swift:500).
    - Mac search filters bot metadata and recent titles/previews. It is not full transcript search. The spec must define what “global search” means. [PickerViews.swift:219](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/PickerViews.swift:219).
    - The operator photo is stored only in the Mac app’s Application Support directory. There is no shared account-photo contract to mirror. [OperatorAvatar.swift:7](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/OperatorAvatar.swift:7).
    - Mac bot rows intentionally omit message previews, while iOS labels previews and unread indicators as parity. The shared bot schema contains no read watermark. [RailView.swift:635](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/RailView.swift:635), [shell-store.ts:47](/Users/wasimjalali/Desktop/useful-bot/shared/shell-store.ts:47).

    **Fix:** Replace “whatever macOS shows” with an explicit feature inventory. Define search scope, recent-conversation navigation, all provider modes, photo ownership and device-local unread semantics. Mark intentional iOS additions separately from parity.

23. **Medium: final-only performance measurement conflicts with the embedded law and delays architectural feedback.**

    **Spec:** §16, §17.1, §17.3, Appendix B.12.

    Section 17 reserves deep measurement for PR-8, while Appendix B requires measurements with performance claims in each PR. See [the spec:728](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:728) and [the spec:1050](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:1050).

    Budget definitions are also incomplete. “First stream event” can be the echoed user message, not the first assistant token. A 200-row UI window does not bound replay or network work. Memory must distinguish app footprint from WebKit processes, which the Mac record explicitly measures separately: [PERFORMANCE.md:93](/Users/wasimjalali/Desktop/useful-bot/docs/audit/PERFORMANCE.md:93). State polling returns the full retained event set: [agent/state:17](/Users/wasimjalali/Desktop/useful-bot/web/app/api/agent/state/route.ts:17).

    **Fix:** Measure basic chat, replay and idle baselines in P2; widget/attachment memory in P4; repeat relevant measurements when those paths change. Keep the final physical-device pass. Define datasets, network conditions, repetitions/percentiles, memory accounting and separate send-accepted/first-assistant-token metrics. Do not certify tailnet latency or device energy from simulator results.

24. **Medium: design parity and accessibility law currently require conflicting outcomes.**

    **Spec:** §12, §15, Appendix A.2/A.4/A.5.

    The mandated faint text token is `#A3A3A3` against white or `#F3F3F3`: [DesignTokens.swift:8](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotCore/DesignTokens.swift:8). Calculated contrast is approximately **2.52:1** on white and **2.27:1** on the canvas, below the spec’s 4.5:1 text requirement. Mac uses it for actual labels, not just decoration: [RailView.swift:637](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/RailView.swift:637).

    The scroll law also needs a minimum-OS implementation plan. Mac gesture/geometry tracking is availability-gated, with no tracking in its fallback: [ChatView.swift:1132](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/ChatView.swift:1132). “Port verbatim” does not establish the required iOS 17 behavior.

    **Fix:** Establish accessibility precedence over literal token/screenshot parity. Use compliant text colors and test the full supported Dynamic Type range, not only 135%. Specify and verify minimum-OS scroll tracking, keyboard resizing and history-prepend anchoring.

25. **Medium: rollout and rollback are not safely additive as claimed.**

    **Spec:** §4.1, §5 S2/S7, §19.

    Enabling remote ingress and upgrading a profile’s authority are operational security changes. Reverting code while leaving Serve enabled can restore old loopback-only assumptions behind remote ingress. Reusing `phone` also requires ensuring that any preexisting phone credential does not silently inherit owner authority.

    Runtime validation currently validates credentials but does not validate `phoneEnabled` or the `tailnet` object before casting the result: [runtime.ts:55](/Users/wasimjalali/Desktop/useful-bot/shared/runtime.ts:55). The current setup script’s rotation replaces configuration wholesale: [setup-local.mjs:167](/Users/wasimjalali/Desktop/useful-bot/scripts/setup-local.mjs:167).

    **Fix:** Define a deployment order, strict tailnet configuration invariants and newly minted owner-phone enrollment. Add an app/server compatibility check. Rollback must first disable remote exposure and invalidate affected sessions, then restore compatible code/configuration. Preserve unrelated credentials and owner data.

## Verdicts on §20’s open questions

1. **Owner parity:** Accept the locked decision, conditional on complete biometric coverage, revocable sessions and safe approval provenance; reducing the tool tier is unnecessary.
2. **Profile name:** Keep `phone`, but require fresh owner-phone enrollment so older credentials cannot silently gain authority.
3. **Workspace actions:** Hard-block phone-originated workspace attachment changes in `PUT /api/shell` for v1; the exception must match its advertised read-only behavior. [Actual mutation](/Users/wasimjalali/Desktop/useful-bot/web/app/api/shell/route.ts:305).
4. **Tailnet session binding:** Reject desktop sessions over tailnet, including locally minted cookies; allowing them undermines the credential-refusal rule.
5. **Dark mode:** Ship dark mode for parity; macOS already supports it. [Appearance implementation](/Users/wasimjalali/Desktop/useful-bot/macos/Sources/UsefulBotApp/NativeTheme.swift:114).
6. **iPad:** Accept adaptive SplitView without dedicated optimization, with navigation, keyboard, rotation and sheet checks included.
7. **Apple Developer account:** Availability is unverified; resolve signing ownership before distribution, while keeping unsigned simulator work independent.
8. **macOS Devices pane:** Keep it in scope as the local enrollment/revocation interface; CLI pairing can support early development.
9. **Package relocation:** Keep `ios -> ../macos` for v1; fix target boundaries without adding a relocation.
10. **Approvals proxy:** Accept the existing decision contract: ID in the URL, `{decision, actionSha256}` in the body; provenance and stale-card handling still need changes. [Contract](/Users/wasimjalali/Desktop/useful-bot/web/app/api/approvals/[id]/route.ts:21).
11. **QR rendering:** Ship local QR rendering with manual fallback; choose a native encoder where feasible, otherwise a vetted vendored implementation, with no network QR service.
12. **Session TTL:** Keep 12 hours; single-flight silent reauthentication is reasonable once credential expiry and revocation also bound session validity.

## Enhancement addenda

1. **Medium: normalize camera and photo attachments before upload.**

   **Spec:** §9.2, §17 P4.

   The existing API caps files at 1 MiB and recognizes PNG, JPEG, GIF and WebP. HEIC can become an attachment without usable image content: [attachments.ts:1](/Users/wasimjalali/Desktop/useful-bot/shared/attachments.ts:1), [attachments.ts:49](/Users/wasimjalali/Desktop/useful-bot/shared/attachments.ts:49) and [attachments/route.ts:45](/Users/wasimjalali/Desktop/useful-bot/web/app/api/attachments/route.ts:45).

   **Recommendation:** Add bounded client-side downsampling, orientation normalization and conversion to a supported format. Show when an image cannot fit or the selected model cannot see it. This makes the existing camera/picker feature usable without increasing server limits.

2. **Medium: maintain one executable contract-fixture set for both Swift clients.**

   **Spec:** §3.2, §18.

   The repository already has useful protocol invariants, including unknown-event counting and tail-index behavior: [StreamCursorTests.swift:9](/Users/wasimjalali/Desktop/useful-bot/macos/Tests/UsefulBotCoreTests/StreamCursorTests.swift:9). The incorrect route matrix demonstrates the cost of separately maintained descriptions.

   **Recommendation:** Use sanitized fixtures produced through actual route handlers for authentication, approvals, routines, provider flows and stream recovery. Exercise them from both clients. Include delayed responses, dropped acknowledgements and competing-client actions. This provides stronger evidence than a stub independently implementing the same mistaken spec.

3. **Low: allow offline draft editing without an outbound queue.**

   **Spec:** §11, §13.

   The spec disables the composer offline while already requiring persistent per-bot drafts: [the spec:612](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:612), [the spec:647](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:647).

   **Recommendation:** Keep text editing available and disable Send. Preserve drafts under the corrected sensitive-data policy. Require an explicit send after reconnection. This improves away-from-desk use without introducing background delivery or retry ambiguity.

4. **Low: provide a direct route to pending approvals from the Bots list.**

   **Spec:** §10, §14.

   Approvals are already returned as a global list, but the specified navigation places their controls inside chat: [approvals/route.ts:12](/Users/wasimjalali/Desktop/useful-bot/web/app/api/approvals/route.ts:12), [the spec:580](/Users/wasimjalali/Desktop/useful-bot/docs/spec/IOS-APP-SPEC.md:580).

   **Recommendation:** Once provenance is fixed, add a pending-approvals entry or filter that opens the correct action context. With no APNs, this makes the core gatekeeping task easier to discover when the owner opens the app.

## Verdict

**Do not freeze this draft yet.** The architecture and locked owner decisions remain viable, but S1–S8 are not a complete implementation contract. Session revocation, ingress classification, biometric coverage, approval provenance, concurrent sends, recovery and OAuth need explicit resolutions. The route inventory and several claims about the Mac are also stale. After those fixes, a demonstrated Apple build/test environment and an early real-Serve security check, the spec can be ready for implementation agents. Keep the phased build and independent reviews, but allow PR boundaries to follow risk and require relevant measurements before the final hardening pass.
# Useful Bot for iOS: implementation specification

Status: **frozen for implementation** (2026-09-19). Review chain: drafted by Devin from a full
codebase audit; critically analysed by GPT-6 Astra (`IOS-APP-SPEC-REVIEW-ASTRA.md`, 25 findings);
adjudicated and finalized by Fable 5.1 (`IOS-APP-SPEC-ADJUDICATION.md`). Handed to SWE-2 Max
cloud agents for implementation per the execution model in §17. This document is the single
contract for the iOS effort. Where it conflicts with `SPEC.md` / `PLAN-FINAL.md` (both written
before the native app was committed to), this document records the newer owner decision and says
so explicitly. Where two sections of this document disagree, §4 (security model) wins.

Source of truth for product behavior: the macOS app (`macos/`) and the shared TypeScript
backend (`shared/`, `web/app/api/`, `web/app/eve/`). The browser UI was removed on 2026-09-28;
`web/` is only that backend now.

Every claim in this document about existing code was verified against the repository on
2026-09-19. Build agents who find a claim stale must record it in the build log (§17.4) and
follow the code, not the claim, then flag the drift in the PR.

---

## 1. Goals and non-goals

### 1.1 Goal

A premium native iOS app that is the owner's phone companion to the Useful Bot macOS app.
Same bots, same conversations, same design system, same backend. The owner walks away from
the Mac and keeps working: read and send messages, approve actions, manage bots, groups,
providers, connectors, routines and memory, with the full authority the Mac has, gated by
device biometrics where the Mac gates by presence.

### 1.2 Owner decisions (locked 2026-09, confirmed through external review)

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| D1 | Trust level | **Owner parity, biometric-gated** | Supersedes the reduced `phone` profile in SPEC.md §phone policy. Conditions attached by review: sessions revocable in real time (§4.3), exhaustive action-to-authentication table (§4.4), approval provenance (§9.2). See §6. |
| D2 | Connectivity | **Tailscale Serve** | Confirmed by review; neither reviewer argued an alternative. A real-Serve security check is a PR-2 gate (§17.2). |
| D3 | v1 scope | **Full parity, phased build** | Everything the Mac can do, delivered in ordered phases (§17). No feature in the parity matrix may be downgraded to "deferral" by a build agent; a parity gap is a finding. |
| D4 | Push | **No APNs in v1** | Local/in-app states only; APNs is a v1.1 candidate (§14). |

### 1.3 Decisions taken in finalization

These resolve the draft's open questions (§20 keeps the full record).

| # | Decision | Choice |
|---|----------|--------|
| F1 | Profile literal | Keep `phone`; fresh enrollment required (S1). |
| F2 | Workspace attach from phone | Hard-blocked server-side on the shell action (S5). |
| F3 | Desktop session over tailnet | Rejected, including locally minted cookies (S3). |
| F4 | Appearance | Dark mode ships in v1; appearance is device-local (§12). |
| F5 | iPad | Adaptive `NavigationSplitView`, not optimized; navigation, keyboard, rotation and sheet checks in the visual gate. |
| F6 | macOS Devices pane | In scope; it is the sanctioned pairing reveal (§6.1, §9.6). |
| F7 | Package location | `ios/` depends on `../macos` for v1. |
| F8 | QR rendering | CoreImage `CIQRCodeGenerator` on macOS; no vendored encoder, no network service. |
| F9 | Session TTL | 12 hours, bounded by credential validity. |
| F10 | OAuth browser | `SFSafariViewController` plus polling; no `ASWebAuthenticationSession`, no URL scheme (§9.4). |
| F11 | Performance cadence | Trap law per PR; baselines in PR-3 and PR-5; full budget pass in PR-8 (§17.3). |
| F12 | Apple Developer account | **Owner decision required.** Blocks TestFlight and installs beyond 7 days only; nothing in P0 to P7 waits on it. |

**Amendments after the freeze** (dated; the only way this document changes):

| # | Date | Amendment |
|---|------|-----------|
| A1 | 2026-09-19 | Cloud execution environment pinned: Devin macOS cloud sessions (Apple Silicon, Xcode 26 default, one preinstalled iPhone simulator running iOS 26). One Devin session per PR, sessions chained without a human, independent reviewer sessions, the whole backend stack run inside the VM. Owner-run gates (real Serve, physical device) move to a post-chain owner checklist. See §17.5. |
| A2 | 2026-09-19 | Design spec `IOS-DESIGN-SPEC.md` is binding alongside this document. Its section 6.2 items are closed (design agents, Prompt 7). Its approved iPhone tokens, `inkFaintText` and `overlayDark` are added to `DesignTokens.swift` in PR-1. |
| A3 | 2026-09-19 | Appendix A.2 scrim rule extended for dark mode: light keeps the solid `rgb(23 23 23 / 0.18)`; dark uses a solid `#000000` at 48% (`overlayDark`), because the token scrim does not move a `#0F0F0F` stage. Still solid, still never a blur. Decided by the design agents within the design spec (its section 6.2 item 2), recorded here so A.2 and the design spec agree. |

### 1.4 Non-goals for v1

- Android (follows iOS with a separate spec; design this one so contracts are portable).
- iPad-specific layout work beyond adaptive `NavigationSplitView` (supported, not optimized).
- watchOS, CarPlay, Siri/App Intents, home-screen widgets, share extensions.
- APNs push notifications, Background App Refresh.
- A hosted relay, multi-Mac support, multi-user/multi-owner support.
- A new backend. The phone talks to the *existing* Next.js service on the Mac.
- App Store submission. Build/install via Xcode; TestFlight optional (§20 Q7).
- Per-device inference accounting (§4.6).

---

## 2. Product context

### 2.1 What the product is

Useful Bot is a local-first multi-agent system. The Mac runs three loopback services:

| Service | Port | Role |
|---------|------|------|
| Router | 127.0.0.1:4319 | AuthN/Z, model routing, credential registry |
| Web (Next.js) | 127.0.0.1:4320 | Owner API + eve proxy |
| Eve agent | 127.0.0.1:4321 | Agent runtime (Vercel `eve` 0.54.3) |

The macOS app supervises these, renders the UI natively (SwiftUI/AppKit), and authenticates
with a Keychain-held device credential. The iOS app changes exactly one thing in this
picture: it is a *remote* owner client. The Mac stays the system of record; the phone holds
no agent state, no provider keys, no transcripts of its own beyond a bounded cache (§13).

### 2.2 Personas / use cases

1. **Away-from-desk continuation**: owner reads and replies to bot threads on the couch,
   in transit, in a meeting. Must feel instant and complete, not a read-only mirror.
2. **Approval gatekeeping**: a bot asks to run a command or edit a file; the owner
   approves from the phone (Face ID) instead of walking back to the Mac. The card says
   which bot asked and where the command runs (§9.2).
3. **Fleet management**: create/rename/move/hide/delete bots, organize sections, form
   groups, set permissions.
4. **Provider and connector administration**: check balances/usage, switch models,
   connect apps (OAuth completes in an in-app Safari sheet over the tailnet, §9.4).
5. **Routine supervision**: view/edit/run routines, see run results in transcripts.

### 2.3 Honest limitation to surface in UI copy

The Mac is the server. **When the Mac is asleep, offline, or the services are down, the
phone app is a cached read view with clear status, never silent staleness.** The offline
states in §11 must say this plainly ("Your Mac is unreachable" with last-seen time), and
must distinguish "no network", "Mac unreachable", "Mac up, agent runtime down" and "Mac up,
model provider down" (§7.2).

### 2.4 Two windows, one system

The phone and the Mac are two windows onto one set of conversations. Rules that follow:

- Conversation state (which session a bot is on, its transcript, pending approvals) is
  shared and server-owned.
- Navigation state (which bot is selected, which sheet is open, appearance) is device-local.
  The phone never writes the Mac's selection and never adopts it (§3.4).
- Both clients may poll and tick at once; the server coalesces the work (§8.5).
- Neither client guarantees routine schedules while both are backgrounded (§14).

---

## 3. Architecture

### 3.1 Diagram

```
┌─────────────────────────┐          tailnet HTTPS (443)          ┌───────────────────────────┐
│  iPhone (iOS 17+)       │  https://<mac>.<tailnet>.ts.net  ───▶ │  Tailscale Serve (macOS)  │
│  UsefulBot iOS app      │  Bearer device credential -> session   │  forwards to loopback only│
│  Keychain: device token │  Cookie ub_session + x-ub-csrf        └────────────┬──────────────┘
└─────────────────────────┘                                                  │
                                                                             v
                                                              Next.js web service 127.0.0.1:4320
                                                                ├─ /api/* owner routes
                                                                ├─ /eve/v1/* -> eve proxy -> 127.0.0.1:4321
                                                                └─ session store ~/.useful-bot/web-sessions.json
```

In the iOS **Simulator**, `http://127.0.0.1:4320` reaches the Mac's loopback directly: the
simulator shares the host network. Development uses loopback; device testing uses the
tailnet URL. The client must not special-case this beyond the configured endpoint (§4.7);
the server classifies the ingress (§4.2) and sets cookie flags accordingly.

### 3.2 Shared Swift code

`macos/Sources/UsefulBotCore/` is nearly platform-agnostic: zero `import AppKit` in the
target (verified). What is not portable is listed precisely, because PR-1 must compile the
iOS target with all of it resolved:

| File | Portable? | What PR-1 does |
|------|-----------|----------------|
| BackendModels, EveStream, Transcript, TranscriptBlocks, ChatMarkdown, ChatInline, ChatAttribution, Threads, ComposerDraft, Proposal, Routines, ShellActions, LocalHost, FacePalette, BrandMotion, ReplayGate, RetryGate, CacheBudget, WidgetSaveRetry, LiveWidget helpers | Yes | Reuse as-is. |
| DesignTokens | Yes | Hex strings, font sizes and metrics only. The color bridge is **not** here: it lives in `UsefulBotApp/NativeTheme.swift` (AppKit). iOS gets its own `NativeTheme` in the iOS target, built from the same hex tokens with `UIColor(dynamicProvider:)` for light and dark. |
| BackendClient | Mostly | Three things are macOS-shaped: (a) `deviceToken(service:)` shells out to `/usr/bin/security` via `Process`; (b) `init` silently replaces any non-loopback base with `ServerConfig.resolved().baseURL`; (c) it uses `HTTPCookieStorage.shared`. PR-1 introduces `protocol DeviceTokenStore` and `protocol EndpointPolicy`, injects both, keeps the current behavior as the macOS implementations, and gives the client a private cookie storage on both platforms. `ServerConfig` stays in Core behind `#if os(macOS)` with a portable `ServerEndpoint` value type extracted for the parts `BackendClient` reads. |
| LocalServices, ServiceSupervisor, HealthPoller, RailClock | macOS-only | Wrapped in `#if os(macOS)` inside Core. They stay in Core because `UsefulBotCoreTests` (for example `LocalServicesTests`) import only Core; moving them would break those tests. Their tests are also wrapped and run on the macOS destination only. |
| Attachments | Mostly | Pickers are platform UI; limits and validation (`shared/attachments.ts` mirror) are portable. |

**Plan (PR-1, complete):** `platforms: [.macOS(.v14), .iOS(.v17)]` in `macos/Package.swift`;
`#if os(macOS)` around the files above and their tests; the two protocols and their macOS
implementations; a private cookie jar; the `ios/` Xcode project depending on `../macos`. The
gate is that `xcodebuild build` for the iOS Simulator succeeds and every existing macOS test
still passes. The iOS `KeychainStore` (SecItem) and `TailnetEndpointPolicy` conform to the
two protocols in PR-2.

**Package layout decision:** keep the package at `macos/`; `ios/` depends on it by local path.
Relocation to a top-level `swift/` package is not part of v1.

### 3.3 iOS project structure

```
ios/
  project.yml                 # XcodeGen spec - .xcodeproj is generated, never hand-edited
  UsefulBot/
    UsefulBotApp.swift        # @main, scene phase handling, model bootstrap
    Pairing/                  # QR scan, manual entry, connection check
    Rail/                     # bot list, sections, search trigger, account row, pending approvals entry
    Chat/                     # transcript, composer, asks dock, header, past-conversation viewer
    Details/                  # bot/group settings panes, routines editor
    Settings/                 # app settings: general, appearance, providers, connectors, usage, devices, about
    Connectors/               # marketplace + connect flows (SFSafariViewController + polling)
    Widgets/                  # WKWebView widget host, isolation configuration
    Platform/
      KeychainStore.swift     # SecItem* wrapper, ThisDeviceOnly accessibility
      PairingStore.swift      # enrolled host + token bookkeeping + client lifecycle state
      EndpointPolicy.swift    # canonical origin validation (§4.7)
      BiometricGate.swift     # LAContext wrapper for the action classes in §4.4
      PhotoPicker.swift       # PhotosUI / document picker / camera + normalization
      NetworkMonitor.swift    # NWPathMonitor + readiness probe -> four-level status (§7.2)
      NativeTheme.swift       # UIColor bridge over DesignTokens hex, light and dark
    Resources/                # brand assets (shared pipeline output), app icon
  UsefulBotTests/             # XCTest (contract-level, model-level)
  UsefulBotUITests/           # XCUITest smoke flows
```

Rationale for **XcodeGen**: `.pbxproj` merge conflicts and agent-generated project edits are
a recurring failure mode. `project.yml` is diffable YAML; `xcodegen generate` is one command.
The generated `UsefulBot.xcodeproj` is committed (lower friction for contributors without
XcodeGen installed); `project.yml` stays the source and CI regenerates and diffs it.

**Deployment target:** iOS 17.0. The transcript uses `defaultScrollAnchor` (iOS 17),
`@Observable` (iOS 17), and `URLSession.bytes` line iteration. Anything that needs 17.4+
(for example https callbacks in `ASWebAuthenticationSession`) is off the table; §9.4 is
designed around that.

**Bundle ID:** `com.usefulbot.app` placeholder; the owner confirms before first signing.
**App icon:** `brand/app/useful-bot-app-icon-1024.png` is the pipeline-approved source.
**Name:** "Useful Bot".

### 3.4 App architecture pattern

Mirror the macOS app's *logic*, not its observation mechanism:

- The macOS `AppModel` is an `ObservableObject` with `@Published` properties (verified,
  `AppModel.swift:22`). The iOS model is a **new** `@Observable` `@MainActor` class that
  ports the macOS logic (shell store, selection, transcript window, stream lifecycle,
  pending/working state, asks, composer state) and drops the macOS-only duties (service
  supervision is replaced by reachability and readiness monitoring). This is a deliberate
  migration and PR-3 verifies it against Appendix B.1 with an idle-CPU measurement.
- **Selection is device-local.** The shared store carries `selectedBotId` and the Mac
  writes it through the `select` shell action and adopts it on poll (`shell-store.ts:564`,
  `AppModel.swift:2449`). The phone never sends `select` and ignores the server's
  `selectedBotId`. If the selected bot disappears from the store, the phone falls back to
  the list, not to the Mac's selection.
- **Opening a past conversation is browsing.** The Mac's "open recent" replaces the bot's
  current session (`shell-store.ts:921`). On the phone, a past conversation opens read-only
  with a single "Continue this conversation" action that performs that same switch
  explicitly. Both clients then see the switch on their next poll.
- `BackendClient` (shared): auth exchange, typed GET/PUT with CSRF, eve proxy calls,
  `historySnapshot` event-tail resume, error taxonomy. Additions in PR-2: device-token
  store protocol, endpoint policy protocol, 401-only silent re-auth (single flight across
  streams and requests), structured 403 errors surfaced as such (§8.4).
- `EveStream` (shared): NDJSON line parsing -> `StreamProjection` (messages, pending, error,
  searchChips). Byte-for-byte the same semantics as `shared/eve-stream.ts`.
- Polling cadence matches web: agent-state poll + handoff tick every **2.5 s while
  foregrounded**, suspended in background (iOS suspends sockets anyway; design for resume).

---
## 4. Security model

This section was written to be attacked and has been. It changes real spec law from SPEC.md;
every change is marked **[CHANGE]** with the rationale. Where any other section disagrees
with this one, this one wins.

### 4.1 Credentials and profiles

`shared/policy.ts` defines `Profile = "desktop" | "phone" | "reviewer" | "eval"`.
`shared/runtime.ts` validates credential rows `{id, kind, sha256, callerId, profile,
expiresAt, revokedAt}`; `scripts/setup-local.mjs` mints values into the Mac Keychain and
digests into `~/.useful-bot/config.json`. Setup has never minted a `phone` row (verified:
`TOKEN_CREDENTIALS` holds desktop, router-desktop, router-ops, router-reviewer), so no
existing credential can inherit the authority granted below.

**[CHANGE] Repurpose `phone` as the owner-phone profile.** The SPEC.md phone profile was
written for a reduced web companion that was never built. There is no second class of phone
user. The `phone` profile gets owner-parity web limits:

```ts
// CALLER_LIMITS
phone: { aliases: ["workhorse"], search: true, rpm: 60, requests24h: 4_000,
         input24h: 30_000_000, output24h: 3_000_000 },   // = desktop
```

The literal stays `phone` (decision F1). `SEARCH_LIMITS.phone` is left as is and is
documented as inert: agent-side search runs under the desktop router token regardless of
which device sent the turn (§4.6).

**New credential** minted by `setup-local.mjs --pair-phone`:

```js
{ id: "device-phone", kind: "device", callerId: "phone", profile: "phone",
  keychain: "com.usefulbot.device.phone" }
```

The Mac Keychain copy is the only copy on the Mac: it exists so the macOS Devices pane
(§9.6) can render the pairing QR and so revoke/rotate can target it. The phone stores the
raw token in the **iOS Keychain**: `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`,
`kSecAttrSynchronizable = false`, service `com.usefulbot.device.phone`, attribute
`kSecAttrAccount` = the canonical origin it was paired for (§4.7). It never touches
UserDefaults, files, logs or the pasteboard (mask it in the manual-entry field).

**[CHANGE] Superseded spec law.** SPEC.md: "Phone tool allowlist is exactly web_search,
web_fetch, memory.search, memory.read ... No ... bash, write_file, skills, connections,
approvals, reviewer or child agents." Under owner parity a phone turn executes with the
target bot's normal permission and workspace grant, exactly as a desktop turn: the same
`syncSessionWorkspace` stamp the proxy applies today. The risk acceptance: the phone
credential becomes remote-shell-equivalent, mitigated by the tailnet ACL (per device), the
device credential (revocable in real time per §4.3, 30-day expiry), the biometric table in
§4.4, and the fact that it grants access only to the *owner's own* bots on the *owner's own*
Mac.

### 4.2 Transport security and ingress classification

- Tailscale Serve terminates TLS with the tailnet cert (`https://<mac>.<tailnet>.ts.net`)
  and forwards to `http://127.0.0.1:4320` only. Router (4319) and eve (4321) stay absent
  from Serve. Funnel stays off. The ACL/grant admits only the enrolled phone's tailnet
  identity to the Mac's Serve HTTPS port (SPEC.md §Phase 3 retains authority here). The
  ACL is the device gate; the login check below is a user gate; both are required.
- The web service keeps binding `127.0.0.1`. Serve requests arrive as loopback TCP with
  `X-Forwarded-For: 100.x.y.z` (CGNAT range) and Tailscale identity headers
  (`Tailscale-User-Login`, `Tailscale-User-Name`).
- **[VERIFY, PR-2 gate]** Confirm the installed Tailscale version's Serve header set, the
  `Host`/`X-Forwarded-Host`/`X-Forwarded-Proto` values Next sees, and whether identity
  headers need a `tailscale serve` flag. This is SPEC.md VERIFY S4, and it runs against a
  real Serve before `phoneEnabled` may be set true on the owner's Mac (§19).

**[CHANGE] One fail-closed ingress classifier** (S3), `classifyIngress(request)`, used by
every gate and by the session route. It returns exactly one of:

| Class | Condition | Consequence |
|-------|-----------|-------------|
| `loopback` | Request URL host is loopback **and** no forwarding or Tailscale header is present | Existing behavior: desktop auto-session allowed, non-Secure cookie. |
| `tailnet` | `phoneEnabled` is true **and** `Tailscale-User-Login` equals `tailnet.userLogin` **and** the first `X-Forwarded-For` hop is in `100.64.0.0/10` or `fd7a:115c:a1e0::/48` **and** `X-Forwarded-Proto` is `https` | Phone-profile sessions accepted; `Secure` cookie; desktop auto-session denied; desktop-profile sessions rejected. |
| `unknown` | Anything else: forwarding headers without identity, identity without forwarding, duplicate or conflicting headers, a login that does not match, `phoneEnabled` false with any proxy header present | **Rejected** with 403 `ingress`. Never falls through to `loopback`. |

Consequences written out so reviewers can break them:

- `GET /api/auth/session` auto-mints a desktop session today from a loopback request URL
  plus a loopback `Origin` or `Referer` (`session/route.ts:24`). Those are HTTP values a
  remote client can supply. Auto-session is therefore allowed only for class `loopback`.
- A desktop-profile session cookie presented on class `tailnet` is rejected (decision F3),
  whether the session was minted remotely or locally. The cookie never legitimately leaves
  the Mac, so there is no legitimate traffic to preserve.
- A local process forging Tailscale headers gains nothing: with `phoneEnabled` false the
  request is `unknown`; with it true the request still needs the phone credential, and a
  local process already has more than that credential grants.
- Header handling is exact: a repeated header is a conflict, not "take the first".

### 4.3 Session and request auth on native

Reuse the existing exchange, with one addition that makes revocation real:

1. `POST /api/auth/session`, `Authorization: Bearer <device-token>` -> verifies digest,
   returns `{ok, profile, expiresAt, csrfToken}` + `Set-Cookie: ub_session`.
2. **[CHANGE] Sessions are bound to their credential** (S9). Today `verifyDeviceToken`
   checks revocation and expiry only at sign-in, and `getBrowserSession` checks only the
   session's own expiry (`web-sessions.ts:126`), so a revoked credential keeps its sessions
   alive for up to 12 hours. The session record gains `credentialId`. `requireOwner`
   re-resolves the credential row on every request and fails with 401
   `credential_invalid` when the row is missing, revoked, expired, or when the profile is
   `phone` and `phoneEnabled` is false. Session `expiresAt` is capped at the credential's
   `expiresAt`. Desktop auto-sessions carry `credentialId: null` and are unaffected. Open
   phone streams end at their next proxied request; there is no push-cancel, and the spec
   accepts that a stream already flowing may finish its current turn.
3. iOS `URLSession` with a private `HTTPCookieStorage` (never `.shared`) holds the cookie;
   every mutation sends `x-ub-csrf`. 12-hour expiry; the app re-posts the device token
   silently on 401 `unauthorized` (single flight across all requests and streams). A 401
   `credential_invalid` is terminal: the app moves to the credential-invalid state (§4.8).
4. Cookie `Secure` flag: **[CHANGE]** `sessionCookie()` omits `Secure` today because the
   UI is loopback HTTP. It adds `Secure` for class `tailnet` (S4). Harmless on loopback,
   correct on tailnet.
5. CSRF stays required for the native app: already implemented, one header, uniform threat
   model.
6. Failed-auth rate limits: **[CHANGE, correction]** the draft claimed 5/min/source and
   50/min total. The code has one 30/min bucket per source key (first `X-Forwarded-For`
   hop or `Host`) and no global bucket (`session/route.ts:7`). S13 keeps the per-source
   bucket, adds a global 100/min bucket, and keys the source on the ingress class so a
   tailnet client cannot choose its own bucket by header.
7. Origin: native sends no `Origin` header; `originHeaderAllowed` returns true for absent
   origin. Keep. Reject `Origin: null` and any present origin that is neither loopback nor
   the configured tailnet origin.

Alternative considered and rejected for v1: bearer-session-token-in-header instead of a
cookie. It would drop cookie handling and make CSRF unnecessary, but it forks `readSession`
semantics for zero security gain on a client that already manages cookies fine.

### 4.4 Biometric gating

The server cannot verify Face ID; biometrics are a *local* assurance that the person
holding the phone is the owner. The policy is `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`
(biometrics with passcode fallback, so a phone with biometrics disabled still works).

**[CHANGE] Exhaustive action table.** The draft gated approval cards and a short list of
settings actions. Review found that a bot on `full_access` auto-approves most shell
commands (`agent/tools/bash.ts:133`), so an unlocked phone could request destructive work
through a plain send without ever meeting a card. The table below is complete; a build agent
who finds a mutation not listed here files a finding rather than guessing.

| Class | Actions | Gate |
|-------|---------|------|
| **A. Per action** | Approve an approval card. Confirm a proposal (`createBot`, `createGroup`, `fanout`, `connectApp`, `connectServer`, `updateBotProfile`). `setPermission` toward `auto` or `full_access`. `deleteBot`, `clearThread`, `deleteSection`. Routine create, edit, enable, run now, delete. Connector key configuration (`PUT /api/connectors`), connector disconnect (`DELETE`). Provider connect, key change, disconnect (`PUT`/`DELETE /api/providers`), OAuth start. Spending limit change (`PUT /api/usage`). "Continue this conversation" on a past session. Unpair. | One `evaluatePolicy` immediately before the request. Cancel or failure returns the UI to the pre-confirm state with the card or form still pending; no server call is made. The evaluation is bound to what was displayed: the client sends exactly the `{id, actionSha256}` (approvals) or action payload it rendered, and a payload that changed since render is re-presented, not sent. |
| **B. Per foreground activation** | Send a message, or answer an owner question, to a bot whose permission is `full_access`. | One `evaluatePolicy` the first time in a foreground activation; the unlock lasts until `scenePhase` leaves `.active`, then resets. This is the single exception to "no grace window" and exists because gating every send to such a bot would make the primary use case unusable. The composer shows a small lock glyph while locked. |
| **C. Ungated** | Read anything. Send to a bot on `read_only` or `auto` (their dangerous lines still raise a card, which is class A). Deny or dismiss a card or proposal. Rename, pin, hide, move to section, collapse. Create bot, group or section from the + menu (the proposal path is class A because the model authored it). Sign out. Change appearance. | None. |

`clearThread` and `deleteBot` reach the server through `PUT /api/shell`; the gate is
client-side for them, as for everything in this table. The server does not know about
biometrics and must never be told about them in a header.

### 4.5 What the phone must never do, and the two sanctioned exceptions

- Print or persist the device token, session token, or CSRF anywhere (logs, crash reports,
  analytics, screenshot helper text, `NSUserActivity`, handoff, iCloud-backed stores).
- Attach to local services or spawn processes; no service supervision on iOS.
- Expose the tailnet URL in UI beyond Settings -> Devices.
- Substitute an endpoint. An invalid or non-loopback-and-non-https endpoint is rejected
  with a visible error, never replaced by a default (§4.7).
- Let a model-authored link open the paired Mac or a private range (§4.7).

**Network policy, corrected.** The app's own traffic goes to exactly one host: the paired
Mac. No analytics SDKs, no crash-reporting services, no external fonts or QR services. Two
exceptions exist and are named because review found the draft's "one host" claim was false
under full parity:

1. **OAuth browser flows** (§9.4) open provider or Composio pages in `SFSafariViewController`.
   That is the user's browser, visibly, with its own cookie store; the app process makes no
   request to those hosts.
2. **MCP widget frames** (§9.2) run inside a `WKWebView` whose host page allows scripts,
   fonts, images and connections to `https://esm.sh` plus up to eight resource-declared
   https domains (`shared/mcp-app-host.ts:12`). The iOS host carries the macOS isolation
   properties verbatim: `WKWebsiteDataStore.nonPersistent()`, HTML fetched by the
   authenticated `BackendClient` outside WebKit and loaded via `loadHTMLString`, navigation
   limited to `about:` (everything else cancelled in `decidePolicyFor`), no
   `WKScriptMessageHandler` bridges beyond what the macOS host exposes, and a navigation
   delegate that additionally refuses any URL whose host is the paired Mac, loopback, CGNAT,
   ULA or link-local.

If a future build adds crash reporting it must be opt-in, locally stored, and scrubbed of
URLs and identifiers.

### 4.6 Audit, accounting and revocation

- `callerId: "phone"` gives phone web traffic its own rate-limit buckets (`eve:phone`,
  `approvals:phone`, `auth:...`). **[CHANGE, correction]** It does *not* give
  phone-attributed inference: eve calls the router with `UB_ROUTER_DESKTOP_TOKEN`
  (`agent/agent.ts:147`) and Usage sums the desktop caller (`usage/route.ts:50`). There is
  one owner inference budget and the Usage screen says so. Per-device attribution is a
  non-goal for v1.
- Revocation = `setup-local.mjs --revoke-phone` sets `revokedAt` on the `device-phone` row
  and deletes the Keychain item -> the next gated request fails `credential_invalid` (§4.3)
  -> the phone enters the credential-invalid state (§4.8). No service restart is required;
  S9 re-reads the config per request (cached on mtime).
- Rotation = `--rotate-phone`: mint a new `device-phone` token, mark the old row revoked,
  leave every other credential and config field untouched. The global `--rotate` also
  rotates the phone row and keeps `phoneEnabled` and `tailnet` as they were
  (`setup-local.mjs` today rebuilds config with `phoneEnabled: false`; S7 changes that).
- Credential expiry: 30 days. The Devices pane and the phone's Settings -> Devices both show
  `expiresAt`; a warning appears seven days out. Expiry is handled like revocation.

### 4.7 Endpoint policy (client)

`EndpointPolicy.validate(input) -> CanonicalOrigin | EndpointError`, applied to the pairing
payload, manual entry and every stored endpoint on launch:

- Scheme `https`, or `http` only when host is loopback (simulator development).
- Host non-empty; for `https` the port is 443 (explicit `:443` is normalized away); for
  loopback `http` any port.
- No userinfo, path, query or fragment. The stored endpoint is the canonical origin string.
- The device token is stored under that origin (`kSecAttrAccount`) and is sent only to it.
  A stored origin that fails validation on launch puts the app in the credential-invalid
  state with a plain message; nothing is substituted.
- Redirects: `URLSession` follows none (`URLSessionTaskDelegate` returns `nil`); a 3xx from
  the Mac is an error.
- TLS: system defaults, no pinning, no "ignore certificate" affordance anywhere.
- `LocalHost.isLocal` (shared) is extended with an injected block list: the paired host,
  `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `fc00::/7`, `fe80::/10`, `169.254.0.0/16`, plus
  the existing loopback and private ranges. Model-authored links matching it do not open.

### 4.8 Client lifecycle states

Persisted in `PairingStore` (UserDefaults is fine for the state enum; nothing secret is in it):

| State | Meaning | Entry | Exit |
|-------|---------|-------|------|
| `unpaired` | No token, no host, no cached data | First launch; Unpair | Successful pairing -> `paired` |
| `paired` | Token in Keychain; sessions exchanged on demand | Pairing; Sign in | Sign out -> `signedOut`; terminal 401 -> `credentialInvalid`; Unpair -> `unpaired` |
| `signedOut` | Token kept; **no automatic session exchange**; cached data kept but not shown | Sign out (works offline: local cookie jar cleared, `DELETE /api/auth/session` attempted best-effort) | Sign in (class C, no biometric) -> `paired`; Unpair -> `unpaired` |
| `credentialInvalid` | Token rejected as revoked, expired or disabled; endpoint invalid | 401 `credential_invalid`; endpoint validation failure | Re-pair (replaces token, keeps cache only if the host matches) -> `paired`; Unpair -> `unpaired` |

Unpair purges: Keychain token, cookie jar, disk cache, drafts, attachment temp files, pending
composer state, and increments a `dataGeneration` counter that every in-flight response is
checked against before it writes to the model, so a late response cannot repopulate data.

---

## 5. Server changes required

The complete server-side diff the iOS app depends on. Small on purpose: the app bends to the
API. All changes are additive to the loopback desktop path.

| # | File | Change |
|---|------|--------|
| S1 | `shared/policy.ts` | `phone` limits -> owner parity (§4.1). |
| S2 | `shared/runtime.ts` | `tailnet: null` -> `tailnet: { httpsOrigin, userLogin, phoneIpv4, phoneIpv6, macIdentity } \| null`. **Validate** `phoneEnabled` (boolean) and `tailnet` (null, or every field a non-empty string with `httpsOrigin` a canonical https origin) in `loadRuntimeConfig`; today only credentials are validated. Invariant: `phoneEnabled: true` requires non-null `tailnet`. |
| S3 | `web/lib/desktop-gate.ts` | Add `classifyIngress(request)` (§4.2) and `requireOwner(request)`: reads the session, rejects `unknown` ingress, rejects `profile === "desktop"` on `tailnet` ingress, accepts `profile in {desktop, phone}` otherwise, re-validates the bound credential (S9), then the origin check. `requireDesktop` stays for any future Mac-only route (none in v1). |
| S4 | `web/lib/auth.ts` | `sessionCookie(token, { secure })`; `Secure` when ingress is `tailnet`. |
| S5 | `web/app/api/shell/route.ts` and every route in §5.1 | `requireDesktop` -> `requireOwner`. In the shell route, a `setWorkspace` action from a `phone` session returns 403 `phone_forbidden_action` (decision F2). |
| S6 | `web/app/api/shell/route.ts` (`connectCallbackUrl`, `serverCallbackUrl`), `web/app/api/connectors/route.ts` (`callbackUrl`), `web/app/api/connections/callback/route.ts` | All three callback builders take the session profile: `phone` sessions get `tailnet.httpsOrigin`-based callbacks, desktop keeps loopback. Never derived from request headers. The MCP completion route's `requestIsLoopback` refusal becomes "loopback, or the configured tailnet origin when `phoneEnabled`"; its stored OAuth `state` and PKCE checks are unchanged. |
| S7 | `scripts/setup-local.mjs` | `--pair-phone`: mint `device-phone` (digest row + Mac Keychain value), set `phoneEnabled: true`, take tailnet fields from interactive prompts or flags (never repo-committed). **No `pairing.json`, no stdout token by default.** `--pair-phone --print` prints the pairing payload once with a scrollback warning (simulator dev loop). `--revoke-phone`: set `revokedAt`, delete the Keychain item, set `phoneEnabled: false`. `--rotate-phone`: new token, old row revoked, everything else untouched. `--rotate`: includes the phone row and preserves `phoneEnabled` and `tailnet`. |
| S8 | `web/app/api/auth/session/route.ts` | `GET` auto-session only on `loopback` ingress. `POST` on `tailnet` ingress refuses desktop-profile credentials; stores `credentialId` in the session record. |
| S9 | `shared/web-sessions.ts`, `web/lib/auth.ts` | `BrowserSession` gains `credentialId: string \| null`. `requireOwner` re-resolves the row per request (config cached by mtime) and fails 401 `credential_invalid` on missing, revoked, expired, or `phone` with `phoneEnabled` false. Session `expiresAt = min(now + 12h, credential.expiresAt)`. |
| S10 | `agent/lib/approvals.ts`, `agent/tools/bash.ts` and the other card-raising tools, `web/app/api/approvals/route.ts` | Pending approval records and the public payload gain immutable provenance: `botId`, `botName` (as of raise time), `sessionId`, `cwd`. Resolved server-side when the card is raised; never re-resolved. The preview stays what it is; the phone renders provenance beside it. |
| S11 | `shared/shell-store.ts`, `web/app/api/shell/route.ts` | `touchChat` accepts optional `expectedSessionId`; when present and different from the stored pointer, the action fails 409 `session_conflict` with the current pointer in the body. The macOS client is not required to send it in v1; the iOS client always does. |
| S12 | `shared/mcp-app-host.ts`, `web/app/api/connections/widget/[id]/route.ts` | `renderWidgetHost` takes `{ platform: "desktop" \| "mobile", width, height }` from query parameters with the current values as defaults; the host page reports them to the frame. |
| S13 | `web/app/api/auth/session/route.ts`, `web/lib/api-guard.ts` | Failed-auth limiter: per-source 30/min keyed on ingress class plus first trusted hop, and a global 100/min bucket. |
| S14 | `web/app/api/agent/tick/route.ts`, `web/lib/agent-exec.ts` | Pump coalescing: at most one running and one pending `pumpHandoffs`/`pumpRoutines` chain; extra ticks return `{ok: true, coalesced: true}`. |
| S15 | `web/app/api/status/route.ts` | Add `apiVersion: 1` and `profile` of the calling session. The phone refuses to operate against an `apiVersion` it does not know and says so. |

**Not changing:** eve itself (single agent; the proxy's channel JWT stays `sub: "desktop-app"`;
eve sessions are per-bot and shared across devices by design), the eve allowlist, the
attachments limits, `requireReviewer` routes, the `{decision, actionSha256}` approval
decision contract.

### 5.1 Route matrix

Method by method, from the route files. Auth is `requireOwner` unless stated. CSRF applies to
every non-GET. Biometric class refers to §4.4 and is client-side.

| Route | Methods | Phone | Biometric | Notes |
|-------|---------|:-----:|-----------|-------|
| `/api/auth/session` | GET, POST, DELETE | yes | C | GET auto-session loopback only (S8). POST with phone credential. DELETE = sign out (CSRF if a session exists). |
| `/api/health` | GET | yes | C | Static `{ok:true}`; proves only that Next answered. Not a readiness signal. |
| `/api/status` | GET | yes | C | Probes eve; returns `profile`, `theme`, `apiVersion` (S15). The readiness signal (§7.2). |
| `/api/shell` | GET, PUT | yes | per action | Full roster and actions including proposals. `setWorkspace` 403 for phone (S5). `touchChat` with `expectedSessionId` (S11). Phone never sends `select`. |
| `/eve/v1/health`, `/eve/v1/info` | GET | yes | C | |
| `/eve/v1/session` | POST | yes | B if bot is `full_access` | Create session. |
| `/eve/v1/session/:id` | POST | yes | B if bot is `full_access` | Continue (send a turn, answer an owner question). |
| `/eve/v1/session/:id/stream` | GET | yes | C | `?startIndex=`; `x-eve-stream-tail-index` on the response. |
| `/eve/v1/session/:id/cancel` | POST | yes | C | |
| `/api/agent/state` | GET | yes | C | `?botId=`; returns the retained event set and proposals for that bot. |
| `/api/agent/tick` | GET, POST | yes | C | POST drives the pumps (coalesced, S14). |
| `/api/agent/widget` | POST | yes | C | Widget persistence (draft said GET; it is POST). |
| `/api/approvals` | GET | yes | C | Pending list with provenance (S10). |
| `/api/approvals/:id` | POST | yes | A on approve, C on deny | Body `{decision, actionSha256}`. 404 when expired or resolved elsewhere. |
| `/api/attachments` | POST | yes | C | 5 files, 1 MiB each, PNG/JPEG/GIF/WebP, text <= 64 KiB. |
| `/api/providers` | GET, PUT, DELETE | yes | A on PUT/DELETE | All provider modes (§9.4). |
| `/api/providers/oauth` | POST | yes | A | Start device flow. |
| `/api/providers/oauth/:pollId` | POST, DELETE | yes | C | Poll; cancel. |
| `/api/workspace` | GET, POST | yes | C | Project recents list; POST adds/removes a recent. This is not the workspace grant; that is the `setWorkspace` shell action. |
| `/api/memory` | GET | yes | C | Read parity; write paths are agent-tool-side. |
| `/api/routines` | GET, POST | yes | A on POST | Structured schedules (§9.3). |
| `/api/routines/:id` | PUT, DELETE | yes | A | |
| `/api/routines/:id/run` | POST | yes | A | |
| `/api/connectors` | GET, PUT, POST, DELETE | yes | A on PUT/POST/DELETE | GET catalog; PUT key config; POST authorize; DELETE disconnect. |
| `/api/connectors/callback` | GET | browser | none | Ungated landing page; no state change. Composio success is learned by polling GET `/api/connectors`. |
| `/api/connections/widget/:id` | GET | yes | C | Widget host HTML (S12 parameters). |
| `/api/connections/callback` | GET | browser | none | MCP OAuth completion with stored `state` and PKCE; accepts loopback or the configured tailnet origin (S6). |
| `/api/reviewer` | POST | yes | C | "Ask the reviewer". |
| `/api/usage` | GET, PUT | yes | A on PUT | PUT moves the daily budget. |

The only server-side phone ban in v1 is `setWorkspace`. Everything else is
permissive-with-audit and gated on the client per §4.4.

---
## 6. Authentication & enrollment

### 6.1 Pairing (enrollment)

Enrollment is local-only per spec law: no remote "create token" route. **[CHANGE]** The draft
printed the token to stdout and kept it in `pairing.json` until revocation; that is a
repeatable plaintext export of a 30-day owner credential, not a single reveal. The final
design keeps exactly one copy on the Mac, in the Keychain, and reveals it only on demand.

1. **Operator step (Mac):** `scripts/setup-local.mjs --pair-phone` mints the `device-phone`
   credential into the Mac Keychain and its digest into config, sets `phoneEnabled: true`,
   records tailnet fields. It prints a confirmation, **not the token**.
2. **Reveal (the product path):** macOS Settings -> Devices -> "Show pairing QR" reads the
   Keychain value, renders the payload as a QR with CoreImage (`CIQRCodeGenerator`, built
   in, no network, no dependency) and dismisses it automatically after 60 seconds or when
   the pane loses focus. The payload:

   ```json
   { "v": 1, "host": "https://<mac>.<tailnet>.ts.net", "token": "<base64url-32B>", "name": "Mac Studio" }
   ```

   Showing the QR again shows the same token; it is not rotated by display. Re-pairing a
   phone after a suspected exposure is "Rotate", which mints a new token and revokes the old
   one, then shows the new QR.
3. **Reveal (the dev path):** `--pair-phone --print` (or `--print-pairing` on an existing
   credential) prints the payload once to stdout with a warning about scrollback. For the
   simulator it takes `--host http://127.0.0.1:4320`. This path exists for build agents and
   is documented as such; it is not the owner's path.
4. **iOS pairing screen:** camera scan (AVFoundation `AVCaptureMetadataOutput`, QR only) or
   "Enter manually" (host + token fields, masked token). On scan: validate `v`, run the
   endpoint policy (§4.7) on `host`, require token base64url >= 32 bytes -> store token in
   iOS Keychain under the canonical origin -> attempt session -> show Mac name + "Connected"
   -> dismiss into the Bots list.
5. **Errors:** unreachable host ("Can't reach your Mac. Is it awake and on Tailscale?"),
   401 after retry ("This pairing was revoked. Re-pair from the Mac"), TLS failure (surfaced
   plainly; no "ignore cert" escape hatch), wrong payload version, invalid endpoint
   (message names the rule that failed), camera permission denied (manual entry offered).
6. **Multiple phones:** v1 = one phone credential. Keep the code plural-safe
   (`id: "device-phone-2"` would work) but the UX single-phone.

### 6.2 Session lifecycle on iOS

- On launch in state `paired`: Keychain read -> `POST /api/auth/session` -> cookie + CSRF in
  memory. In state `signedOut` nothing is exchanged until the user taps Sign in.
- 401 `unauthorized` anywhere -> single-flight re-auth -> if still 401 -> `credentialInvalid`.
  401 `credential_invalid` -> `credentialInvalid` directly. 403 of any kind is never a
  re-auth trigger (§8.4).
- Sign out (Settings -> Devices -> "Sign out on this phone") = clear the in-memory cookie
  jar, persist `signedOut`, attempt `DELETE /api/auth/session` (best effort, works offline).
  The device token stays. Signing out is not unpairing; "Unpair" (class A) wipes everything
  per §4.8.
- `expiresAt` for both the session and the credential is shown in Settings -> Devices.

---

## 7. Connectivity

### 7.1 Primary: Tailscale Serve

Operator setup (script or doc-driven, per SPEC.md §Phase 3 commands):

```sh
tailscale serve --bg http://127.0.0.1:4320   # VERIFY exact CLI for installed version
tailscale serve status
tailscale funnel status                     # must be off
```

- Serve forwards only to 4320. ACL: allow `<phone-tailnet-identity>` -> `<mac>:443` only;
  existing broad rules must not implicitly grant it.
- `tailnet.userLogin` check (S3) binds requests to the enrolled tailnet identity, not just
  "some device on the tailnet".
- Order of operations when enabling: S1 to S15 deployed and tested on loopback first; then
  `--pair-phone`; then `tailscale serve`; then the real-Serve check (§17.2, PR-2 gate); only
  then does the phone get the QR. Disabling is the reverse: `tailscale serve reset` first,
  then `--revoke-phone` (§19).

### 7.2 Readiness levels and failure modes

`/api/health` is static and proves nothing beyond Next answering. The app derives one of four
levels from `NWPathMonitor`, `GET /api/status` and request outcomes:

| Level | Signal | UI |
|-------|--------|----|
| `noNetwork` | Path unsatisfied | Offline banner; cached views; composer editable, Send disabled. |
| `macUnreachable` | Network up; `/api/status` times out or fails TLS/DNS | "Mac unreachable" banner with last-seen time and Retry; every mutation disabled with its reason; Settings -> Devices shows a diagnostics row (resolved? TLS ok? HTTP status?). |
| `runtimeDown` | `/api/status` answers but eve probe fails, or tick reports missing agent credentials | Management screens fully usable (bots, sections, providers, connectors, routines, usage); chat shows "Agent runtime is down on your Mac"; Send disabled; approvals list marked live or cached by its own fetch outcome. |
| `ready` | Status ok | Everything enabled per §4.4. |

A `providerDown` condition (eve up, model provider failing) surfaces as the existing turn
error from the stream, not as a readiness level.

Mac asleep, Mac off tailnet, Tailscale logged out on the phone, Serve stopped, MagicDNS off
all map to `macUnreachable` with the same honest copy. No infinite spinners.

### 7.3 Dev path

Simulator -> `http://127.0.0.1:4320` (host loopback), paired with the `--print` payload
(§6.1.3). The request arrives as class `loopback`, so the phone credential is authorized
normally: the tailnet checks are additive, not required for `phone`. Allowing the phone
credential over plain loopback is not a hole: physical host access already implies
everything the credential grants.

### 7.4 Alternatives analyzed (record)

| Option | Verdict | Why |
|--------|---------|-----|
| Tailscale Serve | **Chosen** | Real TLS cert, WireGuard ACLs to the device level, zero new services, already spec law, works off-LAN. |
| LAN + self-signed/pinned cert | Rejected (v1) | Home-network-only; cert trust UX on iOS is poor; adds nothing once Tailscale exists. |
| Cloudflare Tunnel / Funnel | Rejected | Publishes the service beyond the tailnet; violates the ACL story. |
| Hosted relay | Rejected (v1) | Breaks local-only trust; becomes necessary only for APNs-grade reachability. |
| Direct WireGuard app | Rejected | Tailscale already provides this plus identity and certs. |

---

## 8. Client networking

### 8.1 Session and requests

- One `URLSession` per app lifetime: private `httpCookieStorage`, `waitsForConnectivity =
  false` (reachability is surfaced by the app), default timeout 30 s, streaming requests
  180 s (matches the proxy's `AbortSignal.timeout(180_000)`), TLS defaults, no redirects.
- Every request is stamped with the current `dataGeneration` (§4.8); a response whose
  generation no longer matches is dropped before it touches the model.

### 8.2 Streams

- NDJSON via `URLSession.bytes(for:)` -> `lines` -> the shared `parseEveStreamLine`.
  Cancel via task cancellation; the proxy cancel endpoint is also posted on explicit stop.
- The proxy relays `x-eve-stream-tail-index` and the Swift reader counts event indexes
  itself, including lines it cannot decode (`StreamCursorTests`); that behavior is kept.

### 8.3 Cursor and recovery protocol

**[CHANGE]** The draft said "re-attach at latest tail index" on resume. That skips events the
phone never applied. The rules:

- A cursor is `(sessionId, transcriptGeneration, lastAppliedIndex)`. `transcriptGeneration`
  increments whenever the bot's session pointer changes or the cache is discarded.
- The cursor advances only when an event has been applied to the projection. Decoding a
  line without applying it does not advance it.
- **Warm resume** (same session, generation matches, stream dropped or app foregrounded):
  read `stream?startIndex=lastAppliedIndex + 1` until the advertised tail, apply, then
  continue live.
- **Cold replay** (no cursor, or generation mismatch, or cache missing/corrupt): render the
  cached tail immediately with the "updating" state, then replay from index 0 with the
  history publish gate (Appendix B.2), replace the projection in one publish, and continue.
- **Changed session** (poll shows a different session pointer): discard the projection,
  bump the generation, cold replay the new session.
- **Completeness:** a snapshot read is complete only when the reader has applied every index
  up to the advertised tail. A read that stops early for any reason (timeout, watchdog,
  connection loss) is incomplete, is reported as such, and the cursor stays where it was.
  Incomplete is never presented as complete.
- `session_not_active` -> mark the session ended, offer "New chat" (the macOS contract).
- Tests required: suspension mid-message, unknown event kinds, missing tail header, session
  replacement mid-stream, corrupt cache.

### 8.4 Sends, idempotency and error taxonomy

- **Before creating a session** for a bot without one, the client re-reads the shell store.
  After eve returns the new `sessionId`, the client saves the pointer with `touchChat` and
  `expectedSessionId: null` (S11). On 409 `session_conflict` the client adopts the pointer in
  the response, discards its own session, and replays. Two clients can no longer fork a bot.
- **After a send** whose response is lost (timeout, connection drop), the turn is in state
  `confirming`: the composer shows the message greyed with "Sending, confirming", the client
  reads the tail from its cursor, and resolves to sent (the echo appears) or failed (no
  echo, Retry offered). The client never auto-resends and never creates a replacement
  session because a read failed. This differs from the Mac (`AppModel.swift:1276`), on
  purpose: mobile links drop reads far more often.
- **Errors keep their shape.** `BackendClient` today retries auth on 401 and 403 and maps a
  final 403 to `unauthorized` (`BackendClient.swift:370`). On iOS: 401 `unauthorized` ->
  single-flight re-auth once; 401 `credential_invalid` -> credential-invalid state; 403
  `forbidden`, `origin`, `csrf`, `ingress`, `phone_forbidden_action` -> surfaced by code, no
  re-auth; 409 `session_conflict` -> adopt; 429 -> backoff with the server's window; 503
  `approvals_locked`, `workspace_unavailable` -> retry once after 1 s, then surface.

### 8.5 Polling, ticking and foreground/resume

- `scenePhase == .active` -> one resync: `GET /api/status`, `GET /api/shell`, then per open
  chat a warm resume (§8.3), then restart the 2.5 s loop. Never a burst of overdue polls.
- Both clients tick. The server coalesces (S14). Whichever client is foregrounded drives
  handoffs and routine schedules; when both are backgrounded nothing drives them, and §14
  says so in UI copy.
- Reachability: `NWPathMonitor` plus `GET /api/status` on demand, mapped to §7.2.
- Concurrency: single-flight session refresh; per-bot stream tasks; polls coalesced.
  `docs/audit/PERFORMANCE.md` is required reading for whoever ports `AppModel`.

---

## 9. Features: parity matrix and screen inventory

Legend: **P** parity, **R** reduced (stated), **+** iOS addition (not parity), **-** not applicable.

### 9.1 Bot rail -> iOS "Bots" list

| Capability | iOS |
|------------|:---:|
| Logo header + "New Bot" plus button | P (nav-bar leading logo, trailing +) |
| Search pill -> global search | P. Search scope is the Mac's: bot name, label, description, section, and recent conversation titles (`PickerViews.swift:219`). It is not transcript search. |
| Pinned bots | P |
| Sections: create, collapse, move-to, unassigned bucket, hidden bucket | P (collapse + move + create; drag-reorder R: context menu only) |
| Row actions: pin, rename, move to section, settings, hide, delete, new chat | P (swipe actions + context menu) |
| Per-row content | P: avatar, name, label. **No message preview and no timestamp**, matching the Mac (`RailView.swift:635`). Working indicator from server state: P. **Unread indicator: not in v1**; the shared schema has no read watermark and a device-local one is a v1.1 candidate. |
| Pending approvals entry | + At the top of the list when any approval is pending: count, tap opens a list grouped by bot (S10 provenance), each row opens the chat with the card focused. |
| Account row -> account menu (settings, usage, connectors, about) | P (profile row -> sheet). Operator photo: device-local on the phone; the Mac's photo lives only in its Application Support and is not synced. |

### 9.2 Chat

| Capability | iOS |
|------------|:---:|
| Transcript: user right-bubbles, bot left white bubbles with hairline border, per-turn stacked bubbles | P |
| Day dividers, bot-meta rows, connected-app cards | P |
| Markdown: headings, bold/italic, code + fenced blocks, lists, links | P (shared `ChatMarkdown`; links open Safari; `LocalHost.isLocal` with the §4.7 block list) |
| Long user-message folding | P |
| Working row + activity/tool labels + elapsed | P |
| Search chips under turn | P |
| Streaming deltas, cancel, session-ended/interrupted errors, resume | P (§8.3) |
| Past conversations | P as read-only browsing + "Continue this conversation" (class A) (§3.4) |
| MCP app widgets | P. `WKWebView` host with the §4.5 isolation properties; HTML from `GET /api/connections/widget/:id?platform=mobile&width=&height=` (S12); created only when the row nears the viewport (Appendix B.10). States: loading skeleton at the requested height, failure page (the Mac's copy), resize on frame message within bounds, WebKit process termination -> reload once then failure page. Ships in PR-5; not deferrable. |
| Composer: multiline, send/stop, attachments (+), model/effort/speed pickers, @mentions in groups | P (pickers as iOS menus/sheets). Lock glyph while a `full_access` bot is not yet unlocked this activation (§4.4 B). |
| Attachments | P with client-side normalization (+): images are downsampled to fit 1 MiB, EXIF orientation applied, HEIC converted to JPEG, unsupported types refused with the reason; text files up to 64 KiB. Camera capture supported. |
| Approval cards | P with provenance (+): bot avatar and name, working directory, the full preview scrollable (no six-line cap on the phone), expiry countdown (five minutes per SPEC.md). Approve = class A bound to the displayed `{id, actionSha256}`. States: pending, approving, approved, denied, expired, "resolved on your Mac" (404 on decide), "changed" (hash mismatch: re-presented, never sent). |
| Owner questions, proposal cards | P (proposal confirm class A; owner-question answer class B when the bot is `full_access`) |
| Onboarding card on fresh bot | P |
| Empty states with permission-aware copy | P (reuse `emptyCopy` strings verbatim; "on this Mac" wording retained, it is still true) |

### 9.3 Details/settings panes

| Capability | iOS |
|------------|:---:|
| Bot settings: name, label/title, description, avatar shape+color picker, permission | P (class A on escalation to `auto`/`full_access`) |
| Group settings: name, members | P |
| Workspace: show attached folder + permission | R: read-only on phone; attach/detach is blocked server-side (S5) and the UI says "Attach a folder from your Mac". |
| Routines | P. **Structured schedules, not cron:** `daily {time}`, `weekly {days, time}`, `once {date, time}` with an IANA `timeZone` (`routines-store.ts:50`). The editor mirrors the Mac's; the phone always sends `timeZone` explicitly, defaulting to and displaying its current zone, so a travelling phone never creates a routine in an unstated zone. DST follows the server. States: enabled, paused, running, last run ok/failed with the run's session link, next run time in the displayed zone. All writes class A. |
| Memory notes surface | P (mirror the Mac pane) |

### 9.4 App settings

| Capability | iOS |
|------------|:---:|
| General (operator name) | P |
| Appearance | P: System / Light / Dark, device-local (the Mac has the same picker, `AppSettingsView.swift:245`). |
| Providers | P for **every mode** in `shared/provider-catalog.ts`: OAuth device flow, subscription sign-in, API key, local, with each provider's specific fields. Active model, effort and speed pickers. Connect/disconnect class A. |
| Connectors marketplace | P: browse, key configuration, connect (Composio OAuth), disconnect. |
| Usage | P, with the one-budget wording (§4.6). Limit change class A. |
| About/version | P |
| Devices | P on iOS: Mac name, tailnet host, session expiry, credential expiry, diagnostics row, Sign out, Sign in, Unpair (class A). |

**OAuth flows: three state machines, one browser.** `ASWebAuthenticationSession` is not used:
its https callback form needs iOS 17.4 and a custom URL scheme is a non-goal. Every flow opens
`SFSafariViewController` as a sheet and the app detects completion by polling, exactly as the
Mac does today.

| Flow | Start | Browser | Completion | Dismissal |
|------|-------|---------|------------|-----------|
| Provider device flow | `POST /api/providers/oauth` -> `{pollId, url, code}` | Safari sheet on `url`; code shown in-app for copy | App polls `POST /api/providers/oauth/:pollId` every 3 s | App dismisses the sheet on success; user Done or app `DELETE` on cancel |
| Composio (connectors and `connectApp` proposals) | `POST /api/connectors` authorize, or the proposal confirm -> `redirectUrl` with the tailnet callback (S6) | Safari sheet on `redirectUrl` | Browser lands on `/api/connectors/callback` (landing page); app polls `GET /api/connectors` until the connection appears | App dismisses on success; user Done otherwise |
| MCP server (`connectServer`) | Proposal confirm -> `redirectUrl` with the tailnet callback (S6) | Safari sheet | Browser lands on `/api/connections/callback`, which verifies `state` and PKCE and completes; app polls the proposal status | App dismisses on success; user Done otherwise |

Suspension mid-flow: the sheet survives backgrounding; on foreground the app resumes polling.
A poll that reports `expired` or `failed` shows the reason with "Try again".

### 9.5 Explicit non-parity (v1)

- Local service supervision, launchd, port management: meaningless on phone.
- Folder pickers (workspace attach): read-only view instead.
- Menu-bar/window chrome behaviors.
- Drag-and-drop files into composer: use pickers (share-sheet *into* the app is v1.1).
- Keyboard-shortcut surface beyond standard iOS editing keys.
- APNs push (§14), share extensions, Siri.
- Unread indicators, per-device inference accounting, transcript search.
- Deep links / universal links: none. No `usefulbot://` scheme is registered.

### 9.6 macOS deltas required by this spec

In scope (decision F6), delivered as a desktop PR inside P5:

1. Settings -> **Devices** pane: enrolled phone status (credential id, expiry, `phoneEnabled`),
   "Show pairing QR" (CoreImage, auto-dismiss 60 s), "Rotate" (new token + new QR),
   "Revoke phone". Renders the Keychain value; never writes it anywhere else.
2. `setup-local.mjs` flags (S7).
3. Gate/profile/callback/provenance changes (S1 to S15).

---
## 10. Screen inventory & navigation

iPhone: `NavigationStack` rooted at **Bots list**; chat pushes on. iPad/large:
`NavigationSplitView` (sidebar = rail equivalent, detail = chat; v1 uses sheets instead of a
third column).

Screens (each needs the states in §11):

1. **Pairing** (state `unpaired` or `credentialInvalid`): hero mark, Scan QR / Enter
   manually, status line, camera-denied fallback.
2. **Bots list**: pending-approvals entry (when any), sections (Pinned, named sections,
   Unassigned, Hidden collapsed by default), search bar, + menu (New Bot / New Group / New
   Section), profile row, readiness banner.
3. **Chat**: header (avatar+name, settings gear), transcript scroll, asks dock above
   composer, composer bar with lock glyph state.
4. **Past conversation** (push from bot settings or search): read-only transcript with
   "Continue this conversation".
5. **Bot settings** (sheet): form sections, routines list.
6. **Group settings** (sheet).
7. **Create flows** (sheets): New Bot, New Group (member multi-select), New Section,
   Rename, Delete confirm, Move to section.
8. **Routine editor** (sheet): structured schedule, zone shown.
9. **Global search** (sheet): query box, results grouped by bot; scope per §9.1.
10. **Pending approvals** (push): grouped by bot with provenance.
11. **App settings** (sheet or push): General, Appearance, Providers, Connectors, Usage,
    Devices, About.
12. **Provider detail** (push): mode-specific form, model/effort/speed pickers, status,
    connect flow.
13. **Connectors** (push): catalog list, key configuration, connect cards -> Safari sheet.
14. **Usage** (push): the usage payload rendered as the macOS pane does, one-budget wording.
15. **Devices** (push): status, expiries, diagnostics, Sign out / Sign in / Unpair.
16. **Image viewer** (full-screen modal for attachment previews).
17. **Widget host** (inline row, matching the macOS rendering choice).
18. **Signed-out** (state `signedOut`): Mac name, Sign in, Unpair.

Swipe gestures: standard back-swipe; swipe on bot rows = pin/hide shortcuts only where
unambiguous (destructive actions stay behind confirm). No custom gesture inventions.

---

## 11. States (design-all-seven applies to every screen)

| State | Requirement |
|-------|-------------|
| Empty | Permission-aware empty copy ported verbatim; Bots list empty state = "Create your first bot" (macOS copy). |
| Loading | Skeleton rows matching bubble geometry (not spinners); header loads first, transcript streams in. |
| Error | Inline, muted, retry where sensible; error copy from the shared error taxonomy plus §8.4 codes. |
| Pressed | Pressed opacity/highlight per tokens; no hover on iOS. |
| Focus/keyboard | VoiceOver focus order = visual order; external keyboard return-to-send matches macOS. |
| Active | Selected bot row, active section header, toggles: token accent. |
| Disabled | Every disabled mutation shows its reason text, not just grey (offline, runtime down, session expired, locked). |
| **Offline** (8th state) | Banner per §7.2 level; composer stays editable with Send disabled (drafts persist per §13); timestamps from cache age. |

Additional states this app must design, found in review:

| State | Where |
|-------|-------|
| Camera permission denied | Pairing: manual entry offered inline. |
| Passcode not set / biometrics unavailable | Any class A or B action: `evaluatePolicy` fails with `passcodeNotSet`; the action is refused with "Set a passcode on this iPhone to approve actions". |
| Forbidden (403 by code) | Inline on the action that caused it; never a sign-in loop. |
| Conflict (409) | Chat: "Your Mac moved this conversation" toast, then adopt (§8.4). |
| Confirming (lost send response) | Composer/transcript per §8.4. |
| Resolved elsewhere / expired / changed | Approval card per §9.2. |
| Runtime down (management usable) | Chat disabled with reason; settings fully live. |
| Credential expiring | Devices and a one-time banner at seven days. |

VoiceOver: every row announces name + state ("Test Bot, working, double-tap to open").
Approval cards announce bot name, directory and preview. Rotors for messages/actions are v1.1.

---

## 12. Design system on iOS

- Tokens: `DesignTokens.swift` is Swift and is the authority for hex values, font sizes and
  metrics. The iOS target adds its own `NativeTheme` (the macOS bridge lives in the App
  target, not in Core) using `UIColor(dynamicProvider:)` over the light and dark hex sets.
- **Dark mode ships in v1** (decision F4). The macOS app already has System/Light/Dark with
  dynamic token resolution (`NativeTheme.swift:114`); light-only would be the regression.
  Appearance is device-local. Every verification screenshot is taken in both appearances.
- **Accessibility precedes literal token parity.** `inkFaint = #A3A3A3` is about 2.5:1 on
  white and 2.3:1 on the canvas; the Mac uses it for readable labels. On iOS, any text a
  user must read uses `inkMuted` (`#5C5C5C`) or a new `inkFaintText` token at >= 4.5:1;
  `inkFaint` is reserved for decorative marks and disabled glyphs. Appendix A.7 records this
  amendment; the Mac's identical gap is logged as a desktop follow-up outside this spec.
- Type: fixed pt sizes in tokens wrapped in scaled fonts (`Font.system(size:).relativeTo` or
  `UIFontMetrics`) so Dynamic Type works across the **full** range including accessibility
  sizes; controls never truncate, layouts reflow (composer grows, pickers stack).
- Brand assets: consume `brand/` pipeline output: `brand/app/useful-bot-app-icon-1024.png`
  for the icon; `brand/avatars/` head-color set for bot avatars; `brand/motion/native`
  layers + `motion.json` for any animated mark (loading states only; honor Reduce Motion).
- Bans carry over: no gradients/glow/glass, no purple/violet, no emoji icons, monochrome
  chrome, avatar colors only from the approved palette, mascot geometry untouched.
- Component mapping examples: macOS `RailView` -> iOS list; `NativeIconButton` -> iOS
  `Button` with token sizing (min 44 pt hit target); hairlines via 0.5 pt rects; shadows per
  tokens (subtle only, on bubbles/cards).

## 13. Persistence on device

- iOS Keychain: device token (§4.1), keyed by canonical origin.
- Cookie jar: in memory only, private storage; cleared on sign out and unpair.
- Disk cache (`Library/Caches/<origin-hash>/`, `NSFileProtectionCompleteUntilFirstUserAuthentication`,
  `isExcludedFromBackupKey`): shell snapshot, per-bot transcript tail (last 200 rows per bot,
  LRU across bots <= 25 MB), avatar images, cursor records (§8.3). Cold paint shows the
  cached list/transcript instantly with a quiet "updating" state.
- **Drafts are sensitive.** [CHANGE] The draft classified them as non-secret; user input can
  contain anything. Composer drafts live in the same protected, backup-excluded container,
  per bot, and are purged on unpair.
- Nothing goes to iCloud. Nothing is written outside the app container.
- `dataGeneration` (§4.8) is persisted alongside the cache and bumped on unpair and re-pair
  to a different host.

## 14. Notifications & background

- v1: **no remote notifications, no Background App Refresh.** In-app only: when
  foregrounded, new activity in non-selected threads updates their working indicator;
  approval arrival plays the default haptic and updates the pending-approvals entry.
- Backgrounding suspends streams (OS does this) -> resume protocol in §8.3.
- **Scheduler ownership, stated honestly:** handoffs and routines run only while some client
  ticks. The Mac ticks while its app is running (even hidden); the phone ticks while
  foregrounded. With the Mac app quit and the phone backgrounded, routines wait. The
  routines screen shows "Runs while Useful Bot is open on your Mac or this phone."
- v1.1 candidates (spec them, don't build): APNs via Mac-side `.p8` push sender for
  "approval needed" / "turn finished"; needs the Apple Developer account (Q7). Notification
  content must be minimal ("Test Bot finished"), never message text, since APNs payload
  leaves the device trust boundary.

## 15. Accessibility

WCAG-aligned floor identical to design law: 4.5:1 text, 3:1 controls, visible focus
(keyboard), >= 44 pt targets, semantic labels on every icon button (macOS already labels;
port the strings), Reduce Motion disables the working-row wave and brand motion (static frame
instead), Dynamic Type across the full range (§12). Where design parity and this floor
conflict, this floor wins (§12). Audit each screen with Accessibility Inspector, VoiceOver and
the largest accessibility text size before any screen is called done.

## 16. Performance budgets

Measured on a mid-range device (iPhone 13 class) over a real tailnet, and in the simulator
for the PR-3 and PR-5 baselines (§17.3), against the **long fixture chat** (a sanitized
3,500-event session, the same order of magnitude the macOS audit used). Every number is p50
and p95 over five runs; simulator numbers are labelled as such and never certify tailnet
latency or energy.

| Metric | Definition | Budget |
|--------|------------|--------|
| Cold launch -> interactive bots list (cached) | Process start to first tappable row | <= 1.5 s |
| Cold launch -> live shell fetch over tailnet | Process start to first live-data paint | <= 3 s |
| Chat open (cached transcript paint) | Tap to cached rows visible | <= 400 ms |
| Chat open (cold replay, long chat) | Tap to complete projection painted | <= 4 s (the Mac's number after its audit) |
| Send -> accepted | Tap Send to the user echo confirmed from the stream | <= 1 s over tailnet, report actual |
| Send -> first assistant token | Tap Send to first assistant delta (not the echo) | network and model dependent; report actual, no budget |
| Transcript scroll | 200-row window, long chat | sustained 60 fps, no dropped-frame runs > 3 |
| Memory, app process | Chat open, 200 rows, no widgets | <= 150 MB |
| Memory, WebKit | Per widget process, reported separately | report actual; > 80 MB is a finding |
| Idle foreground CPU | Chat open, no activity, 60 s window | < 1% |
| Markdown parse | Reuse the shared cache strategy | never re-parse per body evaluation (measured by parse counter) |

Carry the `docs/audit/PERFORMANCE.md` discipline: measure before optimizing, log the numbers
in `docs/audit/PERFORMANCE-IOS.md`, no estimates presented as measurements.

---
## 17. Cloud execution model (SWE-2 Max agents)

The implementation runs in Devin's cloud environment. The implementer is **SWE-2 Max**,
Cognition's flagship model. One lead agent owns each PR; independent SWE-2 Max agents review
it. The loop below is the contract: a PR is not done when its code compiles, it is done when
every gate is green and the review loop converges to zero findings.

### 17.0 Prerequisites (before PR-1 opens)

Review found that "fully in the cloud" does not by itself establish the Apple toolchain the
gates need. Before PR-1 opens, the lead agent proves, and records in the build log:

- The Devin macOS cloud environment (A1): Apple Silicon VM, Xcode 26 at `/Applications/Xcode.app`,
  one preinstalled iPhone simulator with the iOS 26 runtime. `xcodebuild -version`, the exact
  simulator device name (`xcrun simctl list devices available`) and the runtime are recorded, and
  that device name is what every `-destination` in this document means by "the simulator".
  Deployment target stays iOS 17.0; the runtime that runs it is whatever the image ships.
- A clean clone of `main` builds the macOS package, runs `make -C macos test`, and produces
  one simulator screenshot via `xcrun simctl io booted screenshot` from a trivial app.
- Node toolchain: `node scripts/verify-release.mjs` passes on the clean clone (it typechecks
  root, `web/` and `router/` separately and builds Next; root `npx tsc --noEmit` excludes
  `web/`, so it is not sufficient for server changes).
- The full Useful Bot stack runs inside the VM from the repository (§17.5): `setup-local.mjs`
  against the VM's login Keychain, router, web and eve started through `scripts/service.mjs`,
  OpenCode Go connected through `PUT /api/providers` with the key from the
  `UB_CLOUD_PROVIDER_KEY` secret (§17.5), and a bot named **Test Bot** created through the API. Every live check in this
  document targets that stack, never the owner's Mac.
- The owner-run gates (real Serve, physical device) cannot run in the cloud (no Tailscale, no
  USB). They are recorded **red** in every PR that requires them and collected into
  `docs/audit/IOS-OWNER-CHECKLIST.md` (§17.5) for the owner to run after the chain finishes.
  Red is never rewritten as skipped or passed.

### 17.1 The per-PR loop

Each phase below ships as **one PR**. The lead agent may split a phase along a risk boundary
(P5 into settings+sections and providers+connectors, for example), never merge two phases,
and records the split in the build log. A PR merges only when ALL of this is true:

1. **Build & test gate**
   - `xcodebuild build -destination 'platform=iOS Simulator,name=<the simulator>'` clean, where
     the name is the preinstalled device recorded in §17.0.
   - `xcodebuild test` for the package on both macOS and iOS Simulator destinations;
     `UsefulBotCoreTests` green on both (macOS-only tests run on macOS only, by `#if`).
   - Server-side changes (S1 to S15 and any later ones): `node scripts/verify-release.mjs`
     green, `npm test` green, `make -C macos test` green (macOS must not regress; it is the
     source of truth).
   - `xcodegen generate` produces no diff against the committed project.
2. **Backend verification gate**: the PR's routes exercised for real:
   - Simulator hits the Mac's services on loopback (`127.0.0.1:4320`) or the shared fixture
     set (§18); every request/response shape asserted against the actual route handlers.
   - Auth paths verified: session create, 401 -> silent re-auth, `credential_invalid` ->
     credential-invalid state, 403 codes surfaced unchanged.
   - Any live message goes only to **Test Bot** (the macOS rule carries over verbatim).
   - The gate record names which of four evidence levels was reached: **simulator against
     fixtures**, **simulator against real routes**, **real Serve** (owner-assisted), **physical
     device** (owner-assisted). A stub never substitutes for a higher level that the PR
     requires (§17.2 names them).
3. **Visual verification gate** (the repo's screenshot rule, ported):
   - `xcrun simctl io booted screenshot` captures of every screen the PR touches, in every
     state it can reach (§11), in **light and dark**, at 390 pt standard width plus one 360 pt
     check; iPad split-view check where the PR touches navigation; one accessibility-XXXL
     Dynamic Type capture per screen.
   - Screenshots are judged against macOS screenshots for parity and against Appendix A's
     blacklist. "Tests pass" is never sufficient for UI.
   - For flows, record `xcrun simctl io booted recordVideo` where a state sequence matters
     (send -> working -> streaming -> durable merge).
4. **Review loop**: at least two independent SWE-2 Max reviewer passes per PR, in
   adversarial roles:
   - *Correctness/API reviewer*: contracts vs the routes, error paths, edge cases, §8.3 and
     §8.4 protocols.
   - *Security reviewer*: §4 rules, secrets, transport, ingress classification, biometric
     table coverage, endpoint policy.
   - *Design/a11y reviewer* (on UI PRs): Appendix A law, eight states plus §11 additions,
     Dynamic Type full range, VoiceOver labels, contrast per §12.
   - Findings go back to the lead agent, which fixes and re-submits. The loop repeats until
     a full pass returns zero findings. Only then is the PR mergeable.
5. **Performance compliance gate (per PR)**: the Appendix B traps are PR-level law:
   compare-before-assign, replay-publishes-once, minimal row inputs, id->index maps,
   windowed transcript, sized bitmaps, lazy widget views, no minimum-time gates. A PR that
   introduces one of these traps fails review even if everything else is green. Where a PR
   first creates a measurable surface or touches one, the §17.3 baseline runs in that PR.

### 17.2 The PR sequence

- **PR-1 (P0): repo & project skeleton.** The complete split from §3.2: `Package.swift`
  platforms += iOS 17; `#if os(macOS)` around supervision files and tests; `DeviceTokenStore`
  and `EndpointPolicy` protocols with macOS implementations; private cookie storage;
  `ServerEndpoint` extraction; `ios/project.yml`; the iOS app launches to a static pairing
  screen. Gate: iOS simulator build green; all existing macOS tests green on macOS; portable
  tests green on the simulator. Evidence level: simulator.
- **PR-2 (P1): connectivity & auth.** `KeychainStore`, `TailnetEndpointPolicy`,
  `PairingStore` with the §4.8 states, pairing UI (QR scan + manual), session exchange,
  re-auth, readiness levels, error taxonomy. Server S1 to S9, S13, S15 ride this PR's server
  branch, with tests for: ingress classification (all three classes, duplicate headers,
  IPv6), revocation without restart, rotation, desktop-session-over-tailnet rejection,
  auto-session denial on proxied requests. Gate: real sign-in over loopback from the
  simulator; **real-Serve check** (owner-assisted): sign-in over the tailnet from a device,
  desktop cookie refused over tailnet, forged headers refused on loopback. This check is
  required before `phoneEnabled` may be true on the owner's Mac; if it cannot run yet, the
  PR merges with the gate red and the build log says so, and `phoneEnabled` stays false.
- **PR-3 (P2): chat core.** Bots list (device-local selection), transcript (durable+live
  merge, day dividers, markdown, folding, working row, search chips), composer send/cancel
  with the §8.4 confirming state, cursor protocol (§8.3), poll loop, dark mode. Server S11,
  S14. Gate: send -> stream -> durable round-trip against the real backend in simulator;
  two-client test (Mac + simulator) proving no session fork and no selection cross-talk;
  screenshot parity vs macOS in both appearances; **baseline measurements** for chat open
  (cached and cold replay on the long fixture chat), idle CPU, transcript scroll, app memory.
- **PR-4 (P3): asks.** Approval cards with provenance (server S10), biometric classes A and
  B, owner questions, proposal cards, pending-approvals entry. Gate: scripted
  approve/deny/dismiss on simulator; `xcrun simctl biometric` for Face ID including cancel
  and failure; expired and resolved-elsewhere states.
- **PR-5 (P4): attachments & widgets.** Pickers, normalization, limits, previews, upload;
  `WKWebView` widget host with the §4.5 isolation and S12 sizing. Gate: image (HEIC, large
  JPEG, PNG) and text file round-trip; a real Excalidraw widget renders in the simulator;
  navigation to the paired host is proven blocked; **baseline measurements** for WebKit
  memory per widget and app memory with widgets mounted.
- **PR-6 (P5): management.** Bot/group settings, create/delete, sections, routines
  (structured editor), providers (all modes) + OAuth via Safari sheet, connectors + OAuth via
  tailnet callback (server S6), memory, usage, iOS Devices screen, and the **macOS Devices
  pane** (desktop PR in this phase; may be the risk split). Gate: each OAuth state machine
  exercised against fixtures; one real Composio connect against Test Bot's fleet.
- **PR-7 (P6): search, polish, accessibility.** Global search, all §11 states, Reduce
  Motion, Dynamic Type full-range pass, VoiceOver labels audit, offline draft editing.
- **PR-8 (P7): release hardening.** The final whole-app loop below + docs.

### 17.3 The final whole-app loop (PR-8)

After all feature PRs merge, the same machinery runs once across the complete app:

- Full review loop (the three adversarial roles) over the *entire* diff surface, not just
  one PR: this catches cross-phase seams a per-PR review cannot see.
- **Performance, decided:** trap law is enforced on every PR (17.1 gate 5). Instrumented
  baselines are taken when a measurable surface first exists (PR-3: chat open, replay, idle,
  scroll, memory; PR-5: widget and attachment memory) and re-taken on any PR that touches
  those paths. PR-8 runs every §16 budget on a mid-range physical device over a real tailnet,
  with Instruments/signpost traces on send -> accepted, send -> first assistant token and
  chat-open, memory footprint split app/WebKit, idle CPU. Results go to
  `docs/audit/PERFORMANCE-IOS.md`. Any regression is a finding; the loop continues until
  budgets pass or a budget is amended with owner sign-off. Rationale for measuring earlier
  than the draft proposed: the macOS audit found its worst trap only by measuring the long
  chat, and finding it at PR-8 would mean re-architecting the transcript after six PRs were
  built on it.
- Reliability matrix: airplane mode, Mac sleep mid-stream, Mac off tailnet, revoked
  credential mid-session, rotated credential, session expiry mid-turn, background/foreground
  churn, lost send response, concurrent Mac + phone sends, Mac switching the bot's session
  while the phone streams.
- Accessibility audit: Accessibility Inspector + VoiceOver walkthrough + largest Dynamic
  Type on every screen, both appearances.
- Privacy/release review: secrets scan, logging scan, backup flags, transport checklist,
  endpoint policy tests, open-source hygiene (clean-clone build with only Xcode + xcodegen).
- Physical-device pass: owner-run after the chain, from `IOS-OWNER-CHECKLIST.md`; recorded red
  in PR-8 until the owner runs it.
- **Done means:** all cloud gates green, zero open findings, docs current, the owner checklist
  written. The two owner-run gates are the only work left, and the checklist names each step.

### 17.4 Case-study build log (required, append-only)

This build is also a case study. The lead agent maintains
`docs/audit/IOS-BUILD-LOG.md` from the 17.0 prerequisites onward, written **at merge time, per
PR**, never reconstructed at the end (reconstructed numbers are fiction).

Per-PR entry:

| Field | What to record |
|-------|----------------|
| PR / phase | number, title, phase tag (P0-P7), branch, merge commit |
| Scope | files changed, lines +/-, what was built in one paragraph |
| Effort | wall-clock start->merge, agent sessions used, ACU/token spend **as exposed by the platform**; log what is measurable, mark the rest "not exposed" honestly |
| Review loop | review rounds to zero findings; findings per round by role (correctness / security / design-a11y) and severity; notable findings quoted verbatim |
| Verification | test counts, screenshots/recordings produced (paths), gates run and the evidence level reached for each (§17.1 gate 2) |
| Measurements | any §16 numbers taken in this PR, with dataset and conditions |
| Surprises | approaches that failed and why, spec ambiguities hit, spec claims found stale, decisions taken |

Running totals at the top of the file, updated per merge: PRs merged, total wall time,
total review rounds, total findings by severity, token spend where known.

Final summary section (written in PR-8): the whole table condensed, before/after
performance numbers linked from `PERFORMANCE-IOS.md`, the three most instructive findings
of the build, and an honest "what the spec got wrong / what the agents got wrong" section.
This file is intended for publication: **no secrets, no personal identifiers, no tailnet
addresses, no device names**. Write it publishable from the start, because scrubbing later
means it never happens.

Rule carried from the perf record: measured numbers and estimates are never mixed; every
number is either instrumented or labelled an estimate.

### 17.5 Session model in the Devin cloud (amendment A1)

Cognition's guidance is that a single Devin session degrades past roughly 2.5 hours. The build
therefore runs as a **chain of focused sessions**, one per PR, with no human between them.

- **One macOS session per PR.** The session receives the per-PR prompt (`REVIEW-PROMPTS.md`,
  Prompt 5) with its PR number, works at SWE-2 **max** effort, and owns that PR from branch to
  merge. It never starts the next PR's code.
- **Self-chaining.** At merge, the session appends the build-log entry, then creates the session
  for the next PR through the Devin API (`DEVIN_API_KEY`, `DEVIN_ORG_ID` secrets;
  `platform: "macos"`), confirms it exists, records its id in the build log, and stops. If a
  session dies, the owner restarts the chain by creating one session with Prompt 5 for the
  first PR whose build-log entry is missing; Prompt 5 is idempotent from the build log and the
  branch state.
- **Independent reviewers are separate sessions.** For each review round the lead creates the
  reviewer sessions (Prompt 6, one per role, Linux is fine, SWE-2 max) pointing at the PR, and
  waits for their reviews to land as GitHub PR reviews (`gh pr view --json reviews`). The lead
  fixes, pushes, and starts the next round. Zero findings from every role in one round is the
  exit. Any automated reviewer configured on the repository must also be green.
- **Merging.** The lead merges its own PR (`gh pr merge --squash`) only at zero findings with
  all cloud gates green. The repository rule stands: nothing is ever committed to `main`
  directly.
- **Screenshots** are committed under `docs/audit/ios-shots/PR-<n>/` at 1x device scale
  (`sips -Z 1000` on the capture), named `<screen>-<state>-<light|dark>.png`, at most 60 per PR.
  Recordings stay out of git; their paths in the session are logged.
- **The stack in the VM.** Started once per session, before any gate:
  `node scripts/setup-local.mjs` (VM Keychain), then `scripts/service.mjs router`, `eve`, `web`
  in the background with logs under `~/Library/Logs/UsefulBot/`; OpenCode Go connected via
  `PUT /api/providers` from the secret; Test Bot created via `PUT /api/shell`. Health is
  `GET /api/status`. The stack is disposable with the VM.
- **Secrets** (Devin org secrets, exposed as environment variables): `DEVIN_API_KEY`,
  `DEVIN_ORG_ID`, `UB_CLOUD_PROVIDER_KEY`, optionally `UB_CLOUD_COMPOSIO_KEY` for the one real
  connector check in PR-6. No secret is ever written to the repository, the build log or a
  screenshot.
- **The provider is OpenCode Go** (catalogue id `opencode-go`, mode `plan`, connection
  `opencode-go:plan`, default models `glm-5.3-flash` for chat and `glm-5.3` for the reviewer).
  The key in `UB_CLOUD_PROVIDER_KEY` is a plan key issued for this build; it is connected
  through `PUT /api/providers` the way the route expects. Spend it on real verification as
  freely as a check requires. The plan has a **weekly usage limit**: when the upstream answers
  `Weekly usage limit reached` (or a turn produces no tokens and the router log shows that
  error), that is the provider, not a defect. The session records it in the build log, marks
  the live checks it could not finish **red (provider limit)** rather than green, completes the
  same checks against the contract fixtures, and continues; the next session retries the live
  checks first. Never loop on a limited provider.
- **Network allowlist** the org must cover: the npm registry, `esm.sh` (widgets),
  `mcp.excalidraw.com`, the chosen provider's API host, Composio if used, `api.devin.ai`,
  `github.com`.
- **Owner checklist.** `docs/audit/IOS-OWNER-CHECKLIST.md`, created in PR-2 and appended by every
  PR that records a red owner-run gate: the exact steps for the owner's Mac (deploy order from
  §19, `--pair-phone`, `tailscale serve`, the real-Serve checks from PR-2, install to iPhone,
  the §17.3 reliability matrix), each with its expected result.
- **Never wait on a human.** A question a session cannot answer from this document, the design
  spec, the code or the adjudication is answered by the most conservative reading, recorded in
  the build log under Surprises with the assumption stated, and the work continues.

---

## 18. Testing & verification

- **Unit (XCTest):** all portable `UsefulBotCoreTests` run on the iOS Simulator destination;
  new tests for endpoint policy, pairing payload validation, lifecycle states, session
  re-auth and the 401/403 taxonomy, cursor math and completeness, `dataGeneration` drops,
  attachment normalization, `LocalHost` block list.
- **Contract fixtures, shared by both Swift clients:** one fixture set, produced by running
  the actual route handlers against a fixture config (the `service.mjs` fixture path) and
  sanitized, covering auth (all three ingress classes), approvals with provenance, routines,
  provider flows, connector flows, stream recovery (dropped connection, missing tail header,
  unknown events, session replacement), 409 conflicts and delayed responses. The fixtures
  live under `test/fixtures/ios-contract/` and are regenerated by a script when a route
  changes; both `UsefulBotCoreTests` and the iOS tests consume them. A hand-written stub that
  merely restates this spec is not a contract test.
- **UI (XCUITest):** pairing screen renders; manual-entry validation; bots list renders from
  fixtures; send flow against fixture echo; biometric-gated approval with
  `xcrun simctl biometric` enrollment and match/non-match.
- **Screenshot verification (the repo's rule, ported):** every UI change verified with a real
  simulator/device screenshot after driving to the state, both appearances, and compared
  against macOS screenshots for parity. No "tests passed so UI is fine."
- **Live checks:** any real message goes to **Test Bot** only; the macOS rule carries over
  verbatim.
- **Two-client checks:** Mac app and simulator open together for PR-3, PR-4 and PR-6.
- **Device checks (owner-assisted):** install on the owner's iPhone, run the §17.3
  reliability matrix for real (Mac sleep mid-stream is the critical one).

## 19. Rollout & release

- v1 installs via Xcode to the owner's device (free provisioning is acceptable for dev; the
  7-day re-sign nuisance is noted). TestFlight/App Store requires the Apple Developer
  account: owner decision (Q7), not blocking the build.
- Versioning: iOS `CFBundleShortVersionString` tracks the app release (1.0);
  `MARKETING_VERSION` in `project.yml`. The app checks `apiVersion` from `/api/status` (S15)
  and refuses to operate against an unknown one with a plain message.
- Open-source readiness (owner intent): `ios/` must build from a clean clone with only Xcode
  + xcodegen; document prerequisites; zero private paths or identities in committed files
  (the tailnet host comes from the pairing payload, never the repo).
- **Enable order** on the owner's Mac: deploy S1 to S15 and restart services with
  `phoneEnabled: false` -> loopback regression pass -> `--pair-phone` -> `tailscale serve`
  -> real-Serve check (PR-2 gate) -> QR to the phone.
- **Rollback order**: `tailscale serve reset` (remote exposure off first) -> `--revoke-phone`
  (invalidates phone sessions immediately via S9) -> revert code and restart services. Never
  revert code while Serve is still forwarding.
- The phone app is a client: rollback = reinstall previous build. Server changes are
  additive, so a code revert is a normal revert plus service restart per repo rules, after
  the order above.

## 20. Open questions: resolved

Every question from the draft, with who decided and why. Nothing is left open except Q7.

| # | Question | Resolution |
|---|----------|------------|
| 1 | Owner parity vs reduced | **Decided, owner (D1), confirmed by both reviewers.** Parity stands. The conditions review attached are now law: real-time revocation (§4.3), the exhaustive action table (§4.4), approval provenance (§9.2). |
| 2 | Profile name | **Decided, Fable.** Keep `phone`. No phone row was ever minted, so nothing inherits; the credential row carries the meaning. |
| 3 | Workspace actions | **Decided, Fable.** Hard-block `setWorkspace` for phone sessions on the shell action (S5). Hiding a picker is not a control. |
| 4 | Tailnet session binding | **Decided, Fable.** Reject desktop-profile sessions on tailnet ingress, including locally minted cookies. The cookie never legitimately leaves the Mac; the security model wins over the draft's convenience argument. |
| 5 | Dark mode | **Decided, Fable.** Ships in v1. The draft's light-only justification was false; macOS already has System/Light/Dark. |
| 6 | iPad | **Decided, Fable.** Adaptive SplitView, not optimized; navigation, keyboard, rotation and sheet checks in the visual gate. |
| 7 | Apple Developer account | **Owner decision required.** Blocks TestFlight, installs beyond 7 days and future APNs. Nothing in P0 to P7 waits on it. |
| 8 | macOS Devices pane | **Decided, Fable.** In scope, desktop PR in P5. It is the sanctioned pairing reveal and replaces the removed `pairing.json` path. |
| 9 | Package relocation | **Decided, Fable.** Keep `ios -> ../macos` for v1; PR-1 fixes target boundaries in place. |
| 10 | Approvals contract | **Decided, Fable.** Verified: id in the URL, `{decision, actionSha256}` in the body. Kept; provenance added by S10. |
| 11 | QR rendering | **Decided, Fable.** CoreImage `CIQRCodeGenerator` on macOS; zero dependencies; manual entry stays. |
| 12 | Session TTL | **Decided, Fable.** 12 hours, now bounded by credential validity (S9). Silent re-auth is single-flight. |

## 21. Review record

- Draft: Devin, from a full codebase audit.
- Critical analysis: GPT-6 Astra, xhigh effort, read-only over the repository, 2026-09-19:
  `docs/spec/IOS-APP-SPEC-REVIEW-ASTRA.md`.
- Adjudication and finalization: Fable 5.1, 2026-09-19: `docs/spec/IOS-APP-SPEC-ADJUDICATION.md`.
- Next: designer agent produces `docs/spec/IOS-DESIGN-SPEC.md` from §9 to §12 and Appendix A
  against the iOS mockups (prompt in `docs/spec/REVIEW-PROMPTS.md`, Prompt 3 final).
- Then: SWE-2 Max build per §17.

---
## Appendix A: Embedded design law (carried into the cloud build)

The implementing agents will not have the owner's local design skill. This appendix is the
enforceable subset, distilled for iOS. It is law, not guidance. Where it and a mockup
conflict, the mockup wins on layout and the law still wins on the blacklist.

### A.1 The blacklist (never ship)

- No purple, violet, indigo or lavender anywhere - `#6366F1`-family is the AI tell and is
  banned even as a small accent.
- No gradient decoration (backgrounds, buttons, text, borders, blobs, mesh). Only allowed
  gradient: a 1-3% luminance top sheen on a primary fill (send button, composer) - that is
  finish, not decoration.
- No neon, glow, frosted glass/backdrop blur as decoration, animated border beams,
  shimmer, cursor spotlights, grain or dot-grid textures.
- No emoji as UI icons; no sparkle/magic-wand/robot iconography on AI features. SF Symbols,
  one weight (`regular`), monochrome, accessibility-labelled.
- No decorative badge/eyebrow pills above headings; no bento reflex; no numbered "01/02/03"
  markers unless genuinely sequential; no cards inside cards (one elevation level only);
  no thick single-side accent borders on rounded elements.
- No spring/bounce animations; no animate-everything; no hover scale on cards.
- No hype copy (supercharge, unleash, seamless, empower); no exclamation marks in UI;
  sentence case everywhere; buttons name the exact action ("Approve command", not
  "Continue").
- One accent only (the monochrome ink accent per tokens); semantic color (success/warning/
  danger) only on real state, never decoration.
- Never the platform segmented control - it paints the OS accent color into the brand.
  Draw the token version (tone track + surface pill).

### A.2 Surfaces and depth (the polish rules)

- Lift, don't outline: content on a surface (bubbles, cards, popovers) uses a whisper edge
  (~5% ink in light) plus a short soft shadow (`0 0.5px 1px` @4%, `0 3px 16px` @8% in the
  token scale) - never a hard gray 1px border.
- One elevation level only. No card in a lifted card, no stacked shadows.
- The canvas sits a tone step below the stage (`#f3f3f3` under white) so lift is visible.
- Selection on a tinted ground lifts as a small surface card; hover is a tone shift only.
- Hairlines only for real dividers (header bottoms, list rules), never as box outlines.
- Primary action = solid fill; secondary = tone fill with a whisper edge. No outline-only
  buttons. Disabled = quieter sunken fill, not a gray ring.
- Names (bots, people) are weight 600 at rest; selection shows through the surface, not a
  weight jump. Section titles in navigation are sentence case, 12pt, weight 500, faint ink.
- Radius scale by role - never a one-off: xs 6 (chips, kbd), sm 10 (buttons, nav items,
  icon buttons), md 14 (fields, groups, message bubbles), lg 16 (cards, dialogs, sheets,
  popovers), xl 22 (expanded composer), 2xl 24 (stage), pill 999.
- Composer: raised field, whisper edge at rest, stronger edge on focus (the edge is what
  says the field is live); send = solid brand circle with faint sheen when sendable,
  sunken circle with faint glyph when not.
- Scrim is a solid `rgb(23 23 23 / 0.18)`; never blur a backdrop.
- Status/proposal cards are dense: 8x12 padding, status as a soft pill (soft bg + status
  ink) on the right, one line where it fits.

### A.3 Motion

- One easing everywhere: `cubic-bezier(0.22, 1, 0.36, 1)`. Durations 120-300ms: ~150ms for
  hover/press/control surfaces, ~250-260ms for entrances/sheets/dialogs, ~120ms for exits.
- Page/section changes are two beats, never a cross-fade (the brand curve is ~88% complete
  at 40% of duration, so a cross-fade reads as a hard cut and double-exposes both pages):
  highlight moves instantly; old content recedes ~120ms (fade + -6pt); swap; new content
  rises ~260ms (fade + 8pt). On iOS drive `.opacity`/`.offset` on a stable container with
  separate `selection`/`displayed` state - not `.id(selection)` + transition.
- Press feedback: `scale(0.97-0.98)` ~150ms; press beats hover in precedence.
- Skeletons over spinners for content areas, matching loaded geometry; 1.6s opacity pulse.
- Reduce Motion: all of the above becomes an instant swap - static skeleton, no offsets,
  no wave on the working row, brand motion frozen on a static frame.

### A.4 Chat transcript law (the hardest-won rules - port verbatim to iOS)

The transcript is always already at the newest turn. Exactly one automatic scroll exists:
a finished reply taller than the viewport scrolls once to its top. A reply that fits is
never moved. If the reader scrolls up, nothing pulls them back; streaming continues below.
- Position is a consequence of layout: `defaultScrollAnchor(.bottom)` holds the bottom;
  do not issue scroll commands against it.
- Stable row identity end-to-end: optimistic send row and its durable echo reconcile in
  the model, never remove+reinsert (that is what makes the scroll jump).
- Never scroll on a timer; never re-anchor per streamed token; never hide the transcript
  while loading - render what has arrived.
- Keep the scroll container mounted across empty states; an empty intermediate frame
  destroys scroll position.
- The working/thinking indicator is replaced by the reply's first token, not removed
  after the reply lands (removal shifts everything above it by its height).
- Replay collects in silence and publishes once - never one publish per replayed event.
- Distinguish content-size change from a reader gesture: track the scroll phase; only a
  real gesture may unpin "at bottom".
- Session state (folder, model, permission) lives in chrome near the composer, never
  appended into bubbles.

### A.5 iOS-specific additions

- Touch targets >= 40pt (44pt preferred) everywhere; the macOS 28-32pt icon buttons become
  40pt+ hit areas even where the glyph stays small.
- Safe areas respected; composer docks above the keyboard via `safeAreaInset`, never by
  padding math on keyboard notifications.
- Sheet detents: settings/create sheets use `.presentationDetents` tuned per content;
  destructive confirms use the smallest detent that fits.
- Swipe actions on bot rows are secondary shortcuts only; destructive actions still pass
  through a confirm. No custom gesture inventions.
- Dynamic Type: token font sizes scale (`Font.system(size:).relativeTo` or scaled
  metrics); transcript body must reach 135% without truncating controls.
- iOS has no hover - pressed state only; keep all seven states mapped (empty, loading,
  error, pressed, focus-visible, active, disabled) plus the 8th, offline.
- Verification widths become device classes: 360pt (small), 390pt (standard), 430pt
  (large), plus one iPad split-view check. Same rule as desktop: real screenshot of the
  running app per state, judged frozen - would a stranger guess a human designed this?

### A.6 Brand assets

Consume only `brand/` pipeline output: app icon from `brand/app/useful-bot-app-icon-1024.png`,
avatar head colors only from `brand/avatars/` + `avatar-palette.json`, native motion layers
from `brand/motion/native` driven by `motion.json` timings (used for loading states only).
Never redraw mascot geometry, never recolor outside the approved avatar palette, monochrome
for all chrome and icons.

### A.7 Amendments from finalization (2026-09-19)

A.1 to A.6 above are carried verbatim from the draft. These amendments came out of the
review and take precedence where they overlap:

- **Accessibility precedes literal token parity.** `inkFaint` (`#A3A3A3`) measures about
  2.5:1 on white; it may not be used for text a user must read. Readable secondary text uses
  `inkMuted` or `inkFaintText` (>= 4.5:1). Decorative marks and disabled glyphs keep
  `inkFaint`. The Mac has the same gap; that is a desktop follow-up, not a reason to copy it.
- **Dynamic Type covers the full range**, including the accessibility sizes, not 135% only.
  Controls never truncate; layouts reflow.
- **Both appearances are law.** Every screenshot in every gate is taken in light and dark.
- **Scroll law on iOS 17, concretely:** `defaultScrollAnchor(.bottom)` holds the bottom;
  "at bottom" is unpinned only by a real gesture, detected with `onScrollPhaseChange` where
  available and a `UIScrollView` delegate bridge on iOS 17.0 (there is no fallback that
  skips tracking); history prepend ("Show earlier") preserves the visible row by anchoring to
  its identity, never by offset math; the composer resizing above the keyboard must not move
  the transcript unless the reader was at bottom.
- **Approval cards** show provenance (bot, directory) and the full preview; the six-line cap
  from the Mac does not apply on the phone.
- **Touch targets are 44 pt minimum**, replacing the "40 pt, 44 preferred" wording above.

## Appendix B: Embedded performance law (from the macOS audit record)

`docs/audit/PERFORMANCE.md` is the source; these are the traps that cost real time on the
macOS app and have direct iOS analogues. The implementing agents inherit these as
constraints - do not rediscover them.

1. **Compare before assigning.** Every poll response (shell, state, proposals, approvals)
   is diffed before touching observable state; an unchanged payload republishes nothing.
   One @Observable model with unconditional writes per tick is how the Mac burned 29% CPU
   idle. Target: <1% idle foreground CPU.
2. **History replay publishes once.** Replayed durable/stream events assemble silently and
   paint in one pass. Publishing per event on a long chat is the single worst trap
   (measured: 4 minutes at 96% CPU on macOS). Measure every fix on the long chat, not a
   fresh one.
3. **Rows receive minimal, equatable inputs.** A transcript row gets a `transcriptFace`
   (fields it actually reads), not the whole bot object - `sessionId`/`lastPreview`/`lastAt`
   change whenever any bot speaks and would rebuild every row's markdown on every event.
4. **Streaming deltas never scan history.** Maintain an id->index map on append;
   `firstIndex(where:)` per delta is quadratic on the main actor.
5. **Streaming markdown parses into one replaceable slot.** The in-flight reply parses
   once per delta into a cached slot; completed messages parse once into a shared cache.
   Never re-parse the transcript per body evaluation.
6. **Windowed transcript.** Mount the newest blocks + always the newest turn; older
   history mounts as the reader asks ("Show earlier"). A 3,500-event chat cannot be an
   eager stack.
7. **Cheap checks stay cheap.** `canSend` = non-blank draft or attachments present -
   never a format pass over the message.
8. **Poll cadence follows visibility.** Foreground: 2.5s. Backgrounded/inactive: stop -
   iOS suspends anyway; design the resume, don't fight the suspension. On return: one
   resync (state + shell + tail-index stream resume), not a burst of overdue polls.
9. **Bitmap discipline.** Raster assets are sized to their display box; the macOS app
   once shipped a 278MB icon bitmap. iOS: asset catalog scales + `downsampling` for
   decoded images; never decode a 1024px source into a 24pt avatar.
10. **Lazy widget views.** `WKWebView` for MCP widgets is created only when its row nears
    the viewport, never eagerly for the whole transcript.
11. **No minimum-time gates.** Splash/launch states end when ready, never on a fixed
    timer; a launch animation that outlives readiness is a bug (measured: 2.8s of dead
    launch time).
12. **Measure, don't estimate.** Every performance claim in a PR carries a measurement
    (XCTest metrics, Instruments signposts via `OSSignposter`, `os_signpost` intervals on
    send->first-token and chat-open paths, memory via `footprint`-equivalent gauges).
    Numbers go into a `docs/audit/PERFORMANCE-IOS.md` the same way.


*End of spec. Frozen for implementation on 2026-09-19. Changes after this point go through
the owner and are recorded as dated amendments in §1.3, never as silent edits.*

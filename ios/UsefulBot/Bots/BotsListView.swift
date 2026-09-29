import SwiftUI
import UsefulBotCore

extension DynamicTypeSize {
    /// `isAccessibilityCategory` is a `ContentSizeCategory` member — this
    /// SDK's `DynamicTypeSize` has none, so the same set by hand.
    var ubIsAccessibilitySize: Bool {
        switch self {
        case .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5:
            return true
        default:
            return false
        }
    }
}

/// The paired landing: the Bots list. PR-3 builds the real rail+list anatomy;
/// this is the honest minimum PR-2 needs — the nav chrome with the badge and
/// "Useful Bot", the live roster read from `/api/shell`, the readiness banner
/// states, and the entry to Devices where sign-out and unpair live.
struct BotsListView: View {
    @EnvironmentObject private var coordinator: PairingCoordinator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var bots: [ShellBot] = []
    /// `loaded` means a roster fetch has *succeeded* at least once — a failed
    /// first load shows the error row, never "Create your first bot".
    @State private var loaded = false
    /// The last non-readiness fetch failure, rendered as the spec 1.2 Error
    /// row (inline line + Retry); cleared by the next successful fetch.
    @State private var loadError: String?
    @State private var showDevices = false
    /// When `/api/shell` last answered — the "cached N min ago" the offline
    /// banner quotes.
    @State private var lastFetchAt: Date?
    /// The expiry warning marks itself warned the moment it renders (one-time
    /// per credential); this holds it on screen for the rest of the screen's
    /// life so the banner doesn't flicker out in the same frame. It is keyed
    /// to the credential's expiry — a re-pair brings a new expiry, and the
    /// latch must not keep the old credential's banner standing (or suppress
    /// the new one's once-per-credential warning).
    @State private var expiryBannerShownFor: Date?


    var body: some View {
        List {
            if let readiness = coordinator.readiness, readiness != .ready {
                readinessBanner(readiness)
            } else if showsExpiryWarning
                        || (expiryBannerShownFor != nil
                            && expiryBannerShownFor == coordinator.store.credentialExpiresAt) {
                expiryBanner
            }
            Section {
                if let loadError {
                    loadErrorRow(loadError)
                }
                if loadError == nil && !loaded {
                    skeletonRows
                } else if bots.isEmpty {
                    // A failed fetch never asserts an empty roster.
                    if loadError == nil { emptyState }
                } else {
                    ForEach(bots) { bot in
                        Text(bot.name)
                            .tokenFont(DesignTokens.FontSize.chatName, .semibold)
                            .foregroundStyle(Theme.C.ink)
                            .frame(minHeight: DesignTokens.Space.phoneRowMinHeight)
                            .listRowBackground(Color.clear)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        // Lists sit on canvas, one tone under surfaces (design spec 1.0).
        .background(Theme.C.canvas)
        // The paired root's own marker: "Useful Bot" staticText alone is
        // ambiguous — the pairing badge carries it as an accessibility label.
        .accessibilityIdentifier("bots-list")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // Design spec 1.2 item 1: badge 32 plus the 22 pt semibold
                // title — the system inline title renders ~17 pt, so the
                // tokens are drawn here instead of `.navigationTitle`.
                HStack(spacing: 10) {
                    Image("useful-bot-badge")
                        .resizable()
                        .frame(width: 32, height: 32)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                    Text("Useful Bot")
                        .tokenFont(DesignTokens.FontSize.phoneLargeTitle, .semibold)
                        .foregroundStyle(Theme.C.ink)
                }
                // iOS 26 sizes a custom leading item to its first subview and
                // clips the rest; fixedSize keeps the title past the badge.
                .fixedSize()
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showDevices = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(Theme.font(DesignTokens.FontSize.chatBody, .regular))
                        .foregroundStyle(Theme.C.ink)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Devices")
                .ubFocusRing()
            }
        }
        .task {
            await coordinator.probeReadiness()
            await refresh()
        }
        // §8.5's one resync on foreground: the coordinator stamps resyncAt
        // after its status probe; the shell re-fetch rides it.
        .onChange(of: coordinator.resyncAt) { _, _ in
            Task { await refresh() }
        }
        .refreshable {
            await coordinator.probeReadiness()
            await refresh()
        }
        // Devices is a push (design spec 1.15), not a sheet — the nav stack
        // gives it the back chevron.
        .navigationDestination(isPresented: $showDevices) {
            DevicesView()
        }
    }

    private func refresh() async {
        // UI-test seams for the §11 states a live stack cannot produce on
        // cue: HANG holds the skeleton, EMPTY forces the empty state.
        // Neither is ever set outside the test harness.
        if ProcessInfo.processInfo.environment["UB_HANG_SHELL"] == "1" {
            try? await Task.sleep(for: .seconds(120))
            return
        }
        if ProcessInfo.processInfo.environment["UB_EMPTY_SHELL"] == "1" {
            bots = []
            loaded = true
            return
        }
        // Same class of seam: FAIL makes the roster fetch error while the
        // Mac stays reachable, so the 1.2 Error row (not the empty state)
        // is what the visual gate records.
        if ProcessInfo.processInfo.environment["UB_FAIL_SHELL"] == "1" {
            loadError = Self.loadErrorCopy(for: BackendError.http(500))
            return
        }
        // A response stamped with an older generation is dropped before it
        // touches the model (spec 8.1): an unpair or a cross-Mac re-pair
        // landing mid-fetch must not repopulate the list it just wiped.
        let generation = coordinator.store.dataGeneration
        do {
            let shell = try await coordinator.client?.shell()
            guard coordinator.store.isCurrent(generation: generation) else { return }
            bots = shell?.bots.filter { $0.kind == "bot" } ?? []
            lastFetchAt = Date()
            loadError = nil
            loaded = true
        } catch BackendError.credentialInvalid, BackendError.deviceTokenMissing {
            guard coordinator.store.isCurrent(generation: generation) else { return }
            coordinator.store.markCredentialInvalid()
            coordinator.phase = .idle
        } catch {
            // A fetch failure can mean the Mac went quiet — probe so the
            // banner tells that story — but whatever the level, the failure
            // itself is the spec 1.2 Error row, never the empty state.
            await coordinator.probeReadiness()
            guard coordinator.store.isCurrent(generation: generation) else { return }
            loadError = Self.loadErrorCopy(for: error)
        }
    }

    /// Spec 1.2 Error: the server's typed copy when it sent one, else a
    /// plain sentence — readiness failures are already told by the banner.
    private static func loadErrorCopy(for error: Error) -> String {
        if let backend = error as? BackendError {
            return backend.localizedDescription
        }
        return "Could not load your bots."
    }

    /// Design spec 1.2's Error row: danger glyph, one muted sentence,
    /// trailing secondary Retry — the cached list stays visible under it.
    private func loadErrorRow(_ copy: String) -> some View {
        // Secondary recipe (sunken fill + edge stroke), never bare text:
        // A.7's 44 pt floor needs the hit area to read as a button.
        let retry = Button("Retry") {
            Task {
                await coordinator.probeReadiness()
                await refresh()
            }
        }
        .tokenFont(DesignTokens.FontSize.button, .semibold)
        .foregroundStyle(Theme.C.ink)
        .padding(.horizontal, 20)
        .frame(minHeight: 44)
        .background(
            Theme.C.sunken,
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .buttonStyle(PressedScale())
        .ubFocusRing()
        let text = HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(Theme.C.danger)
            Text(copy)
                .tokenFont(DesignTokens.FontSize.attachError, .regular)
                .foregroundStyle(Theme.C.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        return Group {
            if dynamicTypeSize.ubIsAccessibilitySize {
                // A.7/1.0: the trailing action drops under the text at
                // accessibility sizes instead of squeezing it.
                VStack(alignment: .leading, spacing: 8) {
                    text
                    retry
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    text
                    Spacer(minLength: 8)
                    retry
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bots-load-error")
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// "Create your first bot" as the only content, primary "New bot" under
    /// it (design spec 1.2 Empty row). The button is the shell's own CTA:
    /// the designed create sheet (1.7) is PR-6 scope, so until it lands the
    /// control is disabled-with-reason rather than minting an unnamed bot.
    private var emptyState: some View {
        let newBotEnabled = false
        return VStack(alignment: .leading, spacing: 12) {
            Text("Create your first bot")
                .tokenFont(DesignTokens.FontSize.emptyTitle, .semibold)
                .tracking(DesignTokens.Tracking.tight * DesignTokens.FontSize.emptyTitle)
                .foregroundStyle(Theme.C.ink)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            Button {
            } label: {
                Text("New bot")
                    .tokenFont(DesignTokens.FontSize.button, .semibold)
                    .foregroundStyle(newBotEnabled ? Theme.C.brandInk : Theme.C.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .disabled(true)
            .buttonStyle(PressedScale(
                fill: newBotEnabled ? Theme.C.brand : Theme.C.sunken,
                pressedFill: newBotEnabled ? Theme.C.accentStrong : Theme.C.sunken,
                shadowed: newBotEnabled
            ))
            .ubFocusRing()
            Text("Bot creation arrives with the chat update.")
                .tokenFont(DesignTokens.FontSize.attachError, .regular)
                .foregroundStyle(Theme.C.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 48)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }


    /// Loading (design spec 1.2's mockup, §11): the "Connecting to
    /// <Mac>" status line with its `inkFaint` dot, a pinned-card skeleton,
    /// the section-title bar, then five row skeletons at loaded geometry in
    /// `border` — 1.6 s pulse; static under Reduce Motion.
    private var skeletonRows: some View {
        let rows = VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Theme.C.inkFaint)
                    .frame(width: 6, height: 6)
                Text("Connecting to \(coordinator.store.pairedName ?? "your Mac")")
                    .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer()
            }
            .frame(minHeight: DesignTokens.Space.phoneRowMinHeight)
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .fill(Theme.C.border)
                .frame(height: DesignTokens.Space.phoneRowMinHeight)
                .padding(.vertical, 8)
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                .fill(Theme.C.border)
                .frame(width: 90, height: 10)
                .padding(.vertical, 10)
            ForEach(0..<5, id: \.self) { _ in
                HStack(spacing: 12) {
                    Circle()
                        .fill(Theme.C.border)
                        .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                            .fill(Theme.C.border)
                            .frame(width: 110, height: 12)
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                            .fill(Theme.C.border)
                            .frame(width: 170, height: 10)
                    }
                    Spacer()
                }
                .frame(minHeight: DesignTokens.Space.phoneRowMinHeight)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bots-skeleton")
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        return Group {
            if reduceMotion {
                rows
            } else {
                rows.phaseAnimator([1.0, 0.45]) { content, phase in
                    content.opacity(phase)
                } animation: { _ in
                    .easeInOut(duration: 0.8)
                }
            }
        }
    }

    /// The §7.2 banner is a lifted card: glyph, title, one line, trailing
    /// "Retry" (design spec 1.2's Readiness banner table, verbatim copy).
    private func readinessBanner(_ level: MacReadiness) -> some View {
        let (glyph, title, line) = bannerCopy(level)
        let retry = Button {
            Task {
                await coordinator.probeReadiness()
                await refresh()
            }
        } label: {
            Text("Retry")
                .tokenFont(DesignTokens.FontSize.button, .semibold)
                .foregroundStyle(Theme.C.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: DesignTokens.Space.phoneHitTarget)
        }
        .buttonStyle(PressedScale())
        .background(
            Theme.C.sunken,
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .ubFocusRing()
        let text = HStack(alignment: .top, spacing: 12) {
            Image(systemName: glyph)
                .font(Theme.font(DesignTokens.FontSize.emptyBody, .regular))
                // §7.2 levels are degraded, not destructive — `warning`
                // matches the Devices statusPill; `danger` is reserved for
                // refused/destructive (§1.0 shared states).
                .foregroundStyle(Theme.C.warning)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .tokenFont(DesignTokens.FontSize.emptyBody, .semibold)
                    .foregroundStyle(Theme.C.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(line)
                    .tokenFont(DesignTokens.FontSize.attachError, .regular)
                    .foregroundStyle(Theme.C.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        return Group {
            if dynamicTypeSize.ubIsAccessibilitySize {
                // Same A.7/1.0 rule as the error row: the trailing Retry
                // drops under the copy rather than squeezing it.
                VStack(alignment: .leading, spacing: 10) {
                    text
                    retry
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    text
                    Spacer(minLength: 8)
                    retry
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            Theme.C.surface,
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
        )
        // Lifted card per §4.3: `lift` shadow (two-component), not the
        // button's `sm`.
        .cardLift(cornerRadius: DesignTokens.Radius.md)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("readiness-banner")
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(
            top: 8,
            leading: DesignTokens.Space.phoneGutter,
            bottom: 8,
            trailing: DesignTokens.Space.phoneGutter
        ))
    }

    /// §11 "Credential expiring": the one-time banner seven days out
    /// (design 1.2's banner table, fourth row). It yields the slot to a real
    /// readiness banner and fires once per credential — the store keys the
    /// warning to the expiry so a rotated credential warns again.
    private var showsExpiryWarning: Bool {
        guard let expiry = coordinator.store.credentialExpiresAt,
              expiry.timeIntervalSinceNow > 0,
              expiry.timeIntervalSinceNow <= 7 * 86_400,
              coordinator.store.expiryWarnedFor != expiry else { return false }
        return true
    }

    /// Same lifted card as the readiness banner, minus Retry — nothing
    /// retries a calendar. The `key` glyph stays `ink`: on this screen
    /// warning color belongs to pending approvals alone (design R1).
    private var expiryBanner: some View {
        let days = Int(
            ((coordinator.store.credentialExpiresAt ?? .now).timeIntervalSinceNow / 86_400)
                .rounded(.up)
        )
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: "key")
                .font(Theme.font(DesignTokens.FontSize.emptyBody, .regular))
                .foregroundStyle(Theme.C.ink)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pairing expires in \(days) \(days == 1 ? "day" : "days")")
                    .tokenFont(DesignTokens.FontSize.emptyBody, .semibold)
                    .foregroundStyle(Theme.C.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Re-pair from your Mac before then.")
                    .tokenFont(DesignTokens.FontSize.attachError, .regular)
                    .foregroundStyle(Theme.C.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            Theme.C.surface,
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
        )
        .cardLift(cornerRadius: DesignTokens.Radius.md)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("expiry-banner")
        .onAppear {
            expiryBannerShownFor = coordinator.store.credentialExpiresAt
            coordinator.store.markExpiryWarned()
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(
            top: 8,
            leading: DesignTokens.Space.phoneGutter,
            bottom: 8,
            trailing: DesignTokens.Space.phoneGutter
        ))
    }

    /// Copy pinned by the design spec's banner table; the age clause only
    /// appears once there is a timestamp to quote.
    private func bannerCopy(_ level: MacReadiness) -> (String, String, String) {
        switch level {
        case .noNetwork:
            if let lastFetchAt {
                return (
                    "wifi.slash",
                    "You're offline",
                    "Showing what was cached \(Self.ago(lastFetchAt))."
                )
            }
            return ("wifi.slash", "You're offline", "Showing cached data.")
        case .macUnreachable(let lastSeen, _, _):
            if let lastSeen {
                return (
                    "desktopcomputer",
                    "Your Mac is unreachable",
                    "Last seen \(Self.ago(lastSeen)). Bots pick up when it's back."
                )
            }
            return (
                "desktopcomputer",
                "Your Mac is unreachable",
                "Bots pick up when it's back."
            )
        case .runtimeDown:
            return (
                "exclamationmark.triangle",
                "Agent runtime is down on your Mac",
                "Settings still work. Chats are paused."
            )
        case .unsupportedVersion:
            // S15's "says so": the Mac answered but speaks an apiVersion
            // this build doesn't know — honest copy, not the pinned
            // unreachable/runtime-down lines it would falsify.
            return (
                "exclamationmark.triangle",
                "Your Mac runs an unsupported version",
                "Update Useful Bot on your Mac."
            )
        case .ready:
            return ("", "", "")
        }
    }

    /// "4 min ago", abbreviated to match the spec's sample copy. Under a
    /// minute the abbreviated formatter emits future tense ("in 0 sec") —
    /// clamp those to "just now".
    private static func ago(_ date: Date) -> String {
        if Date().timeIntervalSince(date) < 60 { return "just now" }
        return agoFormatter.localizedString(for: date, relativeTo: .now)
    }

    private static let agoFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

/// Devices (spec 6.2's sign-out home, pushed per design spec 1.15): the
/// paired Mac's name, host and status, the two expiry clocks, the
/// Diagnostics group under macUnreachable, "Sign out on this phone"
/// (class C) and "Unpair" (class A, confirm sheet then biometric).
struct DevicesView: View {
    @EnvironmentObject private var coordinator: PairingCoordinator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var gateUnavailable = false
    @State private var confirmUnpair = false
    @State private var showRePair = false
    // The host value's mono 13 still rides Dynamic Type — footnote is the
    // nearest text style at this point size (same rule tokenFont uses).
    @ScaledMetric(relativeTo: .footnote) private var hostMonoSize: CGFloat = 13

    private var hostNeedsWrap: Bool {
        dynamicTypeSize.ubIsAccessibilitySize
    }

    /// A connect running anywhere (the pushed re-pair) makes the lifecycle
    /// rows inert: the exchange and the wipe must not interleave.
    private var connectBusy: Bool {
        switch coordinator.phase {
        case .connecting, .connected: return true
        case .idle, .failed: return false
        }
    }

    /// Design spec 1.15's group titles: `fieldLabel` 13 medium in
    /// `inkMuted`, never iOS's large header style (adjudication V1).
    private func groupHeader(_ title: String) -> some View {
        Text(title)
            .tokenFont(DesignTokens.FontSize.fieldLabel, .medium)
            .foregroundStyle(Theme.C.inkMuted)
            .textCase(nil)
    }

    var body: some View {
        List {
            Section {
                if let name = coordinator.store.pairedName {
                    LabeledContent("Name", value: name)
                }
                if let host = pairedHost {
                    // 1.15: the host value is SF Mono 13 and scales like
                    // every other token; at accessibility sizes it wraps to
                    // two lines instead of truncating.
                    LabeledContent {
                        Text(host)
                            .font(.system(size: hostMonoSize, design: .monospaced))
                            .lineLimit(hostNeedsWrap ? 2 : 1)
                            .truncationMode(.middle)
                            .multilineTextAlignment(.trailing)
                    } label: {
                        Text("Host")
                    }
                }
                LabeledContent("Status") {
                    statusPill
                }
            } header: {
                groupHeader("This Mac")
            }
            .foregroundStyle(Theme.C.ink)

            Section {
                if let session = coordinator.store.sessionExpiresAt {
                    LabeledContent("Session expires", value: session, format: .dateTime)
                }
                if let credential = coordinator.store.credentialExpiresAt {
                    // 1.15's Credential-expiring state: the value goes
                    // `warning` inside the seven-day window and the re-pair
                    // row appears under it — the banner's "Re-pair" needs a
                    // path that is not the destructive Unpair.
                    LabeledContent {
                        Text(credential, format: .dateTime)
                            .foregroundStyle(credentialExpiring ? Theme.C.warning : Theme.C.ink)
                    } label: {
                        Text("Pairing expires")
                    }
                    if credentialExpiring {
                        Button {
                            showRePair = true
                        } label: {
                            Text("Re-pair from your Mac")
                        }
                        .disabled(connectBusy)
                        .ubFocusRing()
                    }
                }
            } header: {
                groupHeader("Expiry")
            }
            .foregroundStyle(Theme.C.ink)

            // §1.15 item 3: under macUnreachable the Diagnostics group
            // shows which layer dropped the probe — DNS, TLS, then HTTP.
            if case .macUnreachable(_, _, let diag) = coordinator.readiness {
                Section {
                    diagRow("Resolved", diag.resolved)
                    diagRow("TLS", diag.tls)
                    diagRow("HTTP status", diag.httpStatus)
                } header: {
                    groupHeader("Diagnostics")
                }
                .foregroundStyle(Theme.C.ink)
            }

            Section {
                Button("Sign out on this phone") {
                    Task {
                        await coordinator.signOut()
                        dismiss()
                    }
                }
                .foregroundStyle(Theme.C.ink)
                .disabled(connectBusy)
                .ubFocusRing()
                Button {
                    // Class A: the spec's confirm sheet explains the purge,
                    // then the biometric prompt runs (the gate is the final
                    // confirmation, not a second one).
                    confirmUnpair = true
                } label: {
                    Text("Unpair")
                        .foregroundStyle(Theme.C.danger)
                }
                .disabled(connectBusy)
                .ubFocusRing()
                if gateUnavailable {
                    Text(OwnerGate.unavailableCopy)
                        .foregroundStyle(Theme.C.danger)
                }
            } footer: {
                // §11/1.1: never grey alone — while a connect runs on the
                // re-pair push, say why these rows are inert.
                if connectBusy {
                    Text("Finishing the current connection first.")
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
        }
        .confirmationDialog(
            "Unpair this iPhone?",
            isPresented: $confirmUnpair,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) {
                Task {
                    let verdict = await OwnerGate.evaluate(reason: "Unpair this iPhone")
                    guard verdict == .approved else {
                        gateUnavailable = verdict == .unavailable
                        return
                    }
                    await coordinator.unpair()
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This signs out and erases the pairing token, caches and drafts on this iPhone. Pair again with a new code from your Mac.")
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        // Re-pairing pushes the real pairing flow; a fresh pair lands on
        // `.connected` — close back to Devices.
        .navigationDestination(isPresented: $showRePair) {
            // Pushed, not root: keep the nav bar so the back chevron is the
            // exit affordance the root flow does not need (or have).
            PairingView(pushedFlow: true)
        }
        .onChange(of: coordinator.phase) { _, phase in
            // A landed re-pair closes back to Devices; reset so a second
            // re-pair doesn't mount a view that reads busy forever.
            if case .connected = phase {
                showRePair = false
                coordinator.phase = .idle
            }
        }
        .scrollContentBackground(.hidden)
        // Grouped settings sit on canvas; the group rows are the surfaces.
        .background(Theme.C.canvas)
    }

    /// The tailnet host with the scheme stripped (design spec 1.15 renders
    /// the host, not the URL).
    private var pairedHost: String? {
        guard let origin = coordinator.store.pairedOrigin else { return nil }
        if let components = URLComponents(string: origin), let host = components.host {
            return components.port.map { "\(host):\($0)" } ?? host
        }
        var host = origin
        for prefix in ["https://", "http://"] where host.hasPrefix(prefix) {
            host = String(host.dropFirst(prefix.count))
        }
        if let slash = host.firstIndex(of: "/") { host = String(host[..<slash]) }
        return host
    }

    /// The 1.15 status pill speaks the spec's vocabulary (1.11): a good
    /// connection is "Connected" in `success`, anything degraded is
    /// `warning` — `danger` is reserved for refused/destructive states — and
    /// a nil readiness (probe not yet landed) is the neutral "Checking".
    private var statusPill: some View {
        let (text, foreground, background): (String, Color, Color)
        switch coordinator.readiness {
        case .ready:
            (text, foreground, background) = ("Connected", Theme.C.success, Theme.C.successSoft)
        case .noNetwork:
            // §7.2 honest copy: the phone's own path is down — pointing at
            // the Mac would send the user the wrong way.
            (text, foreground, background) = ("Offline", Theme.C.warning, Theme.C.warningSoft)
        case .macUnreachable:
            (text, foreground, background) = ("Unreachable", Theme.C.warning, Theme.C.warningSoft)
        case .runtimeDown:
            (text, foreground, background) = ("Runtime down", Theme.C.warning, Theme.C.warningSoft)
        case .unsupportedVersion:
            (text, foreground, background) = ("Unsupported version", Theme.C.warning, Theme.C.warningSoft)
        case nil:
            (text, foreground, background) = ("Checking", Theme.C.inkMuted, Theme.C.sunken)
        }
        return Text(text)
            .tokenFont(DesignTokens.FontSize.phoneChatMeta, .medium)
            .foregroundStyle(foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(background, in: Capsule())
    }

    /// A §1.15 Diagnostics row: the layer name and an ok/bad pill in the
    /// status vocabulary (success/warning soft — degradation, never
    /// destructive).
    private func diagRow(_ label: String, _ verdict: ReachabilityDiagnostics.Verdict) -> some View {
        LabeledContent(label) {
            Text(verdict == .ok ? "ok" : "bad")
                .tokenFont(DesignTokens.FontSize.phoneChatMeta, .medium)
                .foregroundStyle(verdict == .ok ? Theme.C.success : Theme.C.warning)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(verdict == .ok ? Theme.C.successSoft : Theme.C.warningSoft, in: Capsule())
        }
    }

    /// Inside the one-time seven-day warning window (spec 11) — the same
    /// predicate the banner uses.
    private var credentialExpiring: Bool {
        guard let expiry = coordinator.store.credentialExpiresAt,
              expiry.timeIntervalSinceNow > 0,
              expiry.timeIntervalSinceNow <= 7 * 86_400 else { return false }
        return true
    }
}

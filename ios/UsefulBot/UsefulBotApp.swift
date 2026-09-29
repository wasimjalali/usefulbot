import SwiftUI
import UsefulBotCore

@main
struct UsefulBotApp: App {
    @StateObject private var coordinator = PairingCoordinator()
    @Environment(\.scenePhase) private var scenePhase
    @State private var booted = false

    var body: some Scene {
        WindowGroup {
            if let testSizeCategory = Self.testSizeCategory {
                root.environment(\.sizeCategory, testSizeCategory)
            } else {
                root
            }
        }
    }

    private var root: some View {
        Group {
            if !booted {
                // Launch settles the stored state first: a persisted
                // `paired` re-exchanges, a broken stored origin lands in
                // credentialInvalid — before any screen renders.
                ZStack {
                    Theme.C.surface.ignoresSafeArea()
                    ProgressView()
                }
            } else if isPad, coordinator.store.state == .paired {
                // Spec 10: iPad is NavigationSplitView — the rail equivalent
                // in the sidebar, the detail column holding pushes (Devices
                // today; chat lands with PR-3). Pairing, sign-in and
                // credential-invalid stay full-width.
                NavigationSplitView {
                    BotsListView()
                } detail: {
                    // Sidebar destinations (Devices, and its pushed re-pair)
                    // land in the detail column — it needs its own stack or
                    // nested pushes silently go nowhere and carry no chrome.
                    NavigationStack {
                        Text("Select a bot")
                            .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                            .foregroundStyle(Theme.C.inkMuted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.C.canvas)
                    }
                }
            } else {
                // Each auth state owns its stack. Swapping the root's type
                // inside one persistent NavigationStack leaves the new
                // root's toolbar unmounted (the roster re-renders with no
                // title or Devices gear after sign-in) and would leave a
                // pushed Devices screen above a signed-out root.
                switch coordinator.store.state {
                case .paired:
                    NavigationStack { BotsListView() }
                case .signedOut:
                    NavigationStack { SignedOutView() }
                case .unpaired, .credentialInvalid:
                    NavigationStack { PairingView() }
                }
            }
        }
        .environmentObject(coordinator)
        // The accent is monochrome: `accent` token (#171717/#EDEDED) so
        // carets, selection and the back chevron never leak system blue.
        .tint(Theme.C.accent)
        .preferredColorScheme(Self.testAppearance)
        .task {
            await coordinator.bootstrap()
            booted = true
        }
        // Spec 8.5: returning to active runs one resync — a status probe
        // plus the shell re-fetch the Bots list drives off `resyncAt`.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await coordinator.sceneBecameActive() }
            }
        }
    }

    private var isPad: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    /// UI tests pin an appearance via `UB_APPEARANCE` and a type size via
    /// `UB_TYPE_SIZE` so the visual gate does not depend on the simulator's
    /// global settings. Unset in normal runs.
    private static var testAppearance: ColorScheme? {
        switch ProcessInfo.processInfo.environment["UB_APPEARANCE"] {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    private static var testSizeCategory: ContentSizeCategory? {
        switch ProcessInfo.processInfo.environment["UB_TYPE_SIZE"] {
        case "xxxl": return .accessibilityExtraExtraExtraLarge
        default: return nil
        }
    }
}

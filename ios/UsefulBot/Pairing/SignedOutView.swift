import SwiftUI
import UsefulBotCore

/// The `signedOut` screen (design spec 1.18): centered block on `surface` —
/// badge 56 pt, "Signed out", the Mac name in `inkMuted`, primary "Sign in"
/// (class C), secondary "Unpair" (class A, biometric). Cached data is never
/// shown. Offline disables Sign in with "You're offline".
struct SignedOutView: View {
    @EnvironmentObject private var coordinator: PairingCoordinator
    @State private var gateUnavailable = false

    private var isSigningIn: Bool {
        coordinator.phase == .connecting
    }

    private var isOffline: Bool {
        !coordinator.monitor.isOnline
    }

    private var signInEnabled: Bool {
        !isSigningIn && !isOffline
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image("useful-bot-badge")
                .resizable()
                .frame(width: 56, height: 56)
                .clipShape(Circle())
                .accessibilityLabel("Useful Bot")
                .padding(.bottom, 20)
            Text("Signed out")
                .tokenFont(DesignTokens.FontSize.emptyTitle, .semibold)
                .tracking(DesignTokens.Tracking.tight * DesignTokens.FontSize.emptyTitle)
                .foregroundStyle(Theme.C.ink)
                .accessibilityAddTraits(.isHeader)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 8)
            if let name = coordinator.store.pairedName, !name.isEmpty {
                Text(name)
                    .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.bottom, 28)
            } else {
                Spacer().frame(height: 28)
            }
            VStack(spacing: 12) {
                Button {
                    Task { await coordinator.signIn() }
                } label: {
                    Text(isSigningIn ? "Signing in" : "Sign in")
                        .tokenFont(DesignTokens.FontSize.button, .semibold)
                        .foregroundStyle(signInEnabled ? Theme.C.brandInk : Theme.C.inkFaint)
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .disabled(!signInEnabled)
                .buttonStyle(PressedScale(
                    fill: signInEnabled ? Theme.C.brand : Theme.C.sunken,
                    pressedFill: signInEnabled ? Theme.C.accentStrong : Theme.C.sunken,
                    shadowed: signInEnabled
                ))
                .frame(minHeight: DesignTokens.Space.phoneHitTarget)
                .accessibilityIdentifier("signed-out-sign-in")
                .ubFocusRing()
                // Disabled reason sits directly under the control it
                // disables (the §1.0 recipe), not above the button stack.
                reasonLine

                Button {
                    Task {
                        let verdict = await OwnerGate.evaluate(reason: "Unpair this iPhone")
                        guard verdict == .approved else {
                            gateUnavailable = verdict == .unavailable
                            return
                        }
                        await coordinator.unpair()
                    }
                } label: {
                    Text("Unpair")
                        .tokenFont(DesignTokens.FontSize.button, .semibold)
                        .foregroundStyle(isSigningIn ? Theme.C.inkFaint : Theme.C.ink)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(
                            Theme.C.sunken,
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                                .strokeBorder(Theme.C.edge, lineWidth: 1)
                        )
                }
                // The exchange and the wipe must not interleave (the
                // coordinator's generation guard is the backstop).
                .disabled(isSigningIn)
                .buttonStyle(PressedScale())
                .frame(minHeight: DesignTokens.Space.phoneHitTarget)
                .ubFocusRing()
                if gateUnavailable {
                    Text(OwnerGate.unavailableCopy)
                        .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                        .foregroundStyle(Theme.C.danger)
                        .multilineTextAlignment(.center)
                }
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, DesignTokens.Space.phoneGutter)
        .background(Theme.C.surface)
    }

    @ViewBuilder
    private var reasonLine: some View {
        if isOffline {
            // A disabled reason, not an error — inkMuted per the §1.0 recipe.
            Text("You're offline")
                .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                .foregroundStyle(Theme.C.inkMuted)
                .accessibilityIdentifier("signed-out-reason")
        } else if case .failed(let message) = coordinator.phase {
            Text(message)
                .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                .foregroundStyle(Theme.C.danger)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("signed-out-reason")
        }
    }
}

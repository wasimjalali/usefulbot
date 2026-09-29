import SwiftUI
import UsefulBotCore

/// Manual entry, pushed inside the pairing screen (design spec 1.1): host
/// field, masked token field, Connect disabled until both hold text. The
/// endpoint validation and the request itself are PR-2; this is the anatomy.
struct ManualPairingView: View {
    @EnvironmentObject private var coordinator: PairingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var token = ""
    @FocusState private var focusedField: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Scrolled so accessibility type sizes reflow rather than truncate
        // (A.7); at ordinary sizes the column still fills the screen and
        // pins Connect at `sheetInset` + the safe area.
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 16) {
                    field("Mac address", text: $address, keyboard: .URL, secure: false)
                    field("Pairing token", text: $token, keyboard: .default, secure: true)
                    Spacer(minLength: DesignTokens.Space.phoneGutter)
                    connectButton
                }
                .padding(.top, 24)
                .padding(.horizontal, DesignTokens.Space.phoneGutter)
                .padding(.bottom, DesignTokens.Space.sheetInset)
                .frame(minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.C.surface)
        .navigationTitle("Enter manually")
        .navigationBarTitleDisplayMode(.inline)
        // Pairing succeeded underneath the sheet: close it; the root swap to
        // the Bots list happens on the state change.
        .onChange(of: coordinator.store.state) { _, state in
            if state == .paired { dismiss() }
        }
    }

    private func field(
        _ label: String,
        text: Binding<String>,
        keyboard: UIKeyboardType,
        secure: Bool
    ) -> some View {
        // The prompt carries the placeholder; `inkFaintText` is the token
        // that survives contrast on `sunken` in both appearances.
        let prompt = Text(label).foregroundStyle(Theme.C.inkFaintText)
        return Group {
            if secure {
                SecureField(label, text: text, prompt: prompt)
                    // A pairing token is one-shot, not a login password —
                    // oneTimeCode keeps Keychain from offering "Save
                    // Password?" (and AutoFill from offering credentials).
                    .textContentType(.oneTimeCode)
            } else {
                TextField(label, text: text, prompt: prompt)
                    .keyboardType(keyboard)
            }
        }
        .tokenFont(DesignTokens.FontSize.phoneFieldInput, .regular)
        .foregroundStyle(Theme.C.ink)
        .focused($focusedField, equals: label)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 14)
        .frame(minHeight: DesignTokens.Control.phoneFieldMinHeight)
        .background(
            Theme.C.sunken,
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
        )
        .overlay(
            // Focused field: `ink` edge plus a 3 pt ring at 8% (design spec).
            ZStack {
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                    .strokeBorder(focusedField == label ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
                if focusedField == label {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.md + 3, style: .continuous)
                        .strokeBorder(Theme.C.ink.opacity(0.08), lineWidth: 3)
                        .padding(-4)
                }
            }
        )
        .animation(
            reduceMotion
                ? nil
                : .timingCurve(0.22, 1, 0.36, 1, duration: DesignTokens.Motion.fast),
            value: focusedField
        )
    }

    private var connectButton: some View {
        let filled = !address.isEmpty && !token.isEmpty
        let online = coordinator.monitor.isOnline
        // Busy means connecting *or* the connected hold — a tap mid-hold
        // would race a second pair against the first attempt's retire.
        let connecting: Bool = {
            switch coordinator.phase {
            case .connecting, .connected: return true
            case .idle, .failed: return false
            }
        }()
        let enabled = filled && online && !connecting
        return VStack(spacing: 8) {
            Button {
                Task { await coordinator.pairManually(host: address, token: token) }
            } label: {
                Text(connecting ? "Connecting" : "Connect")
                    .tokenFont(DesignTokens.FontSize.button, .semibold)
                    .foregroundStyle(enabled ? Theme.C.brandInk : Theme.C.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .disabled(!enabled)
            .buttonStyle(PressedScale(
                fill: enabled ? Theme.C.brand : Theme.C.sunken,
                pressedFill: enabled ? Theme.C.accentStrong : Theme.C.sunken,
                shadowed: enabled
            ))
            .accessibilityIdentifier("manual-connect")
            .ubFocusRing()
            // A failed attempt's message sits in the reason slot under the
            // button — inline, never a floating overlay that could paint
            // over the control (design spec 1.1's error row is a `danger`
            // status line). The error reason rides the coordinator's phase
            // so this line and the pairing screen's status line never
            // disagree.
            if case .failed(let message) = coordinator.phase {
                Text(message)
                    .tokenFont(DesignTokens.FontSize.attachError, .regular)
                    .foregroundStyle(Theme.C.danger)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !enabled {
                // Disabled-with-reason (design spec 1.1): inkMuted, never
                // danger — nothing failed.
                Text(reason(online: online, connecting: connecting, filled: filled))
                    .tokenFont(DesignTokens.FontSize.attachError, .regular)
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func reason(online: Bool, connecting: Bool, filled: Bool) -> String {
        if connecting { return "Connecting to your Mac" }
        if !online { return "You're offline" }
        return "Enter the Mac address and pairing token."
    }
}


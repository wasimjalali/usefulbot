import SwiftUI
import UsefulBotCore
import AVFoundation

/// The pairing screen (design spec 1.1), wired for real: badge, title,
/// scanner square with the live camera feed, status line, numbered steps,
/// manual entry. States: empty, loading (frozen scanner + "Connecting to
/// your Mac"), success ("Connected to <name>", dismiss into the Bots list
/// after 600 ms), error (danger status line with the exact spec copy),
/// camera-denied (sunken block + inline manual fields), credentialInvalid
/// ("Pair again" + Unpair), offline ("You're offline", scanning paused).
struct PairingView: View {
    /// `pushedFlow` is Devices' "Re-pair" push — there the nav bar stays up
    /// so the back chevron is the exit affordance the root flow lacks
    /// (design 1.1's anatomy has no navigation chrome at all).
    private let pushedFlow: Bool
    @EnvironmentObject private var coordinator: PairingCoordinator
    @Environment(\.sizeCategory) private var sizeCategory
    @State private var cameraStatus: AVAuthorizationStatus = CameraAccess.status()
    @State private var showManual = false
    @State private var gateUnavailable = false

    init(pushedFlow: Bool = false) {
        self.pushedFlow = pushedFlow
    }

    private var isInvalid: Bool {
        coordinator.store.state == .credentialInvalid
    }

    private var isOffline: Bool {
        !coordinator.monitor.isOnline
    }

    /// Denied or restricted: the scanner square becomes the sunken block and
    /// the manual fields come inline (design spec 1.1).
    private var cameraDenied: Bool {
        cameraStatus == .denied || cameraStatus == .restricted
    }

    /// Busy through the 600 ms connected hold too: a second scan mid-hold
    /// would re-enter `connect()` while the first attempt still owns the
    /// Keychain writes (the coordinator also refuses re-entry itself).
    private var connectBusy: Bool {
        switch coordinator.phase {
        case .connecting, .connected: return true
        case .idle, .failed: return false
        }
    }

    var body: some View {
        GeometryReader { proxy in
            // The square keeps its 300 pt cap until the column outgrows the
            // screen: the full column measures ~740 pt with a 300 pt scanner,
            // so below that it shrinks to 200 to keep the footer button on
            // screen (the SE's 667 pt is the narrow case), and accessibility
            // type sizes pin the same 200 pt floor (design spec 1.1).
            // (ViewThatFits would instantiate every variant, leaving ghost
            // fields in the accessibility tree, so the cap is picked once.)
            let cap: CGFloat = sizeCategory.isAccessibilityCategory
                ? 200
                : (proxy.size.height >= 740 ? 300 : 200)
            ScrollView {
                column(in: proxy, scannerCap: cap)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Theme.C.surface)
        .toolbar(pushedFlow ? .visible : .hidden, for: .navigationBar)
        .task {
            if cameraStatus == .notDetermined {
                cameraStatus = await CameraAccess.request()
            }
        }
        // Manual entry pushes inside this screen (design spec 1.1); the back
        // chevron replaces sheet chrome.
        .navigationDestination(isPresented: $showManual) {
            ManualPairingView()
        }
    }

    private func column(in proxy: GeometryProxy, scannerCap: CGFloat) -> some View {
        VStack(spacing: 0) {
            badge
            title
            scanner(in: proxy, cap: scannerCap)
            statusLine
            if cameraDenied {
                manualFields
            } else {
                steps
            }
            Spacer(minLength: DesignTokens.Space.phoneGutter)
            footer
        }
        .padding(.top, 32)
        .padding(.horizontal, DesignTokens.Space.phoneGutter)
        .padding(.bottom, DesignTokens.Space.sheetInset)
    }

    private var badge: some View {
        Image("useful-bot-badge")
            .resizable()
            .frame(width: 56, height: 56)
            .clipShape(Circle())
            .padding(.bottom, 20)
            .accessibilityLabel("Useful Bot")
    }

    private var title: some View {
        VStack(spacing: 8) {
            Text(isInvalid ? "Pair again" : "Connect to your Mac")
                .tokenFont(DesignTokens.FontSize.emptyTitle, .semibold)
                .tracking(DesignTokens.Tracking.tight * DesignTokens.FontSize.emptyTitle)
                .foregroundStyle(Theme.C.ink)
                .accessibilityAddTraits(.isHeader)
                // A.7: never truncate; at accessibility sizes the title
                // reflows onto as many lines as it needs inside the scroll.
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Your bots run on your Mac. This iPhone connects to it over Tailscale.")
                .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                .foregroundStyle(Theme.C.inkMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 28)
    }

    private func scanner(in proxy: GeometryProxy, cap: CGFloat) -> some View {
        // Full gutter width, square, capped at 300; the Dynamic Type floor is
        // 200 so the area never collapses.
        let guttered = proxy.size.width - 2 * DesignTokens.Space.phoneGutter
        let side = max(200, min(guttered, cap))
        return Group {
            if cameraDenied {
                // Camera denied: the square becomes a sunken block with the
                // reason and the settings escape (design spec 1.1). The block
                // keeps the square as its minimum but grows past it — wider
                // too, so grown button copy never breaks mid-word — to fit
                // the copy at accessibility sizes (A.7). On a height under
                // the full column (~740 pt) — or on the credential-invalid
                // root, whose extra Unpair tertiary needs the room — it
                // shrinks to its content so the controls stay on screen —
                // the same rule the scanner cap applies to the live preview.
                deniedBlock
                    .padding(16)
                    .frame(minWidth: side, minHeight: proxy.size.height >= 740 && !isInvalid ? side : 0)
            } else {
                QRScannerView(paused: connectBusy || isOffline) { scanned in
                    Task { await coordinator.pair(scanned: scanned) }
                }
                .frame(width: side, height: side)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xl, style: .continuous)
                .fill(Theme.C.sunken)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xl, style: .continuous))
        .overlay(
            ScannerGuides(cornerRadius: DesignTokens.Radius.xl, arm: 28, inset: 10)
                .stroke(Theme.C.scannerGuide, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .allowsHitTesting(false)
        )
        .frame(maxWidth: .infinity)
        .padding(.bottom, 16)
        // Denied keeps its children in the tree: the Open Settings button is
        // the only recovery and .ignore would swallow it. The live preview
        // collapses to one labeled element instead.
        .accessibilityElement(children: cameraDenied ? .contain : .ignore)
        .accessibilityLabel("Camera preview for scanning the pairing code")
    }

    /// The sunken block in place of the preview when the camera is denied
    /// (design spec 1.1): the reason plus the settings escape.
    private var deniedBlock: some View {
        VStack(spacing: 12) {
            Text("Camera access is off")
                .tokenFont(DesignTokens.FontSize.emptyBody, .medium)
                .foregroundStyle(Theme.C.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .tokenFont(DesignTokens.FontSize.button, .semibold)
                    .foregroundStyle(Theme.C.ink)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .background(Theme.C.surface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .ubFocusRing()
        }
    }

    /// The status line: one of empty/loading/success/error/credentialInvalid/
    /// offline, all in the spec's exact copy.
    private var statusLine: some View {
        let (text, color) = statusCopy
        return Text(text)
            .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
            .foregroundStyle(color)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 12)
            .accessibilityIdentifier("pairing-status")
    }

    private var statusCopy: (String, Color) {
        if isOffline {
            // Offline is a Disabled state, not a failure — the status line
            // stays inkMuted; `danger` belongs to the Error row alone.
            return ("You're offline", Theme.C.inkMuted)
        }
        switch coordinator.phase {
        case .connecting:
            return ("Connecting to your Mac", Theme.C.inkMuted)
        case .connected(let name):
            return ("Connected to \(name)", Theme.C.success)
        case .failed(let message):
            return (message, Theme.C.danger)
        case .idle:
            if isInvalid {
                return (
                    "This pairing was revoked or expired. Scan a new code from your Mac.",
                    Theme.C.danger
                )
            }
            if cameraDenied {
                // The denied block above already carries the reason; a second
                // line of camera copy would just argue with it.
                return ("", Theme.C.inkMuted)
            }
            return ("Point the camera at the code on your Mac", Theme.C.inkMuted)
        }
    }

    /// Camera denied: the manual fields sit inline below the sunken block,
    /// no extra tap (design spec 1.1).
    private var manualFields: some View {
        ManualPairingForm()
            .padding(.top, 4)
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            step(1, "On your Mac, open Settings, then Devices.")
            step(2, "Choose Show pairing QR.")
            step(3, "Scan the code.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func step(_ number: Int, _ copy: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(number).")
                .tokenFont(DesignTokens.FontSize.emptyBody, .medium)
                .foregroundStyle(Theme.C.inkMuted)
            Text(copy)
                .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                .foregroundStyle(Theme.C.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        // "1. On your Mac, ..." is one step, not two stops.
        .accessibilityElement(children: .combine)
    }

    /// "Enter manually" — or, in `credentialInvalid`, the tertiary "Unpair"
    /// text button alongside it (class A; the gate runs in the coordinator).
    private var footer: some View {
        let manualEnabled = !connectBusy && !isOffline
        return VStack(spacing: 8) {
            // Denied shows the fields inline ("no extra tap") — pushing the
            // same form would be redundant.
            if !cameraDenied {
                Button { showManual = true } label: {
                    Text("Enter manually")
                        .tokenFont(DesignTokens.FontSize.button, .semibold)
                        .foregroundStyle(manualEnabled ? Theme.C.ink : Theme.C.inkFaint)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                                .strokeBorder(Theme.C.edge, lineWidth: 1)
                        )
                }
                .buttonStyle(PressedScale())
                .disabled(!manualEnabled)
                .frame(minHeight: DesignTokens.Space.phoneHitTarget)
                .ubFocusRing()
                if !manualEnabled {
                    // Design spec 1.1: disabled with the reason, in inkMuted.
                    // During the connected hold the status line already says
                    // "Connected to <name>" — no second line argues with it.
                    Text(isOffline ? "You're offline" : (coordinator.phase == .connecting ? "Connecting to your Mac" : ""))
                        .tokenFont(DesignTokens.FontSize.attachError, .regular)
                        .foregroundStyle(Theme.C.inkMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if isInvalid {
                Button {
                    Task {
                        // Class A: the biometric prompt is the confirmation.
                        let verdict = await OwnerGate.evaluate(reason: "Unpair this iPhone")
                        guard verdict == .approved else {
                            gateUnavailable = verdict == .unavailable
                            return
                        }
                        await coordinator.unpair()
                    }
                } label: {
                    Text("Unpair")
                        .tokenFont(DesignTokens.FontSize.button, .regular)
                        .foregroundStyle(connectBusy ? Theme.C.inkFaint : Theme.C.inkMuted)
                }
                // A connect in flight owns the exchange — the wipe waits for
                // it (the coordinator's generation guard is the backstop).
                .disabled(connectBusy)
                .frame(minHeight: 44)
                .ubFocusRing()
                if gateUnavailable {
                    Text(OwnerGate.unavailableCopy)
                        .tokenFont(DesignTokens.FontSize.emptyBody, .regular)
                        .foregroundStyle(Theme.C.danger)
                        .multilineTextAlignment(.center)
                }
            }
        }
    }
}

/// The inline manual fields used by the camera-denied state — the same two
/// fields as the pushed manual screen, without its page chrome.
private struct ManualPairingForm: View {
    @EnvironmentObject private var coordinator: PairingCoordinator
    @State private var address = ""
    @State private var token = ""
    @FocusState private var focusedField: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 16) {
            field("Mac address", text: $address, secure: false)
            field("Pairing token", text: $token, secure: true)
            let online = coordinator.monitor.isOnline
            // Busy means connecting *or* the connected hold — a tap mid-hold
            // races a second pair against the first attempt's retire.
            let connecting: Bool = {
                switch coordinator.phase {
                case .connecting, .connected: return true
                case .idle, .failed: return false
                }
            }()
            let enabled = !address.isEmpty && !token.isEmpty && online && !connecting
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
            if !enabled {
                // Disabled-with-reason (design spec 1.1): the reason sits
                // under the button in inkMuted, never danger — nothing failed.
                Text(reason(online: online, connecting: connecting,
                            filled: !address.isEmpty && !token.isEmpty))
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

    private func field(_ label: String, text: Binding<String>, secure: Bool) -> some View {
        let prompt = Text(label).foregroundStyle(Theme.C.inkFaintText)
        return Group {
            if secure {
                SecureField(label, text: text, prompt: prompt)
                    // oneTimeCode keeps Keychain from offering "Save
                    // Password?" over the field — the token is one-shot
                    // and the alert steals first responder mid-typing.
                    .textContentType(.oneTimeCode)
            } else {
                TextField(label, text: text, prompt: prompt)
                    .keyboardType(.URL)
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
            // Focused field: `ink` edge plus a 3 pt ring at 8% — the same
            // treatment the pushed manual screen's fields get.
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
}

/// The four viewfinder corners over the scanner square: a quarter-arc elbow on
/// the square's corner radius with straight arms continuing along both edges.
private struct ScannerGuides: Shape {
    var cornerRadius: CGFloat
    var arm: CGFloat
    var inset: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let r = max(cornerRadius - inset, 0)
        let bounds = rect.insetBy(dx: inset, dy: inset)
        let corners: [(CGPoint, Angle, Angle)] = [
            // (arc center, start angle, end angle), then the two arm directions
            (CGPoint(x: bounds.minX + r, y: bounds.minY + r), .degrees(180), .degrees(270)),
            (CGPoint(x: bounds.maxX - r, y: bounds.minY + r), .degrees(270), .degrees(360)),
            (CGPoint(x: bounds.maxX - r, y: bounds.maxY - r), .degrees(0), .degrees(90)),
            (CGPoint(x: bounds.minX + r, y: bounds.maxY - r), .degrees(90), .degrees(180)),
        ]
        for (center, start, end) in corners {
            // `addArc` on a non-empty path draws a straight connector to the
            // arc's start; move first so each corner stands alone.
            path.move(to: CGPoint(
                x: center.x + r * Darwin.cos(start.radians),
                y: center.y + r * Darwin.sin(start.radians)
            ))
            path.addArc(center: center, radius: r, startAngle: start, endAngle: end, clockwise: false)
            // Each arc endpoint lies on one edge: an endpoint on a vertical
            // edge grows a vertical arm toward the midline, an endpoint on a
            // horizontal one grows a horizontal one. Which endpoint sits on
            // which edge differs per corner, so derive it from the point.
            for angle in [start, end] {
                let point = CGPoint(
                    x: center.x + r * Darwin.cos(angle.radians),
                    y: center.y + r * Darwin.sin(angle.radians)
                )
                let onVerticalEdge =
                    abs(point.x - bounds.minX) < 0.5 || abs(point.x - bounds.maxX) < 0.5
                path.move(to: point)
                if onVerticalEdge {
                    path.addLine(to: CGPoint(
                        x: point.x,
                        y: point.y + (point.y < bounds.midY ? arm : -arm)
                    ))
                } else {
                    path.addLine(to: CGPoint(
                        x: point.x + (point.x < bounds.midX ? arm : -arm),
                        y: point.y
                    ))
                }
            }
        }
        return path
    }
}

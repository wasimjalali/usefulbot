import AppKit
import SwiftUI
import UsefulBotCore

enum NativeButtonKind {
    case primary
    case secondary
    case danger
    case ghost
}

private struct ButtonChrome: ButtonStyle {
    let kind: NativeButtonKind
    let small: Bool
    let hovering: Bool
    let focused: Bool
    let enabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(DesignTokens.FontSize.button, .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, small ? 12 : 14)
            .frame(minHeight: small ? DesignTokens.Control.buttonSmallMinHeight : DesignTokens.Control.buttonMinHeight)
            .background(background)
            // A primary fill carries a faint top-lit sheen, a few percent of
            // luminance, so it reads as a button rather than a flat block.
            .overlay(
                LinearGradient(
                    colors: [Theme.C.white.opacity(kind == .primary && enabled ? 0.1 : 0), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            // A tone fill alone melts into a canvas-backed group; the whisper
            // edge keeps a secondary button's shape on any ground.
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous)
                    .strokeBorder(kind == .secondary && enabled ? Theme.C.edge : .clear, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
            .shadow(
                color: enabled ? Theme.shadow(DesignTokens.Shadow.sm) : .clear,
                radius: Theme.radius(DesignTokens.Shadow.sm),
                x: 0,
                y: DesignTokens.Shadow.sm.y
            )
            .scaleEffect(configuration.isPressed && enabled ? 0.98 : 1)
            .focusRing(focused)
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: hovering)
    }

    /// One step past the resting fill in both appearances: darker in light,
    /// lighter in dark, so hover never sinks.
    private static let secondaryHover = Theme.adaptive(DesignTokens.Hex.border, DesignTokens.DarkHex.borderStrong)

    private var foreground: Color {
        // Disabled is one sunken look for every kind: flat, muted, full opacity.
        // Muted, not faint: on the sunken fill faint fell under 3:1 and a
        // disabled button read as a plain label.
        if !enabled { return Theme.C.inkMuted }
        switch kind {
        case .primary: return Theme.C.accentInk
        case .secondary: return hovering ? Theme.C.accent : Theme.C.ink
        case .danger: return Theme.C.danger
        case .ghost: return hovering ? Theme.C.accent : Theme.C.ink
        }
    }

    private var background: Color {
        if !enabled { return kind == .ghost ? .clear : Theme.C.sunken }
        switch kind {
        case .primary: return hovering && enabled ? Theme.C.accentStrong : Theme.C.accent
        case .secondary: return hovering && enabled ? Self.secondaryHover : Theme.C.sunken
        case .danger: return Theme.C.dangerSoft
        case .ghost: return hovering && enabled ? Theme.C.accentSoft : .clear
        }
    }
}

struct NativeButton<Label: View>: View {
    var kind: NativeButtonKind = .secondary
    var small = false
    var enabled = true
    var action: () -> Void
    @ViewBuilder var label: Label

    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) { label }
            .buttonStyle(ButtonChrome(
                kind: kind,
                small: small,
                hovering: hovering,
                focused: focused,
                enabled: enabled
            ))
            .disabled(!enabled)
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onHover { hovering = $0 }
            .pointerOnHover()
    }
}

extension NativeButton where Label == Text {
    init(
        _ title: String,
        kind: NativeButtonKind = .secondary,
        small: Bool = false,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.init(kind: kind, small: small, enabled: enabled, action: action) {
            Text(title)
        }
    }
}

extension NativeButton where Label == AnyView {
    init(
        _ title: String,
        systemImage: String? = nil,
        kind: NativeButtonKind = .secondary,
        small: Bool = false,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.init(kind: kind, small: small, enabled: enabled, action: action) {
            AnyView(
                HStack(spacing: 8) {
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 12, weight: .regular))
                    }
                    Text(title)
                }
            )
        }
    }
}

/// OpenAI's "Continue with ChatGPT" button: the OpenAI mark and the label on
/// black in light appearance, on white in dark. Sized like a primary
/// `NativeButton`.
struct ContinueWithChatGPTButton: View {
    var enabled = true
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var ink: Color { colorScheme == .dark ? .black : .white }
    private var fill: Color { colorScheme == .dark ? .white : .black }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let image = ProviderMarkImage.load("openai") {
                    Image(nsImage: image)
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 16, height: 16)
                }
                Text("Continue with ChatGPT")
            }
            .font(Theme.font(DesignTokens.FontSize.button, .semibold))
            .foregroundStyle(enabled ? ink : Theme.C.inkMuted)
            .padding(.horizontal, 14)
            .frame(minHeight: DesignTokens.Control.buttonMinHeight)
            .background(enabled ? fill.opacity(hovering ? 0.85 : 1) : Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .focusRing(focused)
        .onHover { hovering = $0 }
        .pointerOnHover()
        .accessibilityLabel("Continue with ChatGPT")
        .accessibilityIdentifier("continue-with-chatgpt")
    }
}

/// "Use a different account": a menu of the other saved ChatGPT accounts plus
/// "Add another account", or a plain button when there are no others.
struct UseDifferentAccountControl: View {
    let accounts: [SavedChatGptAccount]
    /// The client this attempt uses, left out of the list.
    let currentClientId: String?
    /// After a mismatch or unknown-account error the control shows even with no other account.
    var afterError = false
    var kind: NativeButtonKind = .ghost
    let onPick: (String) -> Void
    let onAddNew: () -> Void

    private var others: [SavedChatGptAccount] {
        accounts.filter { $0.clientId != currentClientId }
    }

    var body: some View {
        // A fresh registration has nothing to switch from. An attempt on a
        // saved client always keeps a way out to another account.
        if others.isEmpty, !afterError, currentClientId == nil {
            EmptyView()
        } else if others.isEmpty {
            NativeButton("Use a different account", kind: kind, small: true, action: onAddNew)
                .accessibilityIdentifier("use-different-account")
        } else {
            Menu {
                ForEach(others, id: \.clientId) { account in
                    Button(account.label) { onPick(account.clientId) }
                }
                Divider()
                Button("Add another account", action: onAddNew)
            } label: {
                HStack(spacing: 4) {
                    Text("Use a different account")
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                }
                .font(Theme.font(DesignTokens.FontSize.button, .semibold))
                .foregroundStyle(Theme.C.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: DesignTokens.Control.buttonSmallMinHeight)
                .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .pointerOnHover()
            .accessibilityIdentifier("use-different-account")
        }
    }
}

/// `.icon-btn`: 10pt radius, muted ink, accent-soft hover, 32pt default.
struct NativeIconButton: View {
    let systemImage: String
    var size: CGFloat = DesignTokens.Control.iconButton
    var iconSize: CGFloat = 14
    var action: () -> Void

    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: iconSize, weight: .regular))
                .foregroundStyle(hovering ? Theme.C.accent : Theme.C.inkMuted)
                .frame(width: size, height: size)
                .background(hovering ? Theme.C.accentSoft : .clear)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.iconButton, style: .continuous))
        }
        .buttonStyle(.plain)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .focusRing(focused)
        .onHover { hovering = $0 }
        .pointerOnHover()
    }
}

/// Non-interactive switch track for rows that toggle on their own.
struct SwitchVisual: View {
    let isOn: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule()
                .fill(isOn ? Theme.C.accent : Theme.C.borderStrong)
                .frame(width: DesignTokens.Control.switchWidth, height: DesignTokens.Control.switchHeight)
            Circle()
                .fill(Theme.C.surface)
                .frame(width: DesignTokens.Control.switchKnob, height: DesignTokens.Control.switchKnob)
                .offset(x: isOn ? DesignTokens.Control.switchTravel : 0)
                .padding(.leading, 3)
        }
        .animation(.easeOut(duration: DesignTokens.Motion.fast), value: isOn)
        .accessibilityHidden(true)
    }
}

/// `.switch`: 36x22 track, 16pt knob, accent-on.
struct NativeSwitch: View {
    let isOn: Bool
    var action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(isOn ? Theme.C.accent : Theme.C.borderStrong)
                    .frame(width: DesignTokens.Control.switchWidth, height: DesignTokens.Control.switchHeight)
                Circle()
                    .fill(Theme.C.surface)
                    .frame(width: DesignTokens.Control.switchKnob, height: DesignTokens.Control.switchKnob)
                    .shadow(color: Theme.shadow(DesignTokens.Shadow.sm), radius: Theme.radius(DesignTokens.Shadow.sm), x: 0, y: DesignTokens.Shadow.sm.y)
                    .offset(x: isOn ? DesignTokens.Control.switchTravel : 0)
                    .padding(.leading, 3)
            }
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: isOn)
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// `.bot-label`: 10pt uppercase chip on the sunken surface. The web caps it at
/// 72px with an ellipsis; measuring here keeps the chip at its natural size so
/// the bot name is what truncates, exactly like the flex row on the web.
struct BotLabelChip: View {
    let text: String
    /// Pickers have room: show the whole label instead of the 84 pt cap.
    var fitsFully = false

    /// The web caps the chip at 72px in Geist; SF Pro runs wider, so the cap
    /// is raised just enough that a ten-letter chip like "RESEARCHER" still
    /// fits whole while longer labels clip at the same visual size.
    private static let maxWidth: CGFloat = 84

    private var chipWidth: CGFloat {
        let font = NSFont.systemFont(ofSize: DesignTokens.FontSize.railLabel, weight: .semibold)
        let tracked = NSMutableParagraphStyle()
        tracked.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .kern: 0.02 * DesignTokens.FontSize.railLabel,
        ]
        let measured = NSAttributedString(string: text.uppercased(), attributes: attributes).size().width
        // Whole in a picker, but never so wide that a long role pushes the
        // bot's own name out of its row.
        return min(ceil(measured) + 13, fitsFully ? 160 : Self.maxWidth)
    }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: DesignTokens.FontSize.railLabel, weight: .semibold))
            .tracking(0.02 * DesignTokens.FontSize.railLabel)
            .foregroundStyle(Theme.C.inkMuted)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.action, style: .continuous))
            .frame(width: chipWidth, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
    }
}

/// `.section-toggle` header: 11pt uppercase, tracked, faint ink.
struct SectionHeader: View {
    let title: String
    let collapsed: Bool
    let onToggle: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
                // Sentence case, as the section was named: a quiet label,
                // not an all-caps eyebrow.
                Text(title)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(hovering ? Theme.C.inkMuted : Theme.C.inkFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}

/// `.field`: 13pt medium label above the control, 13pt danger error under it.
struct FieldShell<Content: View>: View {
    let label: String
    var error: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: DesignTokens.FontSize.fieldLabel, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            content
            if let error, !error.isEmpty {
                Text(error)
                    .font(.system(size: DesignTokens.FontSize.fieldLabel))
                    .foregroundStyle(Theme.C.danger)
            }
        }
    }
}

/// `.field-input`: 12pt radius, strong hairline, ink focus border with a soft
/// 3px ring, matching the web's focus-within treatment.
struct NativeFieldStyle: ViewModifier {
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.system(size: DesignTokens.FontSize.fieldInput))
            .foregroundStyle(Theme.C.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: DesignTokens.Control.fieldMinHeight)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                    .strokeBorder(focused ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
            .shadow(color: focused ? Theme.C.ink.opacity(0.08) : .clear, radius: 1.5, x: 0, y: 0)
    }
}

extension View {
    func nativeField(focused: Bool) -> some View {
        modifier(NativeFieldStyle(focused: focused))
    }
}

/// A drawn segmented control: a tone track with a lifted surface pill under
/// the picked option. The system picker fills the pick with the OS accent
/// colour, which breaks the monochrome brand. The pill glides between options.
struct ToneSegmented<Item: Hashable>: View {
    let items: [Item]
    @Binding var selection: Item
    var height: CGFloat = 30
    var accessibilityLabel: String
    let label: (Item) -> AnyView
    let name: (Item) -> String

    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.self) { item in
                let picked = item == selection
                Button {
                    withAnimation(reduceMotion ? nil : Theme.ease(0.22)) { selection = item }
                } label: {
                    label(item)
                        .foregroundStyle(picked ? Theme.C.ink : Theme.C.inkMuted)
                        .frame(maxWidth: .infinity)
                        .frame(height: height - 4)
                        .background { Color.clear.matchedGeometryEffect(id: item, in: pill, isSource: true) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .accessibilityLabel(name(item))
                .accessibilityAddTraits(picked ? [.isSelected] : [])
            }
        }
        // The pill sits under every label and glides to the picked one.
        .background {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                .fill(Self.pillFill)
                .shadow(color: Theme.C.shadow.opacity(0.08), radius: 2, x: 0, y: 1)
                .matchedGeometryEffect(id: selection, in: pill, isSource: false)
        }
        .padding(2)
        .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    /// Lighter than the track in both appearances.
    private static var pillFill: Color { Theme.adaptive(DesignTokens.Hex.surface, "#3A3A3A") }
}

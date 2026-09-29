import SwiftUI
import UsefulBotCore

/// The web button press: scale 0.98 plus one tone step, for `Motion.fast`,
/// on the shared motion curve. iOS has no hover; pressed is the only
/// transient state. Under Reduce Motion the tone step stays and the scale
/// drop does not.
struct PressedScale: ButtonStyle {
    var cornerRadius: CGFloat = DesignTokens.Radius.md
    /// Set when the pressed state needs a different fill, not an overlay:
    /// `brand`/`accent` fills step to `accentStrong` on press (the macOS
    /// precedent) because `ink == accent` makes an ink overlay composite to
    /// the identical color. With `fill` nil the ink tone step overlays.
    var fill: Color? = nil
    var pressedFill: Color? = nil
    /// Primary buttons carry the `sm` shadow; disabled ones drop it.
    var shadowed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                if let fill {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(configuration.isPressed ? (pressedFill ?? fill) : fill)
                }
            }
            .shadow(
                color: shadowed ? Theme.shadow(DesignTokens.Shadow.sm) : .clear,
                radius: shadowed ? Theme.radius(DesignTokens.Shadow.sm) : 0,
                x: 0,
                y: shadowed ? DesignTokens.Shadow.sm.y : 0
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Theme.C.ink.opacity(
                        pressedFill == nil && configuration.isPressed ? 0.08 : 0))
                    .allowsHitTesting(false)
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(
                reduceMotion
                    ? nil
                    : .timingCurve(0.22, 1, 0.36, 1, duration: DesignTokens.Motion.fast),
                value: configuration.isPressed
            )
    }
}

/// A token font that still responds to Dynamic Type: `.system(size:)` alone
/// is fixed, so the size rides through `ScaledMetric` on the `.body` curve.
private struct ScaledTokenFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight) {
        // Each token rides the text style nearest its point size: body-scale
        // on a 28 pt title overscales it past 3x at accessibilityXXXL, while
        // larger styles' curves grow more gently, matching the web tokens.
        _size = ScaledMetric(wrappedValue: size, relativeTo: Self.style(for: size))
        self.weight = weight
    }

    // Style sizes are 11/12/13/15/16/17/20/22/28/34; the nearest style for a
    // token size is decided at the midpoint between neighbors.
    private static func style(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<11.5: return .caption2
        case ..<12.5: return .caption
        case ..<14: return .footnote
        case ..<15.5: return .subheadline
        case ..<16.5: return .callout
        case ..<18.5: return .body
        case ..<21: return .title3
        case ..<25: return .title2
        case ..<31: return .title
        default: return .largeTitle
        }
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight))
    }
}

/// §1.0 Focus-visible: a 2 pt `accent` ring offset 2 pt with `Radius.xs`
/// corners, drawn only while the control holds keyboard focus (external
/// keyboard / Full Keyboard Access) — focus never lands on touch, so taps
/// never see it. The `\.isFocused` environment reads the nearest focusable
/// ANCESTOR, which a plain overlay can never satisfy; `.focused` binds the
/// wrapped control's own focus instead.
private struct FocusRing: ViewModifier {
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focused($focused)
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                        .strokeBorder(Theme.C.accent, lineWidth: 2)
                        .padding(-4)
                }
            }
    }
}

extension View {
    /// The keyboard-focus ring (§1.0 Focus-visible baseline). Buttons are
    /// already focusable; plain views need `.focusable()` first.
    func ubFocusRing() -> some View {
        modifier(FocusRing())
    }

    /// The token's font, scaled by Dynamic Type. Text uses this; fixed-point
    /// chrome uses `Theme.font` directly.
    func tokenFont(_ size: CGFloat, _ token: FontWeightToken) -> some View {
        modifier(ScaledTokenFont(size: size, weight: Theme.weight(token)))
    }

    /// One level off the page: a whisper of an edge and the spec's `lift`
    /// shadow (§4.3: 0.5/1 @4% + 3/16 @8%) for bubbles, pinned/approval/
    /// status cards and banners — the macOS `cardLift` recipe, ported
    /// (SwiftUI radius reads half the CSS blur).
    func cardLift(cornerRadius: CGFloat) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .shadow(color: Theme.C.shadow.opacity(0.04), radius: 0.5, x: 0, y: 0.5)
        .shadow(color: Theme.C.shadow.opacity(0.08), radius: 8, x: 0, y: 3)
    }
}

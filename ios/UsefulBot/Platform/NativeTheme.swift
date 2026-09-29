import SwiftUI
import UIKit
import UsefulBotCore

/// The Useful Brain token set (`DesignTokens`), mapped to SwiftUI on
/// the phone. Every color resolves per appearance through
/// `UIColor(dynamicProvider:)`: the light hex from `DesignTokens.Hex`, the
/// dark one from `DesignTokens.DarkHex`.
enum Theme {
    static func color(_ hex: String) -> Color {
        Color(uiColor: uiColor(hex))
    }

    static func uiColor(_ hex: String) -> UIColor {
        guard let rgb = RGBColor(hex: hex) else { return .black }
        return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }

    /// One token, resolved against the drawing view's appearance.
    static func adaptive(_ light: String, _ dark: String) -> Color {
        let lightColor = uiColor(light)
        let darkColor = uiColor(dark)
        return Color(uiColor: UIColor(dynamicProvider: { traits in
            traits.userInterfaceStyle == .dark ? darkColor : lightColor
        }))
    }

    private typealias L = DesignTokens.Hex
    private typealias D = DesignTokens.DarkHex

    enum C {
        static let canvas = adaptive(L.canvas, D.canvas)
        static let rail = adaptive(L.rail, D.rail)
        static let surface = adaptive(L.surface, D.surface)
        static let sunken = adaptive(L.sunken, D.sunken)
        static let bubbleBot = adaptive(L.bubbleBot, D.bubbleBot)
        static let ink = adaptive(L.ink, D.ink)
        static let inkMuted = adaptive(L.inkMuted, D.inkMuted)
        static let inkFaint = adaptive(L.inkFaint, D.inkFaint)
        static let inkFaintText = adaptive(L.inkFaintText, D.inkFaintText)
        static let brand = adaptive(L.brand, D.brand)
        static let brandInk = adaptive(L.brandInk, D.brandInk)
        static let accent = adaptive(L.accent, D.accent)
        static let accentStrong = adaptive(L.accentStrong, D.accentStrong)
        static let accentSoft = adaptive(L.accentSoft, D.accentSoft)
        static let accentInk = adaptive(L.accentInk, D.accentInk)
        static let border = adaptive(L.border, D.border)
        static let borderStrong = adaptive(L.borderStrong, D.borderStrong)
        static let scrollKnob = adaptive(L.scrollKnob, D.scrollKnob)
        static let scrollKnobActive = adaptive(L.scrollKnobActive, D.scrollKnobActive)
        static let success = adaptive(L.success, D.success)
        static let successSoft = adaptive(L.successSoft, D.successSoft)
        static let warning = adaptive(L.warning, D.warning)
        static let warningSoft = adaptive(L.warningSoft, D.warningSoft)
        static let danger = adaptive(L.danger, D.danger)
        static let dangerSoft = adaptive(L.dangerSoft, D.dangerSoft)
        static let white = color(L.white)
        /// Scanner corner guides: the spec's white 80% presumes the dark
        /// camera feed; over the light `sunken` placeholder that is ~1.1:1,
        /// so light appearance takes ink at a visible strength (3:1 floor).
        static let scannerGuide = Color(uiColor: UIColor(dynamicProvider: { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 1, alpha: 0.8)
                : UIColor(white: 0, alpha: 0.5)
        }))
        /// Sheet scrim: the token's light overlay in light, `overlayDark` in
        /// dark, each at its spec opacity (design spec 4.1).
        static let overlay = Color(uiColor: UIColor(dynamicProvider: { traits in
            traits.userInterfaceStyle == .dark
                ? uiColor(D.overlayDark).withAlphaComponent(0.48)
                : uiColor(L.dialogOverlay).withAlphaComponent(0.18)
        }))
        /// A lifted card's edge: a whisper in light, where the shadow does
        /// the lifting, and a faint light rim in dark, where shadows vanish.
        static let edge = Color(uiColor: UIColor(dynamicProvider: { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 1, alpha: 0.07)
                : UIColor(white: 0, alpha: 0.05)
        }))
        /// Shadows stay dark in both appearances; an ink shadow would glow.
        static let shadow = color(L.ink)
    }

    enum R {
        static let stage = DesignTokens.Radius.stage
        static let card = DesignTokens.Radius.card
        static let field = DesignTokens.Radius.field
        static let channel = DesignTokens.Radius.channel
        static let dialog = DesignTokens.Radius.dialog
        static let settingsGroup = DesignTokens.Radius.settingsGroup
        static let composerExpanded = DesignTokens.Radius.composerExpanded

        /// The web avatar uses one radius per size class, not one ratio.
        static func avatar(_ size: CGFloat) -> CGFloat {
            switch size {
            case ..<28: return 6
            case ..<36: return 12
            case ..<56: return 16
            default: return 22
            }
        }
    }

    static func weight(_ token: FontWeightToken) -> Font.Weight {
        switch token {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        }
    }

    /// Fixed-point font, for chrome that must not respond to Dynamic Type.
    static func font(_ size: CGFloat, _ token: FontWeightToken) -> Font {
        .system(size: size, weight: weight(token))
    }

    /// SwiftUI shadow radii read roughly half of a CSS blur value.
    static func radius(_ token: DesignTokens.ShadowToken) -> CGFloat {
        max(token.blur / 2, 0.5)
    }

    static func shadow(_ token: DesignTokens.ShadowToken) -> Color {
        color(token.color).opacity(token.opacity)
    }
}

/// Which appearance the app draws in. The phone follows the system until the
/// owner overrides it in Settings; the key matches the Mac's so a choice
/// reads the same on both surfaces.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let storageKey = "ub.appearance"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

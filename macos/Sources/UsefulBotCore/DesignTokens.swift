import Foundation

/// Raw Useful Brain design tokens, first ported from the removed web UI's CSS.
/// These are the CSS authoring values; the app target maps them to SwiftUI
/// colors, fonts and metrics. These are the source of truth for both apps.
public enum DesignTokens {
    public enum Hex {
        public static let canvas = "#F3F3F3"
        public static let rail = "#F3F3F3"
        public static let surface = "#FFFFFF"
        public static let sunken = "#F0F0F0"
        /// A bot's chat bubble: white, not a gray. The chat behind it is white
        /// too, so the border and a soft shadow are what set it apart.
        public static let bubbleBot = "#FFFFFF"

        public static let ink = "#171717"
        public static let inkMuted = "#5C5C5C"
        public static let inkFaint = "#A3A3A3"
        /// Placeholders and tertiary readable text: `inkFaint` fails contrast
        /// everywhere, this one passes on every surface (design spec 4.2).
        public static let inkFaintText = "#6B6B6B"

        public static let brand = "#171717"
        public static let brandInk = "#FAFAFA"

        public static let accent = "#171717"
        public static let accentStrong = "#0A0A0A"
        public static let accentSoft = "#F0F0F0"
        public static let accentDeep = "#171717"
        public static let accentInk = "#FFFFFF"

        public static let border = "#EBEBEB"
        public static let borderStrong = "#E0E0E0"

        public static let scrollKnob = "#E3E3E3"
        public static let scrollKnobActive = "#D4D4D4"

        public static let success = "#0F6F56"
        public static let successSoft = "#E4F4EE"
        public static let warning = "#8A5300"
        public static let warningSoft = "#FBF1DE"
        public static let danger = "#B23C22"
        public static let dangerSoft = "#FBEAE5"

        public static let white = "#FFFFFF"
        public static let dialogOverlay = "#171717" // 18% opacity over content
        public static let thumbBadge = "#171717" // 72% opacity over images
    }

    /// The dark appearance. Same neutral brand, inverted: near-black
    /// surfaces a step apart in tone, light ink, and the accent flips to the
    /// light end so a primary fill still reads as the loudest thing on screen.
    public enum DarkHex {
        public static let canvas = "#0F0F0F"
        public static let rail = "#0F0F0F"
        public static let surface = "#171717"
        public static let sunken = "#2C2C2C"
        public static let bubbleBot = "#202020"

        public static let ink = "#EDEDED"
        public static let inkMuted = "#A3A3A3"
        public static let inkFaint = "#6E6E6E"
        public static let inkFaintText = "#949494"

        public static let brand = "#EDEDED"
        public static let brandInk = "#141414"

        public static let accent = "#EDEDED"
        public static let accentStrong = "#FFFFFF"
        public static let accentSoft = "#262626"
        public static let accentInk = "#141414"

        public static let border = "#262626"
        public static let borderStrong = "#333333"

        public static let scrollKnob = "#3A3A3A"
        public static let scrollKnobActive = "#4A4A4A"

        public static let success = "#4CC39B"
        public static let successSoft = "#13302A"
        public static let warning = "#E3A64A"
        public static let warningSoft = "#33260F"
        public static let danger = "#F0795C"
        public static let dangerSoft = "#3A1B14"

        /// Sheet scrim in dark, at 48% opacity. Replaces `dialogOverlay`
        /// (which stays the light-appearance scrim) per design spec 4.1.
        public static let overlayDark = "#000000"
    }

    /// One radius scale, by role. Role names below point into it.
    public enum Radius {
        /// Focus rings, tiny chips, kbd, labels.
        public static let xs: CGFloat = 6
        /// Buttons, nav items, icon buttons, menu rows.
        public static let sm: CGFloat = 10
        /// Fields, settings groups, small cards, chat bubbles.
        public static let md: CGFloat = 14
        /// Cards, dialogs, menus, popovers.
        public static let lg: CGFloat = 16
        /// The expanded composer.
        public static let xl: CGFloat = 22
        /// The main stage.
        public static let xxl: CGFloat = 24
        public static let pill: CGFloat = 999

        public static let channel = sm
        public static let iconButton = sm
        public static let field = md
        public static let stage = xxl
        public static let dialog = lg
        public static let card = lg
        public static let settingsGroup = md
        public static let composerExpanded = xl
        public static let composerCompact = pill
        public static let action = xs
    }

    public enum Space {
        public static let railWidth: CGFloat = 248
        public static let settingsPaneWidth: CGFloat = 320
        public static let stageMargin: CGFloat = 10
        public static let chatHead: CGFloat = 52
        public static let chatColumnMax: CGFloat = 768
        /// The one cap on a bubble's width, for the owner and the bots alike.
        /// A narrow window shrinks bubbles below it; nothing grows past it.
        public static let bubbleMax: CGFloat = 640
        public static let chatColumnPadding: CGFloat = 24
        public static let chatPaddingVertical: CGFloat = 32
        public static let transcriptGap: CGFloat = 24
        /// Between two bubbles the same bot posted back to back.
        public static let bubbleStackGap: CGFloat = 6
        public static let composerBottom: CGFloat = 20
        public static let composerTop: CGFloat = 8
        public static let botRow: CGFloat = 36
        public static let headerGap: CGFloat = 10
        public static let sectionHead: CGFloat = 24
        public static let pinnedCardPadding: CGFloat = 10
        public static let scrollbarWidth: CGFloat = 5

        // Phone metrics (iOS design spec 4.3); the Mac values above stay put.
        public static let phoneGutter: CGFloat = 16
        public static let phoneTranscriptGap: CGFloat = 16
        public static let phoneRowMinHeight: CGFloat = 60
        public static let phoneHitTarget: CGFloat = 44
        public static let sheetInset: CGFloat = 8
    }

    public enum FontSize {
        public static let chatName: CGFloat = 15
        public static let chatBody: CGFloat = 15
        public static let chatLineHeight: CGFloat = 24
        public static let chatMeta: CGFloat = 11
        public static let railName: CGFloat = 13
        public static let railPreview: CGFloat = 11
        public static let railTime: CGFloat = 10
        public static let railLabel: CGFloat = 10
        public static let sectionHead: CGFloat = 11
        public static let searchTrigger: CGFloat = 13
        public static let kbd: CGFloat = 10
        public static let newBotTrigger: CGFloat = 13
        public static let fieldLabel: CGFloat = 13
        public static let fieldInput: CGFloat = 14
        public static let button: CGFloat = 14
        public static let smallButton: CGFloat = 14
        public static let settingsTitle: CGFloat = 15
        public static let proposalTitle: CGFloat = 11
        public static let proposalName: CGFloat = 15
        public static let proposalBody: CGFloat = 13
        public static let memoryNote: CGFloat = 13
        public static let emptyTitle: CGFloat = 28
        public static let emptyBody: CGFloat = 15
        public static let dialogTitle: CGFloat = 16
        public static let dialogBody: CGFloat = 14
        public static let modeChip: CGFloat = 13
        public static let attachError: CGFloat = 12
        public static let tabLabel: CGFloat = 12

        // Phone type scale (iOS design spec 4.3). Where the phone's approved
        // size differs from the desktop's the phone gets its own token.
        public static let phoneNavTitle: CGFloat = 17
        public static let phoneLargeTitle: CGFloat = 22
        public static let phoneChatMeta: CGFloat = 12
        public static let phoneRailLabel: CGFloat = 11
        public static let phoneFieldInput: CGFloat = 15
    }

    public enum Tracking {
        public static let tight: CGFloat = -0.03
        public static let heading: CGFloat = -0.02
        public static let label: CGFloat = 0.04
        public static let operatorAvatar: CGFloat = 0.06
    }

    public enum Control {
        public static let buttonMinHeight: CGFloat = 40
        public static let buttonSmallMinHeight: CGFloat = 36
        public static let fieldMinHeight: CGFloat = 40
        public static let iconButton: CGFloat = 32
        public static let searchTrigger: CGFloat = 36
        public static let newBotTrigger: CGFloat = 40
        public static let composerCompact: CGFloat = 52
        public static let composerInput: CGFloat = 32
        public static let composerButton: CGFloat = 32
        public static let switchWidth: CGFloat = 36
        public static let switchHeight: CGFloat = 22
        public static let switchKnob: CGFloat = 16
        public static let switchTravel: CGFloat = 14
        public static let operatorAvatar: CGFloat = 32
        public static let faceDot: CGFloat = 18
        public static let faceSwatchHeight: CGFloat = 52
        public static let faceTabHeight: CGFloat = 36
        public static let facePreview: CGFloat = 80
        public static let composerExpandedMax: CGFloat = 160
        public static let dialogConfirmWidth: CGFloat = 384
        public static let dialogFormWidth: CGFloat = 448
        public static let railHairline: CGFloat = 1

        // The phone's drawn toggle (design spec 4.3); the Mac's switch metrics
        // above stay untouched.
        public static let phoneToggleWidth: CGFloat = 51
        public static let phoneToggleHeight: CGFloat = 31
        /// `fieldMinHeight` raised for touch (design spec 1.1).
        public static let phoneFieldMinHeight: CGFloat = 48
    }

    /// `box-shadow` tokens. Blur and spread are the CSS authoring values.
    public struct ShadowToken: Equatable, Sendable {
        public let y: CGFloat
        public let blur: CGFloat
        public let spread: CGFloat
        public let color: String
        public let opacity: Double

        public init(y: CGFloat, blur: CGFloat, spread: CGFloat, color: String, opacity: Double) {
            self.y = y
            self.blur = blur
            self.spread = spread
            self.color = color
            self.opacity = opacity
        }
    }

    public enum Shadow {
        public static let sm = ShadowToken(y: 1, blur: 2, spread: 0, color: Hex.ink, opacity: 0.04)
        public static let cardTop = ShadowToken(y: 1, blur: 0, spread: 0, color: Hex.ink, opacity: 0.03)
        public static let card = ShadowToken(y: 18, blur: 40, spread: -24, color: Hex.ink, opacity: 0.18)
        public static let raiseTop = ShadowToken(y: 1, blur: 0, spread: 0, color: Hex.ink, opacity: 0.04)
        public static let raise = ShadowToken(y: 22, blur: 44, spread: -22, color: Hex.ink, opacity: 0.22)
        public static let pop = ShadowToken(y: 24, blur: 56, spread: -28, color: Hex.ink, opacity: 0.28)
    }

    public enum Motion {
        public static let fast: Double = 0.15
        public static let overlay: Double = 0.2
        public static let dialog: Double = 0.25
        public static let scrollFade: Double = 0.22
        /// Light and dark trading places.
        public static let appearance: Double = 0.25
    }
}

/// Weight ladder used by the CSS. `550` and `600` share the semibold step;
/// `500` is medium; `400` regular.
public enum FontWeightToken: Equatable, Sendable {
    case regular
    case medium
    case semibold
    case bold

    public init(css: Int) {
        switch css {
        case ..<450: self = .regular
        case ..<550: self = .medium
        case ..<700: self = .semibold
        default: self = .bold
        }
    }
}

/// Parse a `#RRGGBB` token into normalized components. Kept platform-free so
/// the token table can be tested without SwiftUI.
public struct RGBColor: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init?(hex: String) {
        let clean = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard clean.count == 6, let value = UInt32(clean, radix: 16) else { return nil }
        red = Double((value >> 16) & 0xFF) / 255
        green = Double((value >> 8) & 0xFF) / 255
        blue = Double(value & 0xFF) / 255
    }
}

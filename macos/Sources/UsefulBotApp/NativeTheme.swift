import AppKit
import ObjectiveC.runtime
import SwiftUI
import UsefulBotCore

/// The Useful Brain token set (`DesignTokens`), mapped to SwiftUI.
/// Every color resolves per appearance: the light hex from `DesignTokens.Hex`
/// and the dark one from `DesignTokens.DarkHex`. `AppAppearance` picks which
/// one the app draws in.
enum Theme {
    static func color(_ hex: String) -> Color {
        guard let rgb = RGBColor(hex: hex) else { return .black }
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: 1)
    }

    static func nsColor(_ hex: String) -> NSColor {
        guard let rgb = RGBColor(hex: hex) else { return .black }
        return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }

    /// One token, resolved against the drawing view's appearance.
    static func adaptive(_ light: String, _ dark: String) -> Color {
        let lightColor = nsColor(light)
        let darkColor = nsColor(dark)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? darkColor : lightColor
        })
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
        static let overlay = color(L.dialogOverlay).opacity(0.18)
        /// A lifted card's edge: a whisper in light, where the shadow does
        /// the lifting, and a faint light rim in dark, where shadows vanish.
        static let edge = Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 1, alpha: 0.07)
                : NSColor(white: 0, alpha: 0.05)
        })
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

    /// The brand easing, the web's `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`.
    /// Front-loaded: most of the change lands in the first third.
    static func ease(_ duration: Double) -> Animation {
        .timingCurve(0.22, 1, 0.36, 1, duration: duration)
    }
}

/// Which appearance the app draws in. Stored per Mac; System follows the
/// macOS setting live.
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

    var nsAppearance: NSAppearance? {
        switch self {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }
}

/// 1pt hairline, the web's `border-b border-border`.
struct Hairline: View {
    var color: Color = Theme.C.border
    var body: some View {
        Rectangle()
            .fill(color)
            .frame(height: DesignTokens.Control.railHairline)
    }
}

/// 1pt vertical hairline, the web's `border-l border-border`. A `Hairline`
/// is a horizontal rule: any edge overlay that wants a side border needs this
/// one, or the flexible rectangle collapses into a line across the middle.
struct VerticalHairline: View {
    var color: Color = Theme.C.border
    var body: some View {
        Rectangle()
            .fill(color)
            .frame(width: DesignTokens.Control.railHairline)
    }
}

/// Walks the AppKit hierarchy and switches the enclosing scroll views to
/// overlay scrollers, the closest system match to `.uv-scroll`'s thin knob
/// that only appears while scrolling.
/// The Useful Voice thin scroller (`design-law.md`): 5px knob, 8px gutter,
/// overlay style, hidden until the content scrolls, then faded out after a
/// beat. Replaces the system scroller, which is wide and dark.
final class ThinScroller: NSScroller {
    private static let thickness: CGFloat = 5
    private static let gutter: CGFloat = 8

    override class func scrollerWidth(
        for controlSize: NSControl.ControlSize,
        scrollerStyle: NSScroller.Style
    ) -> CGFloat {
        gutter
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        controlSize = .mini
        scrollerStyle = .overlay
        knobStyle = .default
    }

    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        drawKnob()
    }

    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        var knob = rect(for: .knob)
        guard !knob.isEmpty else { return }

        if bounds.width >= bounds.height {
            knob = NSRect(
                x: knob.minX + 3,
                y: knob.midY - Self.thickness / 2,
                width: max(0, knob.width - 6),
                height: Self.thickness
            )
        } else {
            knob = NSRect(
                x: knob.midX - Self.thickness / 2,
                y: knob.minY + 3,
                width: Self.thickness,
                height: max(0, knob.height - 6)
            )
        }

        let path = NSBezierPath(roundedRect: knob, xRadius: Self.thickness / 2, yRadius: Self.thickness / 2)
        let color = isHighlighted ? NSColor(Theme.C.scrollKnobActive) : NSColor(Theme.C.scrollKnob)
        color.setFill()
        path.fill()
    }
}

enum ThinScrollbar {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        guard
            let original = class_getInstanceMethod(NSScrollView.self, #selector(NSScrollView.tile)),
            let swizzled = class_getInstanceMethod(NSScrollView.self, #selector(NSScrollView.ub_tile))
        else { return }
        method_exchangeImplementations(original, swizzled)
    }
}

private var ubApplyingThinChrome: UInt8 = 0
private var ubScrollObserver: UInt8 = 0
private var ubHideWork: UInt8 = 0
private var ubLastOrigin: UInt8 = 0
private var ubRevealed: UInt8 = 0

extension NSScrollView {
    @objc fileprivate func ub_tile() {
        ub_tile()
        ub_applyThinChrome()
    }

    fileprivate func ub_applyThinChrome() {
        if objc_getAssociatedObject(self, &ubApplyingThinChrome) as? Bool == true { return }
        objc_setAssociatedObject(self, &ubApplyingThinChrome, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        defer {
            objc_setAssociatedObject(self, &ubApplyingThinChrome, false, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }

        if scrollerStyle != .overlay {
            scrollerStyle = .overlay
        }
        autohidesScrollers = true
        if !(verticalScroller is ThinScroller) {
            verticalScroller = ThinScroller(frame: verticalScroller?.frame ?? .zero)
        }
        if !(horizontalScroller is ThinScroller) {
            horizontalScroller = ThinScroller(frame: horizontalScroller?.frame ?? .zero)
        }
        ub_installScrollFade()
        if objc_getAssociatedObject(self, &ubRevealed) as? Bool != true {
            ub_setScrollersHidden(true)
        }
    }

    fileprivate func ub_installScrollFade() {
        contentView.postsBoundsChangedNotifications = true
        if objc_getAssociatedObject(self, &ubScrollObserver) as? Bool == true { return }
        objc_setAssociatedObject(self, &ubScrollObserver, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        // Selector observers are weak, so the scroll view owns the lifetime.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(ub_contentBoundsDidChange),
            name: NSView.boundsDidChangeNotification,
            object: contentView
        )
        ub_setScrollersHidden(true)
    }

    @objc fileprivate func ub_contentBoundsDidChange() {
        ub_revealScrollers()
    }

    fileprivate func ub_revealScrollers() {
        let origin = contentView.bounds.origin
        if let previous = objc_getAssociatedObject(self, &ubLastOrigin) as? NSValue {
            if previous.pointValue == origin { return }
        } else {
            // The first origin only arms tracking: installing a scroller must
            // not flash the knob before the user scrolls.
            objc_setAssociatedObject(self, &ubLastOrigin, NSValue(point: origin), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            return
        }
        objc_setAssociatedObject(self, &ubLastOrigin, NSValue(point: origin), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        objc_setAssociatedObject(self, &ubRevealed, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        ub_setScrollersHidden(false)

        if let previous = objc_getAssociatedObject(self, &ubHideWork) as? DispatchWorkItem {
            previous.cancel()
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            objc_setAssociatedObject(self, &ubRevealed, false, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.22
                self.verticalScroller?.animator().alphaValue = 0
                self.horizontalScroller?.animator().alphaValue = 0
            } completionHandler: {
                if objc_getAssociatedObject(self, &ubRevealed) as? Bool != true {
                    self.ub_setScrollersHidden(true)
                }
            }
        }
        objc_setAssociatedObject(self, &ubHideWork, work, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.85, execute: work)
    }

    fileprivate func ub_setScrollersHidden(_ hidden: Bool) {
        for scroller in [verticalScroller, horizontalScroller] {
            guard let scroller else { continue }
            scroller.isHidden = hidden
            scroller.alphaValue = hidden ? 0 : 1
        }
    }
}

extension View {
    /// Web's `.uv-scroll`: the thin scroller standard, installed app-wide.
    func uvScroll() -> some View {
        ThinScrollbar.install()
        return self
    }

    func pointerOnHover() -> some View {
        modifier(PointerOnHover())
    }

    func stageShadow() -> some View {
        shadow(color: Theme.shadow(DesignTokens.Shadow.cardTop), radius: 0.5, x: 0, y: DesignTokens.Shadow.cardTop.y)
            .shadow(color: Theme.shadow(DesignTokens.Shadow.card), radius: Theme.radius(DesignTokens.Shadow.card), x: 0, y: DesignTokens.Shadow.card.y)
    }

    func popShadow() -> some View {
        shadow(color: Theme.shadow(DesignTokens.Shadow.pop), radius: Theme.radius(DesignTokens.Shadow.pop), x: 0, y: DesignTokens.Shadow.pop.y)
    }

    func raiseShadow() -> some View {
        shadow(color: Theme.shadow(DesignTokens.Shadow.raiseTop), radius: 0.5, x: 0, y: DesignTokens.Shadow.raiseTop.y)
            .shadow(color: Theme.shadow(DesignTokens.Shadow.raise), radius: Theme.radius(DesignTokens.Shadow.raise), x: 0, y: DesignTokens.Shadow.raise.y)
    }

    /// One level off the page: a whisper of an edge and a short, soft drop.
    /// The card treatment for bubbles and status cards, in place of a hard
    /// gray border.
    func cardLift(cornerRadius: CGFloat) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .shadow(color: Theme.C.shadow.opacity(0.04), radius: 0.5, x: 0, y: 0.5)
        .shadow(color: Theme.C.shadow.opacity(0.08), radius: 8, x: 0, y: 3)
    }

    func smShadow() -> some View {
        shadow(color: Theme.shadow(DesignTokens.Shadow.sm), radius: Theme.radius(DesignTokens.Shadow.sm), x: 0, y: DesignTokens.Shadow.sm.y)
    }
}

/// Pushes the pointing hand only while the view is hovered and pops it when
/// the view disappears under the cursor, so the pushed cursor cannot stick.
private struct PointerOnHover: ViewModifier {
    @State private var hovering = false

    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            // The system pointer style is a cursor rect the window owns: it
            // holds over a whole control and next to a web view, where a
            // push/pop on hover events flickered or never showed.
            content.pointerStyle(.link)
        } else {
            legacy(content)
        }
    }

    private func legacy(_ content: Content) -> some View {
        content
            .onHover { inside in
                guard inside != hovering else { return }
                hovering = inside
                if inside {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }
            .onDisappear {
                if hovering {
                    hovering = false
                    NSCursor.pop()
                }
            }
    }
}

/// Tracks whether the latest input came from the pointer or the keyboard.
/// The web focus ring is a `:focus-visible` treatment, but macOS also focuses
/// a control on a plain click, so drawing the ring for any focus leaves a
/// black outline behind every click. Only keyboard-driven focus draws it.
final class InputModality: ObservableObject {
    static let shared = InputModality()

    /// True while the latest input was a pointer gesture.
    @Published private(set) var pointerDriven = true

    private var monitor: Any?

    private init() {}

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
        ) { [weak self] event in
            dispatchPrecondition(condition: .onQueue(.main))
            let modality: Bool?
            switch event.type {
            case .keyDown where event.keyCode == 48:
                // Tab moves focus; typing must not re-arm the ring.
                modality = false
            case .keyDown:
                modality = nil
            default:
                modality = true
            }
            if let modality, self?.pointerDriven != modality {
                self?.pointerDriven = modality
            }
            return event
        }
    }
}

/// The web focus ring: 2px accent at a 2px offset, radius 4. Only drawn when
/// focus arrived from the keyboard, so pointer clicks stay clean.
struct FocusRing: ViewModifier {
    @ObservedObject private var modality = InputModality.shared
    let focused: Bool

    func body(content: Content) -> some View {
        content.overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                .strokeBorder(Theme.C.accent, lineWidth: 2)
                .padding(-2)
                .opacity(focused && !modality.pointerDriven ? 1 : 0)
        )
    }
}

extension View {
    func focusRing(_ focused: Bool) -> some View {
        modifier(FocusRing(focused: focused))
    }
}

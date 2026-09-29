import AppKit
import SwiftUI
import UsefulBotCore

/// A vendored provider mark from brand/providers/<icon>.svg, tinted ink and
/// drawn at the full size with no tile behind it. Falls back to a monogram on
/// a sunken tile when the file is missing, so `swift build` debug runs and
/// unknown slugs still render.
struct ProviderMark: View {
    let icon: String
    let monogram: String
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let image = ProviderMarkImage.load(icon) {
                Image(nsImage: image)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Theme.C.ink)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                        .fill(Theme.C.sunken)
                    Text(monogram)
                        .font(.system(size: markFont, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var markFont: CGFloat {
        size <= 16 ? 8 : (size <= 22 ? 11 : 13)
    }
}

/// Loads brand/providers/<icon>.svg as a template image. Slugs come from the
/// server, so only a bare file stem is accepted; anything else misses the
/// cache and falls back to the monogram.
@MainActor
enum ProviderMarkImage {
    private static var cache: [String: NSImage?] = [:]

    static func load(_ icon: String) -> NSImage? {
        if let hit = cache[icon] { return hit }
        let image = read(icon)
        cache[icon] = image
        return image
    }

    private static func read(_ icon: String) -> NSImage? {
        guard !icon.isEmpty,
              icon.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }),
              !icon.hasPrefix("-"), !icon.hasSuffix("-") else { return nil }
        let url = BrandAssets.root.appendingPathComponent("providers/\(icon).svg")
        guard let image = NSImage(contentsOf: url) else { return nil }
        image.isTemplate = true
        return image
    }
}

/// Which Providers brand card is open. The dialog owns the selection; the pane
/// publishes each trigger's anchor through `ProvidersCardAnchorsKey` and the
/// dialog renders the card above the sidebar and the scrolling body.
struct ProvidersCard: Equatable, Hashable {
    enum Kind: String, Hashable {
        case connect
        case menu
        case picker
        case effort
    }

    let kind: Kind
    /// connect: "". menu: connection id. picker and effort: role name.
    let key: String
}

struct ProvidersCardAnchor {
    let card: ProvidersCard
    let bounds: Anchor<CGRect>
}

struct ProvidersCardAnchorsKey: PreferenceKey {
    static var defaultValue: [ProvidersCardAnchor] = []
    static func reduce(value: inout [ProvidersCardAnchor], nextValue: () -> [ProvidersCardAnchor]) {
        value.append(contentsOf: nextValue())
    }
}

/// Window frames of the Providers card triggers, keyed by the card each one
/// opens. `ProvidersCardHost` passes them as the outside-click triggers, so a
/// click on any trigger reaches its toggle instead of dismissing the open
/// card first (see OutsideClick.swift). Reads happen on event monitors, so a
/// lock guards the writes from layout.
final class ProvidersTriggerFrames: @unchecked Sendable {
    static let shared = ProvidersTriggerFrames()

    private let lock = NSLock()
    private var frames: [ProvidersCard: CGRect] = [:]

    func frame(for card: ProvidersCard) -> CGRect {
        lock.lock()
        defer { lock.unlock() }
        return frames[card] ?? .zero
    }

    /// Every trigger frame reported so far. The host passes these so clicking
    /// a second trigger while a card is open swaps straight to it.
    func allFrames() -> [CGRect] {
        lock.lock()
        defer { lock.unlock() }
        return Array(frames.values)
    }

    /// A trigger that left the screen (a disconnected row) must not veto an
    /// outside click any more.
    func forget(_ card: ProvidersCard) {
        lock.lock()
        defer { lock.unlock() }
        frames.removeValue(forKey: card)
    }

    func binding(for card: ProvidersCard) -> Binding<CGRect> {
        Binding(
            get: { Self.shared.frame(for: card) },
            set: { Self.shared.store($0, for: card) }
        )
    }

    private func store(_ rect: CGRect, for card: ProvidersCard) {
        lock.lock()
        defer { lock.unlock() }
        frames[card] = rect
    }
}

/// The on-brand card chrome shared by the four Providers cards: the same
/// surface, hairline border, radius and shadow as the rail account popover.
struct ProvidersBrandCard<Content: View>: View {
    let width: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(width: width)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
            .popShadow()
    }
}

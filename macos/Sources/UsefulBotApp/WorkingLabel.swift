import SwiftUI
import UsefulBotCore

/// The working row's status label: swaps in 120 ms (the old text slides up
/// 6 pt and fades while the new one rises from 6 pt below) and carries a
/// light sweep while it stays up. Spec section 5 of
/// ~/.agents/skills/useful-brand/references/agent-working-motion.md.
struct WorkingLabel: View {
    /// The current label. Hidden text of this width holds the slot.
    let text: String
    /// False for the first beat of a turn: the mark arrives alone, then the
    /// label comes in with the swap motion.
    var visible = true
    /// The turn ended: the sweep stops and the label settles on the muted ink.
    var done = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let swap = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.12)
    private static let slide: CGFloat = 6
    /// The row's height, so the 6 pt slide has room before the clip.
    private static let slotHeight: CGFloat = 24

    var body: some View {
        let shown = visible ? text : ""
        // The text that sets the slot is the new one, at once. The outgoing
        // text is an overlay, so it never pushes the timer, and the clip keeps
        // it inside the new label's width.
        label(text)
            .hidden()
            .frame(height: Self.slotHeight)
            .overlay(alignment: .leading) {
                ZStack(alignment: .leading) {
                    if !shown.isEmpty {
                        ShimmerLabel(text: shown, done: done)
                            .id(shown)
                            .transition(reduceMotion ? .identity : Self.swapTransition)
                    }
                }
                .animation(reduceMotion ? nil : Self.swap, value: shown)
            }
            .clipped()
    }

    private func label(_ string: String) -> some View {
        Text(string)
            .lineLimit(1)
            .truncationMode(.tail)
            .font(.system(size: DesignTokens.FontSize.chatBody))
    }

    private static var swapTransition: AnyTransition {
        .asymmetric(
            insertion: .modifier(active: Slide(dy: slide, opacity: 0), identity: Slide(dy: 0, opacity: 1)),
            removal: .modifier(active: Slide(dy: -slide, opacity: 0), identity: Slide(dy: 0, opacity: 1))
        )
    }

    private struct Slide: ViewModifier {
        let dy: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.offset(y: dy).opacity(opacity)
        }
    }
}

/// The label text with its sweep: the muted label, and the same text in the
/// full ink on top, masked by a 130 pt band that crosses it at about 485 pt/s,
/// every 3 s, the first time 0.7 s after the label appears. A new label is a
/// new view, so the clock restarts on every swap.
///
/// Brand-law sweep exception: the `LinearGradient` here is the mask of this
/// sweep and nothing else (a tonal change of the same ink, no hue, no glow,
/// no border), allowed by Wasim on 2026-10-25 for in-progress labels only.
struct ShimmerLabel: View {
    let text: String
    let done: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var born = Date()
    @State private var width: CGFloat = 0

    var body: some View {
        styled(Theme.C.inkMuted)
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, new in width = new }
                }
            )
            .overlay(alignment: .leading) {
                // Only once the width is measured, so the first sweep is timed
                // for this label and not for a zero-width one.
                if !reduceMotion, width > 0 {
                    TimelineView(ShimmerSchedule(origin: born, width: Double(width))) { timeline in
                        let centre = AgentShimmer.bandCentre(
                            elapsed: timeline.date.timeIntervalSince(born),
                            width: Double(width)
                        )
                        styled(Theme.C.ink)
                            .mask(alignment: .leading) { band(centre: centre) }
                    }
                    // Done: the sweep stops and the label settles on the muted
                    // ink over 150 ms, from wherever the sweep left it.
                    .opacity(done ? 0 : 1)
                    .animation(.easeOut(duration: 0.15), value: done)
                }
            }
    }

    private func styled(_ color: Color) -> some View {
        Text(text)
            .lineLimit(1)
            .truncationMode(.tail)
            .font(.system(size: DesignTokens.FontSize.chatBody))
            .foregroundStyle(color)
    }

    @ViewBuilder
    private func band(centre: Double?) -> some View {
        if let centre {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: 0.5),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: AgentShimmer.bandWidth)
            .offset(x: CGFloat(centre - AgentShimmer.bandWidth / 2))
        } else {
            Color.clear
        }
    }
}

/// Wakes the sweep at 60 fps while the band is crossing the label, and only
/// at the start of the next sweep between them, so an idle label costs no
/// redraws.
struct ShimmerSchedule: TimelineSchedule {
    let origin: Date
    let width: Double

    func entries(from start: Date, mode: Mode) -> Entries {
        Entries(origin: origin, width: width, last: start.addingTimeInterval(-1e-3))
    }

    struct Entries: Sequence, IteratorProtocol {
        let origin: Date
        let width: Double
        var last: Date

        mutating func next() -> Date? {
            let sweep = AgentShimmer.sweepDuration(width: width)
            let first = AgentShimmer.firstDelay
            let elapsed = last.timeIntervalSince(origin) - first
            let following: Double
            if elapsed < -1e-6 {
                following = first
            } else {
                let cycle = floor(elapsed / AgentShimmer.period)
                let into = elapsed - cycle * AgentShimmer.period
                if into + 1.0 / 60 < sweep {
                    following = first + cycle * AgentShimmer.period + into + 1.0 / 60
                } else if into < sweep - 1e-6 {
                    // The last frame of the sweep, with the band clear of the text.
                    following = first + cycle * AgentShimmer.period + sweep
                } else {
                    following = first + (cycle + 1) * AgentShimmer.period
                }
            }
            last = origin.addingTimeInterval(following)
            return last
        }
    }
}

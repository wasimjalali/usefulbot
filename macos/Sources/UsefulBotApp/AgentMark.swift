import SwiftUI
import UsefulBotCore

/// The mark that shows the agent is working: a few round dots that juggle,
/// merge and split. The keyframes are `AgentMarkFrames`; this draws them.
/// Spec: ~/.agents/skills/useful-brand/references/agent-working-motion.md.
///
/// - `phase` picks the figure: three dots (thinking), four (a command), or
///   the shrink-away when the turn is done.
/// - `scale` is 1 in the chat's working row and 0.6 in a sidebar row. Sizes,
///   offsets and the fuse blur all scale with it.
/// - `arrives` runs the turn's arrival first. A sidebar mark skips it and
///   loops from the shared clock, so every mark in the app stays in step. So
///   does a row that opens on a turn already under way: it cuts in.
/// - `step` names the running command step. While the phase stays `.command`,
///   a change from one step to another re-triggers the collapse and burst, so
///   consecutive commands do not read as one long loop.
struct AgentMark: View {
    var phase: AgentMarkPhase = .thinking
    var scale: CGFloat = 1
    var arrives = true
    var step: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    /// Built on first draw, not on every re-evaluation of the parent.
    @State private var clock = MarkClock()
    /// Off screen (scrolled out of the transcript, or the window hidden,
    /// minimised or covered) the timeline stops, so a list full of marks
    /// costs only the rows in view. Assumed visible until the probe says not.
    @State private var visible = true

    /// The box every figure fits in, in points at scale 1.
    static let box: CGFloat = 24

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || !visible)) { timeline in
            let dots = frame(at: timeline.date.timeIntervalSinceReferenceDate)
            Canvas { context, size in
                Self.draw(dots, in: &context, size: size, scale: scale, ink: ink)
            }
            .frame(width: Self.box * scale, height: Self.box * scale)
        }
        .frame(width: Self.box * scale, height: Self.box * scale)
        .background(VisibilityProbe { visible = $0 })
        .onChange(of: phase) { _, next in
            clock.sequencer(phase: phase, arrives: arrives).set(next, at: Date.now.timeIntervalSinceReferenceDate)
        }
        .onChange(of: step) { old, new in
            // A different command while one is running: fold and burst again.
            guard phase == .command, AgentMarkSequencer.isNewCommandStep(from: old, to: new) else { return }
            clock.sequencer(phase: phase, arrives: arrives)
                .set(.command, at: Date.now.timeIntervalSinceReferenceDate, restart: true)
        }
        .accessibilityHidden(true)
    }

    private func frame(at now: Double) -> [MarkDot] {
        // Reduce Motion: three still dots, whatever the figure; gone when done.
        if reduceMotion { return phase == .done ? [] : AgentMarkFrames.reducedMotion }
        return clock.sequencer(phase: phase, arrives: arrives).dots(at: now)
    }

    /// The ink token, resolved here: the filter below takes one fixed colour.
    private var ink: Color {
        Theme.color(colorScheme == .dark ? DesignTokens.DarkHex.ink : DesignTokens.Hex.ink)
    }

    /// The fuse filter: blur the dots, then threshold the alpha, so dots that
    /// overlap join into one round blob and pull apart again.
    ///
    /// Brand-law sweep exception: this is the one `blur` in the app that is
    /// not decoration. It is never seen; it only shapes the silhouette, and
    /// the threshold turns every edge back into solid ink. It runs on this
    /// mark's own 24 x 24 pt canvas and nothing else. The blur scales with the
    /// mark (0.6 in the sidebar), so a 1.5 pt dot still clears the threshold.
    static func draw(_ dots: [MarkDot], in context: inout GraphicsContext, size: CGSize, scale: CGFloat, ink: Color) {
        // Filters run last-added first: blur, then threshold.
        context.addFilter(.alphaThreshold(min: fuseThreshold, color: ink))
        context.addFilter(.blur(radius: fuseBlur * scale))
        context.drawLayer { layer in
            for dot in dots where dot.d > 0 {
                let d = CGFloat(dot.d) * scale
                let rect = CGRect(
                    x: size.width / 2 + CGFloat(dot.x) * scale - d / 2,
                    y: size.height / 2 + CGFloat(dot.y) * scale - d / 2,
                    width: d,
                    height: d
                )
                layer.fill(Path(ellipseIn: rect), with: .color(.black))
            }
        }
    }

    static let fuseBlur: CGFloat = 1.0
    static let fuseThreshold: CGFloat = 0.4
}

/// One mark's sequencer. A class so the phase can change from `onChange`
/// without a state write that redraws the row; the timeline redraws it anyway.
/// The sequencer is made on the first draw, from the phase and entry the mark
/// has then, so building the view struct again costs nothing.
final class MarkClock {
    private var stored: AgentMarkSequencer?

    func sequencer(phase: AgentMarkPhase, arrives: Bool) -> Sequencer {
        if stored == nil {
            stored = AgentMarkSequencer(
                start: Date.now.timeIntervalSinceReferenceDate,
                phase: phase,
                arrives: arrives
            )
        }
        return Sequencer(clock: self)
    }

    /// A handle on the stored sequencer, so a call site reads and mutates it
    /// without unwrapping.
    struct Sequencer {
        fileprivate let clock: MarkClock

        func dots(at now: Double) -> [MarkDot] {
            clock.stored?.advance(to: now)
            return clock.stored?.dots(at: now) ?? []
        }

        func set(_ next: AgentMarkPhase, at now: Double, restart: Bool = false) {
            clock.stored?.set(next, at: now, restart: restart)
        }
    }
}

/// Tells the mark whether it can be seen: the window is on screen (not
/// minimised, hidden or fully covered) and, inside a scroll view, the mark is
/// within the visible part of it. Reports only changes. A mark with no scroll
/// view around it (the sidebar's rows scroll too, but a plain container does
/// not) is judged by the window alone.
private struct VisibilityProbe: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> ProbeView { ProbeView(onChange: onChange) }
    func updateNSView(_ view: ProbeView, context: Context) {
        view.onChange = onChange
        // The parent re-evaluated: the mark may have moved (a re-sorted sidebar
        // row) without any event the probe observes.
        DispatchQueue.main.async { [weak view] in view?.evaluate() }
    }

    final class ProbeView: NSView {
        var onChange: (Bool) -> Void
        private var last: Bool?
        private var observers: [NSObjectProtocol] = []

        init(onChange: @escaping (Bool) -> Void) {
            self.onChange = onChange
            super.init(frame: .zero)
            postsFrameChangedNotifications = true
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        deinit { observers.forEach(NotificationCenter.default.removeObserver) }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            if let window {
                let center = NotificationCenter.default
                for name in [
                    NSWindow.didChangeOcclusionStateNotification,
                    NSWindow.didMiniaturizeNotification,
                    NSWindow.didDeminiaturizeNotification,
                ] {
                    observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                        self?.evaluate()
                    })
                }
                // The mark's own frame moving (a re-sorted row) and the clip view
                // scrolling or resizing.
                observers.append(center.addObserver(
                    forName: NSView.frameDidChangeNotification, object: self, queue: .main
                ) { [weak self] _ in self?.evaluate() })
                if let clip = enclosingScrollView?.contentView {
                    clip.postsBoundsChangedNotifications = true
                    clip.postsFrameChangedNotifications = true
                    for name in [NSView.boundsDidChangeNotification, NSView.frameDidChangeNotification] {
                        observers.append(center.addObserver(forName: name, object: clip, queue: .main) { [weak self] _ in
                            self?.evaluate()
                        })
                    }
                }
            }
            evaluate()
        }

        // The transcript grows under the mark as the turn runs.
        override func layout() {
            super.layout()
            evaluate()
        }

        func evaluate() {
            let visible = isSeen
            guard visible != last else { return }
            last = visible
            // Not mid-layout: the report writes state.
            DispatchQueue.main.async { [weak self] in self?.onChange(visible) }
        }

        private var isSeen: Bool {
            guard let window else { return false }
            if window.isMiniaturized || !window.occlusionState.contains(.visible) { return false }
            guard let scroll = enclosingScrollView else { return true }
            let inClip = scroll.contentView.convert(bounds, from: self)
            return inClip.intersects(scroll.contentView.bounds)
        }
    }
}

import AppKit
import SwiftUI

/// Popovers and side panes close on a click outside the card, inside one of
/// Useful Bot's own windows. SwiftUI anchored overlays have no equivalent, so
/// this installs a temporary AppKit local event monitor for the lifetime of
/// the view. Clicks in other apps never close it (a global monitor would see
/// exactly those), and neither does the click that brings Useful Bot back to
/// the front. A click in a different window of this app counts as outside,
/// since the card's coordinates mean nothing there. Pass `triggers` with the
/// toggle button's window frame so clicking the button again closes instead of
/// dismissing-then-reopening.
///
/// Inside detection is hover based, not frame based: anchored popovers are
/// placed with `.offset`, and the AppKit frame of an offset view does not
/// include that shift, so a frame check would classify every click on the
/// popover as outside and tear the popover down on mousedown, before the
/// clicked row's action could run.
extension View {
    func dismissOnOutsideClick(
        triggers: (() -> [CGRect])? = nil,
        onClose: @escaping () -> Void
    ) -> some View {
        modifier(OutsideClickDismissal(triggers: triggers, onClose: onClose))
    }

    /// Reports a view's frame in window coordinates into `frame`, using
    /// AppKit's own conversion so it stays correct across window moves.
    ///
    /// Only on a real change. The reader reports from `layout()`, and SwiftUI
    /// invalidates on every write to a `@State` binding whether or not the
    /// value moved, so an unconditional assignment here put the composer and
    /// the rail into a layout/update feedback loop: report, rebuild, lay out,
    /// report. That is what made clicking the field and the model chip feel
    /// heavy.
    func trackWindowFrame(_ frame: Binding<CGRect>) -> some View {
        background(WindowFrameReader { rect, _ in
            if frame.wrappedValue != rect { frame.wrappedValue = rect }
        })
    }
}

private struct OutsideClickDismissal: ViewModifier {
    let triggers: (() -> [CGRect])?
    let onClose: () -> Void

    @State private var hoveringInside = false
    /// The popover's own window frame. Hover alone cannot prove a click is
    /// inside: a popover that opens under a resting pointer gets no enter
    /// event until the pointer moves, and a fast click on a menu row can land
    /// before tracking catches up. That is the model chip's menu closing on
    /// the very row that was clicked. The frame covers what hover misses.
    @State private var cardFrame = CGRect.zero
    @State private var monitors: [Any] = []
    @State private var state = ClickState()

    func body(content: Content) -> some View {
        content
            .background(
                WindowFrameReader { rect, window in
                    if cardFrame != rect { cardFrame = rect }
                    if state.cardWindow !== window { state.cardWindow = window }
                }
            )
            .onHover { hoveringInside = $0 }
            .onAppear(perform: install)
            .onDisappear(perform: uninstall)
    }

    private func install() {
        guard monitors.isEmpty else { return }
        // Mouse-up, not mouse-down: popover rows run their action on mouse-up,
        // so a mouse-down dismissal would tear the row down before the action
        // could fire for any click hover tracking missed. Mouse-down is only
        // watched to spot the click that re-activates the app.
        let state = state
        let activation = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            state.lastActivation = ProcessInfo.processInfo.systemUptime
        }
        let local = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .leftMouseUp, .rightMouseUp]
        ) { event in
            switch event.type {
            case .leftMouseDown, .rightMouseDown:
                // The click that activated the app was pressed before, or a
                // hair after, the activation it caused. A click a person
                // makes after Cmd-Tab or a Dock click comes later than that.
                state.activationClick = !NSApp.isActive
                    || event.timestamp - state.lastActivation < 0.1
            default:
                if state.activationClick {
                    state.activationClick = false
                } else if shouldClose(event) {
                    close()
                }
            }
            return event
        }
        state.activationObserver = activation
        monitors = [local].compactMap { $0 }
    }

    private func uninstall() {
        monitors.forEach(NSEvent.removeMonitor)
        if let observer = state.activationObserver {
            NotificationCenter.default.removeObserver(observer)
            state.activationObserver = nil
        }
        monitors = []
    }

    /// Deferred so a dismissal and a row action in the same click both land:
    /// the row runs its action on mouse-up, then the popover closes.
    private func close() {
        DispatchQueue.main.async(execute: onClose)
    }

    private func shouldClose(_ event: NSEvent) -> Bool {
        // Modal sheets own the screen while they run; dismissing the popover
        // under them would be surprising.
        if NSApp.modalWindow != nil || event.window?.sheetParent != nil { return false }
        // The frames below are in the card's window space. A click in another
        // window of this app is outside by definition.
        if let cardWindow = state.cardWindow, event.window !== cardWindow { return true }
        // A click on the popover keeps it open so the row action can fire.
        if hoveringInside { return false }
        if cardFrame.contains(event.locationInWindow) { return false }
        guard let triggers else { return true }
        let frames = triggers()
        if frames.contains(where: { $0.contains(event.locationInWindow) }) {
            return false
        }
        // A trigger that has not reported a frame yet cannot prove the click
        // is outside; keep the popover so its toggle button stays in charge.
        if frames.contains(where: { $0.isEmpty }) {
            return false
        }
        return true
    }
}

/// Mutable state the event monitors share with the view. A class, so the
/// monitor closures see current values.
private final class ClickState {
    weak var cardWindow: NSWindow?
    var lastActivation: TimeInterval = 0
    var activationClick = false
    var activationObserver: Any?
}

private struct WindowFrameReader: NSViewRepresentable {
    let onChange: (CGRect, NSWindow?) -> Void

    func makeNSView(context: Context) -> FrameObserver {
        let view = FrameObserver()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: FrameObserver, context: Context) {
        view.onChange = onChange
    }

    final class FrameObserver: NSView {
        var onChange: ((CGRect, NSWindow?) -> Void)?
        private var scrollObserver: Any?
        private weak var observedScroll: NSScrollView?

        override func layout() {
            super.layout()
            observeEnclosingScroll()
            report()
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observeEnclosingScroll()
            report()
        }

        deinit {
            if let scrollObserver {
                NotificationCenter.default.removeObserver(scrollObserver)
            }
        }

        /// A trigger that lives in a ScrollView moves in window coordinates
        /// when the content scrolls, and neither a layout nor a window change
        /// fires then, so the stored frame would go stale. Re-target when the
        /// view lands in a different scroll view.
        private func observeEnclosingScroll() {
            let scroll = enclosingScrollView
            guard scroll !== observedScroll else { return }
            if let scrollObserver {
                NotificationCenter.default.removeObserver(scrollObserver)
                self.scrollObserver = nil
            }
            observedScroll = scroll
            guard let scroll else { return }
            scroll.contentView.postsBoundsChangedNotifications = true
            scrollObserver = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: scroll.contentView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.report()
                }
            }
        }

        private func report() {
            guard let window else { return }
            onChange?(convert(bounds, to: nil), window)
        }
    }
}

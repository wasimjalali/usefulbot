import AppKit
import SwiftUI

/// Popovers close on any mousedown outside the card. SwiftUI anchored
/// overlays have no
/// equivalent, so this installs temporary AppKit event monitors for the
/// lifetime of the popover view and closes it when the user clicks anywhere
/// else. Pass `triggers` with the toggle button's window frame so clicking the
/// button again closes instead of dismissing-then-reopening.
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

    func body(content: Content) -> some View {
        content
            .background(
                WindowFrameReader { rect, _ in
                    if cardFrame != rect { cardFrame = rect }
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
        // could fire for any click hover tracking missed.
        let local = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp, .rightMouseUp]) { event in
            if shouldClose(event) { close() }
            return event
        }
        let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            // Sheets own the screen while they run; a click outside the app
            // must not dismiss the popover under them.
            if NSApp.modalWindow == nil, !hoveringInside { close() }
        }
        monitors = [local, global].compactMap { $0 }
    }

    private func uninstall() {
        monitors.forEach(NSEvent.removeMonitor)
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

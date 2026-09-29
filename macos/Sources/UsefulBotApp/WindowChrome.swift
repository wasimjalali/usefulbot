import AppKit
import SwiftUI
import UsefulBotCore

/// One chrome row, the way Grok does it: no title band, the content runs to
/// the top edge, and the traffic lights sit centred on the rail header and
/// the chat header instead of on a strip of their own.
///
/// AppKit has no setting for where the lights go, so this grows the titlebar
/// container to the header row and centres the three buttons in it (the same
/// approach as Electron's `trafficLightPosition`). AppKit lays the titlebar
/// out again on resize, full screen and key changes, so every one of those
/// re-applies it.
struct WindowChrome: NSViewRepresentable {
    /// Whether this view's own window is in full screen. Scoped to the one
    /// window: another window going full screen must not move this rail.
    @Binding var fullScreen: Bool

    func makeNSView(context: Context) -> ChromeView {
        let view = ChromeView()
        view.onFullScreen = { value in
            if fullScreen != value { fullScreen = value }
        }
        return view
    }

    func updateNSView(_ nsView: ChromeView, context: Context) {}

    /// Where the lights' centre sits, from the window's top edge: tucked into
    /// the corner the way Finder and Notes place them over a full-height
    /// sidebar, not the middle of the header row, which put them beside the
    /// logo.
    static let lightsCenterY: CGFloat = 20

    final class ChromeView: NSView {
        private var observers: [NSObjectProtocol] = []
        var onFullScreen: ((Bool) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.styleMask.insert(.fullSizeContentView)
            let names: [Notification.Name] = [
                NSWindow.didResizeNotification,
                NSWindow.didEndLiveResizeNotification,
                NSWindow.didExitFullScreenNotification,
                NSWindow.didBecomeKeyNotification,
                NSWindow.didResignKeyNotification,
            ]
            observers = names.map { name in
                NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    self?.placeLights()
                }
            }
            observers.append(NotificationCenter.default.addObserver(
                forName: NSWindow.willEnterFullScreenNotification, object: window, queue: .main
            ) { [weak self] _ in self?.onFullScreen?(true) })
            observers.append(NotificationCenter.default.addObserver(
                forName: NSWindow.willExitFullScreenNotification, object: window, queue: .main
            ) { [weak self] _ in self?.onFullScreen?(false) })
            let startsFullScreen = window.styleMask.contains(.fullScreen)
            DispatchQueue.main.async { [weak self] in self?.onFullScreen?(startsFullScreen) }
            placeLights()
        }

        /// An appearance switch lays the titlebar out again without any
        /// window notification, which dropped the lights back to the top edge.
        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            DispatchQueue.main.async { [weak self] in self?.placeLights() }
        }

        private func placeLights() {
            guard
                let window,
                !window.styleMask.contains(.fullScreen),
                let close = window.standardWindowButton(.closeButton),
                let container = close.superview?.superview
            else { return }
            let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
                .compactMap { window.standardWindowButton($0) }
            let height = WindowChrome.lightsCenterY * 2
            var frame = container.frame
            frame.size.height = height
            frame.origin.y = window.frame.height - height
            container.frame = frame
            // The decoration view paints the titlebar's backdrop and edge.
            // Grown to the header row it drew a white band over both
            // headers; the row's own backgrounds are the chrome here.
            for view in container.subviews where NSStringFromClass(type(of: view)) == "_NSTitlebarDecorationView" {
                view.isHidden = true
            }
            for button in buttons {
                button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: (height - button.frame.height) / 2))
            }
        }

        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
        }
    }
}

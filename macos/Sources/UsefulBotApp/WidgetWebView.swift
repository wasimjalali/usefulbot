import SwiftUI
import WebKit
import UsefulBotCore

/// The transcript's place for a widget: its box from the first layout, the
/// web view only once the box is near the window. A `WKWebView` is a
/// content process, a GPU process and a networking process, some 130 MB for
/// a drawing the reader may never scroll up to; a chat that opened at its
/// newest turn used to start them all for every drawing in its history.
/// Once created it stays until the row leaves, so scrolling past a drawing
/// twice does not load it twice.
struct WidgetSlot: View {
    let widgetId: String
    /// The drawing's page has loaded: a caller showing a stand-in can hand over.
    var onLoaded: (() -> Void)?
    /// How far outside the window a box still counts as near, so the page is
    /// loading by the time it scrolls in.
    private static let margin: CGFloat = 800
    @State private var near = false
    /// The page fetch failed or the host reported the drawing is gone. The
    /// row collapses to a compact placeholder instead of holding 480 points
    /// of blank.
    @State private var unavailable = false

    var body: some View {
        if #available(macOS 15.0, *) {
            Group {
                if unavailable {
                    WidgetUnavailableRow(onRetry: { unavailable = false })
                } else if near {
                    WidgetWebView(widgetId: widgetId, onUnavailable: { unavailable = true }, onLoaded: onLoaded)
                } else {
                    Color.clear
                }
            }
            .frame(height: unavailable ? WidgetUnavailableRow.height : 480)
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: Bool.self) { proxy in
                guard let window = proxy.bounds(of: .scrollView) else { return true }
                return proxy.frame(in: .scrollView).intersects(window.insetBy(dx: 0, dy: -Self.margin))
            } action: { isNear in
                if isNear, !near { near = true }
            }
        } else {
            if unavailable {
                WidgetUnavailableRow(onRetry: { unavailable = false })
                    .frame(height: WidgetUnavailableRow.height)
                    .frame(maxWidth: .infinity)
            } else {
                WidgetWebView(widgetId: widgetId, onUnavailable: { unavailable = true }, onLoaded: onLoaded)
                    .frame(height: 480)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// A drawing that could not be shown: compact, says so, and offers a retry.
/// The transcript event stays; only the blank canvas-sized box is gone.
private struct WidgetUnavailableRow: View {
    static let height: CGFloat = 52

    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "scribble")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
            Text("Drawing unavailable")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
            Spacer(minLength: 0)
            Button(action: onRetry) {
                Text("Retry")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .buttonStyle(.plain)
            .pointerOnHover()
        }
        .padding(.horizontal, 14)
    }
}

/// Sandboxed MCP App host. Shows only the widget page the client fetched.
///
/// The web view sits in a plain container so it can leave the row for full
/// screen (the app's "Edit") and come back as the same page, edits and all.
struct WidgetWebView: NSViewRepresentable {
    let widgetId: String
    var height: CGFloat = 480
    /// The page fetch failed, or the host page itself said the drawing cannot
    /// be shown. The slot swaps in its compact row.
    var onUnavailable: (() -> Void)?
    var onLoaded: (() -> Void)?

    func makeNSView(context: Context) -> NSView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.addScriptMessageHandler(
            WeakHostHandler(context.coordinator), contentWorld: .page, name: "ubHost"
        )
        let view = SizedWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        view.autoresizingMask = [.width, .height]
        let container = NSView(frame: .zero)
        container.addSubview(view)
        context.coordinator.webView = view
        context.coordinator.container = container
        context.coordinator.onUnavailable = onUnavailable
        context.coordinator.onLoaded = onLoaded
        // The page is not fetched until the view has a width. The host page's
        // frame is `width: 100%`, and a drawing that laid itself out in a
        // zero-width frame, which is what a view created mid-scroll had for
        // its first moments, stayed blank after the frame grew.
        context.coordinator.wantedId = widgetId
        view.onFirstSize = { [weak view, coordinator = context.coordinator] in
            guard let view, let wanted = coordinator.wantedId else { return }
            coordinator.load(widgetId: wanted, into: view)
        }
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        // A row whose id changes before its first size loads the new id.
        context.coordinator.wantedId = widgetId
        context.coordinator.onUnavailable = onUnavailable
        context.coordinator.onLoaded = onLoaded
        guard let view = context.coordinator.webView else { return }
        if view.sized, context.coordinator.loadedId != widgetId {
            context.coordinator.load(widgetId: widgetId, into: view)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    /// The row left (a chat switch, a cleared chat): a fetch still in flight
    /// would otherwise hand its page to a view nothing shows, and a page
    /// still loading would keep its content process busy for it. A drawing
    /// open in full screen takes its overlay with it.
    static func dismantleNSView(_ container: NSView, coordinator: Coordinator) {
        coordinator.leaveFullscreen(tellPage: false)
        coordinator.cancel()
        guard let view = coordinator.webView else { return }
        view.onFirstSize = nil
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "ubHost", contentWorld: .page)
    }

    /// A web view that says when it first has a width to load into, and
    /// when the reader last clicked in it.
    final class SizedWebView: WKWebView {
        var onFirstSize: (() -> Void)?
        private(set) var sized = false
        private(set) var lastClick = Date.distantPast

        /// A new page starts with no click to its credit.
        func forgetClick() { lastClick = .distantPast }

        override func mouseDown(with event: NSEvent) {
            lastClick = Date()
            super.mouseDown(with: event)
        }

        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            guard !sized, newSize.width > 0 else { return }
            sized = true
            let fire = onFirstSize
            onFirstSize = nil
            fire?()
        }
    }

    /// The content controller keeps its handlers strongly; the coordinator
    /// must not outlive its row through it.
    final class WeakHostHandler: NSObject, WKScriptMessageHandlerWithReply {
        weak var target: Coordinator?
        init(_ target: Coordinator) { self.target = target }

        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping (Any?, String?) -> Void
        ) {
            guard let target else { return replyHandler(nil, "gone") }
            target.handle(message, reply: replyHandler)
        }
    }

    /// Covers the window while a drawing is in full screen: the drawing
    /// below the title bar, a Done button in the title bar strip. Escape
    /// leaves too, even when the drawing does not take the key.
    final class FullscreenOverlay: NSView {
        var onClose: (() -> Void)?

        override func cancelOperation(_ sender: Any?) {
            onClose?()
        }

        @objc func close(_ sender: Any?) {
            onClose?()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedId: String?
        /// The id the row wants shown, read when the view first has a size.
        var wantedId: String?
        /// The widget whose page is in the view now. `loadedId` moves as soon
        /// as a fetch starts; tool calls must speak for the page on screen,
        /// which is the handed-over one only once its load has finished.
        private var shownId: String?
        private var pendingId: String?
        weak var webView: SizedWebView?
        weak var container: NSView?
        private var loading: Task<Void, Never>?
        private var overlay: FullscreenOverlay?
        var onUnavailable: (() -> Void)?
        var onLoaded: (() -> Void)?
        private var lastLinkOpen = Date.distantPast
        /// When a tool call that the reader's click started came back. The
        /// export's link follows that round trip, well after the click.
        private var clickedCallDone = Date.distantPast

        /// One client for every widget fetch. Each `BackendClient` owns a
        /// private cookie jar, so a fresh client pays a full sign-in
        /// (`security` CLI plus `POST /api/auth/session`); a per-load client
        /// would let widget scrolling burn through the auth rate limit.
        /// `DesktopEndpointPolicy` never rejects, so construction cannot fail.
        private static let client = try! BackendClient(base: ServerConfig.resolved().baseURL)

        deinit { loading?.cancel() }

        func cancel() {
            loading?.cancel()
            loading = nil
        }

        /// The page is fetched by the signed-in client and handed over as a
        /// string, so the web view holds no session cookie and never talks to
        /// the loopback server itself.
        func load(widgetId: String, into view: WKWebView) {
            loadedId = widgetId
            shownId = nil
            pendingId = nil
            clickedCallDone = .distantPast
            lastLinkOpen = .distantPast
            (view as? SizedWebView)?.forgetClick()
            loading?.cancel()
            loading = Task { @MainActor [weak view] in
                let client = Self.client
                // A live drawing renders before its save lands: a 404 in the
                // first seconds means "not yet", not "gone".
                for attempt in 0..<6 {
                    if Task.isCancelled { return }
                    do {
                        let html = try await client.widgetPage(id: widgetId)
                        if Task.isCancelled { return }
                        self.pendingId = widgetId
                        view?.loadHTMLString(html, baseURL: nil)
                        return
                    } catch BackendError.http(404) where attempt < 5 {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    } catch {
                        view?.loadHTMLString(Self.failurePage, baseURL: nil)
                        // Not final: the next view update fetches again.
                        self.loadedId = nil
                        self.onUnavailable?()
                        return
                    }
                }
            }
        }

        private static let failurePage = """
        <body style="font: 13px -apple-system; color: #888; margin: 16px">This drawing could not be loaded.</body>
        """

        // MARK: - Host bridge

        /// Requests the host page forwards for the app: a tool call, a link,
        /// a display mode. The handler is reachable from the app's own frame
        /// too, so only the host page (the main frame of this view) is heard.
        func handle(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
            guard let view = webView, message.webView === view, message.frameInfo.isMainFrame,
                  let body = message.body as? [String: Any], let kind = body["kind"] as? String else {
                return reply(nil, "refused")
            }
            switch kind {
            case "tool":
                guard let widgetId = shownId, let name = body["name"] as? String else {
                    return reply(nil, "refused")
                }
                guard let arguments = body["arguments"] as? [String: Any] else { return reply(nil, "refused") }
                let clicked = Self.justClicked(view)
                Task { @MainActor in
                    do {
                        // Same per-load rationale as `Self.client`: a fresh
                        // client per call pays a full sign-in each time.
                        let client = Self.client
                        let result = try await client.widgetToolCall(id: widgetId, name: name, arguments: arguments)
                        // Credit only the page that asked: a slow call from a
                        // page since replaced must not open links for the next.
                        if clicked, self.shownId == widgetId { self.clickedCallDone = Date() }
                        reply(result, nil)
                    } catch {
                        reply(nil, "tool_failed")
                    }
                }
            case "link":
                // A link opens only on the heels of a click in this drawing,
                // or of a tool call such a click started (the export). A page
                // acting on its own gets nothing.
                let fromClick = Self.justClicked(view) || Date().timeIntervalSince(clickedCallDone) < 3
                guard fromClick, let raw = body["url"] as? String, let url = Self.openableLink(raw) else {
                    return reply(nil, "link_refused")
                }
                // One link a second: a page cannot fire a burst of tabs.
                guard Date().timeIntervalSince(lastLinkOpen) > 1 else { return reply(nil, "link_refused") }
                lastLinkOpen = Date()
                clickedCallDone = .distantPast
                NSWorkspace.shared.open(url)
                reply([String: Any](), nil)
            case "status":
                // The host page says the drawing cannot be shown (its app was
                // unreachable): the row collapses instead of holding a blank.
                if body["status"] as? String == "unavailable" { onUnavailable?() }
                reply([String: Any](), nil)
            case "mode":
                // Full screen covers the whole window, so it too needs the
                // reader's click; leaving it never does.
                if body["mode"] as? String == "fullscreen" {
                    if Self.justClicked(view) { enterFullscreen() }
                } else {
                    leaveFullscreen(tellPage: false)
                }
                reply(["mode": overlay == nil ? "inline" : "fullscreen"], nil)
            default:
                reply(nil, "refused")
            }
        }

        /// A click this recent still counts as the reader asking.
        static func justClicked(_ view: SizedWebView) -> Bool {
            Date().timeIntervalSince(view.lastClick) < 2
        }

        /// Only public https addresses leave the app: no other schemes, no
        /// loopback or local names, no IP addresses in any spelling. A real
        /// public name ends in an all-letter top-level label; an address
        /// (127.0.0.1, 0x7f.0.0.1, [::1]) never does.
        static func openableLink(_ raw: String) -> URL? {
            guard raw.count <= 4096, let url = URL(string: raw),
                  url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
                  var host = url.host?.lowercased() else { return nil }
            if host.hasSuffix(".") { host.removeLast() }
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }),
                  let top = labels.last, top.count >= 2,
                  top.allSatisfy({ $0.isASCII && $0.isLetter }),
                  !["localhost", "local", "internal", "home", "lan"].contains(String(top)) else { return nil }
            return url
        }

        /// Move this web view over the window's content, below the title bar.
        /// The cover sits on the frame view just above the content view: as a
        /// subview of the SwiftUI hosting view it was drawn under the chat.
        private func enterFullscreen() {
            guard overlay == nil, let view = webView, let window = view.window,
                  let content = window.contentView, let frame = content.superview else { return }
            let cover = FullscreenOverlay(frame: frame.bounds)
            cover.autoresizingMask = [.width, .height]
            cover.wantsLayer = true
            cover.layer?.backgroundColor = NSColor.white.cgColor
            cover.onClose = { [weak self] in self?.leaveFullscreen(tellPage: true) }
            // The cover fills the frame view, so frame-view coordinates are
            // its own; it is not in the window yet to convert through.
            let drawing = frame.convert(window.contentLayoutRect, from: nil)
            let done = NSButton(title: "Done", target: cover, action: #selector(FullscreenOverlay.close(_:)))
            done.bezelStyle = .rounded
            done.controlSize = .small
            done.sizeToFit()
            // Level with the traffic lights, mirrored to the right edge.
            var midY = cover.bounds.maxY - 20
            if let lights = window.standardWindowButton(.closeButton), let bar = lights.superview {
                midY = frame.convert(lights.frame, from: bar).midY
            }
            done.setFrameOrigin(NSPoint(
                x: cover.bounds.maxX - done.frame.width - 16,
                y: midY - done.frame.height / 2
            ))
            done.autoresizingMask = [.minXMargin, .minYMargin]
            view.removeFromSuperview()
            view.frame = drawing
            cover.addSubview(view)
            cover.addSubview(done)
            frame.addSubview(cover, positioned: .above, relativeTo: content)
            overlay = cover
            window.makeFirstResponder(view)
        }

        /// Put the web view back in its row. `tellPage` when the app did not
        /// ask for it, so its toolbar stops showing the full-screen state.
        func leaveFullscreen(tellPage: Bool) {
            guard let cover = overlay else { return }
            overlay = nil
            if let view = webView {
                view.removeFromSuperview()
                if let container {
                    view.frame = container.bounds
                    container.addSubview(view)
                }
                if tellPage {
                    view.evaluateJavaScript("window.ubHostContext && window.ubHostContext({ displayMode: 'inline' })")
                }
            }
            cover.removeFromSuperview()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let pendingId {
                shownId = pendingId
                self.pendingId = nil
                // The frame is in, the app inside it draws a beat later.
                let loaded = onLoaded
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { loaded?() }
            }
        }

        /// Only the page handed over above and the srcdoc frame inside it.
        /// Nothing in here may navigate to a real address, loopback included.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            decisionHandler(scheme == "about" ? .allow : .cancel)
        }
    }
}

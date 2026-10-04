import AppKit
import CryptoKit
import SwiftUI
import UsefulBotCore
import WebKit

/// An HTML page a bot wrote, in the transcript: a picture of the page at
/// chat width, its title under it, and Open on hover, which hands the file
/// to the default browser. The page itself never runs in the chat; a
/// snapshot of it does.
struct PageRow: View {
    let mediaId: String
    let title: String

    private enum State { case loading, ready(MediaItem, NSImage?), moved, failed }

    @SwiftUI.State private var state: State = .loading
    @SwiftUI.State private var hovering = false
    /// Set by the Library's word that the item is gone, so a load still in
    /// flight cannot bring the picture back.
    @SwiftUI.State private var gone = false

    static let width: CGFloat = 448
    static let height: CGFloat = 280

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            content
            HStack(spacing: 6) {
                Image(systemName: "globe")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.C.inkMuted)
                Text(title.isEmpty ? "Page" : title)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkFaint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: Self.width, alignment: .leading)
        }
        .task(id: mediaId) { await load() }
        // The file can go while the picture stays: trashed from the Library,
        // or moved or deleted in Finder while the app was in the background.
        .onReceive(NotificationCenter.default.publisher(for: .mediaItemGone)) { note in
            if note.object as? String == mediaId {
                gone = true
                state = .moved
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            recheck()
        }
        .onAppear { recheck() }
    }

    @ViewBuilder private var content: some View {
        switch state {
        case .loading:
            placeholder { ProgressView().controlSize(.small) }
        case .ready(let item, let image):
            let url = URL(fileURLWithPath: item.path)
            Button {
                if FileManager.default.fileExists(atPath: url.path) {
                    PageOpener.open(url)
                } else {
                    state = .moved
                }
            } label: {
                ZStack(alignment: .topTrailing) {
                    Group {
                        if let image {
                            Image(nsImage: image)
                                .resizable()
                                .scaledToFill()
                        } else {
                            Theme.C.sunken
                                .overlay {
                                    Image(systemName: "globe")
                                        .font(.system(size: 22))
                                        .foregroundStyle(Theme.C.inkFaint)
                                }
                        }
                    }
                    .frame(width: Self.width, height: Self.height, alignment: .top)
                    .clipped()
                    if hovering {
                        PageOpenChip()
                            .padding(10)
                            .transition(.opacity)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                .cardLift(cornerRadius: DesignTokens.Radius.md)
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .onHover { inside in
                withAnimation(.easeOut(duration: DesignTokens.Motion.overlay)) { hovering = inside }
            }
            .help("Open in your browser")
            .accessibilityLabel(Text(title.isEmpty ? "Page" : title))
            .accessibilityHint("Opens the page in your browser")
        case .moved, .failed:
            HStack(spacing: 8) {
                Image(systemName: "globe")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                Text(isMoved ? "Page moved or deleted" : "Page unavailable")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer(minLength: 0)
                if !isMoved {
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.plain)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.C.ink)
                        .pointerOnHover()
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 52)
            .frame(maxWidth: Self.width, alignment: .leading)
            .background(Theme.C.bubbleBot)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
            .cardLift(cornerRadius: DesignTokens.Radius.md)
        }
    }

    /// A picture of a file that is no longer there turns into the moved row.
    private func recheck() {
        guard case .ready(let item, _) = state else { return }
        if !FileManager.default.fileExists(atPath: item.path) { state = .moved }
    }

    private var isMoved: Bool {
        if case .moved = state { return true }
        return false
    }

    private func placeholder(@ViewBuilder _ inner: () -> some View) -> some View {
        RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
            .fill(Theme.C.sunken)
            .frame(width: Self.width, height: Self.height)
            .overlay { inner() }
    }

    private func load() async {
        guard !gone else { return }
        state = .loading
        do {
            guard let item = try await GeneratedImageCache.shared.mediaItem(mediaId), item.exists else {
                state = .moved
                return
            }
            let image = await PageThumbnails.shared.thumbnail(path: item.path)
            // The file may have gone while the picture rendered.
            guard !gone, FileManager.default.fileExists(atPath: item.path) else {
                state = .moved
                return
            }
            state = .ready(item, image)
        } catch {
            state = gone ? .moved : .failed
        }
    }
}

extension Notification.Name {
    /// Posted with the media id as the object when the Library trashes or
    /// forgets an item, so a chat row still showing it can let go.
    static let mediaItemGone = Notification.Name("ai.useful.bot.mediaItemGone")
}

/// The hover chip on a page's picture.
struct PageOpenChip: View {
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.up.right")
                .font(.system(size: 11, weight: .semibold))
            Text("Open")
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(Theme.C.ink)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Theme.C.surface)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.C.edge, lineWidth: 1))
    }
}

/// Pages open in the default browser, not in whatever app claims .html.
enum PageOpener {
    @MainActor
    static func open(_ url: URL) {
        let workspace = NSWorkspace.shared
        guard let probe = URL(string: "https://example.com"),
              let browser = workspace.urlForApplication(toOpen: probe) else {
            workspace.open(url)
            return
        }
        workspace.open([url], withApplicationAt: browser, configuration: NSWorkspace.OpenConfiguration())
    }
}

/// Pictures of HTML pages, rendered off screen one at a time and kept by
/// path and modification date, in memory and in the app's cache folder, so
/// a page the bot rewrites gets a new picture and an unchanged one never
/// renders twice.
@MainActor
final class PageThumbnails {
    static let shared = PageThumbnails()

    private let memory = NSCache<NSString, NSImage>()
    private var pending: [String: Task<NSImage?, Never>] = [:]
    /// Renders run one after another: each is a web content process.
    private var tail: Task<Void, Never>?

    private static let viewport = NSSize(width: 1280, height: 800)
    private static let cacheDir: URL? = FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask).first
        .map { AppVariant.current.pagesCacheDirectory(caches: $0) }

    func thumbnail(path: String) async -> NSImage? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = Self.key(path: path, modified: modified)
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let running = pending[key] { return await running.value }
        let previous = tail
        let task = Task<NSImage?, Never> {
            await previous?.value
            if let cached = Self.readDisk(key) { return cached }
            let image = await PageSnapshot.render(URL(fileURLWithPath: path), viewport: Self.viewport)
            if let image { Self.writeDisk(key, image) }
            return image
        }
        pending[key] = task
        tail = Task { _ = await task.value }
        let image = await task.value
        pending[key] = nil
        if let image { memory.setObject(image, forKey: key as NSString) }
        return image
    }

    private static func key(path: String, modified: TimeInterval) -> String {
        let digest = SHA256.hash(data: Data("\(path)|\(modified)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func readDisk(_ key: String) -> NSImage? {
        guard let url = cacheDir?.appendingPathComponent("\(key).png") else { return nil }
        return NSImage(contentsOf: url)
    }

    private static func writeDisk(_ key: String, _ image: NSImage) {
        guard let dir = cacheDir,
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try png.write(to: dir.appendingPathComponent("\(key).png"), options: .atomic)
        } catch {
            NSLog("[pages] could not cache a page picture: \(error.localizedDescription)")
        }
    }
}

/// One off-screen render. The page may read only its own file (not its
/// folder: a bot can write a page into the home folder, and a script in it
/// must not reach the files around it), keeps no cookies or storage, and
/// cannot navigate anywhere: a link or a redirect is refused, so the picture
/// is always of the file itself. Scripts run, so a chart draws; assets in
/// other files do not load here, only in the browser.
@MainActor
private final class PageSnapshot: NSObject, WKNavigationDelegate {
    private let url: URL
    private let webView: WKWebView
    private var continuation: CheckedContinuation<NSImage?, Never>?

    private init(url: URL, viewport: NSSize) {
        self.url = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(origin: .zero, size: viewport), configuration: configuration)
        super.init()
        webView.navigationDelegate = self
    }

    static func render(_ url: URL, viewport: NSSize) async -> NSImage? {
        let snapshot = PageSnapshot(url: url, viewport: viewport)
        return await withCheckedContinuation { continuation in
            snapshot.continuation = continuation
            snapshot.webView.loadFileURL(url, allowingReadAccessTo: url)
            // A page that never finishes loading still gets a picture of what
            // it drew, or none, but never holds the queue: a script that
            // hangs the page can stall the snapshot itself, so a hard stop
            // follows the capture.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { snapshot.capture() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { snapshot.finish(nil) }
        }
    }

    private func finish(_ image: NSImage?) {
        guard let continuation else { return }
        self.continuation = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        continuation.resume(returning: image)
    }

    private func capture() {
        guard continuation != nil else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = 896
        webView.takeSnapshot(with: configuration) { [self] image, error in
            if let error { NSLog("[pages] snapshot failed: \(error.localizedDescription)") }
            finish(image)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A beat for scripts and fonts that draw after load.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [self] in capture() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[pages] page failed to load: \(error.localizedDescription)")
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[pages] page failed to load: \(error.localizedDescription)")
        finish(nil)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let target = navigationAction.request.url
        let isThePage = target?.isFileURL == true && target?.standardizedFileURL == url.standardizedFileURL
        // An embedded frame may show web content, never another local file.
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        let isWebFrame = !isMainFrame && (target?.scheme == "https" || target?.scheme == "http" || target?.scheme == "about")
        decisionHandler(isThePage || isWebFrame ? .allow : .cancel)
    }
}

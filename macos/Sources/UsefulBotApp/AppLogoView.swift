import AppKit
import SwiftUI
import UsefulBotCore

/// An app's logo from Composio, or its initial on a sunken tile when there is
/// none or it fails to load. Composio serves SVG, which AsyncImage cannot
/// decode, so the bytes are fetched and handed to NSImage, which can.
struct AppLogo: View {
    let name: String
    let url: String?
    var size: CGFloat = 28

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
        .accessibilityHidden(true)
        .task(id: url) {
            image = await LogoCache.shared.image(for: url)
        }
    }

    private var initial: some View {
        ZStack {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                .fill(Theme.C.sunken)
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.C.inkMuted)
        }
    }
}

/// One fetch per logo URL for the life of the process; a failure is not
/// cached, so a flaky load is retried the next time the row appears. Only
/// Composio's logo host is fetched, so a row's logo field cannot point the
/// app at anything else, and the cache is capped.
actor LogoCache {
    static let shared = LogoCache()
    private static let host = "logos.composio.dev"
    private static let maxEntries = 400
    private var images: [String: NSImage] = [:]
    private var inFlight: [String: Task<NSImage?, Never>] = [:]

    func image(for urlString: String?) async -> NSImage? {
        guard let urlString, let url = URL(string: urlString), url.scheme == "https",
              url.host?.lowercased() == Self.host else { return nil }
        if let cached = images[urlString] { return cached }
        if let running = inFlight[urlString] { return await running.value }
        let task = Task<NSImage?, Never> {
            // The allowlist is checked again on the final URL, since a redirect
            // could otherwise carry the fetch off the logo host.
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  http.url?.scheme == "https", http.url?.host?.lowercased() == Self.host,
                  data.count < 512 * 1024,
                  let image = NSImage(data: data) else { return nil }
            return image
        }
        inFlight[urlString] = task
        let result = await task.value
        inFlight[urlString] = nil
        if let result {
            if images.count >= Self.maxEntries { images.removeAll() }
            images[urlString] = result
        }
        return result
    }
}

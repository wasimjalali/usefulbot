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
    /// A logo the server already holds as bytes; wins over `url`, and an unreadable one falls back to the monogram.
    var data: Data? = nil

    @State private var image: NSImage?
    /// The key of the bytes `image` was decoded from, so the task skips a decode already done in init.
    @State private var decodedKey: String?

    init(name: String, url: String?, size: CGFloat = 28, data: Data? = nil) {
        self.name = name
        self.url = url
        self.size = size
        self.data = data
        // Built here, not in the task, so a tile that has the bytes never shows the monogram first.
        _image = State(initialValue: data.flatMap { NSImage(data: $0) })
        _decodedKey = State(initialValue: data.map(Self.dataKey))
    }

    private static func dataKey(_ data: Data) -> String {
        let head = data.prefix(16).map { String($0, radix: 16) }.joined()
        let tail = data.suffix(16).map { String($0, radix: 16) }.joined()
        // A cheap checksum of every 64th byte, so same-size icons that share both ends still differ.
        let sampled = stride(from: 0, to: data.count, by: 64).reduce(UInt32(0)) { ($0 &* 31) &+ UInt32(data[data.startIndex + $1]) }
        return "\(data.count):\(head):\(tail):\(sampled)"
    }

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
        // Keyed on the byte count and a short prefix: hashing the whole icon on every body pass is wasted work.
        .task(id: "\(url ?? "")|\(data.map(Self.dataKey) ?? "")") {
            if let data {
                let key = Self.dataKey(data)
                if decodedKey != key {
                    image = NSImage(data: data)
                    decodedKey = key
                }
            } else {
                image = await LogoCache.shared.image(for: url)
            }
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

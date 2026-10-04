import Foundation

/// One tile of the Connectors "Added" grid: a Composio app or a direct MCP or
/// OpenAPI server, in the same shape.
public struct ConnectorTile: Identifiable, Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case app(ConnectorToolkit)
        case server(DirectConnection)
    }

    /// The right-hand mark of a tile.
    public enum Mark: Equatable, Sendable {
        case added
        case warning(String)
        case checking
    }

    public let id: String
    public let name: String
    public let source: Source
    public let status: String
    public let mark: Mark
    /// A Composio logo URL, for apps.
    public let logoURL: String?
    /// The server's own logo as a data URI, for servers.
    public let iconData: Data?

    public var isReady: Bool { mark == .added }

    public static func appId(_ slug: String) -> String { "app:\(slug)" }
    public static func serverId(_ id: String) -> String { "server:\(id)" }

    public init(app: ConnectorToolkit) {
        id = Self.appId(app.slug)
        name = app.name
        source = .app(app)
        status = "Ready to use"
        mark = .added
        logoURL = app.logo
        iconData = nil
    }

    public init(server: DirectConnection) {
        id = Self.serverId(server.id)
        name = server.name
        source = .server(server)
        status = Self.statusLine(server.state)
        mark = Self.mark(server.state)
        logoURL = nil
        iconData = Self.decodeIcon(server.icon)
    }

    /// The plain-words line under a server's name.
    public static func statusLine(_ state: DirectConnection.State) -> String {
        switch state {
        case .ready: return "Ready to use"
        case .pending: return "Checking..."
        case .zeroTools: return "No tools"
        case .authFailed: return "Needs sign-in"
        case .expired: return "Sign-in expired"
        case .unreachable: return "Can't reach server"
        case .malformed: return "Tools unreadable"
        case .discoveryFailed: return "Couldn't list tools"
        case .unknown: return "Status unknown"
        }
    }

    public static func mark(_ state: DirectConnection.State) -> Mark {
        switch state {
        case .ready: return .added
        case .pending: return .checking
        default: return .warning("Not ready")
        }
    }

    /// Ready tiles first, then by name, ignoring case; ties keep the apps before the servers.
    public static func merge(apps: [ConnectorToolkit], servers: [DirectConnection]) -> [ConnectorTile] {
        let tiles = apps.filter(\.connected).map(ConnectorTile.init(app:)) + servers.map(ConnectorTile.init(server:))
        return tiles.enumerated().sorted { a, b in
            if a.element.isReady != b.element.isReady { return a.element.isReady }
            let order = a.element.name.compare(b.element.name, options: [.caseInsensitive, .diacriticInsensitive])
            if order != .orderedSame { return order == .orderedAscending }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// The bytes of a `data:image/...;base64,` URI the server cached, or nil
    /// for anything else, so the tile falls back to its monogram.
    public static func decodeIcon(_ uri: String?) -> Data? {
        guard let uri, uri.hasPrefix("data:image/") else { return nil }
        return iconCache.data(for: uri) {
            guard let comma = uri.firstIndex(of: ","), uri[..<comma].hasSuffix(";base64"),
                  let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])),
                  !data.isEmpty, data.count <= 64 * 1024 else { return nil }
            return data
        }
    }

    /// Tiles are rebuilt on every refresh; the same icon is decoded once.
    private static let iconCache = IconDecodeCache()

    private final class IconDecodeCache: @unchecked Sendable {
        private let lock = NSLock()
        private var decoded: [String: Data?] = [:]

        func data(for uri: String, decode: () -> Data?) -> Data? {
            lock.lock()
            defer { lock.unlock() }
            if let hit = decoded[uri] { return hit }
            let value = decode()
            if decoded.count >= 64 { decoded.removeAll() }
            decoded[uri] = .some(value)
            return value
        }
    }
}

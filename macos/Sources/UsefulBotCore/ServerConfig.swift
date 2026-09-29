#if os(macOS)
import Foundation

public struct ServerConfig: Equatable {
    public var repoPath: String
    public var port: Int

    public static let defaultRepoPath = "~/Desktop/useful-bot"
    public static let defaultPort = 4320
    /// The supervised `scripts/service.mjs` stack binds a fixed set of ports
    /// (router 4319, web 4320, eve 4321), so the launcher cannot serve any
    /// other web port. A stored override outside this set would leave startup
    /// probing a port nothing ever listens on.
    public static let supervisedPorts: Set<Int> = [defaultPort]

    public static func resolved(defaults: UserDefaults = .standard) -> ServerConfig {
        // A release build runs the services it carries (RuntimeInstall); a dev
        // build runs the checkout.
        let fallback = RuntimeInstall.bundledRuntime() != nil ? RuntimeInstall.installRoot.path : defaultRepoPath
        let repo = defaults.string(forKey: "repoPath") ?? fallback
        let stored = defaults.object(forKey: "port") as? Int ?? defaultPort
        return ServerConfig(repoPath: repo, port: stored)
    }

    public init(repoPath: String = ServerConfig.defaultRepoPath, port: Int = ServerConfig.defaultPort) {
        self.repoPath = (repoPath as NSString).expandingTildeInPath
        // Only the supervised port is servable, and a value outside the TCP
        // range would make `URL(string:)` return nil behind a force unwrap.
        // Both cases fall back to the default instead of trapping at launch.
        self.port = ServerConfig.supervisedPorts.contains(port) ? port : ServerConfig.defaultPort
    }

    public var baseURL: URL {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        // Scheme, host and a supervised port always produce a URL; the literal
        // fallback is fixed at compile time and cannot fail.
        return components.url ?? URL(string: "http://127.0.0.1:\(ServerConfig.defaultPort)")!
    }

    public var healthURL: URL { baseURL.appendingPathComponent("api/health") }
}
#endif

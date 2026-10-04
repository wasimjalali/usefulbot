#if os(macOS)
import Foundation

public struct ServerConfig: Equatable {
    public var repoPath: String
    public var port: Int
    /// Which stack this config is for. It fixes the web port, so a config for
    /// one stack can never point at the other's services.
    public var variant: AppVariant

    public static let defaultRepoPath = "~/Desktop/useful-bot"
    /// The running app's web port (4320 for the daily app, 4420 for dev).
    public static var defaultPort: Int { AppVariant.current.webPort }

    public static func resolved(defaults: UserDefaults = .standard, variant: AppVariant = .current) -> ServerConfig {
        // A release build runs the services it carries (RuntimeInstall), unless a
        // `repoPath` points it at a checkout. The dev build always runs its own
        // copy: a stored path (the checkout, or the daily install) never moves it.
        let repo: String
        switch variant {
        case .dev:
            repo = RuntimeInstall.installRoot(variant: variant).path
        case .daily:
            let fallback = RuntimeInstall.bundledRuntime(variant: variant) != nil
                ? RuntimeInstall.installRoot(variant: variant).path
                : defaultRepoPath
            repo = defaults.string(forKey: "repoPath") ?? fallback
        }
        let stored = defaults.object(forKey: "port") as? Int ?? variant.webPort
        return ServerConfig(repoPath: repo, port: stored, variant: variant)
    }

    public init(repoPath: String = ServerConfig.defaultRepoPath, port: Int = ServerConfig.defaultPort, variant: AppVariant = .current) {
        self.repoPath = (repoPath as NSString).expandingTildeInPath
        self.variant = variant
        // The supervised `scripts/service.mjs` stack binds a fixed set of
        // ports, so the launcher cannot serve any other web port: only the
        // variant's own is servable. A stored override outside it (or outside
        // the TCP range, which would make `URL(string:)` return nil behind a
        // force unwrap) falls back to the variant's port instead of leaving
        // startup probing a port nothing listens on.
        self.port = port == variant.webPort ? port : variant.webPort
    }

    public var baseURL: URL {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        // Scheme, host and the variant's port always produce a URL; the
        // fallback is the variant's own and cannot fail.
        return components.url ?? variant.webBaseURL
    }

    public var healthURL: URL { baseURL.appendingPathComponent("api/health") }
}
#endif

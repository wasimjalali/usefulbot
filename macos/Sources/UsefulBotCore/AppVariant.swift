import Foundation

/// Which Useful Bot this is: the daily app people use, or the "dev" build that
/// runs next to it and must never share anything with it (bundle id, ports,
/// state folder, Keychain items, caches, logs). Every value that tells them
/// apart is read from one case here, so a half-configured build cannot exist.
///
/// The variant comes from the bundle's `UBVariant` key (`macos/build-app.sh`
/// writes it for the dev build). No key means daily: the daily bundle and a
/// bare `swift run` carry none, so daily behaves exactly as it always did.
public enum AppVariant: Equatable, Sendable, CaseIterable {
    case daily
    case dev

    /// Info.plist key holding the variant.
    public static let plistKey = "UBVariant"

    public enum ResolveError: Error, Equatable, CustomStringConvertible {
        case unknownVariant(String)
        case notAString

        public var description: String {
            switch self {
            case .unknownVariant(let value): return "Info.plist \(AppVariant.plistKey) is \"\(value)\"; the only value is \"dev\"."
            case .notAString: return "Info.plist \(AppVariant.plistKey) is not a string."
            }
        }
    }

    /// Absent means daily, "dev" means dev, anything else is an error: a typo
    /// must never run the daily app's state under a dev build.
    public static func resolve(infoDictionary: [String: Any]?) throws -> AppVariant {
        guard let raw = infoDictionary?[plistKey] else { return .daily }
        guard let value = raw as? String else { throw ResolveError.notAString }
        guard value == "dev" else { throw ResolveError.unknownVariant(value) }
        return .dev
    }

    /// The running bundle's variant. Read once. A bundle whose key is junk
    /// stops here rather than run as either app; the launch check
    /// (`LaunchCheck`) reports it to the owner first, so this is the
    /// backstop for code that runs before it.
    public static let current: AppVariant = {
        do {
            return try resolve(infoDictionary: Bundle.main.infoDictionary)
        } catch {
            fatalError("Useful Bot cannot start: \(error)")
        }
    }()

    // MARK: - Identity

    public enum IdentityError: Error, Equatable, CustomStringConvertible {
        case bundleIdentifier(expected: String, found: String?)
        case executable(expected: String, found: String?)
        case notAnAppBundle

        public var description: String {
            switch self {
            case .bundleIdentifier(let expected, let found):
                return "The bundle id is \(found ?? "missing") but this build is configured for \(expected)."
            case .executable(let expected, let found):
                return "The executable is \(found ?? "missing") but this build is configured for \(expected)."
            case .notAnAppBundle:
                return "A dev build only runs from its app bundle."
            }
        }
    }

    /// The bundle's own id and executable must be the variant's. A dev
    /// variant under the daily id (or the reverse) would share Launch
    /// Services, Keychain and defaults with the wrong app, so it never runs.
    /// A bare binary (`swift run`) has no bundle and is only ever daily.
    public func validateIdentity(bundleIdentifier: String?, executableName: String?, isAppBundle: Bool) throws {
        if !isAppBundle {
            guard self == .daily else { throw IdentityError.notAnAppBundle }
            return
        }
        guard bundleIdentifier == self.bundleIdentifier else {
            throw IdentityError.bundleIdentifier(expected: self.bundleIdentifier, found: bundleIdentifier)
        }
        guard executableName == self.executableName else {
            throw IdentityError.executable(expected: self.executableName, found: executableName)
        }
    }

    // MARK: - The table

    /// What the services report as `stack` in their health answers.
    public var stackName: String {
        switch self {
        case .daily: return "daily"
        case .dev: return "dev"
        }
    }

    public var bundleIdentifier: String {
        switch self {
        case .daily: return "ai.useful.bot"
        case .dev: return "ai.useful.bot.dev"
        }
    }

    public var displayName: String {
        switch self {
        case .daily: return "Useful Bot"
        case .dev: return "Useful Bot Dev"
        }
    }

    public var executableName: String {
        switch self {
        case .daily: return "UsefulBotApp"
        case .dev: return "UsefulBotDevApp"
        }
    }

    public var appBundleName: String { displayName + ".app" }

    /// Where the installed copy lives: the shared Applications folder for
    /// the daily app, the user's own for dev.
    public func installURL(home: URL) -> URL {
        switch self {
        case .daily: return URL(fileURLWithPath: "/Applications", isDirectory: true).appendingPathComponent(appBundleName, isDirectory: true)
        case .dev: return home.appendingPathComponent("Applications", isDirectory: true).appendingPathComponent(appBundleName, isDirectory: true)
        }
    }

    public var routerPort: Int {
        switch self {
        case .daily: return 4319
        case .dev: return 4419
        }
    }

    public var webPort: Int {
        switch self {
        case .daily: return 4320
        case .dev: return 4420
        }
    }

    public var evePort: Int {
        switch self {
        case .daily: return 4321
        case .dev: return 4421
        }
    }

    private func loopback(_ port: Int, _ path: String = "") -> URL {
        // A literal host and an integer port always make a URL.
        URL(string: "http://127.0.0.1:\(port)\(path)")!
    }

    public var webBaseURL: URL { loopback(webPort) }
    public var routerHealthURL: URL { loopback(routerPort, "/health/live") }
    public var eveHealthURL: URL { loopback(evePort, "/eve/v1/health") }

    /// The Keychain service names are `<prefix>.<item>`: the services read
    /// them through `UB_KEYCHAIN_PREFIX`, the app reads the desktop token.
    public var keychainPrefix: String {
        switch self {
        case .daily: return "com.usefulbot"
        case .dev: return "com.usefulbot.dev"
        }
    }

    public var deviceTokenService: String { keychainPrefix + ".device.desktop" }

    /// The folder the services keep config, stores and sessions in.
    /// (`~/.useful-bot-dev` holds older owner data and is never the dev root.)
    public func stateRoot(home: URL) -> URL {
        switch self {
        case .daily: return home.appendingPathComponent(".useful-bot", isDirectory: true)
        case .dev: return home.appendingPathComponent(".useful-bot-dev-app", isDirectory: true)
        }
    }

    /// Where generated media and downloaded files land.
    public func mediaDirectory(home: URL) -> URL {
        home.appendingPathComponent("Documents", isDirectory: true).appendingPathComponent(displayName, isDirectory: true)
    }

    public func logsDirectory(home: URL) -> URL {
        let name: String
        switch self {
        case .daily: name = "UsefulBot"
        case .dev: name = "UsefulBotDev"
        }
        return home.appendingPathComponent("Library/Logs", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    }

    /// `~/Library/Caches/UsefulBot/chat-snapshots` (daily, as it always was),
    /// `~/Library/Caches/<bundle id>/chat-snapshots` (dev).
    public func snapshotsCacheDirectory(caches: URL) -> URL {
        let folder: String
        switch self {
        case .daily: folder = "UsefulBot"
        case .dev: folder = bundleIdentifier
        }
        return caches.appendingPathComponent(folder, isDirectory: true).appendingPathComponent("chat-snapshots", isDirectory: true)
    }

    /// Rendered page thumbnails: `~/Library/Caches/<bundle id>/pages`.
    public func pagesCacheDirectory(caches: URL) -> URL {
        caches.appendingPathComponent(bundleIdentifier, isDirectory: true).appendingPathComponent("pages", isDirectory: true)
    }

    /// `~/Library/Application Support/<display name>`.
    public func appSupportDirectory(support: URL) -> URL {
        support.appendingPathComponent(displayName, isDirectory: true)
    }

    public var logSubsystem: String {
        switch self {
        case .daily: return "com.usefulbot.app"
        case .dev: return "com.usefulbot.app.dev"
        }
    }

    // MARK: - What a variant may do

    /// Both carry their own services and run them from a copy under their own
    /// Application Support folder (RuntimeInstall), never from a checkout: an
    /// ad hoc signed dev build gets a new macOS privacy grant for the Desktop
    /// folder on every rebuild, and a service reading the checkout blocks on it.
    /// The dev payload is built from the working tree (`UB_VARIANT=dev`).
    public var usesRuntimePayload: Bool { true }
    public var allowsMoveToApplications: Bool { self == .daily }
    /// Sparkle: only the daily app updates itself from the release feed.
    public var allowsUpdater: Bool { self == .daily }
    /// Settings > Feedback posts to the production Worker.
    public var allowsFeedback: Bool { self == .daily }

    /// What the app adds to the environment it gives each service. Daily adds
    /// nothing, so its services start exactly as they always did. Dev passes
    /// every setting that keeps its stack apart; the services refuse to start
    /// in dev with any of them missing.
    public func serviceEnvironment(home: URL) -> [String: String] {
        switch self {
        case .daily:
            return [:]
        case .dev:
            return [
                "UB_STACK": stackName,
                "UB_STATE_ROOT": stateRoot(home: home).path,
                "UB_ROUTER_PORT": String(routerPort),
                "UB_WEB_PORT": String(webPort),
                "UB_EVE_PORT": String(evePort),
                "UB_KEYCHAIN_PREFIX": keychainPrefix,
                "UB_MEDIA_DIR": mediaDirectory(home: home).path,
                "UB_WEB_BASE_URL": webBaseURL.absoluteString,
            ]
        }
    }

    // MARK: - Readiness

    /// Ready means healthy on our ports AND reporting our stack. Healthy while
    /// reporting another stack is foreign: it is never adopted and never
    /// signalled. Daily also accepts an answer with no stack field (the
    /// services it runs today have none); dev does not.
    public func readiness(of reading: HealthReading?) -> ServiceReadiness {
        guard let reading else { return .down }
        switch self {
        case .daily:
            if reading.stack == nil || reading.stack == stackName { return .ready }
            return .foreign(found: reading.stack)
        case .dev:
            return reading.stack == stackName ? .ready : .foreign(found: reading.stack)
        }
    }
}

/// A health endpoint that answered 200, and the stack it says it belongs to.
public struct HealthReading: Equatable, Sendable {
    public var stack: String?

    public init(stack: String?) {
        self.stack = stack
    }

    /// From a response body. A body that is not JSON, or has no string
    /// `stack`, reports none.
    public init(body: Data) {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        self.stack = object?["stack"] as? String
    }
}

public enum ServiceReadiness: Equatable, Sendable {
    case ready
    case down
    /// Healthy, but it belongs to another stack (or does not say).
    case foreign(found: String?)
}

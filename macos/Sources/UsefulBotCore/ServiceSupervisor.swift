#if os(macOS)
import Foundation

public struct ServiceCommand: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var workingDirectory: String

    public init(executable: String, arguments: [String], workingDirectory: String) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
    }
}

public enum ServiceMode: String, Sendable {
    case router
    case eve
    case web
}

public struct ServiceSupervisor: Sendable {
    public static let webPort = 4320
    public static let routerPort = 4319
    public static let evePort = 4321

    /// Node in the order Homebrew and the installer put it. Intel Homebrew and
    /// the setup script use `/usr/local`; Apple Silicon Homebrew uses
    /// `/opt/homebrew`, so a single hardcoded path would fail there.
    public static let nodeCandidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"]

    public static let routerHealthURL = URL(string: "http://127.0.0.1:4319/health/live")!
    public static let eveHealthURL = URL(string: "http://127.0.0.1:4321/eve/v1/health")!

    /// Executable check, injectable so a test can exercise the node-missing
    /// path without touching the filesystem.
    private let nodeExists: @Sendable (String) -> Bool

    public init(nodeExists: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) {
        self.nodeExists = nodeExists
    }

    /// First candidate that exists, or the preferred path when none do. The
    /// predicate is injectable so the order is testable without a filesystem.
    /// A release runtime carries its own Node at `bin/node` and comes first.
    public static func resolveNodePath(
        repoPath: String? = nil,
        exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> String {
        let bundled = repoPath.map { ($0 as NSString).appendingPathComponent("bin/node") }
        return ([bundled].compactMap { $0 } + nodeCandidates).first(where: exists) ?? nodeCandidates[0]
    }

    public func isNodeAvailable(repoPath: String) -> Bool {
        nodeExists(Self.resolveNodePath(repoPath: repoPath, exists: nodeExists))
    }

    public func scriptPath(repoPath: String) -> String {
        (repoPath as NSString).appendingPathComponent("scripts/service.mjs")
    }

    public func command(mode: ServiceMode, repoPath: String) -> ServiceCommand {
        ServiceCommand(
            executable: Self.resolveNodePath(repoPath: repoPath),
            arguments: [scriptPath(repoPath: repoPath), mode.rawValue],
            workingDirectory: repoPath
        )
    }

    /// True only for the supervised stack of this checkout. The supervised
    /// script is matched by its full path; the relative markers additionally
    /// require the command line to sit inside `repoPath`, so an unrelated
    /// Next.js or eve process on the same port is never signalled.
    public func isOwnNodeProcess(_ commandLine: String, repoPath: String) -> Bool {
        if commandLine.contains(scriptPath(repoPath: repoPath)) { return true }
        // A raw substring match would also match a sibling checkout whose
        // path extends this one (`useful-bot-2`), so the repo path only
        // counts on a path boundary. The bare suffix covers the
        // working-directory fallback, which appends the path with nothing
        // after it.
        guard commandLine.contains(repoPath + "/") || commandLine.hasSuffix(repoPath) else { return false }
        return commandLine.contains("next/dist/bin/next")
            || commandLine.contains("next-server")
            // The built web server, before it renames itself `next-server`.
            || commandLine.contains("web/.next/standalone/web/server.js")
            || commandLine.contains("router/src/index.ts")
            || commandLine.contains("eve/bin/eve.js")
    }
}
#endif

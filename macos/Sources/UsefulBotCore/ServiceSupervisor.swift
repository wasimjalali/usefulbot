#if os(macOS)
import Foundation

public struct ServiceCommand: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var workingDirectory: String
    /// Added to the service's environment on top of the runner's whitelist.
    /// Empty for the daily app, so its services start as they always did.
    public var environment: [String: String]

    public init(executable: String, arguments: [String], workingDirectory: String, environment: [String: String] = [:]) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

public enum ServiceMode: String, Sendable {
    case router
    case engine
    case web
}

public struct ServiceSupervisor: Sendable {
    /// Node in the order Homebrew and the installer put it. Intel Homebrew and
    /// the setup script use `/usr/local`; Apple Silicon Homebrew uses
    /// `/opt/homebrew`, so a single hardcoded path would fail there.
    public static let nodeCandidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"]

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

    public func command(mode: ServiceMode, repoPath: String, variant: AppVariant = .current) -> ServiceCommand {
        ServiceCommand(
            executable: Self.resolveNodePath(repoPath: repoPath),
            arguments: [scriptPath(repoPath: repoPath), mode.rawValue],
            workingDirectory: repoPath,
            environment: variant.serviceEnvironment(home: FileManager.default.homeDirectoryForCurrentUser)
        )
    }

    /// True for the `service.mjs` launcher of exactly this install and mode: the
    /// command line ends in `<repoPath>/scripts/service.mjs <mode>` and that
    /// path starts a token, so `Useful Bot/app` never matches `Useful Bot Dev/app`
    /// or a longer path that merely ends the same way.
    public func isStrayServiceLine(_ commandLine: String, mode: ServiceMode, repoPath: String) -> Bool {
        let tail = scriptPath(repoPath: repoPath) + " " + mode.rawValue
        let line = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.hasSuffix(tail) else { return false }
        let before = line.dropLast(tail.count)
        return before.isEmpty || before.last == " "
    }

    /// True only for the supervised stack of this checkout. The supervised
    /// script is matched by its full path; the relative markers additionally
    /// require the command line to sit inside `repoPath`, so an unrelated
    /// Next.js process on the same port is never signalled.
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
            || commandLine.contains("agent/server.ts")
    }
}
#endif

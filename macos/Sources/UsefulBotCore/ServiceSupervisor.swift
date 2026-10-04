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
    case eve
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
            // eve forks its server as a detached child; once its launcher is
            // gone this is the process that holds the eve port.
            || commandLine.contains("eve/dist/src/cli/dev/local-server-child.js")
    }

    /// Whether the process holding the eve port may be ADOPTED (counted as
    /// not foreign). Only ever a readiness question: nothing is signalled on
    /// the strength of it, the stop and recovery paths use `isOwnNodeProcess`.
    /// Dev keeps the strict rule: only its own repoPath. Daily adopts an actual
    /// eve (its launcher or server child) whose script sits under this app's
    /// repoPath, the checkout or the release install root, so the checkout
    /// build and the release build (different repoPaths, same ports) can take
    /// over from each other. The root has to start a token and be followed by
    /// `/node_modules/eve/...`, so `/x/steve/bin/eve.js` or another project's
    /// `node_modules/eve` is foreign. Anything running from the dev app's
    /// runtime is refused. The command line may carry the parent's too (see
    /// `ownsProcess`).
    public func isOwnEveProcess(
        _ commandLine: String, variant: AppVariant, repoPath: String, devRuntimeRoot: String,
        releaseRuntimeRoot: String = RuntimeInstall.installRoot(variant: .daily).path,
        checkoutRoot: String = (ServerConfig.defaultRepoPath as NSString).expandingTildeInPath
    ) -> Bool {
        switch variant {
        case .dev:
            return isOwnNodeProcess(commandLine, repoPath: repoPath)
        case .daily:
            let underDevRuntime = commandLine.contains(devRuntimeRoot + "/") || commandLine.hasSuffix(devRuntimeRoot)
            guard !underDevRuntime else { return false }
            let scripts = ["/node_modules/eve/bin/eve.js", "/node_modules/eve/dist/src/cli/dev/local-server-child.js"]
            for root in [repoPath, releaseRuntimeRoot, checkoutRoot] where !root.isEmpty {
                for script in scripts where Self.containsAtTokenStart(commandLine, root + script) { return true }
            }
            return false
        }
    }

    /// `needle` occurs in `text` with a space (or the start) right before it.
    private static func containsAtTokenStart(_ text: String, _ needle: String) -> Bool {
        var from = text.startIndex
        while let range = text.range(of: needle, range: from..<text.endIndex) {
            if range.lowerBound == text.startIndex || text[text.index(before: range.lowerBound)] == " " { return true }
            from = range.upperBound
        }
        return false
    }
}
#endif

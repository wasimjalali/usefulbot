#if os(macOS)
import Foundation

/// The services a release build runs. A release carries them in
/// `Contents/Resources/runtime` (scripts/build-runtime.mjs), but eve compiles
/// and keeps its sessions under the folder it runs from, and an update replaces
/// the whole bundle. So the payload is copied to a writable folder and run
/// from there; `.eve/` in that folder is never touched by a copy.
///
/// The dev build (`AppVariant.dev`) does the same, in its own folder
/// (`~/Library/Application Support/Useful Bot Dev/app`), never reading the
/// checkout it was built from (a Desktop-folder privacy prompt would block every
/// service, and an ad hoc signed rebuild would raise it again). Its setup runs
/// with the dev environment only (`setupEnvironment`), so it writes the dev state
/// folder and the `com.usefulbot.dev.*` Keychain items and nothing of the daily app's.
public enum RuntimeInstall {
    static let stampName = ".ub-runtime-version"

    /// The payload inside this app, when it is a release build.
    public static func bundledRuntime(bundle: Bundle = .main, variant: AppVariant = .current) -> URL? {
        bundledRuntime(resources: bundle.resourceURL, variant: variant)
    }

    static func bundledRuntime(resources: URL?, variant: AppVariant) -> URL? {
        guard variant.usesRuntimePayload else { return nil }
        guard let runtime = resources?.appendingPathComponent("runtime") else { return nil }
        let stamp = runtime.appendingPathComponent(stampName).path
        return FileManager.default.fileExists(atPath: stamp) ? runtime : nil
    }

    /// Where a release build runs its services from.
    public static var installRoot: URL { installRoot(variant: .current) }

    public static func installRoot(variant: AppVariant) -> URL {
        installRoot(
            support: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true),
            variant: variant
        )
    }

    static func installRoot(support: URL, variant: AppVariant) -> URL {
        variant.appSupportDirectory(support: support).appendingPathComponent("app", isDirectory: true)
    }

    public struct Failure: Error, CustomStringConvertible {
        public let description: String
        /// The tool's exit status; nil when it never exited on its own (a
        /// timeout) or no tool ran (the install lock).
        public let status: Int32?
        /// Everything the tool wrote to stderr, untruncated.
        public let output: String

        public init(description: String, status: Int32? = nil, output: String = "") {
            self.description = description
            self.status = status
            self.output = output
        }
    }

    /// First-time setup (`setup-local.mjs`) failed, so the app cannot run.
    /// `message` is what the owner sees; `detail` is the raw failure for Console.
    public struct SetupFailure: Error, CustomStringConvertible {
        /// The `error` field of the JSON setup-local wrote, when there was one.
        public let code: String?
        public let detail: String
        public var description: String { detail }

        public init(code: String?, detail: String) {
            self.code = code
            self.detail = detail
        }

        init(_ error: Error) {
            let failure = error as? Failure
            self.init(code: failure.flatMap { RuntimeInstall.setupErrorCode($0.output) }, detail: String(describing: error))
        }

        public var message: String {
            switch code {
            case "keychain_write_failed":
                return "Useful Bot couldn't save its keys in your Keychain. Unlock the Keychain and try again."
            default:
                return "Useful Bot couldn't set up its local services. Details are in Console."
            }
        }
    }

    /// The `error` field of the last JSON object line setup-local wrote to
    /// stderr (it writes one line per failure; Node warnings may come first).
    public static func setupErrorCode(_ output: String) -> String? {
        for line in output.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            return object["error"] as? String
        }
        return nil
    }

    /// One external tool `prepare` runs (rsync, xattr, node setup-local). A value,
    /// so a test can read exactly what would have run, with which environment.
    public struct ToolInvocation: Equatable, Sendable {
        public var tool: String
        public var arguments: [String]
        public var cwd: URL?
        /// The whole environment the tool gets. Nil inherits the app's; setup
        /// never does (see `setupEnvironment`).
        public var environment: [String: String]?

        public init(tool: String, arguments: [String], cwd: URL? = nil, environment: [String: String]? = nil) {
            self.tool = tool
            self.arguments = arguments
            self.cwd = cwd
            self.environment = environment
        }
    }

    /// Runs one tool to completion within `timeout` seconds, or throws.
    public typealias ToolRunner = @Sendable (ToolInvocation, TimeInterval) throws -> Void

    /// setup-local's exit status for Keychain items with no config: the
    /// orphaned case, answered with `--rebuild-orphaned`.
    static let orphanedExitStatus: Int32 = 3

    /// True when the payload in `root` is not the one this app carries: after
    /// an update, or on the first launch. The caller stops the services still
    /// running the old files before `prepare` replaces them.
    public static func needsCopy(bundled: URL, root: URL = installRoot) -> Bool {
        let wanted = try? String(contentsOf: bundled.appendingPathComponent(stampName), encoding: .utf8)
        let have = try? String(contentsOf: root.appendingPathComponent(stampName), encoding: .utf8)
        return wanted == nil || wanted != have
    }

    /// Held from the `needsCopy` check through `prepare`. Two copies of the
    /// same version starting at once (a relaunch overlapping a slow quit) must
    /// not run two copies into the same folder, and the second must not see
    /// the first's copy half done, stop the services it has just started, and
    /// copy again. Two different versions still take turns replacing each
    /// other; the lock only keeps each copy whole. Released when the value
    /// goes away.
    public final class InstallLock: @unchecked Sendable {
        private let fd: Int32

        /// Blocking until the other holder lets go; call it off the main thread.
        public init(root: URL = installRoot) throws {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let fd = open(root.appendingPathComponent(".ub-install.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw Failure(description: "cannot open the install lock (errno \(errno))") }
            guard flock(fd, LOCK_EX) == 0 else {
                let code = errno
                close(fd)
                throw Failure(description: "cannot take the install lock (errno \(code))")
            }
            self.fd = fd
        }

        deinit {
            flock(fd, LOCK_UN)
            close(fd)
        }
    }

    /// Copies the payload into `root` when its version differs from the one
    /// already there, then mints any missing or expired local credentials.
    /// Blocking; call it off the main thread, holding `lock`, with the old
    /// services stopped when `needsCopy` said so.
    ///
    /// Returns true when it replaced credentials that services may still be
    /// holding (the orphaned-Keychain rebuild): the caller stops them before
    /// starting, since each reads its tokens once at boot. A setup failure on
    /// a Mac with no config throws `SetupFailure`.
    @discardableResult
    public static func prepare(
        bundled: URL,
        root: URL = installRoot,
        holding lock: InstallLock,
        variant: AppVariant = .current,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        runTool: ToolRunner? = nil
    ) throws -> Bool {
        let runTool = runTool ?? { invocation, timeout in try runSystemTool(invocation, timeout: timeout) }
        // Each variant copies into its own folder only: the daily app's install
        // root is never a target for dev, nor the dev root for daily.
        for other in AppVariant.allCases where other != variant {
            if root.standardizedFileURL.path == installRoot(variant: other).standardizedFileURL.path {
                throw Failure(description: "the \(variant.displayName) app never installs into the \(other.displayName) folder \(root.path)")
            }
        }
        // The lock is held only while it is alive; keep it so to the end.
        return try withExtendedLifetime(lock) { () throws -> Bool in
            let fm = FileManager.default
            let wanted = try String(contentsOf: bundled.appendingPathComponent(stampName), encoding: .utf8)
            let stamp = root.appendingPathComponent(stampName)
            if (try? String(contentsOf: stamp, encoding: .utf8)) != wanted {
                // The stamp goes first, so a copy cut short is redone on the next launch.
                try? fm.removeItem(at: stamp)
                // Everything the payload owns is replaced; what the services wrote
                // at runtime (.eve, eve's production output) and the lock stay.
                try runTool(ToolInvocation(tool: "/usr/bin/rsync", arguments: ["-a", "--delete", "--exclude", "/.eve/", "--exclude", "/.output/",
                                           "--exclude", "/\(stampName)", "--exclude", "/.ub-install.lock",
                                           bundled.path + "/", root.path + "/"]), 600)
                // A payload unpacked from a download can carry the quarantine flag,
                // and Gatekeeper would then stop the first `node` it runs. `-d`
                // fails on every file without the flag, so all extended attributes
                // are cleared, on the payload's own files only (never .eve).
                let owned = try fm.contentsOfDirectory(atPath: bundled.path).filter { $0 != stampName }
                try runTool(ToolInvocation(tool: "/usr/bin/xattr", arguments: ["-cr"] + owned.map { root.appendingPathComponent($0).path }), 300)
                try wanted.write(to: stamp, atomically: true, encoding: .utf8)
            }
            // Every launch: the local credentials expire after 30 days, and
            // `--add-missing` refreshes those and mints any that are absent. A Mac
            // that has never been set up gets the plain first-time setup, and the
            // app cannot run without it. A refresh that fails leaves working
            // credentials in place, so it is logged, not fatal.
            let configured = fm.fileExists(atPath: variant.stateRoot(home: home).appendingPathComponent("config.json").path)
            let node = root.appendingPathComponent("bin/node").path
            let setup = root.appendingPathComponent("scripts/setup-local.mjs").path
            let setupEnv = setupEnvironment(variant: variant, home: home)
            func runSetup(_ flags: [String]) throws {
                try runTool(ToolInvocation(tool: node, arguments: [setup] + flags, cwd: root, environment: setupEnv), 60)
            }
            if configured {
                do {
                    try runSetup(["--add-missing"])
                } catch {
                    NSLog("Useful Bot: credential refresh failed, keeping the current ones: %@", String(describing: error))
                }
                return false
            }
            do {
                try runSetup([])
                return false
            } catch let failure as Failure where failure.status == orphanedExitStatus {
                // No config, but Keychain items from an earlier install are
                // still here (the data folder was deleted, the app kept). With
                // no config nothing uses them, so they are replaced; setup
                // itself refuses if a config appeared meanwhile.
                NSLog("Useful Bot: rebuilding local credentials left by an earlier install. A dev stack that points UB_ROUTER_CONFIG elsewhere must run setup-local.mjs again.")
            } catch {
                throw SetupFailure(error)
            }
            do {
                try runSetup(["--rebuild-orphaned"])
            } catch {
                throw SetupFailure(error)
            }
            return true
        }
    }

    /// What `setup-local.mjs` runs with, for either variant: the same short
    /// list a service gets plus the variant's own settings (none for daily), so
    /// no `UB_*` value from however the app was launched can point setup at
    /// another stack. setup-local honours `UB_STACK`, `UB_STATE_ROOT` and
    /// `UB_KEYCHAIN_PREFIX`, so inheriting them would let a launch from a dev
    /// shell rotate the daily credentials. Never nil, so the app's environment is
    /// not inherited.
    static func setupEnvironment(variant: AppVariant, home: URL, inherited: [String: String] = ProcessInfo.processInfo.environment) -> [String: String]? {
        FoundationProcessRunner.environment(
            base: FoundationProcessRunner.baseEnvironment(home: home.path, inherited: inherited),
            adding: variant.serviceEnvironment(home: home)
        )
    }

    /// Runs a tool to completion, or kills it after `timeout` seconds.
    private static func runSystemTool(_ invocation: ToolInvocation, timeout: TimeInterval) throws {
        let tool = invocation.tool
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = invocation.arguments
        if let cwd = invocation.cwd { process.currentDirectoryURL = cwd }
        if let environment = invocation.environment { process.environment = environment }
        let err = Pipe()
        process.standardError = err
        process.standardOutput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        try process.run()
        // Read while it runs, so a chatty tool cannot fill the pipe and stall.
        var data = Data()
        let reader = DispatchQueue(label: "ub.runtime-install.stderr")
        reader.async { data = err.fileHandleForReading.readDataToEndOfFile() }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            done.wait()
            reader.sync {}
            throw Failure(description: "\((tool as NSString).lastPathComponent) did not finish in \(Int(timeout)) s")
        }
        reader.sync {}
        guard process.terminationStatus == 0 else {
            let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw Failure(description: "\((tool as NSString).lastPathComponent) exited \(process.terminationStatus): \(detail.suffix(400))",
                          status: process.terminationReason == .exit ? process.terminationStatus : nil, output: detail)
        }
    }
}
#endif

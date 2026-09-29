#if os(macOS)
import Foundation

/// The services a release build runs. A release carries them in
/// `Contents/Resources/runtime` (scripts/build-runtime.mjs), but eve compiles
/// and keeps its sessions under the folder it runs from, and an update replaces
/// the whole bundle. So the payload is copied to a writable folder and run
/// from there; `.eve/` in that folder is never touched by a copy.
///
/// A dev build has no payload and keeps running the checkout it was built from.
public enum RuntimeInstall {
    static let stampName = ".ub-runtime-version"

    /// The payload inside this app, when it is a release build.
    public static func bundledRuntime(bundle: Bundle = .main) -> URL? {
        guard let runtime = bundle.resourceURL?.appendingPathComponent("runtime") else { return nil }
        let stamp = runtime.appendingPathComponent(stampName).path
        return FileManager.default.fileExists(atPath: stamp) ? runtime : nil
    }

    /// Where a release build runs its services from.
    public static var installRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Useful Bot/app")
    }

    public struct Failure: Error, CustomStringConvertible {
        public let description: String
    }

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
    public static func prepare(bundled: URL, root: URL = installRoot, holding lock: InstallLock) throws {
        // The lock is held only while it is alive; keep it so to the end.
        try withExtendedLifetime(lock) {
            let fm = FileManager.default
            let wanted = try String(contentsOf: bundled.appendingPathComponent(stampName), encoding: .utf8)
            let stamp = root.appendingPathComponent(stampName)
            if (try? String(contentsOf: stamp, encoding: .utf8)) != wanted {
                // The stamp goes first, so a copy cut short is redone on the next launch.
                try? fm.removeItem(at: stamp)
                // Everything the payload owns is replaced; what the services wrote
                // at runtime (.eve, eve's production output) and the lock stay.
                try run("/usr/bin/rsync", ["-a", "--delete", "--exclude", "/.eve/", "--exclude", "/.output/",
                                           "--exclude", "/\(stampName)", "--exclude", "/.ub-install.lock",
                                           bundled.path + "/", root.path + "/"], timeout: 600)
                // A payload unpacked from a download can carry the quarantine flag,
                // and Gatekeeper would then stop the first `node` it runs. `-d`
                // fails on every file without the flag, so all extended attributes
                // are cleared, on the payload's own files only (never .eve).
                let owned = try fm.contentsOfDirectory(atPath: bundled.path).filter { $0 != stampName }
                try run("/usr/bin/xattr", ["-cr"] + owned.map { root.appendingPathComponent($0).path }, timeout: 300)
                try wanted.write(to: stamp, atomically: true, encoding: .utf8)
            }
            // Every launch: the local credentials expire after 30 days, and
            // `--add-missing` refreshes those and mints any that are absent. A Mac
            // that has never been set up gets the plain first-time setup, and the
            // app cannot run without it. A refresh that fails leaves working
            // credentials in place, so it is logged, not fatal.
            let configured = fm.fileExists(atPath: fm.homeDirectoryForCurrentUser.appendingPathComponent(".useful-bot/config.json").path)
            do {
                try run(root.appendingPathComponent("bin/node").path,
                        [root.appendingPathComponent("scripts/setup-local.mjs").path] + (configured ? ["--add-missing"] : []),
                        cwd: root, timeout: 60)
            } catch {
                guard configured else { throw error }
                NSLog("Useful Bot: credential refresh failed, keeping the current ones: %@", String(describing: error))
            }

        }
    }

    /// Runs a tool to completion, or kills it after `timeout` seconds.
    private static func run(_ tool: String, _ args: [String], cwd: URL? = nil, timeout: TimeInterval) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = args
        if let cwd { process.currentDirectoryURL = cwd }
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
            throw Failure(description: "\((tool as NSString).lastPathComponent) exited \(process.terminationStatus): \(detail.suffix(400))")
        }
    }
}
#endif

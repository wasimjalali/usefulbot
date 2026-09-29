#if os(macOS)
import Foundation

/// Why `ensure` finished the way it did. The caller needs the node-missing
/// case distinct from a plain timeout so the UI can say what to install
/// instead of the generic "local server unavailable".
public enum EnsureOutcome: Equatable, Sendable {
    case ready
    case nodeMissing
    case unavailable
}

public struct LocalServices: Sendable {
    private let supervisor: ServiceSupervisor
    private let runner: ProcessRunner
    private let probe: HealthProbe
    /// How long a port that is open but not yet serving is given before it is
    /// treated as wedged. A service that is still starting holds its port
    /// before its health endpoint answers, and killing it there is a restart
    /// loop that never converges. Zero in tests.
    private let startGraceSeconds: Double
    /// How often a still-missing service is started again while `ensure` waits.
    private static let restartInterval: Double = 15

    public init(
        runner: ProcessRunner = FoundationProcessRunner(),
        probe: HealthProbe = URLSessionHealthProbe(),
        supervisor: ServiceSupervisor = ServiceSupervisor(),
        // Long enough for a cold Next dev server, which holds its port well
        // before it serves. A genuinely wedged listener costs this once.
        startGraceSeconds: Double = 20
    ) {
        self.runner = runner
        self.probe = probe
        self.supervisor = supervisor
        self.startGraceSeconds = startGraceSeconds
    }

    /// `timeoutSeconds` is wall clock, not a number of attempts: a probe that
    /// times out costs seconds of its own, and three of them per attempt used
    /// to stretch a 40 second budget into minutes of a window that says it is
    /// starting up. The default covers a cold start of all three services,
    /// where the web is a Next dev server.
    public func ensure(config: ServerConfig, timeoutSeconds: Int = 90) async -> EnsureOutcome {
        if await allReady(config: config) { return .ready }
        // Without a node binary nothing can start; report it now instead of
        // waiting out the health timeout on a launch that can never succeed.
        guard supervisor.isNodeAvailable(repoPath: config.repoPath) else { return .nodeMissing }
        // The checks above were awaits of their own, so nothing is started for
        // an attempt that has already been replaced.
        if Task.isCancelled { return .unavailable }
        // Before the first start, not after: the grace a held port is given is
        // part of the budget, and three of them used to run outside it.
        let deadline = Date().addingTimeInterval(Double(timeoutSeconds))
        await startMissing(config: config, deadline: deadline)
        var nextStart = Date().addingTimeInterval(Self.restartInterval)
        while Date() < deadline {
            // A retry cancels the attempt it replaces, and an abandoned
            // attempt must stop supervising ports rather than run its budget
            // out alongside the new one.
            if Task.isCancelled { return .unavailable }
            if await allReady(config: config) { return .ready }
            if Date() >= deadline { break }
            // A start can fail, and a started service can exit a second later.
            // Polling alone would then wait out the whole budget on a port that
            // nobody is going to open, so the start is attempted again while
            // there is time left. `startMissing` skips anything already healthy
            // and never starts a second listener on an occupied port.
            if Date() >= nextStart {
                // `allowRestart: false`: by now every listener on these ports
                // is either one this call started or one it decided to keep,
                // and a service that is merely slow (a cold Next dev server
                // takes tens of seconds) must not be killed and restarted into
                // the same wait, forever. The retry only fills a port that is
                // still empty.
                await startMissing(config: config, allowRestart: false)
                nextStart = Date().addingTimeInterval(Self.restartInterval)
                continue
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        return await allReady(config: config) ? .ready : .unavailable
    }

    /// All three, not just the one the app talks to.
    ///
    /// The web server answering used to be the whole check, so a dead router
    /// was never noticed or restarted: the app opened looking healthy and every
    /// turn failed at the model call instead. The three are asked at once, so
    /// one unreachable service costs one probe timeout rather than three.
    private func allReady(config: ServerConfig) async -> Bool {
        async let web = probe.probe(config.healthURL)
        async let router = probe.probe(ServiceSupervisor.routerHealthURL)
        async let eve = probe.probe(ServiceSupervisor.eveHealthURL)
        // Each is awaited into a value: `&&` takes an autoclosure, which
        // cannot capture an `async let`.
        let webReady = await web
        let routerReady = await router
        let eveReady = await eve
        return webReady && routerReady && eveReady
    }

    /// `allowRestart` is the permission to treat an occupied but unhealthy port
    /// as a wedged process and signal it. True on the first pass, where the
    /// listener predates this app's attempt; false on the retries, where it
    /// would be killing something this call just started.
    func startMissing(config: ServerConfig, allowRestart: Bool = true, deadline: Date? = nil) async {
        await ensureService(
            mode: .router,
            port: ServiceSupervisor.routerPort,
            health: ServiceSupervisor.routerHealthURL,
            repoPath: config.repoPath,
            allowRestart: allowRestart,
            deadline: deadline
        )
        await ensureService(
            mode: .eve,
            port: ServiceSupervisor.evePort,
            health: ServiceSupervisor.eveHealthURL,
            repoPath: config.repoPath,
            allowRestart: allowRestart,
            deadline: deadline
        )
        await ensureService(
            mode: .web,
            port: ServiceSupervisor.webPort,
            health: config.healthURL,
            repoPath: config.repoPath,
            allowRestart: allowRestart,
            deadline: deadline
        )
    }

    /// A service is left alone when its health endpoint answers. Otherwise any
    /// own listener that accepts TCP but never serves (a wedged process) is
    /// stopped before restarting, and a port held by a foreign process is left
    /// untouched so we never fight another app for it.
    private func ensureService(
        mode: ServiceMode,
        port: Int,
        health: URL,
        repoPath: String,
        allowRestart: Bool = true,
        deadline: Date? = nil
    ) async {
        if Task.isCancelled { return }
        if await probe.probe(health) { return }
        let owns: @Sendable (String) -> Bool = { [supervisor] line in
            supervisor.isOwnNodeProcess(line, repoPath: repoPath)
        }
        // A listener this call is already waiting on is left alone: the retry
        // exists to fill an empty port, not to kill a slow starter.
        if !allowRestart {
            // Re-checked after the health probe above, which was an await:
            // cancellation can land inside it, and a cancelled attempt must not
            // start a service the retry is about to start itself.
            if !Task.isCancelled, runner.listeners(port: port).isEmpty {
                runner.start(supervisor.command(mode: mode, repoPath: repoPath))
            }
            return
        }
        if !runner.listeners(port: port).isEmpty {
            // A port that is open but not yet serving is usually a service
            // still coming up, not a wedged one. Give it a moment: killing a
            // slow starter here restarts it into the same race, every time.
            // The grace never outlives the caller's budget.
            let remaining = deadline.map { $0.timeIntervalSinceNow } ?? startGraceSeconds
            if await waitForHealth(health, seconds: min(startGraceSeconds, remaining)) { return }
            // The wait also ends on cancellation, and a cancelled attempt must
            // not spend its last act killing a listener the retry is about to
            // wait on.
            if Task.isCancelled { return }
            runner.stopOwnListeners(port: port, owns: owns)
            // Poll for the listener to actually go away instead of betting on
            // a fixed sleep, so a slow-but-cooperative process is not force
            // killed and a fast one is not waited on.
            _ = await waitForPortFree(port: port, timeout: 1_000)
            if Task.isCancelled { return }
        }
        if !runner.listeners(port: port).isEmpty {
            runner.forceStopOwnListeners(port: port, owns: owns)
            _ = await waitForPortFree(port: port, timeout: 400)
            if Task.isCancelled { return }
        }
        // A foreign listener survives the own-only signals above, so this
        // stays false and we never start a duplicate on an occupied port.
        if !Task.isCancelled, runner.listeners(port: port).isEmpty {
            runner.start(supervisor.command(mode: mode, repoPath: repoPath))
        }
    }

    /// Stops this checkout's own router, eve and web, leaving any foreign
    /// listener alone. The services outlive the app, so after an update the
    /// old version is still serving; its files are about to be replaced.
    public func stopOwnServices(config: ServerConfig) async {
        let repoPath = config.repoPath
        let owns: @Sendable (String) -> Bool = { [supervisor] line in
            supervisor.isOwnNodeProcess(line, repoPath: repoPath)
        }
        for port in [ServiceSupervisor.webPort, ServiceSupervisor.evePort, ServiceSupervisor.routerPort] {
            runner.stopOwnListeners(port: port, owns: owns)
            if await waitForPortFree(port: port, timeout: 5_000) { continue }
            // A cancelled wait returns at once; force-killing then would cut
            // eve off mid-write. The retry's own boot stops them again.
            if Task.isCancelled { return }
            runner.forceStopOwnListeners(port: port, owns: owns)
            _ = await waitForPortFree(port: port, timeout: 1_000)
        }
    }

    /// Polls the health endpoint until it answers or the grace elapses.
    private func waitForHealth(_ health: URL, seconds: Double) async -> Bool {
        guard seconds > 0 else { return false }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            // A cancelled attempt stops here rather than holding the retry
            // behind a grace window it no longer cares about.
            if Task.isCancelled { return false }
            if await probe.probe(health) { return true }
            if Date() >= deadline { break }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }

    /// Polls until the port has no listener or the timeout elapses. Returns
    /// true when the port is free.
    private func waitForPortFree(port: Int, timeout: Int) async -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        while !runner.listeners(port: port).isEmpty {
            if Task.isCancelled { return false }
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }
}

public protocol ProcessRunner: Sendable {
    func start(_ command: ServiceCommand)
    func portAccepting(_ port: Int) -> Bool
    func listeners(port: Int) -> [pid_t]
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool)
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool)
}

/// Reference box shared by every copy of `FoundationProcessRunner`: it keeps
/// the spawned launchers alive (so a termination handler can run and close the
/// log file), and remembers which pids this app started as a fallback
/// ownership signal for a child whose argv was rewritten.
private final class SpawnRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [pid_t: Process] = [:]
    private var reportedUnknown: Set<String> = []

    func add(pid: pid_t, process: Process) {
        lock.lock()
        defer { lock.unlock() }
        // A process that exits at once can run its termination handler before
        // this call: recording it then would store an entry nothing removes.
        guard process.isRunning else { return }
        processes[pid] = process
    }

    /// True while the recorded process is still alive. The `isRunning` check
    /// closes the race where a short-lived process exits before `add` runs.
    func contains(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let process = processes[pid] else { return false }
        return process.isRunning
    }

    func remove(pid: pid_t) {
        lock.lock()
        defer { lock.unlock() }
        processes.removeValue(forKey: pid)
    }

    /// One log line per port/pid pair so a permanently foreign listener does
    /// not flood the supervisor log on every poll.
    func shouldReport(port: Int, pid: pid_t) -> Bool {
        let key = "\(port):\(pid)"
        lock.lock()
        defer { lock.unlock() }
        if reportedUnknown.contains(key) { return false }
        reportedUnknown.insert(key)
        return true
    }
}

public struct FoundationProcessRunner: ProcessRunner {
    private let registry = SpawnRegistry()

    public init() {}

    public func start(_ command: ServiceCommand) {
        let label = command.arguments.last ?? "service"
        let logURL = Self.logFile(label: label)
        let handle = Self.openLog(logURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.arguments
        process.currentDirectoryURL = URL(fileURLWithPath: command.workingDirectory)
        // A launched server's stdout/stderr go to its own log instead of the
        // void, and the handle doubles as the retention for the termination
        // handler below.
        process.standardOutput = handle ?? FileHandle.nullDevice
        process.standardError = handle ?? FileHandle.nullDevice
        // Still a list and not the app's whole environment: a service must not
        // pick up a stray NODE_OPTIONS or DYLD_* from however the app was
        // launched. The names below are what the service needs to work out the
        // owner's real PATH for itself (see shared/user-path.ts), which is what
        // lets a bot run the CLIs this Mac has installed.
        var env: [String: String] = [
            // Apple Silicon Homebrew lives under /opt/homebrew; without it a
            // Homebrew-node subtree cannot see its sibling tools.
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": NSHomeDirectory(),
        ]
        let inherited = ProcessInfo.processInfo.environment
        for name in ["SHELL", "USER", "LOGNAME", "LANG", "TZ"] {
            if let value = inherited[name], !value.isEmpty {
                env[name] = value
            }
        }
        process.environment = env
        process.terminationHandler = { [registry, handle] finished in
            let pid = finished.processIdentifier
            registry.remove(pid: pid)
            // The handle is closed here, not by the adder: for a process that
            // exits at once this handler can run before `add`, and the closer
            // must not depend on which wins the race.
            if let handle { try? handle.close() }
            Self.appendEvent(
                "service \(label) (pid \(pid)) exited with status \(finished.terminationStatus)",
                to: logURL
            )
        }
        do {
            try process.run()
            registry.add(pid: process.processIdentifier, process: process)
        } catch {
            if let handle { try? handle.close() }
            Self.appendEvent("failed to launch \(label): \(error.localizedDescription)", to: logURL)
        }
    }

    /// Probes both loopback stacks. A server bound only to `::1` would read as
    /// down on an IPv4-only connect and a duplicate would be spawned.
    public func portAccepting(_ port: Int) -> Bool {
        connects(host: "127.0.0.1", port: port, family: AF_INET)
            || connects(host: "::1", port: port, family: AF_INET6)
    }

    private func connects(host: String, port: Int, family: Int32) -> Bool {
        var hints = addrinfo(
            ai_flags: AI_NUMERICHOST,
            ai_family: family,
            ai_socktype: SOCK_STREAM,
            ai_protocol: IPPROTO_TCP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var info: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &info) == 0, let info else {
            return false
        }
        defer { freeaddrinfo(info) }
        let fd = socket(info.pointee.ai_family, info.pointee.ai_socktype, info.pointee.ai_protocol)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var timeout = timeval(tv_sec: 0, tv_usec: 300_000)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        return connect(fd, info.pointee.ai_addr, info.pointee.ai_addrlen) == 0
    }

    public func listeners(port: Int) -> [pid_t] {
        listenerPids(port: port)
    }

    public func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        signalOwnListeners(port: port, signal: SIGTERM, owns: owns)
    }

    public func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        signalOwnListeners(port: port, signal: SIGKILL, owns: owns)
    }

    func signalOwnListeners(port: Int, signal: Int32, owns: @escaping @Sendable (String) -> Bool) {
        for pid in listenerPids(port: port) {
            // Next rewrites its argv to `next-server (vX)`, dropping the repo
            // path, so include the parent command line: the service.mjs
            // launcher still carries it and keeps the match repo-scoped.
            var text = commandLine(pid: pid)
            if let parent = parentPid(of: pid) {
                text += " \(commandLine(pid: parent))"
            }
            // Fallbacks when the argv and parent line cannot identify it: a
            // pid this app spawned, or the listener's working directory (the
            // repo root the launcher was started in) which survives the
            // service.mjs parent dying and the child being reparented.
            var owned = registry.contains(pid: pid) || owns(text)
            if !owned, let cwd = workingDirectory(pid: pid) {
                text += " \(cwd)"
                owned = owns(text)
            }
            guard owned else {
                if registry.shouldReport(port: port, pid: pid) {
                    Self.appendEvent(
                        "port \(port): listener pid \(pid) is not an own process; leaving it alive",
                        to: Self.supervisorLogURL
                    )
                }
                continue
            }
            if kill(pid, signal) != 0 {
                Self.appendEvent(
                    "kill(\(signal)) failed for pid \(pid) on port \(port): \(String(cString: strerror(errno)))",
                    to: Self.supervisorLogURL
                )
            }
        }
    }

    func workingDirectory(pid: pid_t) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("n") {
            let path = String(line.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty { return path }
        }
        return nil
    }

    func parentPid(of pid: pid_t) -> pid_t? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-o", "ppid="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return pid_t(text)
    }

    func listenerPids(port: Int) -> [pid_t] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
    }

    func commandLine(pid: pid_t) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-o", "args="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return ""
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    // MARK: - Logging

    private static let logDirectory: URL = {
        let directory = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/UsefulBot", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()

    private static var supervisorLogURL: URL {
        logDirectory.appendingPathComponent("supervisor.log")
    }

    private static func logFile(label: String) -> URL {
        logDirectory.appendingPathComponent("service-\(label).log")
    }

    /// Service logs are appended forever, so the open path rotates them past
    /// this size instead of letting one chatty service grow without bound.
    private static let logMaxBytes = 8 * 1024 * 1024

    private static func openLog(_ url: URL) -> FileHandle? {
        // Service logs are appended forever with no cap, so a log over the
        // cap is rotated aside before opening and the service starts fresh.
        // The previous rotation is replaced, keeping one spare, not a series.
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        if size >= logMaxBytes {
            let previous = url.appendingPathExtension("1")
            try? FileManager.default.removeItem(at: previous)
            try? FileManager.default.moveItem(at: url, to: previous)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private static func appendEvent(_ line: String, to url: URL) {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        handle.seekToEndOfFile()
        let stamp = ISO8601DateFormatter().string(from: Date())
        try? handle.write(contentsOf: Data("[\(stamp)] \(line)\n".utf8))
    }
}

#endif

#if os(macOS)
import Foundation

/// Why `ensure` finished the way it did. The caller needs the node-missing
/// case distinct from a plain timeout so the UI can say what to install
/// instead of the generic "local server unavailable".
public enum EnsureOutcome: Equatable, Sendable {
    case ready
    case nodeMissing
    case unavailable
    /// A service on this stack's port answers, but as another stack (or does
    /// not say which). It is never adopted, started over or signalled.
    case foreignStack
    /// A process this app started for each of these services is still alive
    /// but never opened its port inside the budget (wedged, or waiting on a
    /// macOS permission prompt). None of them was started a second time.
    case neverBound([ServiceMode])
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
    private let restartIntervalSeconds: Double
    /// How long a SIGTERM is given before the process is sent SIGKILL.
    private let terminateGraceSeconds: Double
    /// How long `stopOwnServices` waits for the stopped services' processes to
    /// actually exit after SIGTERM before it sends SIGKILL. A freed port is not
    /// an exit: Next and eve close their listener first and drain after.
    private let stopExitGraceSeconds: Double
    /// Where the dev app runs its services from. A daily app never adopts an
    /// eve running from here.
    private let devRuntimeRoot: String
    private let releaseRuntimeRoot: String
    private let checkoutRoot: String

    public init(
        runner: ProcessRunner = FoundationProcessRunner(),
        probe: HealthProbe = URLSessionHealthProbe(),
        supervisor: ServiceSupervisor = ServiceSupervisor(),
        // Long enough for a cold Next dev server, which holds its port well
        // before it serves. A genuinely wedged listener costs this once.
        startGraceSeconds: Double = 20,
        restartIntervalSeconds: Double = 15,
        terminateGraceSeconds: Double = 3,
        stopExitGraceSeconds: Double = 10,
        devRuntimeRoot: String = RuntimeInstall.installRoot(variant: .dev).path,
        releaseRuntimeRoot: String = RuntimeInstall.installRoot(variant: .daily).path,
        checkoutRoot: String = (ServerConfig.defaultRepoPath as NSString).expandingTildeInPath
    ) {
        self.devRuntimeRoot = devRuntimeRoot
        self.releaseRuntimeRoot = releaseRuntimeRoot
        self.checkoutRoot = checkoutRoot
        self.terminateGraceSeconds = terminateGraceSeconds
        self.stopExitGraceSeconds = stopExitGraceSeconds
        self.restartIntervalSeconds = restartIntervalSeconds
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
    public func ensure(config: ServerConfig, timeoutSeconds: Int = 90, replaceHung: Bool = false) async -> EnsureOutcome {
        switch await stackState(config: config) {
        case .ready: return .ready
        case .foreign: return .foreignStack
        case .notReady: break
        }
        // Without a node binary nothing can start; report it now instead of
        // waiting out the health timeout on a launch that can never succeed.
        guard supervisor.isNodeAvailable(repoPath: config.repoPath) else { return .nodeMissing }
        // The checks above were awaits of their own, so nothing is started for
        // an attempt that has already been replaced.
        if Task.isCancelled { return .unavailable }
        // A process that never bound is not left to block every start after it:
        // ours is replaced on a Retry or once it has outlived a whole budget,
        // and the ones an earlier launch left behind are stopped.
        await recoverUnboundServices(config: config, budgetSeconds: timeoutSeconds, replaceHung: replaceHung)
        if Task.isCancelled { return .unavailable }
        // Before the first start, not after: the grace a held port is given is
        // part of the budget, and three of them used to run outside it.
        let deadline = Date().addingTimeInterval(Double(timeoutSeconds))
        await startMissing(config: config, deadline: deadline)
        var nextStart = Date().addingTimeInterval(restartIntervalSeconds)
        while Date() < deadline {
            // A retry cancels the attempt it replaces, and an abandoned
            // attempt must stop supervising ports rather than run its budget
            // out alongside the new one.
            if Task.isCancelled { return .unavailable }
            switch await stackState(config: config) {
            case .ready: return .ready
            case .foreign: return .foreignStack
            case .notReady: break
            }
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
                nextStart = Date().addingTimeInterval(restartIntervalSeconds)
                continue
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        switch await stackState(config: config) {
        case .ready: return .ready
        case .foreign: return .foreignStack
        case .notReady:
            // A service this app started that is still alive but never opened
            // its port is named, not retried: another one would only join it.
            let hung = hungServices(config: config)
            return hung.isEmpty ? .unavailable : .neverBound(hung)
        }
    }

    private static let allModes: [ServiceMode] = [.router, .eve, .web]

    private func port(of mode: ServiceMode, variant: AppVariant) -> Int {
        switch mode {
        case .router: return variant.routerPort
        case .eve: return variant.evePort
        case .web: return variant.webPort
        }
    }

    /// For each service whose port is empty: stops our own live spawn when the
    /// owner pressed Retry or it has run for a whole budget without binding
    /// (SIGTERM, then SIGKILL), and stops the `service.mjs <mode>` launchers of
    /// this exact install that hold no port, left by an earlier launch (the
    /// registry is empty after a relaunch, so nothing else would ever find
    /// them). A service with a listening port is never touched here.
    private func recoverUnboundServices(config: ServerConfig, budgetSeconds: Int, replaceHung: Bool) async {
        let repoPath = config.repoPath
        let supervisor = self.supervisor
        for mode in Self.allModes {
            if Task.isCancelled { return }
            guard runner.listeners(port: port(of: mode, variant: config.variant)).isEmpty else { continue }
            if let age = runner.liveSpawnAge(of: mode), replaceHung || age >= Double(budgetSeconds) {
                runner.terminateSpawn(of: mode, force: false)
                if !(await waitForSpawnExit(mode, timeout: Int(terminateGraceSeconds * 1000))) {
                    if Task.isCancelled { return }
                    runner.terminateSpawn(of: mode, force: true)
                    _ = await waitForSpawnExit(mode, timeout: 1_000)
                }
                if !Task.isCancelled { runner.killTermedSurvivors() }
            }
            let matches: @Sendable (String) -> Bool = { line in
                supervisor.isStrayServiceLine(line, mode: mode, repoPath: repoPath)
            }
            let strays = runner.strayServicePids(matching: matches)
            guard !strays.isEmpty else {
                if !Task.isCancelled { runner.killTermedSurvivors() }
                continue
            }
            runner.terminate(pids: strays, force: false)
            let deadline = Date().addingTimeInterval(terminateGraceSeconds)
            // Each pass scans the process table and the listening sockets once,
            // so it is not repeated more often than every 500 ms.
            while !runner.strayServicePids(matching: matches).isEmpty, Date() < deadline {
                if Task.isCancelled { return }
                let wait = min(0.5, max(0, deadline.timeIntervalSinceNow))
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            }
            let remaining = runner.strayServicePids(matching: matches)
            if !remaining.isEmpty, !Task.isCancelled { runner.terminate(pids: remaining, force: true) }
            // A launcher that exited on SIGTERM can leave its detached child
            // (eve's) running; those were recorded when the SIGTERM went out.
            if !Task.isCancelled { runner.killTermedSurvivors() }
        }
    }

    /// Services with a live process of ours behind them and nothing listening
    /// on their port.
    private func hungServices(config: ServerConfig) -> [ServiceMode] {
        Self.allModes.filter { mode in
            runner.hasLiveSpawn(of: mode) && runner.listeners(port: port(of: mode, variant: config.variant)).isEmpty
        }
    }

    /// All three, not just the one the app talks to.
    ///
    /// The web server answering used to be the whole check, so a dead router
    /// was never noticed or restarted: the app opened looking healthy and every
    /// turn failed at the model call instead. The three are asked at once, so
    /// one unreachable service costs one probe timeout rather than three.
    ///
    /// Ready also means it is OUR stack: the web and the router say which
    /// stack they belong to, and one that says another (or, for dev, nothing)
    /// is foreign. eve is a third-party service with no stack field; its port
    /// is the variant's own, so up is asked of it, plus that whatever listens
    /// there is a process of this install: another install's eve (or anything
    /// else that answers 200) is foreign, never adopted or signalled.
    private func stackState(config: ServerConfig) async -> StackState {
        let variant = config.variant
        async let web = probe.read(config.healthURL)
        async let router = probe.read(variant.routerHealthURL)
        async let eve = probe.read(variant.eveHealthURL)
        let webState = variant.readiness(of: await web)
        let routerState = variant.readiness(of: await router)
        let eveUp = await eve != nil
        if case .foreign = webState { return .foreign }
        if case .foreign = routerState { return .foreign }
        if eveUp {
            if runner.hasForeignListener(port: variant.evePort, owns: eveOwnership(config: config)) { return .foreign }
        }
        return webState == .ready && routerState == .ready && eveUp ? .ready : .notReady
    }

    private func eveOwnership(config: ServerConfig) -> @Sendable (String) -> Bool {
        let supervisor = self.supervisor
        let repoPath = config.repoPath
        let variant = config.variant
        let devRoot = devRuntimeRoot
        let releaseRoot = releaseRuntimeRoot
        let checkout = checkoutRoot
        return {
            supervisor.isOwnEveProcess(
                $0, variant: variant, repoPath: repoPath, devRuntimeRoot: devRoot,
                releaseRuntimeRoot: releaseRoot, checkoutRoot: checkout)
        }
    }

    /// For a `.foreignStack` outcome caused by the eve listener: which process
    /// holds the port, with the path it runs from and its parent's. Nil when
    /// it is not eve. The process lookups run off the main actor, with the
    /// same ownership rule the readiness check used.
    public func foreignListenerDetail(config: ServerConfig) async -> String? {
        let owns = eveOwnership(config: config)
        let runner = self.runner
        let port = config.variant.evePort
        let foreign = await Task.detached { runner.foreignListeners(port: port, owns: owns).first }.value
        guard let foreign else { return nil }
        func clip(_ text: String) -> String { text.count > 200 ? String(text.prefix(200)) + "..." : text }
        var detail = "The agent (eve) on port \(port) is pid \(foreign.pid): \(clip(foreign.command))"
        if let parent = foreign.parent, !parent.isEmpty { detail += " (parent: \(clip(parent)))" }
        return detail
    }

    /// What the owner is told when `ensure` ends in `.neverBound`.
    public static func neverBoundMessage(_ modes: [ServiceMode], variant: AppVariant) -> String {
        let ports: (ServiceMode) -> Int = { mode in
            switch mode {
            case .router: return variant.routerPort
            case .eve: return variant.evePort
            case .web: return variant.webPort
            }
        }
        let named = modes.map { "the \($0.rawValue) (port \(ports($0)))" }.joined(separator: ", ")
        let logs = variant.logsDirectory(home: FileManager.default.homeDirectoryForCurrentUser).path
        return "\(variant.displayName) started \(named) but it never opened its port. "
            + "It may be waiting on a macOS permission prompt or have stalled. The service logs are in \(logs)."
    }

    private enum StackState {
        case ready
        case notReady
        case foreign
    }

    /// `allowRestart` is the permission to treat an occupied but unhealthy port
    /// as a wedged process and signal it. True on the first pass, where the
    /// listener predates this app's attempt; false on the retries, where it
    /// would be killing something this call just started.
    func startMissing(config: ServerConfig, allowRestart: Bool = true, deadline: Date? = nil) async {
        await ensureService(
            mode: .router,
            port: config.variant.routerPort,
            health: config.variant.routerHealthURL,
            repoPath: config.repoPath,
            variant: config.variant,
            allowRestart: allowRestart,
            deadline: deadline
        )
        await ensureService(
            mode: .eve,
            port: config.variant.evePort,
            health: config.variant.eveHealthURL,
            repoPath: config.repoPath,
            variant: config.variant,
            allowRestart: allowRestart,
            deadline: deadline
        )
        await ensureService(
            mode: .web,
            port: config.variant.webPort,
            health: config.healthURL,
            repoPath: config.repoPath,
            variant: config.variant,
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
        variant: AppVariant,
        allowRestart: Bool = true,
        deadline: Date? = nil
    ) async {
        if Task.isCancelled { return }
        // Anything that answers is left alone, whichever stack it says it is:
        // a foreign one is reported by `ensure`, never started over or killed.
        if await probe.read(health) != nil { return }
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
                startUnlessAlive(mode: mode, repoPath: repoPath, variant: variant)
            }
            return
        }
        var signalled = false
        if !runner.listeners(port: port).isEmpty {
            signalled = true
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
            // The listener just signalled may take a moment to exit after its
            // port is free; it is not "alive" for the check below once it has.
            if signalled { _ = await waitForSpawnExit(mode, timeout: 1_000) }
            startUnlessAlive(mode: mode, repoPath: repoPath, variant: variant)
        }
    }

    /// Never a second process for a mode while one this app started for it is
    /// still running, whether or not it has opened its port yet. A service
    /// blocked before it binds (a macOS permission prompt) leaves its port
    /// empty for as long as it is blocked, and a fresh set every retry round
    /// leaked 32 node processes in four minutes. A process that has exited is
    /// not alive, so a start that failed or a service that died is still filled.
    private func startUnlessAlive(mode: ServiceMode, repoPath: String, variant: AppVariant) {
        if runner.hasLiveSpawn(of: mode) { return }
        runner.start(supervisor.command(mode: mode, repoPath: repoPath, variant: variant))
    }

    /// Polls until no process of ours is running for `mode`. True when none is.
    private func waitForSpawnExit(_ mode: ServiceMode, timeout: Int) async -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        while runner.hasLiveSpawn(of: mode) {
            if Task.isCancelled || Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    /// Stops this checkout's own router, eve and web, leaving any foreign
    /// listener alone. The services outlive the app, so after an update the
    /// old version is still serving; its files are about to be replaced.
    ///
    /// Returns only once every process of this install has exited, not when a
    /// port is free: Next and eve close the listener first and drain after (a
    /// write in flight, a child shutting down), and an old-version writer that
    /// survived into the runtime swap would write into the new files. The
    /// processes are found from the process table by the install-path ownership
    /// rule, independent of sockets (one already draining holds no port), with
    /// everything below them. SIGTERM, wait up to `stopExitGraceSeconds`,
    /// SIGKILL, wait again, then look again: the verified survivors plus
    /// anything newly found (a survivor whose launcher parent already exited
    /// can drop out of a fresh scan, so the scan never replaces them) get a
    /// second round, and after that `.wouldNotStop` comes back and
    /// the caller must leave the files alone. Each signal is preceded by a fresh
    /// check that the pid still has the start time and command line it was
    /// recorded with.
    @discardableResult
    public func stopOwnServices(config: ServerConfig) async -> ServiceStopResult {
        let repoPath = config.repoPath
        let owns: @Sendable (String) -> Bool = { [supervisor] line in
            supervisor.isOwnNodeProcess(line, repoPath: repoPath)
        }
        let variant = config.variant
        let services: [(port: Int, health: URL, checksStack: Bool)] = [
            (variant.webPort, config.healthURL, true),
            (variant.evePort, variant.eveHealthURL, false),
            (variant.routerPort, variant.routerHealthURL, true),
        ]
        // Read before any signal, while the parent links still exist.
        var owned = runner.ownServiceProcesses(owns: owns)
        for (port, health, checksStack) in services {
            // Another stack's service on this port is not ours to stop.
            if checksStack, case .foreign = variant.readiness(of: await probe.read(health)) { continue }
            runner.stopOwnListeners(port: port, owns: owns)
            if await waitForPortFree(port: port, timeout: 5_000) { continue }
            // A cancelled wait returns at once; force-killing then would cut
            // eve off mid-write. The retry's own boot stops them again.
            if Task.isCancelled { return .cancelled }
            runner.forceStopOwnListeners(port: port, owns: owns)
            _ = await waitForPortFree(port: port, timeout: 1_000)
        }
        for _ in 0..<2 {
            if owned.isEmpty { owned = runner.ownServiceProcesses(owns: owns) }
            if owned.isEmpty { return .stopped }
            // Children first: a parent signalled first would reparent them away.
            for process in owned.reversed() { _ = runner.signalProcess(process, force: false) }
            var remaining = await waitForExit(owned, seconds: stopExitGraceSeconds)
            if Task.isCancelled { return .cancelled }
            if !remaining.isEmpty {
                for process in remaining.reversed() { _ = runner.signalProcess(process, force: true) }
                remaining = await waitForExit(remaining, seconds: stopExitGraceSeconds)
                if Task.isCancelled { return .cancelled }
            }
            // Look again: what is verified to still run, plus anything the old
            // version started while it was going down. A rescan alone could
            // lose a survivor whose parent has gone.
            let survivors = remaining.filter { runner.isStillRunning($0) }
            owned = survivors + runner.ownServiceProcesses(owns: owns).filter { new in
                !survivors.contains { $0.pid == new.pid && $0.started == new.started }
            }
            if owned.isEmpty { return .stopped }
        }
        return .wouldNotStop(owned.map(\.args))
    }

    /// Polls until none of `processes` is still the process that was recorded,
    /// or the time is up. Returns what is still running.
    private func waitForExit(_ processes: [OwnedProcess], seconds: Double) async -> [OwnedProcess] {
        let deadline = Date().addingTimeInterval(seconds)
        var running = processes.filter { runner.isStillRunning($0) }
        while !running.isEmpty, Date() < deadline {
            if Task.isCancelled { return running }
            try? await Task.sleep(nanoseconds: 50_000_000)
            running = running.filter { runner.isStillRunning($0) }
        }
        return running
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

/// A process recorded with its start time and the command line it was running,
/// so a later signal or exit check can tell it from an unrelated process that
/// reused its pid. All three have to match, checked fresh before each signal.
public struct OwnedProcess: Equatable, Sendable {
    public let pid: pid_t
    public let args: String
    /// `ps` start time, whitespace-collapsed ("Thu Oct 2 09:15:30 2026").
    public let started: String
    public init(pid: pid_t, args: String, started: String = "") {
        self.pid = pid
        self.args = args
        self.started = started
    }
}

/// What `stopOwnServices` achieved.
public enum ServiceStopResult: Equatable, Sendable {
    /// No process of this install is running any more.
    case stopped
    /// The attempt was cancelled before it could say.
    case cancelled
    /// These were still running after SIGTERM and SIGKILL (their command lines).
    /// The caller must not replace the files they run from.
    case wouldNotStop([String])

    public var didNotStop: Bool {
        if case .wouldNotStop = self { return true }
        return false
    }
}

public protocol ProcessRunner: Sendable {
    func start(_ command: ServiceCommand)
    /// True while a process this runner started for `mode` is still running,
    /// whether or not it has opened its port.
    func hasLiveSpawn(of mode: ServiceMode) -> Bool
    func portAccepting(_ port: Int) -> Bool
    func listeners(port: Int) -> [pid_t]
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool)
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool)
    /// Seconds since the live process this runner started for `mode` was
    /// started; nil when there is none.
    func liveSpawnAge(of mode: ServiceMode) -> TimeInterval?
    /// SIGTERM (SIGKILL when `force`) to the live process this runner started
    /// for `mode`. Only ever the runner's own spawn.
    func terminateSpawn(of mode: ServiceMode, force: Bool)
    /// True when something listens on `port` and none of it is ours (`owns`
    /// takes the same command-line text as the stop calls).
    func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool
    /// Each listener on `port` with its command line and its parent's, the text
    /// `owns` is asked about. For naming a foreign one.
    func listenerDescriptions(port: Int) -> [(pid: pid_t, line: String)]
    /// The listeners on `port` that `owns` rejects (the ones `hasForeignListener`
    /// counts), each with its own command line and its parent's apart.
    func foreignListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) -> [(pid: pid_t, command: String, parent: String?)]
    /// Processes whose command line `matching` accepts that hold no listening
    /// port and are not a spawn of this runner: what an earlier launch left
    /// behind when its service never bound.
    func strayServicePids(matching: @escaping @Sendable (String) -> Bool) -> [pid_t]
    /// SIGTERM (SIGKILL when `force`) to exactly these pids.
    func terminate(pids: [pid_t], force: Bool)
    /// SIGKILL to whatever a SIGTERM from `terminateSpawn` or `terminate(pids:)`
    /// recorded below its launcher and that is still alive and unchanged: a
    /// descendant that ignored the SIGTERM, or outlived its launcher.
    func killTermedSurvivors()
    /// Every process of this install, found from the process table and not from
    /// a socket (a service that has closed its listener and is draining holds no
    /// port): each one `owns` accepts (its own command line, its parent's, or for
    /// a renamed `next-server` its working directory), and everything below
    /// them. Read before anything is signalled.
    func ownServiceProcesses(owns: @escaping @Sendable (String) -> Bool) -> [OwnedProcess]
    /// True while `process` is still the same process: pid, start time and
    /// command line all as recorded. Read fresh on every call.
    func isStillRunning(_ process: OwnedProcess) -> Bool
    /// SIGTERM (SIGKILL when `force`) to `process` if, checked immediately
    /// before the signal, it is still the same process. False when it was not.
    func signalProcess(_ process: OwnedProcess, force: Bool) -> Bool
}

extension ProcessRunner {
    public func ownServiceProcesses(owns: @escaping @Sendable (String) -> Bool) -> [OwnedProcess] { [] }
    public func isStillRunning(_ process: OwnedProcess) -> Bool { false }
    public func signalProcess(_ process: OwnedProcess, force: Bool) -> Bool { false }
    public func hasLiveSpawn(of mode: ServiceMode) -> Bool { false }
    public func liveSpawnAge(of mode: ServiceMode) -> TimeInterval? { nil }
    public func terminateSpawn(of mode: ServiceMode, force: Bool) {}
    public func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool { false }
    public func listenerDescriptions(port: Int) -> [(pid: pid_t, line: String)] { [] }
    public func foreignListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) -> [(pid: pid_t, command: String, parent: String?)] {
        listenerDescriptions(port: port).filter { !owns($0.line) }.map { ($0.pid, $0.line, nil) }
    }
    public func killTermedSurvivors() {}
    public func strayServicePids(matching: @escaping @Sendable (String) -> Bool) -> [pid_t] { [] }
    public func terminate(pids: [pid_t], force: Bool) {}
}

/// Reference box shared by every copy of `FoundationProcessRunner`: it keeps
/// the spawned launchers alive (so a termination handler can run and close the
/// log file), and remembers which pids this app started as a fallback
/// ownership signal for a child whose argv was rewritten.
private final class SpawnRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [pid_t: Process] = [:]
    private var modes: [pid_t: ServiceMode] = [:]
    private var started: [pid_t: Date] = [:]
    private var termedTrees: [pid_t: [ProcessTable.Row]] = [:]
    private var strayArgs: [pid_t: String] = [:]
    private var reportedUnknown: Set<String> = []

    func add(pid: pid_t, process: Process, mode: ServiceMode?) {
        lock.lock()
        defer { lock.unlock() }
        // A process that exits at once can run its termination handler before
        // this call: recording it then would store an entry nothing removes.
        guard process.isRunning else { return }
        processes[pid] = process
        modes[pid] = mode
        started[pid] = Date()
    }

    /// Seconds the oldest live process for `mode` has been running.
    func liveAge(mode: ServiceMode) -> TimeInterval? {
        lock.lock()
        defer { lock.unlock() }
        let starts = processes.compactMap { pid, process in
            modes[pid] == mode && process.isRunning ? started[pid] : nil
        }
        return starts.min().map { Date().timeIntervalSince($0) }
    }

    /// Every live process started for `mode`.
    func livePids(mode: ServiceMode) -> [pid_t] {
        lock.lock()
        defer { lock.unlock() }
        return processes.compactMap { pid, process in modes[pid] == mode && process.isRunning ? pid : nil }
    }

    /// True while a process started for `mode` is still running.
    func hasLive(mode: ServiceMode) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return processes.contains { pid, process in modes[pid] == mode && process.isRunning }
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
        modes.removeValue(forKey: pid)
        started.removeValue(forKey: pid)
    }

    /// The launcher and everything below it, as seen when SIGTERM went out.
    func saveTree(root: pid_t, rows: [ProcessTable.Row]) {
        lock.lock(); defer { lock.unlock() }
        termedTrees[root] = rows
    }

    func takeTrees() -> [pid_t: [ProcessTable.Row]] {
        lock.lock(); defer { lock.unlock() }
        defer { termedTrees = [:] }
        return termedTrees
    }

    func noteStray(pid: pid_t, args: String) {
        lock.lock(); defer { lock.unlock() }
        strayArgs[pid] = args
    }

    func strayArgs(pid: pid_t) -> String? {
        lock.lock(); defer { lock.unlock() }
        return strayArgs[pid]
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

/// One `ps` snapshot of every process: enough to walk a launcher's children and
/// to tell how long a process has been up.
struct ProcessTable {
    struct Row: Equatable {
        let pid: pid_t
        let ppid: pid_t
        let elapsed: TimeInterval
        let args: String
    }

    static func read() -> [Row] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,ppid=,etime=,args="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return []
        }
        // Read before waiting: a full pipe would otherwise block the child.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return parse(String(data: data, encoding: .utf8) ?? "")
    }

    /// `ps` start times for every process, whitespace-collapsed.
    static func startTimes() -> [pid_t: String] {
        guard let text = run(["-axo", "pid=,lstart="]) else { return [:] }
        var out: [pid_t: String] = [:]
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let space = trimmed.firstIndex(of: " "), let pid = pid_t(trimmed[..<space]) else { continue }
            out[pid] = collapse(String(trimmed[space...]))
        }
        return out
    }

    /// One process's start time and command line, read now; nil when it is gone.
    /// `lstart` is a fixed 24 characters, so the command line starts after them.
    static func identity(of pid: pid_t) -> (started: String, args: String)? {
        guard let text = run(["-o", "lstart=,args=", "-p", String(pid)]) else { return nil }
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count > 24 else { return nil }
        let started = collapse(String(trimmed.prefix(24)))
        let args = String(trimmed.dropFirst(24)).trimmingCharacters(in: .whitespaces)
        return args.isEmpty ? nil : (started, args)
    }

    static func collapse(_ text: String) -> String {
        text.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    }

    private static func run(_ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        // `ps -p` exits 1 when the process is gone.
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func parse(_ text: String) -> [Row] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            let fields = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard fields.count == 4, let pid = pid_t(fields[0]), let ppid = pid_t(fields[1]),
                  let elapsed = seconds(fromElapsed: String(fields[2])) else { return nil }
            return Row(pid: pid, ppid: ppid, elapsed: elapsed, args: fields[3].trimmingCharacters(in: .whitespaces))
        }
    }

    /// `ps` etime: `[[dd-]hh:]mm:ss`, or bare seconds.
    static func seconds(fromElapsed text: String) -> TimeInterval? {
        var rest = Substring(text)
        var days = 0.0
        if let dash = rest.firstIndex(of: "-") {
            guard let d = Double(rest[rest.startIndex..<dash]) else { return nil }
            days = d
            rest = rest[rest.index(after: dash)...]
        }
        let parts = rest.split(separator: ":", omittingEmptySubsequences: false).map { Double($0) }
        guard (1...3).contains(parts.count), !parts.contains(where: { $0 == nil }) else { return nil }
        return days * 86_400 + parts.reduce(0) { $0 * 60 + $1! }
    }

    /// `pid` and everything below it, deepest first, so a parent is signalled
    /// only after the children that would be reparented away from it.
    static func treeDeepestFirst(of pid: pid_t, in rows: [Row]) -> [Row] {
        let byPid = Dictionary(rows.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        var ordered: [pid_t] = [pid]
        var index = 0
        var seen: Set<pid_t> = [pid]
        var children: [pid_t: [pid_t]] = [:]
        for row in rows { children[row.ppid, default: []].append(row.pid) }
        while index < ordered.count {
            for child in children[ordered[index]] ?? [] where seen.insert(child).inserted { ordered.append(child) }
            index += 1
        }
        return ordered.reversed().compactMap { byPid[$0] }
    }

    /// Every process below `pid`, however deep, in the given snapshot.
    static func descendants(of pid: pid_t, in rows: [Row]) -> [pid_t] {
        var children: [pid_t: [pid_t]] = [:]
        for row in rows { children[row.ppid, default: []].append(row.pid) }
        var found: [pid_t] = []
        var queue = children[pid] ?? []
        var seen: Set<pid_t> = [pid]
        while let next = queue.popLast() {
            guard seen.insert(next).inserted else { continue }
            found.append(next)
            queue += children[next] ?? []
        }
        return found
    }
}

public struct FoundationProcessRunner: ProcessRunner {
    private let registry = SpawnRegistry()
    /// A launcher younger than this is never a stray: a healthy one holds no
    /// port itself (its child does) and may simply still be starting. The
    /// default is the startup budget `ensure` waits.
    private let strayMinAge: TimeInterval

    public init(strayMinAge: TimeInterval = 90) {
        self.strayMinAge = strayMinAge
    }

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
        process.environment = Self.environment(
            base: Self.baseEnvironment(home: NSHomeDirectory(), inherited: ProcessInfo.processInfo.environment, variant: .current),
            adding: command.environment
        )
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
            registry.add(pid: process.processIdentifier, process: process, mode: ServiceMode(rawValue: label))
        } catch {
            if let handle { try? handle.close() }
            Self.appendEvent("failed to launch \(label): \(error.localizedDescription)", to: logURL)
        }
    }

    public func hasLiveSpawn(of mode: ServiceMode) -> Bool {
        registry.hasLive(mode: mode)
    }

    public func liveSpawnAge(of mode: ServiceMode) -> TimeInterval? {
        registry.liveAge(mode: mode)
    }

    public func terminateSpawn(of mode: ServiceMode, force: Bool) {
        for pid in registry.livePids(mode: mode) { signalTree(pid, signal: force ? SIGKILL : SIGTERM) }
    }

    /// The launcher and everything below it, deepest first. eve forks its
    /// server detached, so killing only the launcher would leave that child
    /// running, reparented to launchd, and holding the port. The tree is read
    /// before anything is signalled, while the parent links still exist, and
    /// every process is read again right before its signal: one whose command
    /// line changed (the pid was reused, or it exec'd) is skipped. A SIGTERM
    /// records the tree so `killTermedSurvivors` can finish what ignored it.
    /// `launcherArgs` is what the root was seen running earlier, when the pid
    /// came from a scan before this call. Not a process group: eve's child
    /// starts its own session, which a group signal would miss.
    private func signalTree(_ pid: pid_t, signal: Int32, launcherArgs: String? = nil) {
        let tree = ProcessTable.treeDeepestFirst(of: pid, in: ProcessTable.read())
        if signal == SIGTERM { registry.saveTree(root: pid, rows: tree) }
        let fresh = Dictionary(ProcessTable.read().map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        for row in tree {
            let expected = row.pid == pid ? (launcherArgs ?? row.args) : row.args
            guard let now = fresh[row.pid], now.args == expected else { continue }
            // A child that already exited is expected; only the launcher failing is news.
            if kill(row.pid, signal) != 0, row.pid == pid {
                Self.appendEvent(
                    "kill(\(signal)) failed for pid \(pid): \(String(cString: strerror(errno)))",
                    to: Self.supervisorLogURL
                )
            }
        }
    }

    public func killTermedSurvivors() {
        let trees = registry.takeTrees()
        guard !trees.isEmpty else { return }
        let fresh = Dictionary(ProcessTable.read().map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        for (_, rows) in trees {
            for row in rows {
                // Same pid, same command line, still running: it ignored the
                // SIGTERM or was left behind by a launcher that exited.
                guard let now = fresh[row.pid], now.args == row.args else { continue }
                _ = kill(row.pid, SIGKILL)
            }
        }
    }

    public func ownServiceProcesses(owns: @escaping @Sendable (String) -> Bool) -> [OwnedProcess] {
        let rows = ProcessTable.read()
        let byPid = Dictionary(rows.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        let me = getpid()
        var roots: [pid_t] = []
        for row in rows where row.pid != me {
            var owned = registry.contains(pid: row.pid) || owns(row.args)
            // The launcher's line carries the install path that Next's renamed
            // `next-server (vX)` drops, the same fallback `ownsProcess` uses.
            if !owned, let parent = byPid[row.ppid] { owned = owns(row.args + " " + parent.args) }
            // A renamed child whose launcher is gone: its working directory.
            if !owned, row.args.contains("next-server"), let cwd = workingDirectory(pid: row.pid) {
                owned = owns(row.args + " " + cwd)
            }
            if owned { roots.append(row.pid) }
        }
        guard !roots.isEmpty else { return [] }
        let starts = ProcessTable.startTimes()
        var seen: Set<pid_t> = []
        var found: [OwnedProcess] = []
        for root in roots {
            // The process first, then everything below it.
            for member in [root] + ProcessTable.descendants(of: root, in: rows) where member != me {
                guard seen.insert(member).inserted, let row = byPid[member], let started = starts[member] else { continue }
                found.append(OwnedProcess(pid: member, args: row.args, started: started))
            }
        }
        return found
    }

    public func isStillRunning(_ process: OwnedProcess) -> Bool {
        guard let now = ProcessTable.identity(of: process.pid) else { return false }
        return now.started == process.started && now.args == process.args
    }

    public func signalProcess(_ process: OwnedProcess, force: Bool) -> Bool {
        // Checked now, not at the snapshot: the pid may have exited and been
        // reused since, and only the same pid, start time and command is ours.
        guard isStillRunning(process) else { return false }
        return kill(process.pid, force ? SIGKILL : SIGTERM) == 0
    }

    public func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool {
        listenerPids(port: port).contains { pid in
            guard ownsProcess(pid: pid, owns: owns) else {
                if registry.shouldReport(port: port, pid: pid) {
                    Self.appendEvent(
                        "port \(port): listener pid \(pid) is not an own process; leaving it alive",
                        to: Self.supervisorLogURL
                    )
                }
                return true
            }
            return false
        }
    }

    public func listenerDescriptions(port: Int) -> [(pid: pid_t, line: String)] {
        listenerPids(port: port).map { pid in
            var text = commandLine(pid: pid)
            if let parent = parentPid(of: pid) { text += " \(commandLine(pid: parent))" }
            return (pid, text)
        }
    }

    public func foreignListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) -> [(pid: pid_t, command: String, parent: String?)] {
        listenerPids(port: port).compactMap { pid in
            guard !ownsProcess(pid: pid, owns: owns) else { return nil }
            return (pid, commandLine(pid: pid), parentPid(of: pid).map { commandLine(pid: $0) })
        }
    }

    public func strayServicePids(matching: @escaping @Sendable (String) -> Bool) -> [pid_t] {
        let rows = ProcessTable.read()
        let me = getpid()
        let candidates = rows.filter { row in
            row.pid != me && !registry.contains(pid: row.pid) && row.elapsed >= strayMinAge && matching(row.args)
        }
        guard !candidates.isEmpty else { return [] }
        // One lsof for the whole pass. When it cannot be read, nothing is a
        // stray: not knowing is not a licence to kill.
        guard let listening = listeningPids() else { return [] }
        return candidates.compactMap { row in
            // A healthy launcher holds no port of its own; its child does.
            let tree = [row.pid] + ProcessTable.descendants(of: row.pid, in: rows)
            guard !tree.contains(where: { listening.contains($0) }) else { return nil }
            registry.noteStray(pid: row.pid, args: row.args)
            return row.pid
        }
    }

    public func terminate(pids: [pid_t], force: Bool) {
        // The pid came from an earlier scan: it must still run what that scan saw.
        for pid in pids { signalTree(pid, signal: force ? SIGKILL : SIGTERM, launcherArgs: registry.strayArgs(pid: pid)) }
    }

    /// Every pid with a TCP listening socket, from one `lsof`; nil when lsof fails.
    func listeningPids() -> Set<pid_t>? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "p"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        // lsof exits 1 when nothing listens; any other failure prints nothing too.
        guard process.terminationStatus == 0 || process.terminationStatus == 1 else { return nil }
        let text = String(data: data, encoding: .utf8) ?? ""
        return Set(text.split(whereSeparator: \.isNewline).compactMap { line in
            line.hasPrefix("p") ? pid_t(line.dropFirst()) : nil
        })
    }

    func holdsListeningPort(pid: pid_t) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-t"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            // Not knowing is not a licence to kill.
            return true
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return !data.isEmpty
    }

    /// The short list a service (or setup) starts from. The dev variant alone
    /// also passes `UB_PAYLOAD_PROBE_DIR` (router/src/payload-probe.ts); the
    /// daily app never does, whatever it was launched with.
    static func baseEnvironment(home: String, inherited: [String: String], variant: AppVariant = .daily) -> [String: String] {
        var env: [String: String] = [
            // Apple Silicon Homebrew lives under /opt/homebrew; without it a
            // Homebrew-node subtree cannot see its sibling tools.
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": home,
        ]
        let names = variant == .dev ? ["SHELL", "USER", "LOGNAME", "LANG", "TZ", "UB_PAYLOAD_PROBE_DIR"] : ["SHELL", "USER", "LOGNAME", "LANG", "TZ"]
        for name in names {
            if let value = inherited[name], !value.isEmpty {
                env[name] = value
            }
        }
        return env
    }

    /// The whitelist plus what the command adds. The whitelist wins a clash:
    /// a command can add settings, not replace the user's PATH or HOME.
    static func environment(base: [String: String], adding extra: [String: String]) -> [String: String] {
        extra.merging(base) { _, whitelisted in whitelisted }
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
            // Recorded before the ownership check: the signal goes only to this
            // process, not to a pid that exited and was reused meanwhile.
            guard let identity = ProcessTable.identity(of: pid) else { continue }
            guard ownsProcess(pid: pid, owns: owns) else {
                if registry.shouldReport(port: port, pid: pid) {
                    Self.appendEvent(
                        "port \(port): listener pid \(pid) is not an own process; leaving it alive",
                        to: Self.supervisorLogURL
                    )
                }
                continue
            }
            let process = OwnedProcess(pid: pid, args: identity.args, started: identity.started)
            guard isStillRunning(process) else {
                Self.appendEvent(
                    "port \(port): listener pid \(pid) changed before the signal; skipped",
                    to: Self.supervisorLogURL
                )
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

    /// Whether `pid` belongs to this install. Next rewrites its argv to
    /// `next-server (vX)`, dropping the repo path, so include the parent
    /// command line: the service.mjs launcher still carries it and keeps the
    /// match repo-scoped. Fallbacks when the argv and parent line cannot
    /// identify it: a pid this app spawned, or the process's working directory
    /// (the repo root the launcher was started in) which survives the
    /// service.mjs parent dying and the child being reparented.
    func ownsProcess(pid: pid_t, owns: @Sendable (String) -> Bool) -> Bool {
        var text = commandLine(pid: pid)
        if let parent = parentPid(of: pid) {
            text += " \(commandLine(pid: parent))"
        }
        var owned = registry.contains(pid: pid) || owns(text)
        if !owned, let cwd = workingDirectory(pid: pid) {
            text += " \(cwd)"
            owned = owns(text)
        }
        return owned
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
        let directory = AppVariant.current.logsDirectory(home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
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

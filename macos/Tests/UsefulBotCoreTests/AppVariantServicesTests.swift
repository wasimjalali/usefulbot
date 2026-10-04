#if os(macOS)
import Testing
import Foundation
@testable import UsefulBotCore

/// What the dev build's service layer does and, more to the point, refuses to
/// do next to a running daily stack.

private final class StackProbe: HealthProbe, @unchecked Sendable {
    private let lock = NSLock()
    private var readings: [String: HealthReading]
    private(set) var asked: [String] = []

    init(_ readings: [String: HealthReading] = [:]) { self.readings = readings }

    func set(_ url: URL, _ reading: HealthReading?) {
        lock.lock(); defer { lock.unlock() }
        readings[url.absoluteString] = reading
    }

    func probe(_ url: URL) async -> Bool { await read(url) != nil }

    func read(_ url: URL) async -> HealthReading? {
        lock.lock(); defer { lock.unlock() }
        asked.append(url.absoluteString)
        return readings[url.absoluteString]
    }
}

private final class StackRunner: ProcessRunner, @unchecked Sendable {
    var started: [ServiceCommand] = []
    var listening: [Int: [pid_t]] = [:]
    var stopped: [Int] = []
    var forceStopped: [Int] = []

    func start(_ command: ServiceCommand) { started.append(command) }
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { listening[port] ?? [] }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        stopped.append(port)
        listening[port] = []
    }
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        forceStopped.append(port)
        listening[port] = []
    }
}

/// The port frees the moment the listener is signalled, as Next's and eve's do,
/// but the process (and a child under it) keeps running until it is let go.
private final class DrainingRunner: ProcessRunner, @unchecked Sendable {
    private let lock = NSLock()
    var listening: [Int: [pid_t]] = [:]
    var running: [OwnedProcess] = []
    /// Processes that ignore SIGTERM and only die to SIGKILL.
    var stubborn: Set<pid_t> = []
    /// Processes that survive SIGKILL too (uninterruptible).
    var unkillable: Set<pid_t> = []
    /// How many SIGKILLs an unkillable process ignores before it dies.
    var survivesKills = Int.max
    /// A rescan finds the processes only once: their launcher parent is gone after that.
    var hideAfterFirstScan = false
    private var scans = 0
    /// Checks of a TERMed process after which it exits (when not stubborn).
    var exitAfterChecks = 2
    private(set) var termed: [pid_t] = []
    private(set) var killed: [pid_t] = []
    private(set) var exitChecksWithPortFree = 0
    private var checks: [pid_t: Int] = [:]

    func start(_ command: ServiceCommand) {}
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { listening[port] ?? [] }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) { listening[port] = [] }
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) { listening[port] = [] }
    /// Found from the process table: listening or not.
    func ownServiceProcesses(owns: @escaping @Sendable (String) -> Bool) -> [OwnedProcess] {
        lock.lock(); defer { lock.unlock() }
        scans += 1
        if hideAfterFirstScan, scans > 1 { return [] }
        return running
    }
    func isStillRunning(_ process: OwnedProcess) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if listening.values.allSatisfy({ $0.isEmpty }) { exitChecksWithPortFree += 1 }
        if termed.contains(process.pid), !stubborn.contains(process.pid) {
            checks[process.pid, default: 0] += 1
            if checks[process.pid]! >= exitAfterChecks { running.removeAll { $0 == process } }
        }
        return running.contains(process)
    }
    func signalProcess(_ process: OwnedProcess, force: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard running.contains(process) else { return false }
        if force {
            killed.append(process.pid)
            if !unkillable.contains(process.pid) || killed.count > survivesKills { running.removeAll { $0 == process } }
        } else {
            termed.append(process.pid)
        }
        return true
    }
}

/// A runner whose listeners carry a command line, so the ownership rule that
/// `LocalServices` hands it is the one that decides.
private final class LineRunner: ProcessRunner, @unchecked Sendable {
    var listening: [Int: [(pid: pid_t, line: String)]] = [:]
    private(set) var signalled = 0
    private(set) var started = 0
    func start(_ command: ServiceCommand) { started += 1 }
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { (listening[port] ?? []).map(\.pid) }
    func listenerDescriptions(port: Int) -> [(pid: pid_t, line: String)] { listening[port] ?? [] }
    /// What the rule handed to a stop call says about each listener on the port.
    private(set) var stopVerdicts: [Bool] = []
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        signalled += 1
        stopVerdicts += (listening[port] ?? []).map { owns($0.line) }
    }
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        signalled += 1
        stopVerdicts += (listening[port] ?? []).map { owns($0.line) }
    }
    func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool {
        (listening[port] ?? []).contains { !owns($0.line) }
    }
}

/// Reports a foreign listener the way the real runner does: its own command and
/// its parent's apart, picked by the ownership rule it is handed.
private final class ParentRunner: ProcessRunner, @unchecked Sendable {
    var listening: [Int: [(pid: pid_t, command: String, parent: String?)]] = [:]
    func start(_ command: ServiceCommand) {}
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { (listening[port] ?? []).map(\.pid) }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func foreignListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) -> [(pid: pid_t, command: String, parent: String?)] {
        (listening[port] ?? []).filter { !owns($0.command + " " + ($0.parent ?? "")) }
    }
    func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool {
        !foreignListeners(port: port, owns: owns).isEmpty
    }
}

@Suite struct AppVariantServicesTests {
    private let devRoot = "/Users/x/Library/Application Support/Useful Bot Dev/app"
    private let releaseRoot = "/Users/x/Library/Application Support/Useful Bot/app"

    private func eveStack(_ variant: AppVariant, line: String, repoPath: String, pid: pid_t = 4242) -> (LocalServices, LineRunner, ServerConfig) {
        let runner = LineRunner()
        runner.listening[variant.evePort] = [(pid, line)]
        let probe = allHealthy(variant, stack: variant == .dev ? "dev" : nil)
        let services = LocalServices(
            runner: runner, probe: probe, supervisor: nodeOK, startGraceSeconds: 0, devRuntimeRoot: devRoot,
            releaseRuntimeRoot: releaseRoot, checkoutRoot: "/Users/x/Desktop/useful-bot"
        )
        return (services, runner, ServerConfig(repoPath: repoPath, port: variant == .dev ? 4420 : 4320, variant: variant))
    }

    @Test func dailyAdoptsAnEveFromAnotherDailyRuntime() async {
        // The checkout build and the release build share the daily ports and must
        // be able to take over from each other across a repoPath switch.
        let (services, runner, config) = eveStack(
            .daily, line: "node /Users/x/Desktop/useful-bot/node_modules/eve/bin/eve.js dev", repoPath: releaseRoot)
        #expect(await services.ensure(config: config, timeoutSeconds: 0) == .ready)
        #expect(runner.started == 0 && runner.signalled == 0)
    }

    @Test func dailyRefusesAListenerThatIsNotEveAndNamesIt() async {
        let (services, runner, config) = eveStack(.daily, line: "python3 -m http.server 4321", repoPath: releaseRoot, pid: 7007)
        #expect(await services.ensure(config: config, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started == 0 && runner.signalled == 0)
        #expect(await services.foreignListenerDetail(config: config)?.contains("7007") == true)
    }

    @Test func noStopPathEverTargetsAnEveTheStrictRuleDoesNotOwn() async {
        // Adoption is lenient for daily; signalling never is. An unhealthy eve from
        // the checkout, seen by a release-path app, is adopted for readiness but its
        // stop rule must say "not ours", while the app's own eve is.
        let foreignToRepo = "node /Users/x/Desktop/useful-bot/node_modules/eve/bin/eve.js dev"
        let ownLine = "node \(releaseRoot)/node_modules/eve/bin/eve.js dev"
        for (line, expected) in [(foreignToRepo, false), (ownLine, true)] {
            let runner = LineRunner()
            runner.listening[AppVariant.daily.evePort] = [(4343, line)]
            let probe = allHealthy(.daily, stack: nil)
            probe.set(AppVariant.daily.eveHealthURL, nil)
            let services = LocalServices(
                runner: runner, probe: probe, supervisor: nodeOK, startGraceSeconds: 0, devRuntimeRoot: devRoot,
                releaseRuntimeRoot: releaseRoot, checkoutRoot: "/Users/x/Desktop/useful-bot")
            _ = await services.ensure(
                config: ServerConfig(repoPath: releaseRoot, port: 4320, variant: .daily), timeoutSeconds: 0)
            #expect(!runner.stopVerdicts.isEmpty)
            #expect(runner.stopVerdicts.allSatisfy { $0 == expected }, "\(line)")
        }
    }

    @Test func dailyRefusesAnEveRunningFromTheDevRuntimeAndNamesIt() async {
        let (services, runner, config) = eveStack(
            .daily, line: "node \(devRoot)/node_modules/eve/bin/eve.js dev", repoPath: releaseRoot, pid: 5150)
        #expect(await services.ensure(config: config, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started == 0 && runner.signalled == 0)
        let detail = await services.foreignListenerDetail(config: config)
        #expect(detail?.contains("5150") == true)
        #expect(detail?.contains(devRoot) == true)
    }

    @Test func foreignDetailShowsChildAndParentAsTwoParts() async {
        let runner = ParentRunner()
        runner.listening[AppVariant.daily.evePort] = [(pid: 9001, command: "python3 -m http.server", parent: "/bin/zsh -l")]
        let services = LocalServices(
            runner: runner, probe: allHealthy(.daily, stack: nil), supervisor: nodeOK, startGraceSeconds: 0,
            devRuntimeRoot: devRoot, releaseRuntimeRoot: releaseRoot, checkoutRoot: "/Users/x/Desktop/useful-bot")
        let config = ServerConfig(repoPath: releaseRoot, port: 4320, variant: .daily)
        let detail = await services.foreignListenerDetail(config: config)
        #expect(detail?.hasSuffix("pid 9001: python3 -m http.server (parent: /bin/zsh -l)") == true)
    }

    @Test func devKeepsStrictEveOwnership() async {
        let (services, runner, config) = eveStack(
            .dev, line: "node \(releaseRoot)/node_modules/eve/bin/eve.js dev", repoPath: devRoot, pid: 6001)
        #expect(await services.ensure(config: config, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started == 0 && runner.signalled == 0)
        let detail = await services.foreignListenerDetail(config: config)
        #expect(detail?.contains("6001") == true)
        #expect(detail?.contains(releaseRoot) == true)
        let own = eveStack(.dev, line: "node \(devRoot)/node_modules/eve/bin/eve.js dev", repoPath: devRoot)
        #expect(await own.0.ensure(config: own.2, timeoutSeconds: 0) == .ready)
        #expect(await own.0.foreignListenerDetail(config: own.2) == nil)
    }

    private let devConfig = ServerConfig(repoPath: "/repo", port: 4420, variant: .dev)
    private let dailyConfig = ServerConfig(repoPath: "/repo", port: 4320, variant: .daily)
    private let nodeOK = ServiceSupervisor(nodeExists: { _ in true })

    private func allHealthy(_ variant: AppVariant, stack: String?) -> StackProbe {
        let probe = StackProbe()
        let reading = HealthReading(stack: stack)
        probe.set(variant.routerHealthURL, reading)
        probe.set(variant.eveHealthURL, HealthReading(stack: nil))
        probe.set(variant.webBaseURL.appendingPathComponent("api/health"), reading)
        return probe
    }

    // MARK: - Config

    @Test func devConfigServesOnlyTheDevWebPort() {
        #expect(devConfig.port == 4420)
        #expect(devConfig.baseURL.absoluteString == "http://127.0.0.1:4420")
        #expect(devConfig.healthURL.absoluteString == "http://127.0.0.1:4420/api/health")
        // A stored daily port (or any other) never moves it onto the daily stack.
        for port in [4320, 4419, 4421, 80, 0, 99999] {
            #expect(ServerConfig(repoPath: "/repo", port: port, variant: .dev).port == 4420)
        }
    }

    @Test func dailyConfigStillRefusesTheDevPort() {
        #expect(ServerConfig(repoPath: "/repo", port: 4420, variant: .daily).port == 4320)
    }

    @Test func devResolvesToItsOwnInstallRootNeverTheCheckout() {
        let name = "AppVariantServicesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let config = ServerConfig.resolved(defaults: defaults, variant: .dev)
        #expect(config.variant == .dev)
        #expect(config.port == 4420)
        #expect(config.repoPath == RuntimeInstall.installRoot(variant: .dev).path)
        #expect(config.repoPath.hasSuffix("/Library/Application Support/Useful Bot Dev/app"))
        // A stored override (the checkout, or the daily install) never moves it.
        for stray in ["~/Desktop/useful-bot", RuntimeInstall.installRoot(variant: .daily).path] {
            defaults.set(stray, forKey: "repoPath")
            #expect(ServerConfig.resolved(defaults: defaults, variant: .dev).repoPath == RuntimeInstall.installRoot(variant: .dev).path)
        }
    }

    @Test func dailyStillHonoursAStoredRepoPath() {
        let name = "AppVariantServicesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("/somewhere/else", forKey: "repoPath")
        #expect(ServerConfig.resolved(defaults: defaults, variant: .daily).repoPath == "/somewhere/else")
    }

    // MARK: - Service command environment

    @Test func devServicesGetTheDevEnvironment() {
        let command = nodeOK.command(mode: .web, repoPath: "/repo", variant: .dev)
        #expect(command.environment == AppVariant.dev.serviceEnvironment(home: FileManager.default.homeDirectoryForCurrentUser))
        #expect(Set(command.environment.keys) == [
            "UB_STACK", "UB_STATE_ROOT", "UB_ROUTER_PORT", "UB_WEB_PORT", "UB_EVE_PORT",
            "UB_KEYCHAIN_PREFIX", "UB_MEDIA_DIR", "UB_WEB_BASE_URL",
        ])
    }

    @Test func dailyServicesGetNoExtraEnvironment() {
        for mode in [ServiceMode.router, .eve, .web] {
            let command = nodeOK.command(mode: mode, repoPath: "/repo", variant: .daily)
            #expect(command.environment.isEmpty)
            #expect(command.arguments == ["/repo/scripts/service.mjs", mode.rawValue])
        }
    }

    @Test func theRunnerPassesTheCommandEnvironmentOverTheWhitelist() {
        let base = ["PATH": "/usr/bin", "HOME": "/Users/test", "SHELL": "/bin/zsh"]
        // Daily: exactly the whitelist, as before.
        #expect(FoundationProcessRunner.environment(base: base, adding: [:]) == base)
        // Dev: the whitelist plus the contract keys, which win on a clash.
        let merged = FoundationProcessRunner.environment(base: base, adding: ["UB_STACK": "dev", "HOME": "/nope"])
        #expect(merged["UB_STACK"] == "dev")
        #expect(merged["HOME"] == "/Users/test")
        #expect(merged["PATH"] == "/usr/bin")
    }

    // MARK: - Readiness never adopts another stack

    @Test func devIsReadyWhenItsOwnStackAnswers() async {
        let runner = StackRunner()
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0)
        #expect(await services.ensure(config: devConfig, timeoutSeconds: 0) == .ready)
        #expect(runner.started.isEmpty)
    }

    @Test func devNeverAdoptsARunningDailyStack() async {
        // Everything on the daily ports is healthy; nothing on the dev ports.
        let runner = StackRunner()
        let probe = allHealthy(.daily, stack: "daily")
        let services = LocalServices(runner: runner, probe: probe, supervisor: nodeOK, startGraceSeconds: 0)
        let outcome = await services.ensure(config: devConfig, timeoutSeconds: 0)
        #expect(outcome == .unavailable)
        // It started its own three, with the dev environment, ...
        #expect(runner.started.map { $0.arguments.last ?? "" } == ["router", "eve", "web"])
        #expect(runner.started.allSatisfy { $0.environment["UB_STACK"] == "dev" })
        // ... never asked the daily ports at all, and never signalled anything.
        let dailyPorts = [":4319", ":4320", ":4321"]
        #expect(!probe.asked.contains { url in dailyPorts.contains { url.contains($0) } })
        #expect(runner.stopped.isEmpty)
        #expect(runner.forceStopped.isEmpty)
    }

    @Test func aDailyStackAnsweringOnADevPortIsForeignAndLeftAlone() async {
        let runner = StackRunner()
        runner.listening = [4420: [9001], 4419: [9002], 4421: [9003]]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "daily"), supervisor: nodeOK, startGraceSeconds: 0)
        let outcome = await services.ensure(config: devConfig, timeoutSeconds: 0)
        #expect(outcome == .foreignStack)
        #expect(runner.started.isEmpty)
        #expect(runner.stopped.isEmpty)
        #expect(runner.forceStopped.isEmpty)
    }

    @Test func aMissingStackFieldOnADevPortIsForeign() async {
        // A service that predates the stack field: healthy, but not provably ours.
        let runner = StackRunner()
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: nil), supervisor: nodeOK, startGraceSeconds: 0)
        #expect(await services.ensure(config: devConfig, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started.isEmpty)
        #expect(runner.stopped.isEmpty)
    }

    @Test func oneForeignServiceIsEnoughToRefuse() async {
        let runner = StackRunner()
        let probe = allHealthy(.dev, stack: "dev")
        probe.set(AppVariant.dev.routerHealthURL, HealthReading(stack: "daily"))
        let services = LocalServices(runner: runner, probe: probe, supervisor: nodeOK, startGraceSeconds: 0)
        #expect(await services.ensure(config: devConfig, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started.isEmpty)
    }

    @Test func dailyRefusesADevStackOnItsPortsButAcceptsToday() async {
        let runner = StackRunner()
        let foreign = LocalServices(runner: runner, probe: allHealthy(.daily, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0)
        #expect(await foreign.ensure(config: dailyConfig, timeoutSeconds: 0) == .foreignStack)
        #expect(runner.started.isEmpty)
        // Today's services answer with no stack field: still ready.
        let today = LocalServices(runner: runner, probe: allHealthy(.daily, stack: nil), supervisor: nodeOK, startGraceSeconds: 0)
        #expect(await today.ensure(config: dailyConfig, timeoutSeconds: 0) == .ready)
        #expect(runner.started.isEmpty)
    }

    @Test func stoppingServicesLeavesAForeignStackAlone() async {
        let runner = StackRunner()
        runner.listening = [4420: [9001], 4419: [9002], 4421: [9003]]
        // Web and router answer as the daily stack; eve has no stack field.
        let probe = allHealthy(.dev, stack: "daily")
        let services = LocalServices(runner: runner, probe: probe, supervisor: nodeOK, startGraceSeconds: 0)
        await services.stopOwnServices(config: devConfig)
        #expect(!runner.stopped.contains(4420))
        #expect(!runner.stopped.contains(4419))
        #expect(!runner.forceStopped.contains(4420))
        #expect(!runner.forceStopped.contains(4419))
    }

    @Test func stoppingServicesWaitsForTheProcessToExitNotJustThePort() async {
        let runner = DrainingRunner()
        runner.listening = [4420: [9001], 4419: [9002], 4421: [9003]]
        // A listener and its child: the port frees at once, the processes drain later.
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1"), OwnedProcess(pid: 9004, args: "eve local-server-child", started: "t2")]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 5)
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .stopped)
        #expect(runner.running.isEmpty, "returned while a process of the old version was still running")
        #expect(runner.exitChecksWithPortFree >= 2, "the exit was awaited after the port had freed")
        #expect(runner.killed.isEmpty, "a process that exited on SIGTERM is never SIGKILLed")
        #expect(Set(runner.termed) == [9001, 9004])
    }

    @Test func aServiceAlreadyDrainingWithNoListenerIsStillStoppedAndAwaited() async {
        let runner = DrainingRunner()
        // Every port is already closed: the old writer is mid-drain and found only from the process table.
        runner.listening = [:]
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1")]
        runner.stubborn = [9001]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.2)
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .stopped)
        #expect(runner.termed == [9001])
        #expect(runner.killed == [9001])
        #expect(runner.running.isEmpty)
    }

    @Test func aProcessThatIgnoresSigtermIsKilledAfterTheTimeoutAndAwaited() async {
        let runner = DrainingRunner()
        runner.listening = [4420: [9001]]
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1")]
        runner.stubborn = [9001]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.3)
        let started = Date()
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .stopped)
        #expect(runner.killed == [9001], "SIGKILL follows the timeout")
        #expect(runner.running.isEmpty)
        #expect(Date().timeIntervalSince(started) >= 0.3, "SIGKILL came before the SIGTERM grace ran out")
    }

    @Test func aSurvivorOfSigkillIsReportedSoTheRuntimeIsNotReplaced() async {
        let runner = DrainingRunner()
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1")]
        runner.stubborn = [9001]
        runner.unkillable = [9001]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.2)
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .wouldNotStop(["next-server (v15)"]))
        #expect(result.didNotStop)
        #expect(runner.killed.count >= 1)
    }

    @Test func aSurvivorWhoseParentIsGoneIsStillReportedNotDroppedByTheRescan() async {
        let runner = DrainingRunner()
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1")]
        runner.stubborn = [9001]
        runner.unkillable = [9001]
        runner.hideAfterFirstScan = true
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.2)
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .wouldNotStop(["next-server (v15)"]))
    }

    @Test func aSurvivorThatDiesInTheSecondRoundIsStopped() async {
        let runner = DrainingRunner()
        runner.running = [OwnedProcess(pid: 9001, args: "next-server (v15)", started: "t1")]
        runner.stubborn = [9001]
        runner.unkillable = [9001]
        runner.survivesKills = 1
        runner.hideAfterFirstScan = true
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "dev"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.2)
        let result = await services.stopOwnServices(config: devConfig)
        #expect(result == .stopped)
        #expect(runner.killed == [9001, 9001])
        #expect(runner.running.isEmpty)
    }

    @Test func aForeignStackPortIsNotSignalledByTheListenerStop() async {
        let runner = DrainingRunner()
        runner.listening = [4420: [9001], 4419: [9002]]
        let services = LocalServices(runner: runner, probe: allHealthy(.dev, stack: "daily"), supervisor: nodeOK, startGraceSeconds: 0, stopExitGraceSeconds: 0.3)
        let result = await services.stopOwnServices(config: devConfig)
        // Nothing of this install is running, and the other stack's listeners were left alone.
        #expect(result == .stopped)
        #expect(runner.listening[4420] == [9001])
        #expect(runner.listening[4419] == [9002])
        #expect(runner.termed.isEmpty)
    }

    // MARK: - The dev runtime payload and its setup

    private func makeRuntimeFolders(stamp: String = "0.0.0-dev+abc1234.ffffffff") throws -> (root: URL, bundled: URL, install: URL, home: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ub-variant-\(UUID().uuidString)")
        let bundled = root.appendingPathComponent("bundled")
        try FileManager.default.createDirectory(at: bundled.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try stamp.write(to: bundled.appendingPathComponent(RuntimeInstall.stampName), atomically: true, encoding: .utf8)
        let home = root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return (root, bundled, root.appendingPathComponent("install"), home)
    }

    private func writeConfig(under stateRoot: URL) throws {
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        try "{}".write(to: stateRoot.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
    }

    /// Records every tool `prepare` would run. `failing` makes the matching
    /// setup invocation exit with the given status.
    private final class ToolLog: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var invocations: [RuntimeInstall.ToolInvocation] = []
        var failSetupWith: [String: Int32] = [:]

        var runner: RuntimeInstall.ToolRunner {
            { [self] invocation, _ in
                lock.lock()
                invocations.append(invocation)
                let status = failSetupWith[invocation.arguments.last ?? ""]
                lock.unlock()
                if let status { throw RuntimeInstall.Failure(description: "node exited \(status)", status: status) }
            }
        }

        var setupCalls: [RuntimeInstall.ToolInvocation] { invocations.filter { $0.tool.hasSuffix("/node") } }
    }

    @Test func devCarriesAndResolvesARuntimePayload() throws {
        #expect(AppVariant.dev.usesRuntimePayload)
        let resources = FileManager.default.temporaryDirectory.appendingPathComponent("ub-variant-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: resources) }
        let runtime = resources.appendingPathComponent("runtime")
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try "0.0.0-dev+abc1234".write(to: runtime.appendingPathComponent(RuntimeInstall.stampName), atomically: true, encoding: .utf8)
        #expect(RuntimeInstall.bundledRuntime(resources: resources, variant: .daily)?.path == runtime.path)
        #expect(RuntimeInstall.bundledRuntime(resources: resources, variant: .dev)?.path == runtime.path)
    }

    @Test func devPrepareRunsSetupOnlyWithTheDevEnvironment() throws {
        // The setup tool gets the dev settings and no other UB_* value, however the
        // app was launched: the inherited environment below is the daily stack's.
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        let log = ToolLog()
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .dev, home: folders.home, runTool: log.runner)

        let setup = try #require(log.setupCalls.first)
        #expect(log.setupCalls.count == 1)
        #expect(setup.tool == folders.install.appendingPathComponent("bin/node").path)
        // No config yet: the plain first-time setup, never a rotation or a rebuild.
        #expect(setup.arguments == [folders.install.appendingPathComponent("scripts/setup-local.mjs").path])
        #expect(setup.cwd?.path == folders.install.path)
        let env = try #require(setup.environment)
        let stateRoot = AppVariant.dev.stateRoot(home: folders.home).path
        #expect(env["UB_STACK"] == "dev")
        #expect(env["UB_STATE_ROOT"] == stateRoot)
        #expect(env["UB_ROUTER_PORT"] == "4419")
        #expect(env["UB_WEB_PORT"] == "4420")
        #expect(env["UB_EVE_PORT"] == "4421")
        #expect(env["UB_KEYCHAIN_PREFIX"] == "com.usefulbot.dev")
        #expect(env["UB_MEDIA_DIR"] == AppVariant.dev.mediaDirectory(home: folders.home).path)
        #expect(env["UB_WEB_BASE_URL"] == "http://127.0.0.1:4420")
        #expect(Set(env.keys.filter { $0.hasPrefix("UB_") }) == Set(AppVariant.dev.serviceEnvironment(home: folders.home).keys))
        // Nothing in it names the daily stack.
        let dailyState = AppVariant.daily.stateRoot(home: folders.home).path
        for (key, value) in env where key.hasPrefix("UB_") {
            #expect(value != dailyState && value != "com.usefulbot" && !["4319", "4320", "4321"].contains(value), "\(key)=\(value)")
        }
        // Every invocation of the whole prepare stays inside the dev install root.
        for call in log.invocations {
            #expect(!call.arguments.contains { $0.contains("/Application Support/Useful Bot/") }, "\(call)")
        }
    }

    @Test func devPrepareDoesNotInheritAnotherStackFromTheApp() {
        let inherited = ["UB_STACK": "daily", "UB_ROUTER_PORT": "4319", "UB_KEYCHAIN_PREFIX": "com.usefulbot", "UB_STATE_ROOT": "/Users/test/.useful-bot", "NODE_OPTIONS": "--inspect"]
        let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)
        let env = RuntimeInstall.setupEnvironment(variant: .dev, home: home, inherited: inherited)
        #expect(env?["UB_STACK"] == "dev")
        #expect(env?["UB_ROUTER_PORT"] == "4419")
        #expect(env?["UB_KEYCHAIN_PREFIX"] == "com.usefulbot.dev")
        #expect(env?["UB_STATE_ROOT"] == "/Users/test/.useful-bot-dev-app")
        #expect(env?["NODE_OPTIONS"] == nil)
    }

    @Test func dailySetupGetsTheServiceWhitelistAndNoUBKeys() throws {
        // setup-local honours UB_STACK, UB_STATE_ROOT and UB_KEYCHAIN_PREFIX, so a
        // daily setup must not inherit them from however the app was launched.
        let inherited = [
            "UB_STACK": "dev", "UB_STATE_ROOT": "/Users/test/.useful-bot-dev-app", "UB_KEYCHAIN_PREFIX": "com.usefulbot.dev",
            "UB_ROUTER_PORT": "4419", "UB_ANYTHING": "x",
            "NODE_OPTIONS": "--inspect", "DYLD_INSERT_LIBRARIES": "/x.dylib", "SHELL": "/bin/zsh", "USER": "test",
        ]
        let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)
        let env = try #require(RuntimeInstall.setupEnvironment(variant: .daily, home: home, inherited: inherited))
        #expect(env.keys.filter { $0.hasPrefix("UB_") }.isEmpty)
        #expect(env["NODE_OPTIONS"] == nil && env["DYLD_INSERT_LIBRARIES"] == nil)
        #expect(env["HOME"] == "/Users/test")
        #expect(env["SHELL"] == "/bin/zsh" && env["USER"] == "test")
        // The same list a daily service starts from.
        #expect(env == FoundationProcessRunner.environment(
            base: FoundationProcessRunner.baseEnvironment(home: home.path, inherited: inherited),
            adding: AppVariant.daily.serviceEnvironment(home: home)
        ))
    }

    @Test func onlyTheDevVariantPassesThePayloadProbeDir() {
        let inherited = ["UB_PAYLOAD_PROBE_DIR": "/tmp/probe", "SHELL": "/bin/zsh"]
        let daily = FoundationProcessRunner.baseEnvironment(home: "/Users/test", inherited: inherited, variant: .daily)
        let dev = FoundationProcessRunner.baseEnvironment(home: "/Users/test", inherited: inherited, variant: .dev)
        #expect(daily["UB_PAYLOAD_PROBE_DIR"] == nil)
        #expect(dev["UB_PAYLOAD_PROBE_DIR"] == "/tmp/probe")
        #expect(FoundationProcessRunner.baseEnvironment(home: "/Users/test", inherited: inherited)["UB_PAYLOAD_PROBE_DIR"] == nil)
        #expect(FoundationProcessRunner.baseEnvironment(home: "/Users/test", inherited: ["SHELL": "/bin/zsh"], variant: .dev)["UB_PAYLOAD_PROBE_DIR"] == nil)
    }

    @Test func dailyPrepareRunsSetupWithAnExplicitEnvironment() throws {
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        let log = ToolLog()
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .daily, home: folders.home, runTool: log.runner)
        let setup = try #require(log.setupCalls.first)
        let env = try #require(setup.environment)
        #expect(env.keys.filter { $0.hasPrefix("UB_") }.isEmpty)
    }

    @Test func devAConfiguredDevStateIsRefreshedNotRotated() throws {
        // The state a manual `npm run setup:dev` left: config.json under the dev root.
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        try writeConfig(under: AppVariant.dev.stateRoot(home: folders.home))
        let log = ToolLog()
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        let replaced = try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .dev, home: folders.home, runTool: log.runner)
        #expect(!replaced)
        #expect(log.setupCalls.map(\.arguments.last) == ["--add-missing"])
        #expect(!log.invocations.contains { $0.arguments.contains("--rotate") || $0.arguments.contains("--rebuild-orphaned") })
    }

    @Test func devFirstRunCheckNeverLooksAtTheDailyConfig() throws {
        // A daily config exists, the dev one does not: dev is still unconfigured.
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        try writeConfig(under: AppVariant.daily.stateRoot(home: folders.home))
        let log = ToolLog()
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .dev, home: folders.home, runTool: log.runner)
        #expect(log.setupCalls.map(\.arguments.count) == [1])
    }

    @Test func devOrphanedKeychainIsRebuiltUnderTheSameDevEnvironment() throws {
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        let log = ToolLog()
        // The plain setup answers "Keychain items, no config" (exit 3): the app rebuilds.
        let setup = folders.install.appendingPathComponent("scripts/setup-local.mjs").path
        log.failSetupWith[setup] = RuntimeInstall.orphanedExitStatus
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        let replaced = try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .dev, home: folders.home, runTool: log.runner)
        #expect(replaced)
        #expect(log.setupCalls.map(\.arguments.last) == [setup, "--rebuild-orphaned"])
        let envs = log.setupCalls.map(\.environment)
        #expect(envs[0] == envs[1])
        #expect(envs[1]?["UB_KEYCHAIN_PREFIX"] == "com.usefulbot.dev")
        #expect(envs[1]?["UB_STATE_ROOT"] == AppVariant.dev.stateRoot(home: folders.home).path)
    }

    @Test func dailyPrepareRunsTheSameFlagsOnTheWhitelistEnvironment() throws {
        // Daily setup runs the same flags, now on the service whitelist rather than the app's environment.
        let folders = try makeRuntimeFolders(stamp: "1.0.0+1")
        defer { try? FileManager.default.removeItem(at: folders.root) }
        try writeConfig(under: AppVariant.daily.stateRoot(home: folders.home))
        let log = ToolLog()
        let lock = try RuntimeInstall.InstallLock(root: folders.install)
        try RuntimeInstall.prepare(bundled: folders.bundled, root: folders.install, holding: lock, variant: .daily, home: folders.home, runTool: log.runner)
        #expect(log.invocations.map(\.tool) == ["/usr/bin/rsync", "/usr/bin/xattr", folders.install.appendingPathComponent("bin/node").path])
        #expect(log.setupCalls.map(\.arguments.last) == ["--add-missing"])
        #expect(log.setupCalls.allSatisfy { $0.environment?.keys.contains { $0.hasPrefix("UB_") } == false })
    }

    @Test func eachVariantRefusesTheOthersInstallRoot() throws {
        let folders = try makeRuntimeFolders()
        defer { try? FileManager.default.removeItem(at: folders.root) }
        for (variant, other) in [(AppVariant.dev, AppVariant.daily), (.daily, .dev)] {
            let target = RuntimeInstall.installRoot(variant: other)
            let log = ToolLog()
            // Never takes the real lock file either: the lock is on a scratch folder.
            let lock = try RuntimeInstall.InstallLock(root: folders.install)
            #expect(throws: RuntimeInstall.Failure.self) {
                try RuntimeInstall.prepare(bundled: folders.bundled, root: target, holding: lock, variant: variant, home: folders.home, runTool: log.runner)
            }
            #expect(log.invocations.isEmpty)
        }
    }

    @Test func needsCopyIsJudgedPerRoot() throws {
        let folders = try makeRuntimeFolders(stamp: "0.0.0-dev+abc1234.11111111")
        defer { try? FileManager.default.removeItem(at: folders.root) }
        #expect(RuntimeInstall.needsCopy(bundled: folders.bundled, root: folders.install))
        try FileManager.default.createDirectory(at: folders.install, withIntermediateDirectories: true)
        try "0.0.0-dev+abc1234.11111111".write(to: folders.install.appendingPathComponent(RuntimeInstall.stampName), atomically: true, encoding: .utf8)
        #expect(!RuntimeInstall.needsCopy(bundled: folders.bundled, root: folders.install))
        // A new dev build (same commit, different content) copies again.
        try "0.0.0-dev+abc1234.22222222".write(to: folders.bundled.appendingPathComponent(RuntimeInstall.stampName), atomically: true, encoding: .utf8)
        #expect(RuntimeInstall.needsCopy(bundled: folders.bundled, root: folders.install))
    }

    @Test func devNeverOffersToMoveItself() {
        let elsewhere = AppPlacement.Location.elsewhere(path: "/Users/test/Downloads/Useful Bot Dev.app")
        #expect(AppPlacement.shouldOffer(isRelease: true, suppressed: false, location: elsewhere, variant: .daily))
        #expect(!AppPlacement.shouldOffer(isRelease: true, suppressed: false, location: elsewhere, variant: .dev))
    }

    @Test func eachInstallRootOwnsOnlyItsOwnServiceProcesses() {
        // "Useful Bot" is a prefix of "Useful Bot Dev": stopping or adopting must still
        // never cross from one app's copy to the other's.
        let support = URL(fileURLWithPath: "/Users/test/Library/Application Support", isDirectory: true)
        let daily = RuntimeInstall.installRoot(support: support, variant: .daily).path
        let dev = RuntimeInstall.installRoot(support: support, variant: .dev).path
        for tail in ["scripts/service.mjs web", "node_modules/eve/bin/eve.js dev --port 4321", "router/src/index.ts"] {
            let dailyLine = "\(daily)/bin/node --experimental-strip-types \(daily)/\(tail)"
            let devLine = "\(dev)/bin/node --experimental-strip-types \(dev)/\(tail)"
            #expect(nodeOK.isOwnNodeProcess(dailyLine, repoPath: daily))
            #expect(nodeOK.isOwnNodeProcess(devLine, repoPath: dev))
            #expect(!nodeOK.isOwnNodeProcess(dailyLine, repoPath: dev))
            #expect(!nodeOK.isOwnNodeProcess(devLine, repoPath: daily))
        }
        // The working-directory fallback appends the path with nothing after it.
        #expect(!nodeOK.isOwnNodeProcess("next-server (v16) \(daily)", repoPath: dev))
        #expect(!nodeOK.isOwnNodeProcess("next-server (v16) \(dev)", repoPath: daily))
    }

    @Test func theRuntimeInstallRootsDiffer() {
        let support = URL(fileURLWithPath: "/Users/test/Library/Application Support", isDirectory: true)
        #expect(RuntimeInstall.installRoot(support: support, variant: .daily).path == "/Users/test/Library/Application Support/Useful Bot/app")
        #expect(RuntimeInstall.installRoot(support: support, variant: .dev).path == "/Users/test/Library/Application Support/Useful Bot Dev/app")
    }
}
#endif

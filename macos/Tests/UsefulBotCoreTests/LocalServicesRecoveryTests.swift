#if os(macOS)
import Foundation
import Testing
@testable import UsefulBotCore

private final class ReadyProbe: HealthProbe, @unchecked Sendable {
    var healthy: Set<String>
    init(healthy: Set<String> = []) { self.healthy = healthy }
    func probe(_ url: URL) async -> Bool { healthy.contains(url.absoluteString) }
}

/// A runner that can hang, hold strays and report a foreign listener.
private final class RecoveryRunner: ProcessRunner, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var spawned: [ServiceCommand] = []
    private var live: [String: Date] = [:]
    var listening: [Int: [pid_t]] = [:]
    var foreignPorts: Set<Int> = []
    /// A hung spawn that ignores SIGTERM and only dies on SIGKILL.
    var spawnIgnoresTerm = false
    /// Processes running `service.mjs`, with no relation to this runner's spawns.
    var processes: [(pid: pid_t, line: String)] = []
    var strayIgnoresTerm: Set<pid_t> = []
    private(set) var spawnSignals: [String] = []
    private(set) var terminated: [pid_t] = []
    private(set) var killed: [pid_t] = []
    private(set) var strayQueries = 0

    func count(_ mode: ServiceMode) -> Int { spawned.filter { $0.arguments.last == mode.rawValue }.count }

    func start(_ command: ServiceCommand) {
        lock.lock(); defer { lock.unlock() }
        spawned.append(command)
        live[command.arguments.last ?? ""] = Date()
    }
    func hasLiveSpawn(of mode: ServiceMode) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live[mode.rawValue] != nil
    }
    func liveSpawnAge(of mode: ServiceMode) -> TimeInterval? {
        lock.lock(); defer { lock.unlock() }
        return live[mode.rawValue].map { Date().timeIntervalSince($0) }
    }
    func terminateSpawn(of mode: ServiceMode, force: Bool) {
        lock.lock(); defer { lock.unlock() }
        spawnSignals.append("\(force ? "kill" : "term") \(mode.rawValue)")
        if force || !spawnIgnoresTerm { live[mode.rawValue] = nil }
    }
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { listening[port] ?? [] }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool {
        foreignPorts.contains(port) && !(listening[port] ?? []).isEmpty
    }
    func strayServicePids(matching: @escaping @Sendable (String) -> Bool) -> [pid_t] {
        lock.lock(); defer { lock.unlock() }
        strayQueries += 1
        let held = Set(listening.values.flatMap { $0 })
        return processes.filter { matching($0.line) && !held.contains($0.pid) }.map(\.pid)
    }
    func terminate(pids: [pid_t], force: Bool) {
        lock.lock(); defer { lock.unlock() }
        if force { killed += pids } else { terminated += pids }
        processes.removeAll { process in
            pids.contains(process.pid) && (force || !strayIgnoresTerm.contains(process.pid))
        }
    }
}

@Suite struct LocalServicesRecoveryTests {
    private let repo = "/Users/x/Library/Application Support/Useful Bot Dev/app"

    private func services(_ runner: RecoveryRunner, probe: ReadyProbe = ReadyProbe()) -> LocalServices {
        LocalServices(
            runner: runner,
            probe: probe,
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0,
            restartIntervalSeconds: 0.05,
            terminateGraceSeconds: 0.2
        )
    }

    private var dev: ServerConfig { ServerConfig(repoPath: repo, port: 4420, variant: .dev) }

    // MARK: - A hung spawn is replaced, never abandoned

    @Test func anOwnerRetryReplacesAHungSpawnOfEveryMode() async {
        let runner = RecoveryRunner()
        let services = services(runner)
        let first = await services.ensure(config: dev, timeoutSeconds: 1)
        #expect(first == .neverBound([.router, .eve, .web]))
        #expect(runner.spawned.count == 3)
        let second = await services.ensure(config: dev, timeoutSeconds: 1, replaceHung: true)
        #expect(second == .neverBound([.router, .eve, .web]))
        #expect(runner.spawnSignals.sorted() == ["term eve", "term router", "term web"])
        #expect(runner.count(.router) == 2 && runner.count(.eve) == 2 && runner.count(.web) == 2)
    }

    @Test func aSigtermThatIsIgnoredEndsInSigkill() async {
        let runner = RecoveryRunner()
        runner.spawnIgnoresTerm = true
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 1)
        _ = await services.ensure(config: dev, timeoutSeconds: 1, replaceHung: true)
        #expect(runner.spawnSignals.filter { $0.hasPrefix("kill") }.sorted() == ["kill eve", "kill router", "kill web"])
        // Each one was asked politely first.
        #expect(runner.spawnSignals.filter { $0.hasPrefix("term") }.count == 3)
        #expect(runner.count(.web) == 2)
    }

    @Test func aSecondFullBudgetReplacesAHungSpawnWithoutAnyRetry() async {
        let runner = RecoveryRunner()
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 1)
        try? await Task.sleep(nanoseconds: 300_000_000)
        // No owner Retry here (a relaunch of the window, say): the spawn has now
        // outlived a whole budget, so it is replaced.
        let again = await services.ensure(config: dev, timeoutSeconds: 1)
        #expect(again == .neverBound([.router, .eve, .web]))
        #expect(runner.spawnSignals.filter { $0.hasPrefix("term") }.count == 3)
        #expect(runner.count(.router) == 2)
    }

    @Test func aSpawnYoungerThanTheBudgetIsLeftAlone() async {
        let runner = RecoveryRunner()
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 1)
        // About a second old against a two second budget: still just slow.
        _ = await services.ensure(config: dev, timeoutSeconds: 2)
        #expect(runner.spawnSignals.isEmpty)
        #expect(runner.spawned.count == 3)
    }

    @Test func aRetryNeverTouchesAServiceWhosePortIsOpen() async {
        let runner = RecoveryRunner()
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 1)
        runner.listening[dev.variant.routerPort] = [4001]
        _ = await services.ensure(config: dev, timeoutSeconds: 1, replaceHung: true)
        #expect(!runner.spawnSignals.contains("term router"))
        #expect(runner.count(.router) == 1)
    }

    // MARK: - Strays from an earlier launch

    @Test func strayServicesWithNoPortAreStoppedBeforeStarting() async {
        let runner = RecoveryRunner()
        let script = "\(repo)/scripts/service.mjs"
        runner.processes = [
            (901, "/usr/local/bin/node \(script) router"),
            (902, "/usr/local/bin/node /Users/x/Library/Application Support/Useful Bot/app/scripts/service.mjs eve"),
            (903, "/usr/local/bin/node \(script) web"),
            (904, "/usr/local/bin/node \(script) router --extra"),
        ]
        runner.listening[dev.variant.webPort] = [903]
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 0)
        // 901 only: 902 is the daily install's, 903 holds the web port (so the
        // web is not queried at all), 904 is not exactly `service.mjs router`.
        #expect(runner.terminated == [901])
        #expect(runner.killed.isEmpty)
        #expect(runner.processes.map(\.pid).sorted() == [902, 903, 904])
    }

    @Test func aStrayThatIgnoresSigtermIsKilled() async {
        let runner = RecoveryRunner()
        runner.processes = [(910, "/usr/local/bin/node \(repo)/scripts/service.mjs eve")]
        runner.strayIgnoresTerm = [910]
        let services = services(runner)
        _ = await services.ensure(config: dev, timeoutSeconds: 0)
        #expect(runner.terminated == [910])
        #expect(runner.killed == [910])
    }

    @Test func nothingIsScannedWhenTheStackIsAlreadyUp() async {
        let runner = RecoveryRunner()
        // Dev needs a stack name to count as ready, so use the daily stack here.
        let daily = ServerConfig(repoPath: "/repo", port: 4320)
        let probe = ReadyProbe(healthy: [daily.healthURL.absoluteString, AppVariant.daily.routerHealthURL.absoluteString, AppVariant.daily.eveHealthURL.absoluteString])
        let outcome = await services(runner, probe: probe).ensure(config: daily)
        #expect(outcome == .ready)
        #expect(runner.strayQueries == 0)
    }

    // MARK: - eve must be ours

    @Test func aForeignEveOnOurPortIsNeverAdopted() async {
        let runner = RecoveryRunner()
        let daily = ServerConfig(repoPath: "/repo", port: 4320)
        runner.listening[AppVariant.daily.evePort] = [777]
        runner.foreignPorts = [AppVariant.daily.evePort]
        let probe = ReadyProbe(healthy: [daily.healthURL.absoluteString, AppVariant.daily.routerHealthURL.absoluteString, AppVariant.daily.eveHealthURL.absoluteString])
        let outcome = await services(runner, probe: probe).ensure(config: daily)
        #expect(outcome == .foreignStack)
        #expect(runner.spawned.isEmpty)
        #expect(runner.terminated.isEmpty && runner.killed.isEmpty)
    }

    @Test func anEveThisInstallOwnsIsStillAdopted() async {
        let runner = RecoveryRunner()
        let daily = ServerConfig(repoPath: "/repo", port: 4320)
        runner.listening[AppVariant.daily.evePort] = [778]
        let probe = ReadyProbe(healthy: [daily.healthURL.absoluteString, AppVariant.daily.routerHealthURL.absoluteString, AppVariant.daily.eveHealthURL.absoluteString])
        let outcome = await services(runner, probe: probe).ensure(config: daily)
        #expect(outcome == .ready)
        #expect(runner.spawned.isEmpty)
    }

    // MARK: - The match rule

    @Test func theStrayRuleIsExactAndKeepsTheTwoInstallsApart() {
        let supervisor = ServiceSupervisor(nodeExists: { _ in true })
        let daily = "/Users/x/Library/Application Support/Useful Bot/app"
        let devRoot = "/Users/x/Library/Application Support/Useful Bot Dev/app"
        let dailyLine = "/usr/local/bin/node \(daily)/scripts/service.mjs router"
        let devLine = "/usr/local/bin/node \(devRoot)/scripts/service.mjs router"
        #expect(supervisor.isStrayServiceLine(dailyLine, mode: .router, repoPath: daily))
        #expect(supervisor.isStrayServiceLine(devLine, mode: .router, repoPath: devRoot))
        #expect(!supervisor.isStrayServiceLine(devLine, mode: .router, repoPath: daily))
        #expect(!supervisor.isStrayServiceLine(dailyLine, mode: .router, repoPath: devRoot))
        #expect(!supervisor.isStrayServiceLine(dailyLine, mode: .eve, repoPath: daily))
        #expect(!supervisor.isStrayServiceLine(dailyLine + " --x", mode: .router, repoPath: daily))
        // A longer path that merely ends in this one is a different install.
        #expect(!supervisor.isStrayServiceLine("/usr/local/bin/node /old\(daily)/scripts/service.mjs router", mode: .router, repoPath: daily))
        #expect(!supervisor.isStrayServiceLine("/usr/local/bin/node \(daily)2/scripts/service.mjs router", mode: .router, repoPath: daily))
        // Next's renamed child is not a launcher and is never matched here.
        #expect(!supervisor.isStrayServiceLine("next-server (v15) \(daily)", mode: .web, repoPath: daily))
    }
}
#endif

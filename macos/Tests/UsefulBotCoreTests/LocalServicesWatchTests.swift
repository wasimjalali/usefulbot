#if os(macOS)
import Foundation
import Testing
@testable import UsefulBotCore

private final class WatchProbe: HealthProbe, @unchecked Sendable {
    func probe(_ url: URL) async -> Bool { false }
    func read(_ url: URL) async -> HealthReading? { nil }
}

/// Counts the starts it is asked for. A service is "up" while it has a live
/// spawn and a listener, and `die` takes both away, as a crash does.
private final class WatchRunner: ProcessRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var spawned: [ServiceMode] = []
    private var live: Set<String> = []
    private var ports: [Int: [pid_t]] = [:]
    private var lines: [String] = []

    func count(_ mode: ServiceMode) -> Int { lock.withLock { spawned.filter { $0 == mode }.count } }
    var logged: [String] { lock.withLock { lines } }
    func bind(_ mode: ServiceMode, port: Int) { lock.withLock { live.insert(mode.rawValue); ports[port] = [100] } }
    func die(_ mode: ServiceMode, port: Int) { lock.withLock { live.remove(mode.rawValue); ports[port] = nil } }
    /// A process of ours that is running but has not opened its port.
    func spawnUnbound(_ mode: ServiceMode) { lock.withLock { _ = live.insert(mode.rawValue) } }
    /// Someone else's process on the port.
    func hold(port: Int) { lock.withLock { ports[port] = [999] } }

    func start(_ command: ServiceCommand) {
        lock.withLock {
            spawned.append(ServiceMode(rawValue: command.arguments.last ?? "") ?? .web)
            live.insert(command.arguments.last ?? "")
        }
    }
    func hasLiveSpawn(of mode: ServiceMode) -> Bool { lock.withLock { live.contains(mode.rawValue) } }
    func liveSpawnAge(of mode: ServiceMode) -> TimeInterval? { nil }
    func terminateSpawn(of mode: ServiceMode, force: Bool) {}
    func portAccepting(_ port: Int) -> Bool { !listeners(port: port).isEmpty }
    func listeners(port: Int) -> [pid_t] { lock.withLock { ports[port] ?? [] } }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func hasForeignListener(port: Int, owns: @escaping @Sendable (String) -> Bool) -> Bool { false }
    func strayServicePids(matching: @escaping @Sendable (String) -> Bool) -> [pid_t] { [] }
    func terminate(pids: [pid_t], force: Bool) {}
    func logServiceEvent(_ mode: ServiceMode, _ line: String) { lock.withLock { lines.append("\(mode.rawValue): \(line)") } }
}

@Suite struct LocalServicesWatchTests {
    private let dev = ServerConfig(repoPath: "/Users/x/app", port: 4420, variant: .dev)
    private var enginePort: Int { AppVariant.dev.enginePort }

    private func services(_ runner: WatchRunner) -> LocalServices {
        LocalServices(
            runner: runner,
            probe: WatchProbe(),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0,
            restartIntervalSeconds: 0.05,
            terminateGraceSeconds: 0.2
        )
    }

    private func allUp(_ runner: WatchRunner) {
        runner.bind(.router, port: AppVariant.dev.routerPort)
        runner.bind(.engine, port: AppVariant.dev.enginePort)
        runner.bind(.web, port: AppVariant.dev.webPort)
    }

    @Test func aDeadEngineIsRestartedOnTheNextTick() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        runner.die(.engine, port: enginePort)
        await services.watchTick(config: dev, ledger: RestartLedger(), now: Date())
        #expect(runner.count(.engine) == 1)
        #expect(runner.count(.router) == 0 && runner.count(.web) == 0)
        #expect(runner.logged.contains { $0.hasPrefix("engine:") && $0.contains("restart") })
    }

    @Test func aListeningServiceIsNeverTouched() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        let ledger = RestartLedger()
        for _ in 0..<5 { await services.watchTick(config: dev, ledger: ledger, now: Date()) }
        #expect(runner.count(.router) + runner.count(.engine) + runner.count(.web) == 0)
    }

    @Test func aServiceThatKeepsDyingIsRestartedThreeTimesThenLeft() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        let ledger = RestartLedger()
        let start = Date()
        for minute in 0..<4 {
            runner.die(.engine, port: enginePort)
            await services.watchTick(config: dev, ledger: ledger, now: start.addingTimeInterval(Double(minute) * 60))
        }
        #expect(runner.count(.engine) == 3)
        #expect(runner.logged.filter { $0.contains("giving up") }.count == 1)
        // Still dead on a later tick inside the window: no start, no log spam.
        runner.die(.engine, port: enginePort)
        await services.watchTick(config: dev, ledger: ledger, now: start.addingTimeInterval(250))
        #expect(runner.count(.engine) == 3)
        #expect(runner.logged.filter { $0.contains("giving up") }.count == 1)
        // The old restarts age out of the five minutes and it is tried again.
        runner.die(.engine, port: enginePort)
        await services.watchTick(config: dev, ledger: ledger, now: start.addingTimeInterval(400))
        #expect(runner.count(.engine) == 4)
    }

    @Test func aForeignListenerIsLeftAlone() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        // The engine died, then something else took its port.
        runner.die(.engine, port: enginePort)
        runner.hold(port: enginePort)
        await services.watchTick(config: dev, ledger: RestartLedger(), now: Date())
        #expect(runner.count(.engine) == 0)
    }

    @Test func aLiveProcessThatHasNotBoundYetIsLeftAlone() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        runner.die(.engine, port: enginePort)
        runner.spawnUnbound(.engine)
        await services.watchTick(config: dev, ledger: RestartLedger(), now: Date())
        #expect(runner.count(.engine) == 0)
    }

    @Test func stoppingTheServicesStopsTheWatch() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        services.startWatching(config: dev, intervalSeconds: 0.05)
        runner.die(.engine, port: enginePort)
        try? await Task.sleep(nanoseconds: 400_000_000)
        #expect(runner.count(.engine) == 1)
        // The services go down with the stop, so it need not wait out held ports.
        runner.die(.router, port: AppVariant.dev.routerPort)
        runner.die(.web, port: AppVariant.dev.webPort)
        _ = await services.stopOwnServices(config: dev)
        runner.die(.engine, port: enginePort)
        try? await Task.sleep(nanoseconds: 400_000_000)
        #expect(runner.count(.engine) == 1)
    }

    @Test func startingTheWatchTwiceRunsOnlyOne() async {
        let runner = WatchRunner()
        allUp(runner)
        let services = services(runner)
        services.startWatching(config: dev, intervalSeconds: 0.05)
        services.startWatching(config: dev, intervalSeconds: 0.05)
        runner.die(.engine, port: enginePort)
        try? await Task.sleep(nanoseconds: 400_000_000)
        services.stopWatching()
        #expect(runner.count(.engine) == 1)
    }
}
#endif

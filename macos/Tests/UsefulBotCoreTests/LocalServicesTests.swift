#if os(macOS)
import Foundation
import Testing
@testable import UsefulBotCore

private final class FakeProbe: HealthProbe, @unchecked Sendable {
    var healthy: Set<String>
    init(healthy: Set<String> = []) { self.healthy = healthy }
    func probe(_ url: URL) async -> Bool { healthy.contains(url.absoluteString) }
}

private final class FakeRunner: ProcessRunner, @unchecked Sendable {
    var started: [ServiceCommand] = []
    var listening: [Int: [pid_t]] = [:]
    /// Ports whose listener ignores SIGTERM but still dies on SIGKILL.
    var stubborn: Set<Int> = []
    /// Ports held by a foreign process: never signalled by either stop.
    var foreign: Set<Int> = []
    var stopped: [Int] = []
    var forceStopped: [Int] = []

    func start(_ command: ServiceCommand) { started.append(command) }
    func portAccepting(_ port: Int) -> Bool { !(listening[port] ?? []).isEmpty }
    func listeners(port: Int) -> [pid_t] { listening[port] ?? [] }

    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        stopped.append(port)
        if !foreign.contains(port), !stubborn.contains(port) { listening[port] = [] }
    }

    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {
        forceStopped.append(port)
        if !foreign.contains(port) { listening[port] = [] }
    }
}

/// Every process it starts stays alive and never opens its port: the shape of a
/// service blocked on a macOS permission prompt.
private final class HungRunner: ProcessRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var spawned: [ServiceCommand] = []
    private var live: Set<String> = []
    /// A runner whose processes die on their own (a crash) instead of hanging.
    var diesAtOnce = false

    var started: [ServiceCommand] { lock.lock(); defer { lock.unlock() }; return spawned }
    func count(_ mode: ServiceMode) -> Int { started.filter { $0.arguments.last == mode.rawValue }.count }

    func start(_ command: ServiceCommand) {
        lock.lock(); defer { lock.unlock() }
        spawned.append(command)
        if !diesAtOnce { live.insert(command.arguments.last ?? "") }
    }
    func hasLiveSpawn(of mode: ServiceMode) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live.contains(mode.rawValue)
    }
    func portAccepting(_ port: Int) -> Bool { false }
    func listeners(port: Int) -> [pid_t] { [] }
    func stopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
    func forceStopOwnListeners(port: Int, owns: @escaping @Sendable (String) -> Bool) {}
}

@Suite struct LocalServicesTests {
    private var routerHealth: String { AppVariant.daily.routerHealthURL.absoluteString }
    private var eveHealth: String { AppVariant.daily.eveHealthURL.absoluteString }
    private var webHealth: String { ServerConfig(repoPath: "/repo", port: 4320).healthURL.absoluteString }

    private func modes(_ runner: FakeRunner) -> [String] { runner.started.map { $0.arguments.last ?? "" } }

    @Test func startsAllServicesWhenNothingIsRunning() async {
        let runner = FakeRunner()
        let services = LocalServices(runner: runner, probe: FakeProbe(), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(modes(runner) == ["router", "eve", "web"])
        #expect(runner.stopped.isEmpty)
        #expect(runner.forceStopped.isEmpty)
    }

    @Test func startsOnlyWebWhenRouterAndEveAreHealthy() async {
        let runner = FakeRunner()
        let services = LocalServices(runner: runner, probe: FakeProbe(healthy: [routerHealth, eveHealth]), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(modes(runner) == ["web"])
        #expect(runner.stopped.isEmpty)
    }

    @Test func restartsWedgedWebListenerThenStarts() async {
        let runner = FakeRunner()
        runner.listening = [4320: [14301]]
        let services = LocalServices(runner: runner, probe: FakeProbe(healthy: [routerHealth, eveHealth]), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(runner.stopped == [4320])
        #expect(modes(runner) == ["web"])
    }

    @Test func restartsWedgedRouterListenerThenStarts() async {
        let runner = FakeRunner()
        runner.listening = [4319: [14302]]
        let services = LocalServices(runner: runner, probe: FakeProbe(healthy: [eveHealth]), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(runner.stopped == [4319])
        #expect(modes(runner) == ["router", "web"])
    }

    @Test func forceStopsWhenTheListenerIgnoresSigterm() async {
        let runner = FakeRunner()
        runner.listening = [4319: [14303]]
        runner.stubborn = [4319]
        let services = LocalServices(runner: runner, probe: FakeProbe(healthy: [eveHealth]), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(runner.stopped == [4319])
        #expect(runner.forceStopped == [4319])
        #expect(modes(runner) == ["router", "web"])
    }

    @Test func leavesAForeignListenerAlone() async {
        let runner = FakeRunner()
        runner.listening = [4319: [14304]]
        runner.foreign = [4319]
        let services = LocalServices(runner: runner, probe: FakeProbe(healthy: [eveHealth]), startGraceSeconds: 0)
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(!modes(runner).contains("router"))
        #expect(modes(runner) == ["web"])
    }

    @Test func ensureReportsNodeMissingWithoutSpawning() async {
        let runner = FakeRunner()
        let supervisor = ServiceSupervisor(nodeExists: { _ in false })
        let services = LocalServices(runner: runner, probe: FakeProbe(), supervisor: supervisor, startGraceSeconds: 0)
        let outcome = await services.ensure(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(outcome == .nodeMissing)
        #expect(runner.started.isEmpty)
    }

    @Test func ensureIsReadyWhenEveryServiceAnswers() async {
        let runner = FakeRunner()
        let config = ServerConfig(repoPath: "/repo", port: 4320)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(healthy: [config.healthURL.absoluteString, routerHealth, eveHealth]),
            supervisor: ServiceSupervisor(nodeExists: { _ in true })
        )
        let outcome = await services.ensure(config: config)
        #expect(outcome == .ready)
        #expect(runner.started.isEmpty)
    }

    @Test func aDeadRouterIsRestartedEvenWhileTheWebAnswers() async {
        // The web answering used to end the check, so a dead router was never
        // restarted: the app opened healthy and every turn failed at the model
        // call instead.
        let runner = FakeRunner()
        let config = ServerConfig(repoPath: "/repo", port: 4320)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(healthy: [config.healthURL.absoluteString, eveHealth]),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0
        )
        let outcome = await services.ensure(config: config, timeoutSeconds: 0)
        #expect(modes(runner) == ["router"])
        #expect(outcome == .unavailable)
    }

    @Test func aPortThatIsStillComingUpIsNotKilledAsWedged() async {
        // The port is held but not yet serving, which is what a service looks
        // like while it starts. Killing it there restarts it into the same
        // race on every attempt.
        let runner = FakeRunner()
        runner.listening = [4319: [14305]]
        let probe = FakeProbe(healthy: [eveHealth])
        let services = LocalServices(runner: runner, probe: probe, startGraceSeconds: 1)
        // It answers a moment later, as a slow starter does.
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            probe.healthy.insert(AppVariant.daily.routerHealthURL.absoluteString)
        }
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320))
        #expect(runner.stopped.isEmpty)
        #expect(!modes(runner).contains("router"))
    }

    @Test func aRetryPassNeverKillsWhatTheFirstPassStarted() async {
        // The retry exists to fill a port nobody opened. A service that is
        // merely slow holds its port for tens of seconds before it serves, and
        // killing it there restarts it into the same wait, forever.
        let runner = FakeRunner()
        runner.listening = [4319: [14306]]
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(healthy: [eveHealth]),
            startGraceSeconds: 0
        )
        await services.startMissing(config: ServerConfig(repoPath: "/repo", port: 4320), allowRestart: false)
        #expect(runner.stopped.isEmpty)
        #expect(runner.forceStopped.isEmpty)
        // The router's port is held, so only the empty one is filled.
        #expect(modes(runner) == ["web"])
    }

    @Test func theWaitIsWallClockAndNotAnAttemptCount() async {
        let runner = FakeRunner()
        let config = ServerConfig(repoPath: "/repo", port: 4320)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0
        )
        let started = Date()
        let outcome = await services.ensure(config: config, timeoutSeconds: 2)
        let elapsed = Date().timeIntervalSince(started)
        #expect(outcome == .unavailable)
        // Three probes per attempt used to make each "second" cost several.
        #expect(elapsed < 5)
    }

    // MARK: - A hung service is never stacked

    @Test func aServiceThatNeverBindsIsSpawnedOncePerModeAcrossTheWholeBudget() async {
        // The 2026-10-01 leak: every service blocked on a permission prompt, the ports
        // stayed empty, and each retry round spawned a fresh router, eve and web.
        let runner = HungRunner()
        let config = ServerConfig(repoPath: "/repo", port: 4420, variant: .dev)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0,
            restartIntervalSeconds: 0.05
        )
        let outcome = await services.ensure(config: config, timeoutSeconds: 3)
        #expect(runner.count(.router) == 1)
        #expect(runner.count(.eve) == 1)
        #expect(runner.count(.web) == 1)
        // Said out loud, naming each service that never opened its port.
        #expect(outcome == .neverBound([.router, .eve, .web]))
    }

    @Test func aRetryAfterTheBudgetStillDoesNotStackAHungService() async {
        let runner = HungRunner()
        let config = ServerConfig(repoPath: "/repo", port: 4420, variant: .dev)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0,
            restartIntervalSeconds: 0.05
        )
        _ = await services.ensure(config: config, timeoutSeconds: 1)
        let outcome = await services.ensure(config: config, timeoutSeconds: 1)
        #expect(runner.started.count == 3)
        #expect(outcome == .neverBound([.router, .eve, .web]))
    }

    @Test func aServiceThatExitsIsStartedAgainAndIsNotReportedAsHung() async {
        // The retry exists for a start that fails or a service that dies a second
        // later: nothing alive, so a new one is started and the outcome is plain.
        let runner = HungRunner()
        runner.diesAtOnce = true
        let config = ServerConfig(repoPath: "/repo", port: 4420, variant: .dev)
        let services = LocalServices(
            runner: runner,
            probe: FakeProbe(),
            supervisor: ServiceSupervisor(nodeExists: { _ in true }),
            startGraceSeconds: 0,
            restartIntervalSeconds: 0.05
        )
        let outcome = await services.ensure(config: config, timeoutSeconds: 3)
        #expect(runner.count(.router) > 1)
        #expect(outcome == .unavailable)
    }

    @Test func theNeverBoundMessageNamesTheServiceItsPortAndWhereToLook() {
        let message = LocalServices.neverBoundMessage([.router, .web], variant: .dev)
        #expect(message.contains("router"))
        #expect(message.contains("4419"))
        #expect(message.contains("web"))
        #expect(message.contains("4420"))
        #expect(!message.contains("4421"))
        #expect(message.contains("UsefulBotDev"))
        #expect(LocalServices.neverBoundMessage([.eve], variant: .daily).contains("4321"))
    }
}
#endif

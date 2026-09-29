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

@Suite struct LocalServicesTests {
    private var routerHealth: String { ServiceSupervisor.routerHealthURL.absoluteString }
    private var eveHealth: String { ServiceSupervisor.eveHealthURL.absoluteString }
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
            probe.healthy.insert(ServiceSupervisor.routerHealthURL.absoluteString)
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
}
#endif

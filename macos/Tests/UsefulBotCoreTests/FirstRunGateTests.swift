import Testing
@testable import UsefulBotCore

/// How the first-run gate can go wrong, written before the gate:
/// - an owner who already has a provider sees Welcome, even for a frame,
///   because the answer was guessed before the providers loaded;
/// - that owner is never marked done, so every launch waits on the check;
/// - a forced run writes completion on the owner's real defaults;
/// - a forced run is ignored because the owner finished before;
/// - a brand new Mac waits on services before showing Welcome, so the
///   "Getting ready" state never appears;
/// - a failed providers read strands the app on the launch cover;
/// - an owner who skipped setup (no provider, marked done) is sent through
///   again on every launch;
/// - the performance guard's scripted launches land on Welcome.
@Suite struct FirstRunGateTests {
    private func decide(
        forced: Bool = false,
        completed: Bool = false,
        freshMac: Bool = false,
        harnessRun: Bool = false,
        connections: Int? = nil,
        providersFailed: Bool = false
    ) -> FirstRunGate.Decision {
        FirstRunGate.decide(
            forced: forced,
            completed: completed,
            freshMac: freshMac,
            harnessRun: harnessRun,
            connections: connections,
            providersFailed: providersFailed
        )
    }

    @Test func anOwnerWithAProviderNeverSeesItAndIsMarkedDone() {
        #expect(decide(connections: nil) == .wait)
        #expect(decide(connections: 2) == .skip)
        #expect(FirstRunGate.marksDone(forced: false, completed: false, connections: 2))
    }

    @Test func aForcedRunShowsAndNeverWritesCompletion() {
        #expect(decide(forced: true, completed: true, connections: 3) == .show)
        #expect(!FirstRunGate.marksDone(forced: true, completed: false, connections: 3))
        #expect(!FirstRunGate.persistsFinish(forced: true))
        #expect(FirstRunGate.persistsFinish(forced: false))
    }

    @Test func aBrandNewMacShowsWelcomeBeforeServicesAnswer() {
        #expect(decide(freshMac: true, connections: nil) == .show)
        #expect(decide(freshMac: true, connections: nil, providersFailed: true) == .show)
    }

    @Test func aFailedProvidersReadOpensTheAppRatherThanWaiting() {
        #expect(decide(connections: nil, providersFailed: true) == .skip)
        #expect(!FirstRunGate.marksDone(forced: false, completed: false, connections: nil))
    }

    @Test func finishingOnceIsFinal() {
        #expect(decide(completed: true, connections: 0) == .skip)
        #expect(decide(completed: true, connections: nil) == .skip)
        #expect(!FirstRunGate.marksDone(forced: false, completed: true, connections: 4))
    }

    @Test func noProviderAndNotDoneShows() {
        #expect(decide(connections: 0) == .show)
        #expect(!FirstRunGate.marksDone(forced: false, completed: false, connections: 0))
    }

    @Test func harnessLaunchesSkipUnlessForced() {
        #expect(decide(harnessRun: true, connections: 0) == .skip)
        #expect(decide(freshMac: true, harnessRun: true) == .skip)
        #expect(decide(forced: true, harnessRun: true) == .show)
    }
}

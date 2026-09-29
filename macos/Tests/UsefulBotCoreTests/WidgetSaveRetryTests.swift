import Foundation
import Testing
@testable import UsefulBotCore

/// A drawing's save owns its retries. It must not wait for some later publish
/// to try again, and it must always end in an outcome the owner can be told.
@Suite struct WidgetSaveRetryTests {
    private actor Counter {
        var calls = 0
        func next() -> Int {
            calls += 1
            return calls
        }
    }

    @Test func aTransientFailureIsRetriedUntilItSaves() async {
        let counter = Counter()
        let outcome = await WidgetSaveRetry.run(delays: [0, 0]) {
            if await counter.next() < 3 { throw BackendError.http(503) }
        }
        #expect(outcome == .saved)
        #expect(await counter.calls == 3)
    }

    @Test func aSaveThatKeepsFailingGivesUpWithoutAnyoneElseAsking() async {
        let counter = Counter()
        let outcome = await WidgetSaveRetry.run(delays: [0, 0]) {
            _ = await counter.next()
            throw URLError(.cannotConnectToHost)
        }
        #expect(outcome == .gaveUp)
        #expect(await counter.calls == 3)
    }

    @Test func aRefusalIsNotAskedAgain() async {
        let counter = Counter()
        let outcome = await WidgetSaveRetry.run(delays: [0, 0]) {
            _ = await counter.next()
            throw BackendError.http(413)
        }
        #expect(outcome == .refused)
        #expect(await counter.calls == 1)
    }

    @Test func rateLimitingIsTransientNotARefusal() {
        #expect(!WidgetSaveRetry.isRefusal(BackendError.http(429)))
        #expect(WidgetSaveRetry.isRefusal(BackendError.http(400)))
        #expect(!WidgetSaveRetry.isRefusal(BackendError.http(500)))
    }
}

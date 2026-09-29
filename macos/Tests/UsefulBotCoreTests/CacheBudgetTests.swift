import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct CacheBudgetTests {
    private func entry(_ id: String, _ bytes: Int, age: TimeInterval, pinned: Bool = false) -> CacheBudget.Entry {
        CacheBudget.Entry(id: id, bytes: bytes, lastUsed: Date(timeIntervalSince1970: 1_000_000 - age), pinned: pinned)
    }

    @Test func nothingLeavesWhileTheCachesFit() {
        let entries = [entry("a", 100, age: 10), entry("b", 200, age: 5)]
        #expect(CacheBudget.evictions(entries, budget: 300) == [])
    }

    @Test func theLeastRecentlyUsedLeaveFirstAndOnlyAsManyAsNeeded() {
        let entries = [entry("new", 100, age: 1), entry("old", 100, age: 30), entry("older", 100, age: 60)]
        #expect(CacheBudget.evictions(entries, budget: 250) == ["older"])
        #expect(CacheBudget.evictions(entries, budget: 150) == ["older", "old"])
    }

    @Test func aBotWithASendInFlightIsNeverEvicted() {
        let entries = [entry("sending", 500, age: 90, pinned: true), entry("idle", 100, age: 10)]
        // Over budget even after the idle one goes; the sending one still stays.
        #expect(CacheBudget.evictions(entries, budget: 200) == ["idle"])
        #expect(CacheBudget.evictions([entry("sending", 500, age: 90, pinned: true)], budget: 200) == [])
    }
}

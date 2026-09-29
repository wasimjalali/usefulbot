import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct RailCopyTests {
    @Test func pinnedAndHiddenReasonsAccumulate() {
        #expect(RailCopy.emptySectionHint(pinned: 1, hidden: 0)
            == "1 pinned bot shows at the top.")
        #expect(RailCopy.emptySectionHint(pinned: 2, hidden: 0)
            == "2 pinned bots show at the top.")
        #expect(RailCopy.emptySectionHint(pinned: 0, hidden: 1)
            == "1 bot here is hidden.")
        #expect(RailCopy.emptySectionHint(pinned: 1, hidden: 3)
            == "1 pinned bot shows at the top. 3 bots here are hidden.")
    }

    @Test func aGenuinelyEmptySectionStillGetsALine() {
        #expect(RailCopy.emptySectionHint(pinned: 0, hidden: 0)
            == "No bots here yet.")
    }
}

import Foundation
import Testing
@testable import UsefulBotCore

/// Commas are thousands groups and nothing else: "3,5" is a typo, never 35M.
@Suite struct BudgetInputStrictTests {
    private let tokenRule = "Type the limit in millions, like 500 or 3.5."
    private let requestRule = "Type the request limit as a whole number."

    @Test func tokensAcceptStrictThousandsGroups() throws {
        #expect(try BudgetInput.tokens("1,000", min: 1_000_000, max: nil).get() == 1_000_000_000)
        #expect(try BudgetInput.tokens("10,000M", min: 1_000_000, max: nil).get() == 10_000_000_000)
        #expect(try BudgetInput.tokens("1,000,000", min: 1_000_000, max: nil).get() == 1_000_000_000_000)
        #expect(try BudgetInput.tokens("1,000.5", min: 1_000_000, max: nil).get() == 1_000_500_000)
        #expect(try BudgetInput.tokens("3.5M", min: 1_000_000, max: nil).get() == 3_500_000)
        #expect(try BudgetInput.tokens("3.5m", min: 1_000_000, max: nil).get() == 3_500_000)
        #expect(try BudgetInput.tokens(" 500 ", min: 1_000_000, max: nil).get() == 500_000_000)
        #expect(try BudgetInput.tokens("500 M", min: 1_000_000, max: nil).get() == 500_000_000)
    }

    @Test func tokensRefuseLooseCommas() {
        for text in ["3,5", "1,5", "3,50", "1,00", "1,0000", ",5", "5,", "1,,000", "1,00,000", "3.5,000", "1,000,5", "3,5M"] {
            #expect(BudgetInput.tokens(text, min: 1_000_000, max: nil).errorMessage == tokenRule, "\(text)")
        }
    }

    @Test func tokensTakeMOnlyAtTheEnd() {
        for text in ["3M5", "M3", "3MM", "3M.5", "M", "1M,000", "3 M 5"] {
            #expect(BudgetInput.tokens(text, min: 1_000_000, max: nil).errorMessage == tokenRule, "\(text)")
        }
    }

    @Test func requestsAcceptStrictGroupsOnly() throws {
        #expect(try BudgetInput.requests("1,000", min: 1).get() == 1_000)
        #expect(try BudgetInput.requests("12,345", min: 1).get() == 12_345)
        #expect(try BudgetInput.requests("1,000,000", min: 1).get() == 1_000_000)
        #expect(try BudgetInput.requests("500", min: 1).get() == 500)
        for text in ["1,5", "1,00", "12,34", ",5", "5,", "1,,000", "1,000,5", "1M"] {
            #expect(BudgetInput.requests(text, min: 1).errorMessage == requestRule, "\(text)")
        }
    }
}

/// A budget write that arrives while another is in flight is held, not dropped:
/// the latest one per field goes out when the in-flight one finishes.
@Suite struct PendingBudgetWritesTests {
    @Test func theLatestWritePerFieldIsKept() {
        var pending = PendingBudgetWrites<Int>()
        pending.hold(1, for: .tokens)
        pending.hold(2, for: .tokens)
        pending.hold(9, for: .requests)
        #expect(pending.next()?.write == 2)
        #expect(pending.next()?.write == 9)
        #expect(pending.next() == nil)
    }

    @Test func aHeldWriteIsHandedOutOnce() {
        var pending = PendingBudgetWrites<String>()
        #expect(pending.next() == nil)
        pending.hold("a", for: .requests)
        let first = pending.next()
        #expect(first?.field == .requests && first?.write == "a")
        #expect(pending.next() == nil)
    }
}

@Suite struct BudgetInputLeadingZeroTests {
    @Test func aLeadingZeroInAGroupedWholePartIsRefused() {
        #expect(BudgetInput.requests("0,500", min: 1).errorMessage != nil)
        #expect(BudgetInput.requests("001,000", min: 1).errorMessage != nil)
        #expect(BudgetInput.tokens("0,500", min: 1_000_000, max: nil).errorMessage != nil)
        #expect(BudgetInput.tokens("001,000M", min: 1_000_000, max: nil).errorMessage != nil)
    }

    @Test func plainAndGroupedNumbersStillParse() {
        #expect(BudgetInput.requests("1,500", min: 1) == .success(1500))
        #expect(BudgetInput.requests("007", min: 1) == .success(7))
        #expect(BudgetInput.tokens("0.5", min: 100_000, max: nil) == .success(500_000))
        #expect(BudgetInput.tokens("1,000", min: 1_000_000, max: nil) == .success(1_000_000_000))
    }
}

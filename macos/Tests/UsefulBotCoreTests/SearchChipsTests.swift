import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct SearchChipsTests {
    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    @Test func parsesAnArrayPayload() throws {
        let chips = ChatText.parseSearchChips(try value("""
        [{"title":"Coffee prices","url":"https://example.com/coffee","snippet":"A survey"}]
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "Coffee prices")
        #expect(chips[0].url == "https://example.com/coffee")
        #expect(chips[0].snippet == "A survey")
    }

    @Test func parsesResultsObject() throws {
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[{"title":"One","url":"http://example.com/1"}]}
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "One")
    }

    @Test func parsesNestedResultAndOutputShapes() throws {
        let nested = ChatText.parseSearchChips(try value("""
        {"result":{"results":[{"url":"https://example.com/a"}]}}
        """))
        #expect(nested.first?.title == "https://example.com/a")
        let output = ChatText.parseSearchChips(try value("""
        {"output":{"results":[{"url":"https://example.com/b","description":"desc"}]}}
        """))
        #expect(output.first?.snippet == "desc")
    }

    @Test func parsesAStringPayload() throws {
        let chips = ChatText.parseSearchChips(try value("""
        "{\\"results\\":[{\\"title\\":\\"From string\\",\\"url\\":\\"https://example.com/s\\"}]}"
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "From string")
    }

    @Test func refusesNonHttpRows() throws {
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[{"title":"Local","url":"file:///etc/passwd"},{"title":"Bad","url":"javascript:alert(1)"}]}
        """))
        #expect(chips.isEmpty)
    }

    @Test func refusesLoopbackAndPrivateResults() throws {
        // These links must never be rendered as chips: opening them would
        // target the local server with the desktop session cookie.
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[
          {"title":"Local","url":"http://127.0.0.1:4320/api/shell"},
          {"title":"Short","url":"http://127.1/"},
          {"title":"Hex","url":"http://0x7f.0.0.1/"},
          {"title":"Name","url":"http://localhost:4320/"},
          {"title":"Private","url":"http://192.168.1.4/"},
          {"title":"V6","url":"http://[::1]:4320/"}
        ]}
        """))
        #expect(chips.isEmpty)
    }

    @Test func capsAtFiveRows() throws {
        let rows = (1...8).map { "{\"url\":\"https://example.com/\($0)\"}" }.joined(separator: ",")
        let chips = ChatText.parseSearchChips(try value("{\"results\":[\(rows)]}"))
        #expect(chips.count == 5)
        #expect(chips.last?.url == "https://example.com/5")
    }

    @Test func chipsComeFromAToolResultAndClearOnTheNextTurn() throws {
        let epoch = "e1"
        var projection = ChatProjection()
        projection.load(RowsPage(rows: [], tailSeq: 0, epoch: epoch))
        projection.apply(ChatEvent.parse(line: #"{"seq":1,"epoch":"e1","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner"}"#)!)
        projection.apply(ChatEvent.parse(line: #"{"seq":2,"epoch":"e1","chatId":"c","turnId":"t1","type":"tool.result","callId":"c1","name":"web_search","isError":false,"searchResults":[{"title":"Hit","url":"https://example.com/hit","snippet":"s"},{"title":"Local","url":"http://localhost:4320/x","snippet":"s"}]}"#)!)
        // The local link is never a chip.
        #expect(projection.searchHits.map(\.title) == ["Hit"])
        projection.apply(ChatEvent.parse(line: #"{"seq":3,"epoch":"e1","chatId":"c","turnId":"t1","type":"turn.completed"}"#)!)
        projection.apply(ChatEvent.parse(line: #"{"seq":4,"epoch":"e1","chatId":"c","turnId":"t2","type":"turn.started","origin":"owner"}"#)!)
        #expect(projection.searchHits.isEmpty)
    }

    @Test func aReloadedChatShowsTheNewestTurnsChips() {
        var assistant = ChatRow(rowId: "t1:a0", kind: .assistant, turnId: "t1", text: "Here you go.")
        assistant.searchResults = [SearchChip(title: "Hit", url: "https://example.com/hit", snippet: "")]
        var projection = ChatProjection()
        projection.load(RowsPage(rows: [assistant], tailSeq: 3, epoch: "e1"))
        #expect(projection.searchHits.count == 1)
        // Once the owner has said something after it, the chips belong to the past.
        var user = ChatRow(rowId: "t2:u", kind: .user, turnId: "t2", text: "Thanks")
        user.clientId = "c2"
        projection.load(RowsPage(rows: [assistant, user], tailSeq: 4, epoch: "e1"))
        #expect(projection.searchHits.isEmpty)
    }

    @Test func truncatesFieldsToTheWebLimits() throws {
        let title = String(repeating: "t", count: 260)
        let url = "https://example.com/" + String(repeating: "u", count: 2100)
        let snippet = String(repeating: "s", count: 900)
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[{"title":"\(title)","url":"\(url)","snippet":"\(snippet)"}]}
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title.count == 200)
        #expect(chips[0].url.count == 2048)
        #expect(chips[0].snippet.count == 800)
    }

    @Test func stringifiesScalarTitles() throws {
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[{"title":42,"url":"https://example.com/n"}]}
        """))
        #expect(chips.first?.title == "42")
    }

    @Test func ignoresNullAndNonArrayResults() throws {
        let nullResults = ChatText.parseSearchChips(try value(#"{"results":null}"#))
        let scalarResults = ChatText.parseSearchChips(try value(#"{"results":"nope"}"#))
        #expect(nullResults.isEmpty)
        #expect(scalarResults.isEmpty)
    }

    @Test func keepsDuplicateUrls() throws {
        let chips = ChatText.parseSearchChips(try value("""
        {"results":[
          {"title":"One","url":"https://example.com/x"},
          {"title":"Two","url":"https://example.com/x"}
        ]}
        """))
        #expect(chips.count == 2)
        #expect(chips.map(\.title) == ["One", "Two"])
    }

}

@Suite struct ApprovalAndSettingsDecodingTests {
    @Test func decodesApprovals() throws {
        let data = Data("""
        {"ok":true,"approvals":[{"id":"a1","actionSha256":"abc123","preview":"rm -rf build","tool":"bash"}]}
        """.utf8)
        struct Response: Decodable { let approvals: [ApprovalItem] }
        let rows = try JSONDecoder().decode(Response.self, from: data).approvals
        #expect(rows.count == 1)
        #expect(rows[0].id == "a1")
        #expect(rows[0].actionSha256 == "abc123")
        #expect(rows[0].preview == "rm -rf build")
        #expect(rows[0].tool == "bash")
    }

    @Test func decodesProviders() throws {
        let data = Data("""
        {"providers":[
          {"id":"openai","name":"OpenAI","kind":"api","hint":"API key","compatible":true,
           "connected":true,"last4":"1234","source":"settings","active":true,
           "models":{"workhorse":"gpt-5","reviewer":"gpt-5-mini"}}
        ]}
        """.utf8)
        struct Response: Decodable { let providers: [ProviderPublic] }
        let rows = try JSONDecoder().decode(Response.self, from: data).providers
        #expect(rows.count == 1)
        #expect(rows[0].active)
        #expect(rows[0].last4 == "1234")
        #expect(rows[0].source == "settings")
    }

    @Test func decodesUsage() throws {
        let data = Data("""
        {"observed_input_tokens":1200,"observed_output_tokens":800,"requests":7,
         "window_start":"2026-09-01T00:00:00.000Z",
         "by_model":[{"provider":"openai","model":"gpt-5","requests":7,"inputTokens":1200,"outputTokens":800}],
         "caps":{"requests24h":200,"input24h":5000,"output24h":5000}}
        """.utf8)
        let usage = try JSONDecoder().decode(UsagePayload.self, from: data)
        #expect(usage.totalTokens == 2000)
        #expect(usage.totalCap == 10000)
        #expect(usage.byModel.first?.model == "gpt-5")
        #expect(usage.byModel.first?.id == "openai-gpt-5")
    }

    @Test func decodesUsageBudgetsWithNoCeiling() throws {
        let data = Data("""
        {"observed_input_tokens":1,"observed_output_tokens":1,"requests":1,
         "by_model":[],
         "caps":{"requests24h":9007199254740991,"input24h":9007199254740991,"output24h":9007199254740991},
         "budget":{"tokens":10000000000,"isDefault":false,"default":500000000,"min":1000000,"max":null,"step":1000000},
         "requestBudget":{"requests":9007199254740991,"isDefault":false,"default":5000,"min":1,"max":null,"step":500}}
        """.utf8)
        let usage = try JSONDecoder().decode(UsagePayload.self, from: data)
        #expect(usage.budget?.tokens == 10_000_000_000)
        #expect(usage.budget?.max == nil)
        #expect(usage.requestBudget?.requests == Int(Int64(9_007_199_254_740_991)))
        #expect(usage.requestBudget?.min == 1)
        #expect(usage.requestBudget?.max == nil)
        #expect(usage.caps.input24h == 9_007_199_254_740_991)
    }

    @Test func decodesUsageFromAServerWithoutRequestBudget() throws {
        let data = Data("""
        {"observed_input_tokens":1,"observed_output_tokens":1,"requests":1,"by_model":[],
         "caps":{"requests24h":4000,"input24h":5,"output24h":5},
         "budget":{"tokens":30000000,"isDefault":true,"default":30000000,"min":1000000,"max":500000000,"step":1000000}}
        """.utf8)
        let usage = try JSONDecoder().decode(UsagePayload.self, from: data)
        #expect(usage.budget?.max == 500_000_000)
        #expect(usage.requestBudget == nil)
    }

    @Test func budgetEditParsingAcceptsLargeValuesAndNamesTheRule() throws {
        // Tokens are typed in millions: "10000" is 10B, "3.5" is 3.5M.
        #expect(try BudgetInput.tokens("10000", min: 1_000_000, max: nil).get() == 10_000_000_000)
        #expect(try BudgetInput.tokens("3.5M", min: 1_000_000, max: nil).get() == 3_500_000)
        #expect(try BudgetInput.tokens("1,000", min: 1_000_000, max: nil).get() == 1_000_000_000)
        #expect(BudgetInput.tokens("0.5", min: 1_000_000, max: nil).errorMessage == "Has to be at least 1M tokens.")
        #expect(BudgetInput.tokens("0", min: 1_000_000, max: nil).errorMessage == "Has to be at least 1M tokens.")
        #expect(BudgetInput.tokens("abc", min: 1_000_000, max: nil).errorMessage == "Type the limit in millions, like 500 or 3.5.")
        #expect(BudgetInput.tokens("-5", min: 1_000_000, max: nil).errorMessage == "Type the limit in millions, like 500 or 3.5.")
        #expect(BudgetInput.tokens("99999999999999", min: 1_000_000, max: nil).errorMessage != nil, "past the safe integer is refused, not wrapped")
        // Requests are whole numbers, grouped or plain.
        #expect(try BudgetInput.requests("5,000", min: 1).get() == 5_000)
        #expect(try BudgetInput.requests("1", min: 1).get() == 1)
        #expect(BudgetInput.requests("0", min: 1).errorMessage == "Has to be at least 1 request.")
        #expect(BudgetInput.requests("2.5", min: 1).errorMessage == "Type the request limit as a whole number.")
        #expect(BudgetInput.requests("", min: 1).errorMessage == "Type the request limit as a whole number.")
        #expect(BudgetInput.requests("99999999999999999999", min: 1).errorMessage != nil)
    }

    @Test func budgetAndMeterFormatting() {
        #expect(BudgetInput.tokenLabel(500_000_000) == "500M")
        #expect(BudgetInput.tokenLabel(1_000_000_000) == "1,000M")
        #expect(BudgetInput.tokenLabel(10_000_000_000) == "10,000M")
        #expect(BudgetInput.tokenLabel(3_500_000) == "3.5M")
        #expect(BudgetInput.requestLabel(5_000) == "5,000")
        // A budget lowered under what was used reads as full, never over or negative.
        #expect(BudgetInput.meterFraction(used: 80, cap: 50) == 1)
        #expect(BudgetInput.meterFraction(used: 0, cap: 50) == 0)
        #expect(BudgetInput.meterFraction(used: 10, cap: 0) == 0)
        #expect(BudgetInput.meterFraction(used: -5, cap: 50) == 0)
        #expect(BudgetInput.meterFraction(used: 5, cap: Int(Int64(9_007_199_254_740_991))) > 0)
        #expect(BudgetInput.tokenBudgetAboveDefault(tokens: 500_000_001, default: 500_000_000))
        #expect(!BudgetInput.tokenBudgetAboveDefault(tokens: 500_000_000, default: 500_000_000))
    }

    @Test func requestUsageIsExact() {
        #expect(BudgetInput.requestUsage(used: 0, cap: 12_345) == "0 of 12,345")
        #expect(BudgetInput.requestUsage(used: 1_234, cap: 12_345) == "1,234 of 12,345")
        #expect(BudgetInput.requestUsage(used: 7, cap: 0) == "7")
    }

    @Test func budgetMessagesStayPerFieldAndSurvivePolls() {
        var messages = BudgetMessages()
        messages.set(.requests, "Has to be at least 1 request.")
        #expect(messages.message(for: .requests) == "Has to be at least 1 request.")
        #expect(messages.message(for: .tokens) == nil)
        #expect(messages.current == "Has to be at least 1 request.")
        messages.set(.tokens, "Type the limit in millions, like 500 or 3.5.")
        messages.clear(.requests)
        #expect(messages.current == "Type the limit in millions, like 500 or 3.5.")
        messages.clear(.tokens)
        #expect(messages.current == nil)
    }

    @Test func decodesStatus() throws {
        let data = Data("""
        {"ok":true,"engine":"available","operator":{"name":"Wasim","initials":"WA"},
         "version":"0.2.0","theme":"light"}
        """.utf8)
        let status = try JSONDecoder().decode(AppStatus.self, from: data)
        #expect(status.name == "Wasim")
        #expect(status.engine == "available")
        #expect(status.initials == "WA")
        #expect(status.version == "0.2.0")
        #expect(status.theme == "light")
    }
}

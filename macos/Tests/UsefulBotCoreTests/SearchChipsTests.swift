import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct SearchChipsTests {
    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    @Test func parsesAnArrayPayload() throws {
        let chips = EveStream.parseSearchChips(try value("""
        [{"title":"Coffee prices","url":"https://example.com/coffee","snippet":"A survey"}]
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "Coffee prices")
        #expect(chips[0].url == "https://example.com/coffee")
        #expect(chips[0].snippet == "A survey")
    }

    @Test func parsesResultsObject() throws {
        let chips = EveStream.parseSearchChips(try value("""
        {"results":[{"title":"One","url":"http://example.com/1"}]}
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "One")
    }

    @Test func parsesNestedResultAndOutputShapes() throws {
        let nested = EveStream.parseSearchChips(try value("""
        {"result":{"results":[{"url":"https://example.com/a"}]}}
        """))
        #expect(nested.first?.title == "https://example.com/a")
        let output = EveStream.parseSearchChips(try value("""
        {"output":{"results":[{"url":"https://example.com/b","description":"desc"}]}}
        """))
        #expect(output.first?.snippet == "desc")
    }

    @Test func parsesAStringPayload() throws {
        let chips = EveStream.parseSearchChips(try value("""
        "{\\"results\\":[{\\"title\\":\\"From string\\",\\"url\\":\\"https://example.com/s\\"}]}"
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title == "From string")
    }

    @Test func refusesNonHttpRows() throws {
        let chips = EveStream.parseSearchChips(try value("""
        {"results":[{"title":"Local","url":"file:///etc/passwd"},{"title":"Bad","url":"javascript:alert(1)"}]}
        """))
        #expect(chips.isEmpty)
    }

    @Test func refusesLoopbackAndPrivateResults() throws {
        // These links must never be rendered as chips: opening them would
        // target the local server with the desktop session cookie.
        let chips = EveStream.parseSearchChips(try value("""
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
        let chips = EveStream.parseSearchChips(try value("{\"results\":[\(rows)]}"))
        #expect(chips.count == 5)
        #expect(chips.last?.url == "https://example.com/5")
    }

    @Test func eventDataSurvivesDecoding() throws {
        let event = try JSONDecoder().decode(EveEvent.self, from: Data("""
        {"type":"action.result","meta":{"id":"e1"},
         "data":{"results":[{"title":"Hit","url":"https://example.com/hit"}]}}
        """.utf8))
        let chips = EveStream.parseSearchChips(event.data)
        #expect(chips.count == 1)
        #expect(chips[0].title == "Hit")
    }

    @Test func projectionStoresChipsAndClearsOnNewTurn() throws {
        var projection = StreamProjection()
        projection.apply(EveEvent(
            type: "action.result",
            id: "e1",
            data: try value("""
            {"results":[{"title":"Hit","url":"https://example.com/hit"}]}
            """)
        ))
        #expect(projection.searchHits.count == 1)
        projection.apply(EveEvent(type: "turn.started", id: "e2"))
        #expect(projection.searchHits.isEmpty)
    }

    @Test func projectionIgnoresEmptyChipPayloads() throws {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "action.result", id: "e1", data: try value("""
        {"results":[{"title":"Local","url":"file:///tmp/x"}]}
        """)))
        #expect(projection.searchHits.isEmpty)
    }

    @Test func truncatesFieldsToTheWebLimits() throws {
        let title = String(repeating: "t", count: 260)
        let url = "https://example.com/" + String(repeating: "u", count: 2100)
        let snippet = String(repeating: "s", count: 900)
        let chips = EveStream.parseSearchChips(try value("""
        {"results":[{"title":"\(title)","url":"\(url)","snippet":"\(snippet)"}]}
        """))
        #expect(chips.count == 1)
        #expect(chips[0].title.count == 200)
        #expect(chips[0].url.count == 2048)
        #expect(chips[0].snippet.count == 800)
    }

    @Test func stringifiesScalarTitles() throws {
        let chips = EveStream.parseSearchChips(try value("""
        {"results":[{"title":42,"url":"https://example.com/n"}]}
        """))
        #expect(chips.first?.title == "42")
    }

    @Test func ignoresNullAndNonArrayResults() throws {
        let nullResults = EveStream.parseSearchChips(try value(#"{"results":null}"#))
        let scalarResults = EveStream.parseSearchChips(try value(#"{"results":"nope"}"#))
        #expect(nullResults.isEmpty)
        #expect(scalarResults.isEmpty)
    }

    @Test func keepsDuplicateUrls() throws {
        let chips = EveStream.parseSearchChips(try value("""
        {"results":[
          {"title":"One","url":"https://example.com/x"},
          {"title":"Two","url":"https://example.com/x"}
        ]}
        """))
        #expect(chips.count == 2)
        #expect(chips.map(\.title) == ["One", "Two"])
    }

    @Test func optimisticUserRowFoldsIntoTheEcho() {
        var projection = StreamProjection()
        projection.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)abc",
            message: "hi"
        ))
        projection.apply(EveEvent(type: "message.received", id: "evt-1", message: "hi"))
        #expect(projection.messages.count == 1)
        #expect(projection.messages.first?.id == "evt-1")
    }

    @Test func repeatedUserTextStillAppends() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "message.received", id: "u-1", message: "hi"))
        projection.apply(EveEvent(type: "message.received", id: "u-2", message: "hi"))
        #expect(projection.messages.count == 2)
    }

    @Test func completionStripsTheThreadPrefix() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "message.received", id: "u-1", message: "hi"))
        projection.apply(EveEvent(
            type: "message.completed",
            id: "a-1",
            message: "You are Echo.\nStanding instructions: be kind.\n\nhello there"
        ))
        #expect(projection.messages.last?.text == "hello there")
    }

    @Test func reusedDeltaIdsDropLikeTheWeb() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "message.appended", id: "d1", messageDelta: "he"))
        // The web dedupes every identified event, replay included.
        projection.apply(EveEvent(type: "message.appended", id: "d1", messageDelta: "llo"))
        #expect(projection.messages.last?.text == "he")
    }

    @Test func duplicateIdentifiedEventsDrop() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "message.received", id: "u1", message: "hi"))
        projection.apply(EveEvent(type: "message.received", id: "u1", message: "hi"))
        #expect(projection.messages.count == 1)
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

    @Test func decodesStatus() throws {
        let data = Data("""
        {"ok":true,"eve":"available","operator":{"name":"Wasim","initials":"WA"},
         "version":"0.2.0","theme":"light"}
        """.utf8)
        let status = try JSONDecoder().decode(AppStatus.self, from: data)
        #expect(status.name == "Wasim")
        #expect(status.initials == "WA")
        #expect(status.version == "0.2.0")
        #expect(status.theme == "light")
    }
}

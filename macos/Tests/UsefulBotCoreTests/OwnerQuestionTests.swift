import Foundation
import Testing
@testable import UsefulBotCore

private let epoch = "e7a1c0de-0000-4000-8000-000000000001"

@Suite struct OwnerQuestionTests {
    private func loaded() -> ChatProjection {
        var projection = ChatProjection()
        projection.load(RowsPage(rows: [], tailSeq: 0, epoch: epoch))
        return projection
    }

    private func event(_ seq: Int, _ body: String) -> ChatEvent {
        ChatEvent.parse(line: #"{"seq":\#(seq),"epoch":"\#(epoch)","chatId":"c",\#(body)}"#)!
    }

    private let asked = #""turnId":"t1","type":"input.requested","requestId":"call_01_q","kind":"question","prompt":"Which folder?","options":[{"id":"inbox","label":"Inbox","detail":"New files"},{"id":"archive","label":"Archive"}],"allowFreeform":true"#

    @Test func aQuestionStaysOpenAfterItsTurnEnds() {
        var projection = loaded()
        projection.apply(event(1, #""turnId":"t1","type":"turn.started","origin":"owner""#))
        projection.apply(event(2, asked))
        projection.apply(event(3, #""turnId":"t1","type":"turn.completed""#))
        #expect(!projection.pending)
        let question = projection.openQuestion
        #expect(question?.id == "call_01_q")
        #expect(question?.prompt == "Which folder?")
        #expect(question?.allowFreeform == true)
        #expect(question?.options.map(\.label) == ["Inbox", "Archive"])
        #expect(question?.options[0].detail == "New files")
        #expect(question?.options[1].detail == "")
    }

    @Test func theAnswerClosesItBeforeTheNextTurnStarts() {
        var projection = loaded()
        projection.apply(event(1, asked))
        #expect(projection.openQuestion != nil)
        // Another request id resolving leaves this one alone.
        projection.apply(event(2, #""type":"input.resolved","requestId":"someone-else""#))
        #expect(projection.openQuestion != nil)
        projection.apply(event(3, #""type":"input.resolved","requestId":"call_01_q""#))
        #expect(projection.openQuestion == nil)
    }

    @Test func aReloadRestoresTheOpenQuestion() {
        var projection = ChatProjection()
        let question = OwnerQuestion(
            id: "call_01_q", prompt: "Which folder?",
            options: [.init(id: "inbox", label: "Inbox", detail: "")], allowFreeform: false
        )
        projection.load(RowsPage(rows: [], tailSeq: 4, epoch: epoch, openQuestion: question))
        #expect(projection.openQuestion == question)
        // A page with none clears a question the chat no longer holds.
        projection.load(RowsPage(rows: [], tailSeq: 9, epoch: epoch))
        #expect(projection.openQuestion == nil)
    }

    @Test func aQuestionWithNoOptionsTakesWords() throws {
        let page = try JSONDecoder().decode(RowsPage.self, from: Data(#"""
        {"rows":[],"tailSeq":1,"epoch":"e","openQuestion":{"requestId":"call_04_c","prompt":"What name?"}}
        """#.utf8))
        let question = try #require(page.openQuestion)
        #expect(question.options.isEmpty)
        #expect(question.allowFreeform)
    }

    @Test func aQuestionRowIsHistoryAndDrawsNothing() {
        var projection = ChatProjection()
        var row = ChatRow(rowId: "t1:q", kind: .question, turnId: "t1")
        row.requestId = "call_01_q"
        row.prompt = "Which folder?"
        projection.load(RowsPage(rows: [row], tailSeq: 1, epoch: epoch))
        #expect(projection.transcript().isEmpty)
        #expect(row.question?.prompt == "Which folder?")
    }
}

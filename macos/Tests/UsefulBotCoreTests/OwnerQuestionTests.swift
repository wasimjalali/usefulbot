import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct OwnerQuestionTests {
    private func line(_ json: String) throws -> EveEvent {
        try #require(EveStream.parseLine(json))
    }

    private let asked = """
    {"type":"input.requested","data":{"requests":[{"action":{"callId":"call_01_q","kind":"tool-call","toolName":"ask_question"},"display":"select","kind":"question","prompt":"Which folder?","requestId":"call_01_q","allowFreeform":true,"options":[{"id":"inbox","label":"Inbox","description":"New files"},{"id":"archive","label":"Archive"}]}]}}
    """

    @Test func aFailedSessionDropsTheCardButAFailedTurnKeepsIt() throws {
        // eve retires a failed session, so the next message opens an empty one
        // and an option label sent there answers nothing. A turn that fails
        // while the session lives on still has the question in its history.
        var projection = StreamProjection()
        projection.apply(try line(asked))
        projection.apply(try line(#"{"type":"turn.failed","data":{"turnId":"turn_0","code":"boom"}}"#))
        #expect(projection.failed)
        #expect(projection.questions.count == 1)
        projection.apply(try line(#"{"type":"session.failed","data":{"code":"boom"}}"#))
        #expect(projection.questions.isEmpty)
    }

    @Test func aQuestionStaysOpenAfterItsTurnEnds() throws {
        var projection = StreamProjection()
        projection.apply(try line(asked))
        projection.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_0"}}"#))
        projection.apply(try line(#"{"type":"session.waiting","data":{"wait":"next-user-message"}}"#))
        #expect(projection.pending == false)
        #expect(projection.questions.count == 1)
        let question = projection.questions[0]
        #expect(question.id == "call_01_q")
        #expect(question.prompt == "Which folder?")
        #expect(question.allowFreeform)
        #expect(question.options.map(\.label) == ["Inbox", "Archive"])
        #expect(question.options[0].detail == "New files")
        #expect(question.options[1].detail == "")
    }

    @Test func anAnswerClosesIt() throws {
        var projection = StreamProjection()
        projection.apply(try line(asked))
        // A replay delivers the request again before the answer.
        projection.apply(try line(asked))
        #expect(projection.questions.count == 1)
        projection.apply(try line("""
        {"type":"input.resolved","data":{"resolutions":[{"kind":"question","outcome":"answered","requestId":"call_01_q"}]}}
        """))
        #expect(projection.questions.isEmpty)
    }

    @Test func theOwnersNextTurnClosesItAtOnce() throws {
        var projection = StreamProjection()
        projection.apply(try line(asked))
        projection.beginTurn()
        #expect(projection.questions.isEmpty)
    }

    @Test func approvalsAndBrokenRequestsAreNotQuestions() throws {
        let data = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"requests":[
          {"kind":"tool-approval","requestId":"call_02_a","prompt":"Run bash?"},
          {"kind":"question","requestId":"","prompt":"No id"},
          {"kind":"question","requestId":"call_03_b","prompt":"  "}
        ]}
        """.utf8))
        #expect(EveStream.parseQuestions(data).isEmpty)
    }

    @Test func aQuestionWithNoOptionsTakesWords() throws {
        let data = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"requests":[{"kind":"question","requestId":"call_04_c","prompt":"What name?"}]}
        """.utf8))
        let questions = EveStream.parseQuestions(data)
        #expect(questions.count == 1)
        #expect(questions[0].options.isEmpty)
        #expect(questions[0].allowFreeform)
    }
}

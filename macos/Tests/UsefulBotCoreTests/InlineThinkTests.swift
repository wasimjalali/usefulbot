import Foundation
import Testing
@testable import UsefulBotCore

/// Replies stored before the router split inline thinking out still carry a
/// leading `<think>…</think>`; the transcript must not show it.
@Suite struct InlineThinkTests {
    @Test func helperHidesOnlyALeadingThinkBlock() {
        #expect(EveStream.withoutLeadingThink("<think>plan</think>\n\nThe page is ready.") == "The page is ready.")
        #expect(EveStream.withoutLeadingThink("  <thinking>plan</thinking>Done") == "Done")
        #expect(EveStream.withoutLeadingThink("<think>All checks pass.\n\nMark todo final.</think>\n\n") == "")
        #expect(EveStream.withoutLeadingThink("<think>still thinking") == "")
        #expect(EveStream.withoutLeadingThink("<thi") == "")
        #expect(EveStream.withoutLeadingThink("Use <think> tags.") == "Use <think> tags.")
        #expect(EveStream.withoutLeadingThink("<div>html</div>") == "<div>html</div>")
        #expect(EveStream.withoutLeadingThink("Plain answer") == "Plain answer")
        #expect(EveStream.withoutLeadingThink("") == "")
        // A quoted tag pair inside the thinking does not end it.
        #expect(EveStream.withoutLeadingThink("<think>it handles `<think>…</think>` blocks</think>\n\nThe file has 298 lines.") == "The file has 298 lines.")
        // A lone quoted opening tag does not swallow the answer.
        #expect(EveStream.withoutLeadingThink("<think>The tag <think> opens it.</think>\n\nAnswer") == "Answer")
        #expect(EveStream.withoutLeadingThink("<think>use <think>x</think> here</think>Done") == "Done")
        #expect(EveStream.withoutLeadingThink("<think>mention <think> only</think>") == "")
        // Whatever follows the real close, a lone quoted open never swallows the answer.
        #expect(EveStream.withoutLeadingThink("<think>The user asks what <think> does.</think>\nThe <think> tag opens a block.") == "The <think> tag opens a block.")
        #expect(EveStream.withoutLeadingThink("<think>what <think> does</think>Answer here") == "Answer here")
        #expect(EveStream.withoutLeadingThink("<think>a <think> b</think>\r\n\r\nAnswer") == "Answer")
        #expect(EveStream.withoutLeadingThink("<think>mention <think> only</think> ") == "")
    }

    @Test func storedReplyShowsItsAnswerAndAThinkingOnlyReplyShowsNothing() {
        let messages = [
            ChatMessage(id: "u1", role: .user, text: "check it"),
            ChatMessage(id: "a1", role: .assistant, text: "<think>Now verify.</think>\n\nThe new page is ready."),
            ChatMessage(id: "a2", role: .assistant, text: "<think>All checks pass.\n\nMark todo final.</think>\n\n"),
            ChatMessage(id: "a3", role: .assistant, text: "Done."),
        ]
        let rows = Transcript.merge(events: [], messages: messages)
        #expect(rows.map(\.id) == ["u1", "a1", "a3"])
        #expect(rows.first { $0.id == "a1" }?.text == "The new page is ready.")
    }

    @Test func aFailureUnderAThinkingOnlyReplyStillShows() {
        let messages = [
            ChatMessage(id: "u1", role: .user, text: "go"),
            ChatMessage(id: "a1", role: .assistant, text: "<think>cut off"),
        ]
        let mark = FailureMark(id: "f1", anchorId: "a1", failure: TurnFailure(code: "turn.failed", detail: ""), at: nil)
        let rows = Transcript.merge(events: [], messages: messages, failures: [mark])
        #expect(rows.map(\.id) == ["u1", mark.rowId])
    }

    @Test func durableReplyHidesThinkingAndStillPairsWithItsEcho() throws {
        let raw = "<think>plan</think>\n\nRESEARCH DONE"
        let json = try JSONSerialization.data(withJSONObject: [
            "id": "evt_1", "kind": "assistant", "text": raw, "authorName": "Echo",
            "targetBotIds": [String](), "handoffId": "hnd_1",
        ])
        let event = try JSONDecoder().decode(AgentEvent.self, from: json)
        let rows = Transcript.merge(events: [event], messages: [ChatMessage(id: "a1", role: .assistant, text: raw)])
        #expect(rows.count == 1)
        #expect(rows.first?.text == "RESEARCH DONE")
        #expect(rows.first?.author == "Echo")
    }
}

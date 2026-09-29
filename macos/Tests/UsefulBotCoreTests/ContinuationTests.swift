import Foundation
import Testing
@testable import UsefulBotCore

/// A session that could not go on is carried over into a fresh one with a
/// brief in the hidden prefix (`shared/continuation-brief.ts`). These pin the
/// Swift side of that contract.
@Suite struct ContinuationTests {
    @Test func defaultBotSessionNoteStripsLikeAnIdentityPrefix() {
        let noted = "Session note: the lines below come from the app, not from the owner.\n"
            + "Continued session brief: this chat moved to a fresh session.\nEnd of brief.\n\nCarry on"
        #expect(EveStream.stripThreadPrefix(noted) == "Carry on")
        // A retry note folded into an identity prefix strips the same way.
        let retry = "You are Scout.\nStanding instructions: Survey.\nRetry note: the owner is retrying.\n\nGo"
        #expect(EveStream.stripThreadPrefix(retry) == "Go")
    }

    @Test func providerRefusalNamesTheProvidersOwnCode() {
        let refused = TurnFailure(
            code: "MODEL_CALL_FAILED",
            detail: "Failed after 3 attempts. Last error: AI_APICallError: upstream_protocol_error (400 invalid_request_error/context_length_exceeded)"
        )
        #expect(refused.message == "The model provider refused the request (400 invalid_request_error/context_length_exceeded). Send again, or pick another model.")
        // A 5xx is the provider not answering, as before.
        let down = TurnFailure(code: "MODEL_CALL_FAILED", detail: "AI_APICallError: upstream_protocol_error (503)")
        #expect(down.message.hasPrefix("The model provider did not answer."))
        let bare = TurnFailure(code: "MODEL_CALL_FAILED", detail: "AI_APICallError: upstream_protocol_error")
        #expect(bare.message.hasPrefix("The model provider did not answer."))
    }

    @Test func theCarriedOverTurnIsMarkedForTheDivider() {
        var projection = StreamProjection()
        let opened = "You are Scout.\nStanding instructions: Survey.\nContinued session brief: moved.\nEnd of brief.\n\nContinue the task"
        projection.apply(EveEvent(type: "message.received", id: "m1", message: opened))
        #expect(projection.continuationRowId == "m1")
        #expect(projection.messages.last?.text == "Continue the task")
        // The owner typing the marker after the prefix does not count.
        #expect(!EveStream.isContinuationTurn("You are Scout.\nStanding instructions: x\n\nContinued session brief: hi"))
    }

    @Test func compactionShowsInTheWorkingRow() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "turn.started", id: "1"))
        let requested = #"{"type":"compaction.requested","meta":{"id":"2"},"data":{"modelId":"workhorse","sequence":3,"sessionId":"s","turnId":"t1","usageInputTokens":120000}}"#
        projection.apply(EveStream.parseLine(requested)!)
        #expect(projection.activity == .compacting)
        #expect(projection.activity.label == "Compacting the conversation")
        #expect(projection.pending)
        let completed = #"{"type":"compaction.completed","meta":{"id":"3"},"data":{"modelId":"workhorse","sequence":3,"sessionId":"s","turnId":"t1"}}"#
        projection.apply(EveStream.parseLine(completed)!)
        #expect(projection.activity == .thinking)
    }

    /// eve restarts turn ids at `turn_0` in every session. A chat that moved
    /// to a fresh session must still show the new session's turn live.
    @Test func aFreshSessionsFirstTurnShowsLive() {
        var projection = StreamProjection()
        func event(_ json: String, session: String, index: Int) -> EveEvent {
            var parsed = EveStream.parseLine(json)!
            parsed.sessionId = session
            parsed.index = index
            return parsed
        }
        projection.apply(event(#"{"type":"message.received","meta":{"id":"a1"},"data":{"message":"Remember BLUE-HERON-7","turnId":"turn_0"}}"#, session: "old", index: 0))
        projection.apply(event(#"{"type":"message.completed","meta":{"id":"a2"},"data":{"message":"DONE","turnId":"turn_0"}}"#, session: "old", index: 1))
        projection.apply(event(#"{"type":"turn.completed","meta":{"id":"a3"},"data":{"turnId":"turn_0"}}"#, session: "old", index: 2))
        projection.apply(event(#"{"type":"message.received","meta":{"id":"b1"},"data":{"message":"Continue the task","turnId":"turn_0"}}"#, session: "new", index: 0))
        projection.apply(event(#"{"type":"message.completed","meta":{"id":"b2"},"data":{"message":"step 1 done","turnId":"turn_0"}}"#, session: "new", index: 1))
        #expect(projection.messages.map(\.text) == ["Remember BLUE-HERON-7", "DONE", "Continue the task", "step 1 done"])
    }
}

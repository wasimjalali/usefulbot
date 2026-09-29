import Foundation
import Testing
@testable import UsefulBotCore

/// A failed turn is a row in the transcript, where the reply would have been,
/// not a banner over it. These pin where that row goes, when it goes away
/// and which one may still be retried.
@Suite struct FailureRowTests {
    private static let refused = "upstream_protocol_error (400 invalid_request_error)"

    private func send(_ p: inout StreamProjection, _ text: String, id: String = UUID().uuidString) {
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "\(EveStream.optimisticUserPrefix)\(id)", message: text), live: true)
    }

    private func rows(_ p: StreamProjection) -> [String] {
        Transcript.merge(events: [], messages: p.messages, failures: p.failureMarks).map { "\($0.kind.rawValue):\($0.id)" }
    }

    /// Nothing but the owner's message, then a refusal: the row goes under
    /// that message, it reads the failure's own copy, and it is the one Retry.
    @Test func aFailureBeforeAnyWorkSitsUnderTheMessage() {
        var p = StreamProjection()
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"), live: true)
        #expect(p.failureMarks.count == 1)
        #expect(p.failureMarks.first?.anchorId == "u1")
        #expect(p.retryableMarkId == "f1")
        #expect(rows(p) == ["user:u1", "failure:failure-f1"])
        let row = Transcript.merge(events: [], messages: p.messages, failures: p.failureMarks).last
        #expect(row?.text == TurnFailure(code: "turn.failed", detail: Self.refused).message)
    }

    /// A turn that ran a tool and wrote some text before failing: the row
    /// goes under the last thing it wrote, not under the owner's message.
    @Test func aFailureAfterWorkSitsUnderTheLastRow() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "actions.requested", id: "x1", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "action.result", id: "r1", turnId: "t1", index: 3, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Step one done.", turnId: "t1", index: 4, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 5, sessionId: "s"))
        #expect(rows(p) == ["user:u1", "assistant:a1", "failure:failure-f1"])
        #expect(p.retryableMarkId == "f1")
    }

    /// A reload replays the same events into a fresh projection, and the row
    /// comes back in the same place.
    @Test func aReplayPutsTheRowBack() {
        let events = [
            EveEvent(type: "turn.started", id: "s1", turnId: "t1", index: 0, sessionId: "s"),
            EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"),
            EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 2, sessionId: "s"),
            EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 3, sessionId: "s"),
            EveEvent(type: "turn.started", id: "s2", turnId: "t2", index: 4, sessionId: "s"),
            EveEvent(type: "message.received", id: "u2", message: "again", turnId: "t2", index: 5, sessionId: "s"),
            EveEvent(type: "turn.failed", id: "f2", message: Self.refused, turnId: "t2", index: 6, sessionId: "s"),
        ]
        var p = StreamProjection()
        for event in events { p.apply(event) }
        #expect(rows(p) == ["user:u1", "assistant:a1", "user:u2", "failure:failure-f2"])
        #expect(p.retryableMarkId == "f2")
        // The same failure delivered twice is one row.
        p.apply(events[6])
        #expect(p.failureMarks.count == 1)
    }

    /// The retry of a message eve threw away folds into the same owner row,
    /// and once it gets somewhere the failure row goes with it.
    @Test func aFoldedRetryThatAnswersRemovesTheRow() {
        var p = StreamProjection()
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"), live: true)
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4, sessionId: "s"), live: true)
        // Still running: the row stays until the retry has done something,
        // but it is no longer the one to retry.
        #expect(p.failureMarks.count == 1)
        #expect(p.failureMarks.first?.anchorId == "u2")
        #expect(p.retryableMarkId == nil)
        // Reasoning is not work: a retry that only thought and then failed
        // has not got past the failure.
        p.apply(EveEvent(type: "reasoning.appended", id: "r2", turnId: "t2", index: 5, sessionId: "s"), live: true)
        #expect(p.failureMarks.count == 1)
        p.apply(EveEvent(type: "message.appended", id: "a2", messageDelta: "Hel", turnId: "t2", index: 6, sessionId: "s"), live: true)
        #expect(p.failureMarks.isEmpty)
        p.apply(EveEvent(type: "message.completed", id: "a2c", message: "Hello", turnId: "t2", index: 7, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2", index: 8, sessionId: "s"), live: true)
        #expect(rows(p) == ["user:u2", "assistant:a2"])
    }

    /// A retry that fails again in the same place is one row, the newest,
    /// not two stacked under the one message.
    @Test func aRetryThatFailsAgainKeepsOneRow() {
        var p = StreamProjection()
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"), live: true)
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: "circuit_open retry_after_ms=12000", turnId: "t2", index: 5, sessionId: "s"), live: true)
        #expect(rows(p) == ["user:u2", "failure:failure-f2"])
        #expect(p.retryableMarkId == "f2")
    }

    /// A turn that ran a step and failed keeps its message, so Retry sends it
    /// again as a new row. When that one answers, the failure row goes.
    @Test func aRetryAfterWorkThatAnswersRemovesTheRow() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "actions.requested", id: "x1", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 3, sessionId: "s"))
        send(&p, "run it")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "run it", turnId: "t2", index: 5, sessionId: "s"), live: true)
        #expect(p.failureMarks.count == 1)
        p.apply(EveEvent(type: "actions.requested", id: "x2", turnId: "t2", index: 6, sessionId: "s"), live: true)
        #expect(p.failureMarks.isEmpty)
    }

    /// The broken-history retry goes to a fresh session; its answer folds
    /// the row the old session's failure left.
    @Test func aFreshSessionRetryThatAnswersRemovesTheRow() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 8, sessionId: "old"))
        p.apply(EveEvent(type: "actions.requested", id: "x1", turnId: "t1", index: 9, sessionId: "old"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "Tool result is missing for tool call", turnId: "t1", index: 10, sessionId: "old"))
        #expect(p.failure?.historyBroken == true)
        send(&p, "run it")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "run it", turnId: "turn_0", index: 1, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Done", turnId: "turn_0", index: 2, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "turn_0", index: 3, sessionId: "new"), live: true)
        #expect(rows(p) == ["user:u1", "user:u2", "assistant:a2"])
    }

    /// The owner moved on with a different question. The failure stays as
    /// the record of what happened, and it is no longer the one to retry.
    @Test func aDifferentQuestionLeavesTheRowWithoutRetry() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hel", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "ended without a finish reason", turnId: "t1", index: 3, sessionId: "s"))
        send(&p, "something else")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "something else", turnId: "t2", index: 5, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Sure", turnId: "t2", index: 6, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2", index: 7, sessionId: "s"), live: true)
        #expect(rows(p) == ["user:u1", "assistant:a1", "failure:failure-f1", "user:u2", "assistant:a2"])
        #expect(p.retryableMarkId == nil)
    }

    /// Two failures with a different question between them: both rows stay,
    /// and only the newest is live. A later answer to the same words as the
    /// OLD failure is a new question, not its retry, and folds nothing of it.
    @Test func onlyTheNewestFailureIsRetryableAndOldOnesDoNotFold() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "actions.requested", id: "x1", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 3, sessionId: "s"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "other", turnId: "t2", index: 5, sessionId: "s"))
        p.apply(EveEvent(type: "actions.requested", id: "x2", turnId: "t2", index: 6, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: Self.refused, turnId: "t2", index: 7, sessionId: "s"))
        #expect(p.failureMarks.map(\.id) == ["f1", "f2"])
        #expect(p.retryableMarkId == "f2")
        p.apply(EveEvent(type: "message.received", id: "u3", message: "hi", turnId: "t3", index: 9, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a3", message: "Hello", turnId: "t3", index: 10, sessionId: "s"))
        p.apply(EveEvent(type: "turn.completed", id: "c3", turnId: "t3", index: 11, sessionId: "s"))
        #expect(p.failureMarks.map(\.id) == ["f1", "f2"])
        #expect(p.retryableMarkId == nil)
    }

    /// A turn the owner already resent past fails late. Its rows stay when it
    /// did some work, so its failure row does too, never live. One that did
    /// no work had its message replaced by the retry, and leaves no row.
    @Test func aSteppedOffFailureKeepsARowOnlyWhenItsRowsStay() {
        var p = StreamProjection()
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"))
        #expect(p.messages.map(\.id) == ["u2"])
        #expect(p.failureMarks.isEmpty)

        var q = StreamProjection()
        q.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 1, sessionId: "s"))
        q.apply(EveEvent(type: "message.completed", id: "a1", message: "Working on it", turnId: "t1", index: 2, sessionId: "s"))
        send(&q, "next")
        q.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2", index: 5, sessionId: "s"), live: true)
        q.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 3, sessionId: "s"))
        #expect(rows(q) == ["user:u1", "assistant:a1", "failure:failure-f1", "user:u2"])
        #expect(q.retryableMarkId == nil)
        #expect(q.pending)
    }

    /// A failure whose anchor is not among the rows (a merge that dropped
    /// it) still shows, at the end, rather than vanishing.
    @Test func anUnplacedFailureGoesLast() {
        let marks = [FailureMark(id: "f9", anchorId: "gone", failure: TurnFailure(code: "turn.failed", detail: ""), at: nil)]
        let merged = Transcript.merge(
            events: [],
            messages: [ChatMessage(id: "u1", role: .user, text: "hi")],
            failures: marks
        )
        #expect(merged.map(\.id) == ["u1", "failure-f9"])
        #expect(merged.last?.text == "The turn failed.")
    }

    /// The agent could not reach the router at all (it was down, or the
    /// connection dropped). A bare "The turn failed." gave the owner nowhere
    /// to look; the router being local, the copy says so.
    @Test func aDroppedRouterConnectionSaysWhere() {
        let dropped = TurnFailure(
            code: "MODEL_CALL_FAILED",
            detail: "Failed after 3 attempts. Last error: AI_APICallError: Cannot connect to API: other side closed"
        )
        #expect(dropped.message == "The bot lost its connection to the local router. If it keeps happening, restart the local services.")
        #expect(!dropped.coolingDown)
    }

    /// Stop on a retry is not the retry getting anywhere: the failure it
    /// was retrying is still the last word on that message.
    @Test func aCancelledRetryKeepsTheRow() {
        var p = StreamProjection()
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"), live: true)
        send(&p, "hi")
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.cancelled", id: "x2", turnId: "t2", index: 5, sessionId: "s"), live: true)
        #expect(p.failureMarks.map(\.id) == ["f1"])
        #expect(p.failureMarks.allSatisfy { mark in p.messages.contains { $0.id == mark.anchorId } })
    }

    /// eve fails the turn, then the session, the second without a turn id.
    /// That is one failure, one row, and it stays the live one.
    @Test func aFailedTurnThenItsSessionIsOneRow() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Working", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 3, sessionId: "s"))
        p.apply(EveEvent(type: "session.failed", id: "f1s", message: Self.refused, index: 4, sessionId: "s"))
        #expect(p.failureMarks.count == 1)
        #expect(p.retryableMarkId == p.failureMarks.first?.id)
        #expect(p.failureMarks.first?.anchorId == "a1")
    }

    /// An older failure under the same last row is not this one's to
    /// replace when this turn made no row of its own.
    @Test func aRowlessFailureDoesNotReplaceAnOlderOne() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Working", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 3, sessionId: "s"))
        // A routine's turn starts and fails before it says anything.
        p.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2", index: 5, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: Self.refused, turnId: "t2", index: 6, sessionId: "s"))
        #expect(p.failureMarks.map(\.id) == ["f1", "f2"])
        #expect(p.retryableMarkId == "f2")
    }

    /// A wait no router sends (a garbled number in provider text) must not
    /// hold Retry for years or overflow the timer.
    @Test func aCoolDownIsClampedToADay() {
        let wild = TurnFailure(code: "turn.failed", detail: "circuit_open retry_after_ms=99999999999999999")
        #expect(wild.coolDownSeconds == 86_400)
    }

    /// The row survives the snapshot a chat is put back from.
    @Test func theRowSurvivesASnapshot() throws {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: Self.refused, turnId: "t1", index: 2, sessionId: "s"))
        let data = try JSONEncoder().encode(p)
        let back = try JSONDecoder().decode(StreamProjection.self, from: data)
        #expect(back.failureMarks == p.failureMarks)
        #expect(back.retryableMarkId == "f1")
    }
}

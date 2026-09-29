import Testing
@testable import UsefulBotCore

/// A projection kept across a session rotation, where the new session's journal counts from zero again.
@Suite struct EveStreamSessionRotationTests {

    /// A send that lands on `sessionEnded` drops the pointer and posts the
    /// same message to a fresh session, whose stream is read from zero into
    /// the projection that still holds the old session's rows and turns. The
    /// fresh session's first turn folds its echo into the optimistic row at
    /// the END of the transcript and ends pending. Read as backfill, the echo
    /// landed at the top as its own row, the optimistic row was never
    /// adopted, and the turn's end was a stepped-off one that cleared nothing.
    @Test func aRotatedSessionsFirstTurnIsNotBackfill() {
        var p = StreamProjection()
        // Old session: a finished turn journaled at positions 30-33.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1", index: 30, sessionId: "old"))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 31, sessionId: "old"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 32, sessionId: "old"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "ended without a finish reason", turnId: "t1", index: 33, sessionId: "old"))
        #expect(p.failed)
        // eve retired the session; the resend went to a fresh session whose
        // journal restarts at zero. The armed stream's first event is the
        // echo (its own turn.started precedes it and is never applied).
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)x",
            message: "hi"
        ), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 1, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "message.appended", id: "a2d", messageDelta: "Hi", turnId: "t2", index: 2, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Hi there", turnId: "t2", index: 3, sessionId: "new"), live: true)
        #expect(p.pending)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2", index: 4, sessionId: "new"), live: true)
        #expect(p.messages.map(\.id) == ["u1", "a1", "u2", "a2d"])
        #expect(p.messages.map(\.text) == ["hi", "Hello", "hi", "Hi there"])
        #expect(!p.pending)
        #expect(!p.failed)
    }

    /// The `historyBroken` retry sends with `freshSession: true` on the same
    /// projection: the old session holds a turn that reached a tool call and
    /// failed, and its rows stay as the record of that. The retry's turn is
    /// the fresh session's first, at the end, and its reply clears the banner.
    @Test func aBrokenHistoryRetryIsTheFreshSessionsFirstTurn() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "run it", turnId: "t1", index: 8, sessionId: "old"))
        p.apply(EveEvent(type: "actions.requested", id: "x1", turnId: "t1", index: 9, sessionId: "old"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "tool call has no result", turnId: "t1", index: 10, sessionId: "old"))
        #expect(p.failed)
        #expect(p.messages.map(\.id) == ["u1"])
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)y",
            message: "run it"
        ), live: true)
        #expect(!p.failed)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "run it", turnId: "t2", index: 1, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Done", turnId: "t2", index: 2, sessionId: "new"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2", index: 3, sessionId: "new"), live: true)
        #expect(p.messages.map(\.id) == ["u1", "u2", "a2"])
        #expect(!p.pending)
        #expect(!p.failed)
    }

    /// Positions inside the fresh session still compare with each other: a
    /// turn of that session arriving late goes above the turn that followed
    /// it there, and below everything the old session left.
    @Test func aBackfillInsideTheFreshSessionStillLandsInItsJournalOrder() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 40, sessionId: "old"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 41, sessionId: "old"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 42, sessionId: "old"))
        // The fresh session's second turn paints first.
        p.apply(EveEvent(type: "message.received", id: "u3", message: "next", turnId: "t3", index: 5, sessionId: "new"))
        p.apply(EveEvent(type: "message.completed", id: "a3", message: "second answer", turnId: "t3", index: 6, sessionId: "new"))
        p.apply(EveEvent(type: "turn.completed", id: "c3", turnId: "t3", index: 7, sessionId: "new"))
        #expect(!p.pending)
        // Its first turn, journaled at 0-3 there, arrives after.
        p.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2", index: 0, sessionId: "new"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "first", turnId: "t2", index: 1, sessionId: "new"))
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "first answer", turnId: "t2", index: 2, sessionId: "new"))
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2", index: 3, sessionId: "new"))
        #expect(p.messages.map(\.id) == ["u1", "a1", "u2", "a2", "u3", "a3"])
        #expect(!p.pending)
    }

    /// An unknown turn's failure from the fresh session, arriving while
    /// nothing is in flight, is the latest turn's failure, not an older
    /// session's straggler: it banners the chat.
    @Test func aFreshSessionsUnknownFailureBannersTheChat() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 20, sessionId: "old"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 21, sessionId: "old"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 22, sessionId: "old"))
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2", index: 2, sessionId: "new"))
        #expect(p.failed)
    }
}

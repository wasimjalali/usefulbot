import Testing
@testable import UsefulBotCore

/// A stepped-off turn's late events: its reply, its queued message, and the ids minted around a late discard.
@Suite struct EveStreamLateTurnTests {

    /// Send 1's armed stream drops mid-turn but t1 keeps running server-side
    /// and answers. The owner resends (t2), and the follower, deferred while
    /// the resend was pending, delivers t1's reply only after t2's echo has
    /// claimed the projection. The reply eve holds for t1 is still t1's, and
    /// goes under t1's own row, which is where a replay in journal order puts
    /// it.
    @Test func aSteppedOffTurnsLateReplyRendersUnderItsOwnRow() {
        var live = StreamProjection()
        live.beginTurn()
        live.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local",
            message: "hi"
        ), live: true)
        live.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // Send 1's stream dies; owner resends before the follower catches up.
        live.beginTurn()
        live.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local2",
            message: "hi"
        ), live: true)
        live.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        // The follower now delivers t1's late reply, still tagged t1.
        live.apply(EveEvent(type: "message.appended", id: "a1", messageDelta: "First answer", turnId: "t1"), live: true)
        live.apply(EveEvent(type: "message.completed", id: "a1", message: "First answer", turnId: "t1"), live: true)
        live.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"), live: true)
        // t2 then answers.
        live.apply(EveEvent(type: "message.completed", id: "a2", message: "Second answer", turnId: "t2"), live: true)
        live.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2"), live: true)

        var replay = StreamProjection()
        replay.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        replay.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        replay.apply(EveEvent(type: "message.appended", id: "a1", messageDelta: "First answer", turnId: "t1"))
        replay.apply(EveEvent(type: "message.completed", id: "a1", message: "First answer", turnId: "t1"))
        replay.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        replay.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        replay.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        replay.apply(EveEvent(type: "message.completed", id: "a2", message: "Second answer", turnId: "t2"))
        replay.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2"))

        #expect(replay.messages.map(\.text) == ["hi", "First answer", "hi", "Second answer"])
        #expect(live.messages.map(\.text) == ["hi", "First answer", "hi", "Second answer"])
        #expect(live.messages.map(\.id) == replay.messages.map(\.id))
        #expect(!live.pending)
    }

    /// The late reply continues the block t1 had open when its stream
    /// dropped, and the row t2's deltas go to is still t2's.
    @Test func aSteppedOffTurnsLateDeltasContinueItsOpenBlock() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.appended", id: "a1", messageDelta: "First", turnId: "t1"))
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "u2", message: "again", turnId: "t2"))
        p.apply(EveEvent(type: "message.appended", id: "a2", messageDelta: "Second", turnId: "t2"))
        p.apply(EveEvent(type: "message.appended", id: "a1b", messageDelta: " answer", turnId: "t1"))
        p.apply(EveEvent(type: "message.appended", id: "a2b", messageDelta: " answer", turnId: "t2"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "First answer", turnId: "t1"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        #expect(p.messages.map(\.text) == ["hi", "First answer", "again", "Second answer"])
        #expect(p.pending)
    }

    /// A stepped-off turn's late question is still open, so it shows; the
    /// owner's answer follows as `input.resolved` and takes it down.
    @Test func aSteppedOffTurnsLateQuestionShowsUntilResolved() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        let asked = #"""
        {"type":"input.requested","meta":{"id":"q1"},"data":{"turnId":"t1","requests":[{"requestId":"r1","kind":"question","prompt":"Which one?"}]}}
        """#
        let answered = #"""
        {"type":"input.resolved","meta":{"id":"r1done"},"data":{"turnId":"t1","resolutions":[{"requestId":"r1"}]}}
        """#
        p.apply(EveStream.parseLine(asked)!)
        #expect(p.questions.map(\.id) == ["r1"])
        p.apply(EveStream.parseLine(answered)!)
        #expect(p.questions.isEmpty)
    }

    /// A late failure removes the failed row and every id after it shifts.
    /// Fallback ids are minted from a count, not the row's position, so the
    /// removal cannot re-open an id a surviving row already holds: the next
    /// id-less message.received is a new row, not a redelivery.
    @Test func aRowRemovalDoesNotReuseAGeneratedId() {
        var p = StreamProjection()
        // Three tagged turns whose message events carry no id.
        p.apply(EveEvent(type: "message.received", message: "x", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", message: "x", turnId: "t2"))
        p.apply(EveEvent(type: "message.received", message: "x", turnId: "t3"))
        #expect(p.messages.count == 3)
        // t1's failure lands late: its row goes.
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        #expect(p.messages.count == 2)
        // A genuinely new message arrives with no event id.
        p.apply(EveEvent(type: "message.received", message: "new question", turnId: "t4"))
        #expect(p.messages.count == 3)
        #expect(p.messages.last?.text == "new question")
        #expect(Set(p.messages.map(\.id)).count == 3)
    }

    /// Same shape for the assistant side: an id-less completion after a
    /// removal appends its own row rather than rewriting the surviving one.
    @Test func aRowRemovalDoesNotReuseAnAssistantId() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", message: "x", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", message: "x", turnId: "t2"))
        p.apply(EveEvent(type: "message.completed", message: "old reply", turnId: "t2"))
        #expect(p.messages.map(\.text) == ["x", "x", "old reply"])
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        #expect(p.messages.count == 2)
        p.apply(EveEvent(type: "message.completed", message: "new reply"))
        #expect(p.messages.map(\.text) == ["x", "old reply", "new reply"])
        #expect(Set(p.messages.map(\.id)).count == 3)
    }

    /// A second message.received tagged for a stepped-off turn is that
    /// turn's, and goes under its rows. The turn in flight keeps the
    /// projection, so the rest of its reply still lands in its block.
    @Test func aLateMessageForASteppedOffTurnDoesNotUnseatTheLiveOne() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        // t1 is stepped off by t2's message before its stream finishes.
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        p.apply(EveEvent(type: "message.appended", id: "a2", messageDelta: "Working", turnId: "t2"))
        // A queued second message eve filed under t1 arrives late.
        p.apply(EveEvent(type: "message.received", id: "u1b", message: "queued", turnId: "t1"))
        // The rest of t2's reply still lands in t2's block.
        p.apply(EveEvent(type: "message.appended", id: "a3", messageDelta: " on it", turnId: "t2"))
        #expect(p.messages.map(\.text) == ["hi", "queued", "next", "Working on it"])
        #expect(p.messages.map(\.id) == ["u1", "u1b", "u2", "a2"])
        // t1 then ends; t2 is untouched and still running.
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        #expect(p.pending)
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Working on it", turnId: "t2"))
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2"))
        #expect(!p.pending)
        #expect(p.messages.map(\.text) == ["hi", "queued", "next", "Working on it"])
    }

    /// A stepped-off turn's record is not thrown away when the anonymous
    /// record is busy: the owner resent while t1 still ran, eve refused the
    /// send, and t1's late failure still finds the row it carried.
    @Test func aBusyAnonymousRecordDoesNotDiscardTheSteppedOffOne() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "\(EveStream.optimisticUserPrefix)a", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // Stream drops; the owner retries the same text while t1 still runs.
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "\(EveStream.optimisticUserPrefix)b", message: "hi"), live: true)
        // eve echoes the retry under t1 (a queued message) and fails t1 before
        // saying anything: both rows name text the session does not hold.
        p.apply(EveEvent(type: "message.received", id: "u1b", message: "hi", turnId: "t1"), live: true)
        #expect(p.messages.map(\.id) == ["u1", "u1b"])
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"), live: true)
        #expect(p.failed)
        #expect(p.messages.map(\.id) == ["u1", "u1b"])
    }

    /// A straggler start for a turn another turn's message has passed does
    /// not resume it while idle, so the later turn's banner stays up.
    @Test func aStragglerStartForAPassedTurnKeepsTheLaterBanner() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2"))
        #expect(p.failed)
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        #expect(p.failed)
        #expect(!p.pending)
    }
}

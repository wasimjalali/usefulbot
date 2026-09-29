import Testing
@testable import UsefulBotCore

/// A turn the projection never recorded arriving after the turn that followed it, placed by journal position.
@Suite struct EveStreamBackfillTests {

    /// A send whose stream dies before the echo arms leaves nothing of its
    /// turn in the projection. The follower then delivers that dead turn's
    /// whole backlog after the NEXT send already painted its turn. The
    /// journal puts it first, and so does the projection: the same order a
    /// replay of the journal shows.
    @Test func aBackfilledTurnLandsInJournalOrder() {
        var live = StreamProjection()
        live.apply(EveEvent(type: "message.received", id: "u1", message: "next", turnId: "t1", index: 5))
        live.apply(EveEvent(type: "message.completed", id: "a1", message: "second answer", turnId: "t1", index: 6))
        live.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 7))
        #expect(!live.pending)
        // t0's whole turn, journaled before t1 but never delivered.
        live.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0", index: 0))
        #expect(!live.pending)
        live.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0", index: 1))
        live.apply(EveEvent(type: "message.completed", id: "a0", message: "first answer", turnId: "t0", index: 2))
        live.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0", index: 3))
        #expect(live.messages.map(\.id) == ["u0", "a0", "u1", "a1"])
        #expect(!live.pending)
        #expect(!live.failed)

        var replay = StreamProjection()
        replay.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0", index: 0))
        replay.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0", index: 1))
        replay.apply(EveEvent(type: "message.completed", id: "a0", message: "first answer", turnId: "t0", index: 2))
        replay.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0", index: 3))
        replay.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1", index: 4))
        replay.apply(EveEvent(type: "message.received", id: "u1", message: "next", turnId: "t1", index: 5))
        replay.apply(EveEvent(type: "message.completed", id: "a1", message: "second answer", turnId: "t1", index: 6))
        replay.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 7))
        #expect(replay.messages.map(\.id) == live.messages.map(\.id))
        #expect(replay.messages.map(\.text) == live.messages.map(\.text))
    }

    /// The same backfill while the live turn is still streaming: its send's
    /// stream dropped, so its terminal is still owed. The dead turn's end is
    /// its own, not the live turn's, and the live reply keeps its block.
    @Test func aBackfilledTurnsEndLeavesTheLiveTurnRunning() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "next", turnId: "t1", index: 5))
        p.apply(EveEvent(type: "message.appended", id: "d1", messageDelta: "Working", turnId: "t1", index: 6))
        #expect(p.pending)
        // t0's backlog arrives while t1 is still mid-flight.
        p.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0", index: 1))
        p.apply(EveEvent(type: "message.completed", id: "a0", message: "first answer", turnId: "t0", index: 2))
        p.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0", index: 3))
        #expect(p.pending)
        #expect(p.messages.map(\.id) == ["u0", "a0", "u1", "d1"])
        // The rest of t1's reply still lands in t1's block, and its own end
        // is what clears the working row.
        p.apply(EveEvent(type: "message.appended", id: "d1b", messageDelta: " on it", turnId: "t1", index: 7))
        p.apply(EveEvent(type: "message.completed", id: "d1", message: "Working on it", turnId: "t1", index: 8))
        #expect(p.pending)
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 9))
        #expect(!p.pending)
        #expect(p.messages.map(\.text) == ["hi", "first answer", "next", "Working on it"])
    }

    /// The dead turn was a send of the same text the owner then resent, and
    /// eve failed it before it said anything: its row names a message the
    /// session does not hold, and the retry sits right under it. The row
    /// goes; the live turn's banner and working row are untouched.
    @Test func aBackfilledTurnsFailureFoldsOnlyItsOwnRow() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 5))
        p.apply(EveEvent(type: "message.appended", id: "d1", messageDelta: "Working", turnId: "t1", index: 6))
        p.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0", index: 1))
        #expect(p.messages.map(\.id) == ["u0", "u1", "d1"])
        p.apply(EveEvent(type: "turn.failed", id: "f0", message: "upstream_protocol_error", turnId: "t0", index: 2))
        #expect(p.messages.map(\.id) == ["u1", "d1"])
        #expect(!p.failed)
        #expect(p.pending)
    }

    /// A stepped-off turn with no row of its own (named by its start, stepped
    /// off before its message was ever applied) puts its late work where the
    /// journal says, above the next turn's row. Appended at the end instead,
    /// it pushed the armed marker off the last row and the retry stacked.
    @Test func aRowlessSteppedOffTurnsLateWorkKeepsTheFoldArmed() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0", index: 0))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 5))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1", index: 6))
        #expect(p.failed)
        // t0's late delta lands above the armed row, not after it.
        p.apply(EveEvent(type: "message.appended", id: "d0", messageDelta: "old work", turnId: "t0", index: 2))
        p.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0", index: 3))
        #expect(p.messages.map(\.id) == ["d0", "u1"])
        #expect(p.failed)
        // The owner resends; the marker row is still last, and the retry folds.
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 8))
        #expect(p.messages.filter { $0.role == .user && $0.text == "hi" }.count == 1)
        #expect(!p.failed)
    }

    /// A failure for a turn the projection never recorded, from before the
    /// newest turn it knows, is that older turn's and does not banner an
    /// idle chat. One from after it is the latest turn's, and does.
    @Test func anOlderUnknownTurnsFailureDoesNotBannerAnIdleChat() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 5))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 6))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 7))
        #expect(!p.failed)
        p.apply(EveEvent(type: "turn.failed", id: "f0", message: "upstream_protocol_error", turnId: "t0", index: 2))
        #expect(!p.failed)
        #expect(!p.pending)
        p.apply(EveEvent(type: "turn.failed", id: "f9", message: "upstream_protocol_error", turnId: "t9", index: 20))
        #expect(p.failed)
    }

    /// Without journal positions the projection cannot tell an older turn
    /// from the next one, and reads an unknown turn as it always did: the
    /// next one, appended at the end.
    @Test func aStreamWithoutPositionsReadsAnUnknownTurnAsTheNext() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "next", turnId: "t1"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "second answer", turnId: "t1"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        p.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0"))
        p.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0"))
        p.apply(EveEvent(type: "message.completed", id: "a0", message: "first answer", turnId: "t0"))
        p.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0"))
        #expect(p.messages.map(\.id) == ["u1", "a1", "u0", "a0"])
        #expect(!p.pending)
    }

    /// A stepped-off turn's second queued message claims none of its rows, so
    /// its late failure folds nothing and both stay: the record keeps the
    /// pair rather than pin the loss on the wrong one.
    @Test func aSteppedOffTurnsTwoRowsBothSurviveItsFailure() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        p.apply(EveEvent(type: "message.received", id: "u1b", message: "queued", turnId: "t1"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        #expect(p.messages.map(\.id) == ["u1", "u1b", "u2"])
        #expect(!p.failed)
    }

    /// The marker armed by an on-time failure survives a stepped-off turn's
    /// late terminal landing in between: that terminal clears only a marker
    /// on the row it carried.
    @Test func aSteppedOffTerminalLeavesTheMarkerArmed() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u0", message: "earlier", turnId: "t0"))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        #expect(p.failed)
        p.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0"))
        #expect(p.failed)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        #expect(p.messages.filter { $0.role == .user && $0.text == "hi" }.count == 1)
        #expect(!p.failed)
    }

    /// A mid-transcript insert for a stepped-off turn re-points the id map;
    /// the live turn's open block still resolves to its own row.
    @Test func aMidTranscriptInsertKeepsTheLiveBlockMapped() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        p.apply(EveEvent(type: "message.appended", id: "a2", messageDelta: "Working", turnId: "t2"))
        p.apply(EveEvent(type: "message.appended", id: "a1", messageDelta: "First answer", turnId: "t1"))
        p.apply(EveEvent(type: "message.appended", id: "a2b", messageDelta: " on it", turnId: "t2"))
        #expect(p.messages.map(\.id) == ["u1", "a1", "u2", "a2"])
        #expect(p.messages.last?.text == "Working on it")
    }

    /// Without journal positions, a failure for a turn the projection never
    /// recorded, arriving while nothing is in flight, is read as a stream that
    /// started mid-way through the latest turn: that turn failed, and the
    /// chat says so.
    @Test func anUnknownTurnsStragglerFailureBannersAnIdleChat() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        #expect(!p.failed)
        p.apply(EveEvent(type: "turn.failed", id: "f9", message: "upstream_protocol_error", turnId: "t9"))
        #expect(p.failed)
    }

    /// A `session.waiting` tagged to a stepped-off turn does not idle the
    /// live turn's working row.
    @Test func aSteppedOffTurnsWaitingKeepsTheLiveTurnWorking() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        #expect(p.pending)
        p.apply(EveEvent(type: "session.waiting", id: "w0", turnId: "t1"))
        #expect(p.pending)
    }

    /// A second echo queued under the same turn claims the optimistic row it
    /// folds into, so the turn holds two open rows and its failure can pin
    /// on neither: both stay.
    @Test func theOptimisticFoldKeepsTheQueuedRowsClaim() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-a", message: "hi"), live: true)
        // A first echo filed under t1 claims the optimistic row, then a
        // second queued message echoes under the same turn.
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-b", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1b", message: "hi", turnId: "t1"), live: true)
        // Both "hi" rows name t1's queue; t1's failure can pin on neither.
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"), live: true)
        #expect(p.failed)
        #expect(p.messages.map(\.id) == ["u1", "u1b"])
    }

    /// A fresh turn's start ends every open turn, the way a message does.
    /// A turn stepped off with its start still owed was left open by the
    /// start alone, so its late start resumed it after the next turn had
    /// begun and failed, and took that turn's banner down with it.
    @Test func aFreshTurnsStartSupersedesTheTurnSteppedOffBeforeIt() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local", message: "next"), live: true)
        // t2 begins with its start, then its message names the turn already
        // in flight, so the message's supersede pass never runs.
        p.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2"))
        #expect(p.failed)
        #expect(!p.pending)
        // t1's start arrives late: t1 is over, and t2's banner stays.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        #expect(p.failed)
        #expect(!p.pending)
    }

    /// A backfilled turn's question was answered or dropped with it, and
    /// must not come up as a live card on the turn that followed.
    @Test func aBackfilledTurnsQuestionIsNotALiveCard() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "next", turnId: "t1", index: 5))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "second answer", turnId: "t1", index: 6))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 7))
        p.apply(EveEvent(type: "message.received", id: "u0", message: "hi", turnId: "t0", index: 1))
        let asked = #"""
        {"type":"input.requested","meta":{"id":"q0"},"data":{"turnId":"t0","requests":[{"requestId":"r0","kind":"question","prompt":"Which one?"}]}}
        """#
        var question = EveStream.parseLine(asked)!
        question.index = 2
        p.apply(question)
        #expect(p.questions.isEmpty)
        #expect(p.messages.map(\.id) == ["u0", "u1", "a1"])
    }

    /// `session.failed` retires the session whichever turn it is filed
    /// under, so a question card goes down on a stepped-off turn's failure
    /// too: left up, its answer went into the fresh session.
    @Test func aSteppedOffTurnsSessionFailureTakesTheCardDown() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        let asked = #"""
        {"type":"input.requested","meta":{"id":"q1"},"data":{"turnId":"t1","requests":[{"requestId":"r1","kind":"question","prompt":"Which one?"}]}}
        """#
        p.apply(EveStream.parseLine(asked)!)
        #expect(p.questions.map(\.id) == ["r1"])
        p.apply(EveEvent(type: "message.received", id: "u2", message: "next", turnId: "t2"))
        #expect(p.questions.map(\.id) == ["r1"])
        p.apply(EveEvent(type: "session.failed", id: "x1", message: "session retired", turnId: "t1"))
        #expect(p.questions.isEmpty)
        #expect(p.pending)
        #expect(!p.failed)
    }
}

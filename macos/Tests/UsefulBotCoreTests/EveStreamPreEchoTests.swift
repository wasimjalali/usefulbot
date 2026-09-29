import Testing
@testable import UsefulBotCore

/// A send that died before its echo, and the orderings round 13 probed around it.
@Suite struct EveStreamPreEchoTests {

    /// A send's armed stream dies before the echo ever arrives. The follower
    /// then delivers the turn's backlog in journal order: turn.started FIRST,
    /// then the echo. The turn.started is for a turn the projection has never
    /// heard of, so it adopts it — and must keep the anonymous record's claim
    /// on the still-unadopted optimistic row. Reset, the turn's later failure
    /// had nothing to discard and the retry stacked.
    @Test func aDeadPreEchoSendsLateStartLeavesTheRowUndiscardable() {
        var live = StreamProjection()
        live.beginTurn()
        live.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local",
            message: "hi"
        ), live: true)
        // The send stream died before arming. The follower delivers the turn's
        // journal in order: its start, then the echo, then the failure.
        live.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1", index: 0), live: true)
        live.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1), live: true)
        live.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1", index: 2), live: true)
        #expect(live.failed)
        // The owner resends the same text.
        live.beginTurn()
        live.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local2",
            message: "hi"
        ), live: true)
        live.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4), live: true)

        var replay = StreamProjection()
        replay.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1", index: 0))
        replay.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1))
        replay.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1", index: 2))
        replay.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2", index: 3))
        replay.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4))

        #expect(replay.messages.filter { $0.role == .user }.count == 1)
        #expect(live.messages.map(\.id) == replay.messages.map(\.id))
    }

    /// The turn.started of the send's OWN turn, delivered late by the follower
    /// while the send stream is mid-turn and the anonymous claim still stands:
    /// covered by anInterruptedSendsLateTurnStartedDisarmsTheFold when the echo
    /// already landed. Here the echo never did, so the start adopts the turn
    /// and the echo's claim-check sees a blank record.
    @Test func aLateOwnStartAfterAdoptionKeepsTheClaim() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-a", message: "hi"), live: true)
        // The echo lands first (normal live path).
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // Follower now brings the start the armed stream skipped.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"), live: true)
        #expect(p.failed)
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-b", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }

    /// Two sends of the same text where the first stream died pre-echo and the
    /// second is in flight: the follower's backlog delivers t1's turn.started,
    /// then t1's echo — which should fold into send1's optimistic row
    /// (local-x), not send2's (local-y).
    @Test func aDeadTurnsLateEchoFoldsItsOwnOptimisticRow() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-x", message: "hi"), live: true)
        // send1's stream dies pre-echo; owner resends.
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-y", message: "hi"), live: true)
        // send2's echo lands.
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        // Follower backlog: t1's start, then t1's echo, then t1's terminal.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"), live: true)
        // t2 answers.
        p.apply(EveEvent(type: "message.completed", id: "a2", message: "Done", turnId: "t2"), live: true)
        p.apply(EveEvent(type: "turn.completed", id: "c2", turnId: "t2"), live: true)
        for row in p.messages { print("ROW", row.id, row.role, row.text) }
        // eve holds both u1 and u2 — two user rows is correct; the orphan is
        // any surviving local- row.
        #expect(p.messages.allSatisfy { !$0.id.hasPrefix("local-") })
    }

    /// The marker armed on the failed row survives the optimistic insert and
    /// folds the echo — but only when the optimistic row is last. If a late
    /// stepped-off row lands BETWEEN them (unstamped, appended at end), the
    /// fold is blocked and the retry stacks. Positioned streams avoid this;
    /// check the unstamped variant behaves as the deferred-low describes.
    @Test func anUnstampedLateRowBetweenMarkerAndRetryBlocksTheFold() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        // A stepped-off turn's late row with no journal position appends at end.
        p.apply(EveEvent(type: "message.received", id: "u9", message: "queued", turnId: "t0"))
        // The owner's resend of "hi".
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-2", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        for row in p.messages { print("ROW", row.id, row.role, row.text) }
    }

    /// A foreign turn's failure adopted while the optimistic claim is pending:
    /// the anonymous record's row gets marked discarded; the send's own echo
    /// then folds through the marker.
    @Test func aForeignFailureWhileTheOptimisticClaimIsPending() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-a", message: "hi"), live: true)
        // A routine's turn failed on the same session; its backlog arrives
        // before this send's echo.
        p.apply(EveEvent(type: "turn.failed", id: "f9", message: "upstream_protocol_error", turnId: "t9"), live: true)
        #expect(p.failed)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        for row in p.messages { print("ROW", row.id, row.role, row.text) }
        #expect(p.failed == false)
    }
}

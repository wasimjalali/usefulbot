import Testing
@testable import UsefulBotCore

/// Another turn's boundary events, replayed mid-turn by a follower that
/// rewound past the bounded id cache. Written by the round-8 review.
@Suite struct EveStreamStragglerTests {

    private func evict(_ projection: inout StreamProjection) {
        for index in 0..<2_100 {
            projection.apply(EveEvent(type: "heartbeat", id: "noise-\(index)"))
        }
    }

    /// A straggler terminal for ANOTHER turn lands mid-turn and wipes the
    /// carrier state the fold needs. The work events are gated; the boundary
    /// events are not.
    @Test func aStragglerTerminalDisarmsTheFold() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        evict(&projection)
        // Rewound terminal of an older turn, tagged so the gate can see it.
        projection.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1"))
        // The real failure of this turn.
        projection.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u3", message: "hi", turnId: "t3"))
        #expect(projection.messages.filter { $0.role == .user }.count == 1)
    }

    /// Same shape with a straggler turn.failed: it also raises a banner for a
    /// turn that is not the one running.
    @Test func aStragglerFailureBannersAndDisarms() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        evict(&projection)
        projection.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        // A foreign failure must not end this turn or banner it.
        #expect(projection.pending)
        #expect(!projection.failed)
        projection.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u3", message: "hi", turnId: "t3"))
        #expect(projection.messages.filter { $0.role == .user }.count == 1)
    }

    /// A rewound replay of the failed turn ITSELF loses the armed fold: the
    /// replayed turn.started wipes the carrier, the redelivered message early-
    /// returns before re-arming it, and the replayed failure arms nothing.
    @Test func aRewindOfTheFailedTurnLosesTheFold() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        projection.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        projection.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        evict(&projection)
        // The durable stream re-sends the same failed turn.
        projection.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        projection.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        projection.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        // The owner resends.
        projection.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        #expect(projection.messages.filter { $0.role == .user }.count == 1)
    }

    /// A replayed turn.started for an older turn hijacks currentTurnId: this
    /// turn's remaining events are then gated out and the reply is truncated.
    @Test func aStragglerTurnStartedHijacksTheGate() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        projection.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        projection.apply(EveEvent(type: "message.appended", id: "d2", messageDelta: "Hi", turnId: "t2"))
        evict(&projection)
        projection.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        projection.apply(EveEvent(type: "message.appended", id: "d3", messageDelta: " there", turnId: "t2"))
        let last = projection.messages.last
        #expect(last?.role == .assistant)
        #expect(last?.text == "Hi there")
    }

    /// The id-less fold leaves the marker armed; a zero-work successful turn
    /// then leaves it armed still, and a genuine second same-text message is
    /// folded away.
    @Test func anIdlessFoldLeavesAStaleMarker() {
        var projection = StreamProjection()
        projection.apply(EveEvent(type: "message.received", id: "u1", message: "hi"))
        projection.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error"))
        // Resend arrives with no event id: the fold fires but the marker stays.
        projection.apply(EveEvent(type: "message.received", message: "hi"))
        // The turn completes with no journaled work at all.
        projection.apply(EveEvent(type: "turn.completed", id: "c1"))
        // eve kept that message; a third "hi" is a genuine second question.
        projection.apply(EveEvent(type: "message.received", id: "u3", message: "hi"))
        #expect(projection.messages.filter { $0.role == .user }.count == 2)
    }
}

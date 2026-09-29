import Testing
@testable import UsefulBotCore

/// A turn's boundary events arriving late, twice, or after the next turn has
/// begun: the orderings the per-turn record exists for.
@Suite struct EveStreamOrderingTests {

    private func evict(_ projection: inout StreamProjection) {
        for index in 0..<2_100 {
            projection.apply(EveEvent(type: "heartbeat", id: "noise-\(index)"))
        }
    }

    /// Send 1's stream drops mid-turn, so `turn.failed(t1)` sits in the
    /// journal undelivered. The owner resends immediately; send 2's armed
    /// stream applies `u2` while the follower is still catching up (it defers
    /// while a send is pending). When `turn.failed(t1)` finally arrives, turn
    /// 2 is the live one, so it must not banner; but eve threw turn 1's
    /// message away, so its row goes rather than standing over the retry.
    @Test func aResendBeforeTheLateFailureLandsKeepsTheDuplicate() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local",
            message: "hi"
        ), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // Send 1's stream drops mid-turn; eve fails t1 server-side and the
        // owner resends before the follower delivers t1's failure.
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local2",
            message: "hi"
        ), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        // The follower's catch-up now delivers t1's failure.
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"), live: true)
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }

    /// A replayed `turn.started` for the turn CURRENTLY in flight names this
    /// turn, so the gate lets it through. Taken as a fresh start it wiped the
    /// carrier bookkeeping; the paired `message.received` early-returns
    /// through `indexById` before it could re-arm, so the turn's real
    /// failure could no longer fold its retry.
    @Test func aRewindOfTheTurnInFlightDisarmsTheFold() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        evict(&p)
        // The follower rewinds and re-sends this same turn's opening.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        // The turn then fails for real.
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        p.apply(EveEvent(type: "turn.started", id: "s2", turnId: "t2"))
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"))
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }

    /// The common case of the same defect, no eviction needed: a send's armed
    /// stream drops `turn.started` by design, so the follower's catch-up
    /// applies it for the FIRST time while the send's turn is still in flight.
    /// The send stream then dies mid-turn ("The reply could not be read") and
    /// eve fails the turn. If the late `turn.started` wiped the carrier claim,
    /// the retry stacked a second row: the exact bug this change exists to fix.
    @Test func anInterruptedSendsLateTurnStartedDisarmsTheFold() {
        var p = StreamProjection()
        // Live send: beginTurn + optimistic row, then the echo. The armed
        // stream never carries turn.started.
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local",
            message: "hi"
        ), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // The send's stream drops mid-turn. The follower, reading the journal
        // from its own cursor, meets turn.started for the first time, inside
        // the turn that is still running.
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"), live: true)
        // u1's echo is deduped by the seen cache before the carrier can re-arm.
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"), live: true)
        // eve then fails the turn for real.
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"), live: true)
        // The owner resends.
        p.beginTurn()
        p.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)local2",
            message: "hi"
        ), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2"), live: true)
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }

    /// Between turns nothing is in flight, so a straggler `turn.started` of
    /// an old turn passed the gate in full and cleared `failed`: the banner
    /// of the turn that actually failed was silently dropped. A turn that is
    /// over does not start again.
    @Test func aBetweenTurnsStragglerWipesTheFailureBanner() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0"))
        p.apply(EveEvent(type: "message.received", id: "u0", message: "earlier", turnId: "t0"))
        p.apply(EveEvent(type: "message.completed", id: "a0", message: "Done", turnId: "t0"))
        p.apply(EveEvent(type: "turn.completed", id: "c0", turnId: "t0"))
        p.apply(EveEvent(type: "turn.started", id: "s1", turnId: "t1"))
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1"))
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1"))
        #expect(p.failed)
        evict(&p)
        // A rewind re-sends the OLD successful turn's opening while nothing is
        // in flight.
        p.apply(EveEvent(type: "turn.started", id: "s0", turnId: "t0"))
        #expect(p.failed)
    }
}

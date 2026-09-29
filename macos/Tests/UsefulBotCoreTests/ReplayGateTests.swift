import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ReplayGateTests {
    private func durableEvent(_ id: String, kind: String, at: String? = nil) throws -> AgentEvent {
        let stamp = at.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"\#(id)","at":\#(stamp),"kind":"\#(kind)","text":"t","targetBotIds":[]}"#
        return try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    private func streamed(_ type: String, id: String? = nil, at: String? = nil) -> EveEvent {
        EveEvent(type: type, id: id, metaAt: at)
    }

    @Test func aStoreWithNoSessionRowsIsLiveFromTheFirstEvent() throws {
        let durable = ReplayGate.Durable(events: [try durableEvent("n1", kind: "note")])
        #expect(durable.startsLive)
        #expect(ReplayGate.reachedLiveTail(durable: durable, event: streamed("message.received", id: "u1")))
    }

    @Test func theDurableTailIsTheNewestUserOrAssistantRow() throws {
        let durable = ReplayGate.Durable(events: [
            try durableEvent("u1", kind: "user"),
            try durableEvent("a1", kind: "assistant", at: "2026-09-14T10:00:00.000Z"),
            try durableEvent("p1", kind: "post", at: "2026-09-14T11:00:00.000Z"),
        ])
        #expect(durable.tailId == "a1")
        #expect(durable.tailAt == TranscriptBlocks.date(fromISO8601: "2026-09-14T10:00:00.000Z"))
    }

    @Test func replayingTheDurableTailIdEndsTheReplay() throws {
        let durable = ReplayGate.Durable(events: [try durableEvent("a1", kind: "assistant")])
        #expect(!durable.startsLive)
        #expect(ReplayGate.reachedLiveTail(durable: durable, event: streamed("message.completed", id: "a1")))
    }

    @Test func aStampAtOrAfterTheTailEndsTheReplay() throws {
        let durable = ReplayGate.Durable(events: [
            try durableEvent("a1", kind: "assistant", at: "2026-09-14T10:00:00.000Z"),
        ])
        #expect(ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u9", at: "2026-09-14T10:00:00.000Z")
        ))
        #expect(ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u9", at: "2026-09-14T10:00:01.000Z")
        ))
        #expect(!ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u0", at: "2026-09-14T09:59:59.000Z")
        ))
    }

    @Test func aStampedReplayOfAnUnstampedStoreStaysAReplay() throws {
        // An old store writes no `at`, while the server stamps the whole
        // replayed history: the first stamped event is still old history.
        let durable = ReplayGate.Durable(events: [
            try durableEvent("u1", kind: "user"),
            try durableEvent("a1", kind: "assistant"),
        ])
        #expect(!durable.hasStamps)
        #expect(!ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u1", at: "2026-09-14T10:00:00.000Z")
        ))
        // Delta chunks and tool results carry ids no store ever holds, so they
        // can never stand in for novelty either.
        #expect(!ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.appended", id: "chunk-1", at: "2026-09-14T10:00:00.000Z")
        ))
        #expect(!ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("action.result", id: "act-1", at: "2026-09-14T10:00:00.000Z")
        ))
    }

    @Test func anIdTheUnstampedStoreNeverWroteEndsTheReplay() throws {
        let durable = ReplayGate.Durable(events: [
            try durableEvent("u1", kind: "user"),
            try durableEvent("a1", kind: "assistant"),
        ])
        #expect(ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u2", at: "2026-09-14T10:00:00.000Z")
        ))
        #expect(ReplayGate.reachedLiveTail(durable: durable, event: streamed("message.completed", id: "a2")))
    }

    @Test func aStampedStoreDecidesOnTimeAlone() throws {
        // The tail itself is unstamped but the store stamps rows, so the time
        // arm is the one that can move: only the tail id can end this replay.
        let durable = ReplayGate.Durable(events: [
            try durableEvent("u1", kind: "user", at: "2026-09-14T10:00:00.000Z"),
            try durableEvent("a1", kind: "assistant"),
        ])
        #expect(durable.hasStamps)
        #expect(durable.tailAt == nil)
        #expect(!ReplayGate.reachedLiveTail(
            durable: durable,
            event: streamed("message.received", id: "u2", at: "2026-09-14T11:00:00.000Z")
        ))
        #expect(ReplayGate.reachedLiveTail(durable: durable, event: streamed("message.completed", id: "a1")))
    }
}

/// Coming back to a chat that had finished flashed a working row for a beat.
/// `StreamProjection.pending` is true for the tail of every replayed turn,
/// between its last reply and the `turn.completed` after it, so the reload read
/// settled history as a turn in flight.
@Suite struct LiveTurnTests {
    private func event(_ type: String, id: String = "e") -> EveEvent {
        EveEvent(type: type, id: id)
    }

    @Test func replayingAFinishedTurnIsNotWork() {
        var live = ReplayGate.LiveTurn()
        // History, before the replay catches up: none of it is running.
        live.apply(event("message.received", id: "u1"), atLiveTail: false)
        #expect(!live.running)
        live.apply(event("message.appended", id: "d1"), atLiveTail: false)
        #expect(!live.running)
        // The tail itself opens the gate, and what follows is the same
        // finished turn ending. That stretch is the flash.
        live.apply(event("message.completed", id: "a1"), atLiveTail: true)
        #expect(!live.running)
        live.apply(event("turn.completed", id: "t1"), atLiveTail: true)
        #expect(!live.running)
    }

    @Test func aTurnThatBeginsAfterTheTailIsWork() {
        var live = ReplayGate.LiveTurn()
        live.apply(event("message.completed", id: "a1"), atLiveTail: true)
        #expect(!live.running)
        // A handoff or a routine started while the owner was in another chat.
        live.apply(event("turn.started", id: "t2"), atLiveTail: true)
        #expect(live.running)
        live.apply(event("message.appended", id: "d2"), atLiveTail: true)
        #expect(live.running)
        live.apply(event("turn.completed", id: "t2-end"), atLiveTail: true)
        #expect(!live.running)
    }

    @Test func aFreshChatsFirstTurnIsWork() {
        // No durable rows at all, so the gate is open from the first event.
        var live = ReplayGate.LiveTurn()
        live.apply(event("message.received", id: "u1"), atLiveTail: true)
        #expect(live.running)
    }

    @Test func everyWayATurnEndsStopsTheRow() {
        for ending in ["turn.completed", "turn.cancelled", "turn.failed",
                       "session.completed", "session.failed", "session.waiting"] {
            var live = ReplayGate.LiveTurn()
            live.apply(event("message.received", id: "u1"), atLiveTail: true)
            #expect(live.running, "\(ending) setup")
            live.apply(event(ending, id: "end"), atLiveTail: true)
            #expect(!live.running, "\(ending) should stop the working row")
        }
    }

    @Test func aParkedSessionDoesNotReadAsWork() {
        // eve writes a session's terminal event after this read sometimes, so
        // the replay can simply run out. That is not a turn in flight.
        var live = ReplayGate.LiveTurn()
        live.apply(event("message.received", id: "u1"), atLiveTail: false)
        live.apply(event("message.completed", id: "a1"), atLiveTail: true)
        #expect(!live.running)
    }

    @Test func aNovelStartProvesTheTurnIsNowWithoutWaitingForAPause() {
        // The durable store holds a row for every user and assistant message,
        // so an id it does not know arrived after the reload read the
        // transcript. A turn that streams straight out of the history burst
        // with no gap is still proved live by that.
        var live = ReplayGate.LiveTurn()
        live.apply(event("message.received", id: "u-new"), atLiveTail: true, novel: true)
        #expect(live.running)
        #expect(live.novelStart)
        live.apply(event("turn.completed", id: "t-end"), atLiveTail: true)
        #expect(!live.running)
        #expect(!live.novelStart)
    }

    @Test func aCardTurnsOwnUserRowIsNotNovel() {
        // A turn ending in a card leaves the durable tail on the owner's own
        // message, so the gate opens there and `running` goes true. That row is
        // already durable, so it is not novel, and the working row waits for
        // the burst to go quiet rather than flashing.
        var live = ReplayGate.LiveTurn()
        live.apply(event("message.received", id: "u-durable"), atLiveTail: true, novel: false)
        #expect(live.running)
        #expect(!live.novelStart)
    }

    @Test func noWorkingRowWhileTheReadIsStillInsideTheHistory() {
        // A chat whose rows live in the session: every id is novel, and that
        // alone used to read as a turn happening now.
        #expect(!ReplayGate.mayShowWorking(historyRemaining: 1200, drained: false, novelStart: true))
        #expect(!ReplayGate.mayShowWorking(historyRemaining: 1, drained: true, novelStart: true))
        // The last recorded event, and anything after it, is now.
        #expect(ReplayGate.mayShowWorking(historyRemaining: 0, drained: false, novelStart: false))
        #expect(ReplayGate.mayShowWorking(historyRemaining: -3, drained: false, novelStart: false))
        // A server that does not say keeps the older signals.
        #expect(ReplayGate.mayShowWorking(historyRemaining: nil, drained: true, novelStart: false))
        #expect(!ReplayGate.mayShowWorking(historyRemaining: nil, drained: false, novelStart: false))
    }
}

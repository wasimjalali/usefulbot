import Testing
@testable import UsefulBotCore

/// A resend folding into the optimistic row a dead send left behind.
@Suite struct EveStreamOrphanRowTests {

    /// send1 dies pre-echo leaving `local-a`; send2 resends the same text and
    /// its optimistic row folds into the orphan. The fold adopts the row but
    /// the live record never claimed it (`carriedUserMessageId` stays nil),
    /// so send2's own `turn.failed` has nothing to discard and arms no
    /// marker — send3 then stacks instead of folding.
    @Test func aFoldIntoADeadSendsOrphanLeavesTheResendUndiscardable() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-a", message: "hi"), live: true)
        // send1's stream dies before the echo. Owner resends the same text.
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-b", message: "hi"), live: true)
        // send2's echo folds into the orphan row; t2 then fails for real.
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 4), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f2", message: "upstream_protocol_error", turnId: "t2", index: 5), live: true)
        #expect(p.failed)
        // send3 resends. eve holds only u3: t1 never echoed (discarded or
        // never journaled a durable row), t2's message was discarded.
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-c", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u3", message: "hi", turnId: "t3", index: 7), live: true)
        for row in p.messages { print("ROW", row.id, row.role, row.text) }
        // Expectation: one user row (u3). Actual: [u2, u3] — u2 stands.
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }

    /// Control: the same failed-resend chain without the pre-echo death —
    /// marker arms on u2 and send3 folds. Confirms the claim drop is what
    /// breaks the first test, not something inherent in two failures.
    @Test func aPlainFailedResendStillFolds() {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 0), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error", turnId: "t1", index: 1), live: true)
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "local-b", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u2", message: "hi", turnId: "t2", index: 3), live: true)
        #expect(p.messages.filter { $0.role == .user }.count == 1)
    }
}

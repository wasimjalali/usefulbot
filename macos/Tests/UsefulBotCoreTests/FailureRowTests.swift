import Foundation
import Testing
@testable import UsefulBotCore

private let epoch = "e7a1c0de-0000-4000-8000-000000000001"

private func failureRow(turn: String, code: String = "upstream_unavailable", retryAfterMs: Int? = nil) -> ChatRow {
    var row = ChatRow(rowId: "\(turn):f", kind: .failure, turnId: turn, at: "2026-10-25T12:00:04.000Z")
    row.code = code
    row.detail = "The provider didn't answer."
    row.retryAfterMs = retryAfterMs
    return row
}

private func userRow(turn: String, text: String, clientId: String, queued: Bool = false) -> ChatRow {
    var row = ChatRow(rowId: "\(turn):u", kind: .user, turnId: turn, at: "2026-10-25T12:00:03.000Z", text: text)
    row.clientId = clientId
    row.queued = queued
    return row
}

private func assistantRow(turn: String, text: String) -> ChatRow {
    ChatRow(rowId: "\(turn):a0", kind: .assistant, turnId: turn, at: "2026-10-25T12:00:05.000Z", text: text)
}

private func loaded(_ rows: [ChatRow]) -> ChatProjection {
    var projection = ChatProjection()
    projection.load(RowsPage(rows: rows, tailSeq: 10, epoch: epoch))
    return projection
}

@Suite struct FailureRowTests {
    @Test func theNewestFailedTurnOffersRetryWithItsMessage() {
        let projection = loaded([
            userRow(turn: "t1", text: "Hello", clientId: "c1"),
            failureRow(turn: "t1"),
        ])
        #expect(projection.retryableFailureRowId == "t1:f")
        #expect(projection.retryTarget?.clientId == "c1")
        #expect(projection.retryTarget?.text == "Hello")
    }

    @Test func anOlderFailureIsOnlyTheRecord() {
        let projection = loaded([
            userRow(turn: "t1", text: "First", clientId: "c1"),
            failureRow(turn: "t1"),
            userRow(turn: "t2", text: "Second", clientId: "c2"),
            failureRow(turn: "t2"),
        ])
        #expect(projection.retryableFailureRowId == "t2:f")
        #expect(projection.retryTarget?.text == "Second")
    }

    @Test func aLaterAnswerEndsRetry() {
        let projection = loaded([
            userRow(turn: "t1", text: "First", clientId: "c1"),
            failureRow(turn: "t1"),
            userRow(turn: "t2", text: "Again", clientId: "c2"),
            assistantRow(turn: "t2", text: "Here you go."),
        ])
        #expect(projection.retryableFailureRowId == nil)
        #expect(projection.retryTarget == nil)
    }

    @Test func aMessageQueuedBehindTheFailureDoesNotHideRetry() {
        let projection = loaded([
            userRow(turn: "t1", text: "First", clientId: "c1"),
            failureRow(turn: "t1"),
            userRow(turn: "t2", text: "Next", clientId: "c2", queued: true),
        ])
        #expect(projection.retryableFailureRowId == "t1:f")
    }

    @Test func retryWaitsForAnIdleChat() {
        var projection = loaded([
            userRow(turn: "t1", text: "First", clientId: "c1"),
            failureRow(turn: "t1"),
        ])
        // A retry makes the stream ask for the rows again (the engine drops the failed attempt's rows).
        #expect(projection.apply(ChatEvent.parse(line: #"{"seq":11,"epoch":"\#(epoch)","chatId":"c","turnId":"t2","type":"turn.started","origin":"owner","clientId":"c1","retry":true}"#)!) == .resync)
        #expect(projection.retryableFailureRowId == "t1:f")
    }

    @Test func aFailureRowNeverCountsTheSecondsAfterTheMoment() {
        let projection = loaded([
            userRow(turn: "t1", text: "First", clientId: "c1"),
            failureRow(turn: "t1", code: "circuit_open", retryAfterMs: 21_500),
        ])
        let row = projection.transcript().first { $0.kind == .failure }
        #expect(row?.text == "The model provider failed repeatedly, so sending was paused.")
        // The live clock reads the failure's own cool-down.
        #expect(projection.rows.last?.failure.coolDownSeconds == 22)
    }

    @Test func aRowWithoutItsMessageHasNothingToRetry() {
        // The user row carries no client id.
        var user = userRow(turn: "t1", text: "Hello", clientId: "")
        user.clientId = nil
        let projection = loaded([user, failureRow(turn: "t1")])
        #expect(projection.retryableFailureRowId == "t1:f")
        #expect(projection.retryTarget == nil)
    }
}

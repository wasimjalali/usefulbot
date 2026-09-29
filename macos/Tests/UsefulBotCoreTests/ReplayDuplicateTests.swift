import Foundation
import Testing
@testable import UsefulBotCore

/// A session longer than the projection's id cache used to re-append the
/// messages it had forgotten, so the owner saw their own turn twice.
@Suite struct ReplayDuplicateTests {
    private func line(_ json: String) throws -> EveEvent {
        try #require(EveStream.parseLine(json))
    }

    /// One turn: the owner's message, a streamed reply, then enough reasoning
    /// deltas to push those ids out of a cache of any bounded size.
    private func turn(_ index: Int, filler: Int) throws -> [EveEvent] {
        var events: [EveEvent] = [
            try line("""
            {"type":"turn.started","meta":{"id":"evt-start-\(index)"},"data":{"turnId":"turn_\(index)"}}
            """),
            try line("""
            {"type":"message.received","meta":{"id":"evt-user-\(index)","at":"2026-09-17T07:0\(index):00.000Z"},"data":{"message":"Visuals only for now","turnId":"turn_\(index)"}}
            """),
        ]
        for chunk in 0..<3 {
            events.append(try line("""
            {"type":"message.appended","meta":{"id":"evt-delta-\(index)-\(chunk)"},"data":{"messageDelta":"part\(chunk) ","turnId":"turn_\(index)"}}
            """))
        }
        events.append(try line("""
        {"type":"message.completed","meta":{"id":"evt-reply-\(index)","at":"2026-09-17T07:0\(index):30.000Z"},"data":{"message":"Visuals only it is.","turnId":"turn_\(index)"}}
        """))
        for filler in 0..<filler {
            events.append(try line("""
            {"type":"reasoning.appended","meta":{"id":"evt-think-\(index)-\(filler)"},"data":{"turnId":"turn_\(index)"}}
            """))
        }
        events.append(try line("""
        {"type":"turn.completed","meta":{"id":"evt-end-\(index)"},"data":{"turnId":"turn_\(index)"}}
        """))
        return events
    }

    @Test func replayingALongSessionDoesNotDuplicateItsMessages() throws {
        // More filler than any bounded id cache keeps, so the replay below
        // cannot rely on the cache recognising the first turn.
        let events = try turn(1, filler: 2100) + turn(2, filler: 10)
        var projection = StreamProjection()
        for event in events { projection.apply(event, live: true) }
        let afterFirstPass = projection.messages
        #expect(afterFirstPass.count == 4)

        for event in events { projection.apply(event, live: true) }
        #expect(projection.messages.count == 4)
        #expect(projection.messages.map(\.id) == afterFirstPass.map(\.id))
        #expect(projection.messages.map(\.text) == afterFirstPass.map(\.text))
    }

    @Test func aReplayedReplyKeepsItsTextInsteadOfDoublingIt() throws {
        let events = try turn(1, filler: 0)
        var projection = StreamProjection()
        for event in events { projection.apply(event, live: true) }
        let reply = try #require(projection.messages.last)
        #expect(reply.text == "Visuals only it is.")

        // Only the deltas replay, without their completion: the text must not
        // grow by a second copy of the same stream.
        for event in events where event.type == "message.appended" {
            projection.apply(event, live: true)
        }
        #expect(projection.messages.count == 2)
        #expect(projection.messages.last?.text == "Visuals only it is.")
    }
}

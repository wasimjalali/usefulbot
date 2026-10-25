import Foundation
import Testing
@testable import UsefulBotCore

/// The chat protocol v1 fixtures (`test/fixtures/chat-protocol/`), which the
/// engine's own tests also assert. A change to their shape fails here too.
enum ChatFixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/fixtures/chat-protocol", isDirectory: true)

    /// The suite runs from the repo; a build that moved the sources has no fixtures to read.
    static var available: Bool {
        FileManager.default.fileExists(atPath: directory.appendingPathComponent("README.md").path)
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: data(name))
    }

    static func events(_ name: String) throws -> [ChatEvent] {
        let text = String(decoding: try data(name), as: UTF8.self)
        return try text.split(separator: "\n").map { line in
            guard let event = ChatEvent.parse(line: String(line)) else {
                throw FixtureError.unreadable(String(line.prefix(80)))
            }
            return event
        }
    }

    enum FixtureError: Error { case unreadable(String) }
}

@Suite(.enabled(if: ChatFixtures.available)) struct ChatProtocolDecodeTests {
    @Test func theNewestRowsPageDecodesEveryKind() throws {
        let page = try ChatFixtures.decode(RowsPage.self, "rows-page.json")
        let kinds = Set(page.rows.compactMap(\.kind))
        #expect(kinds == [.user, .assistant, .note, .failure, .question, .unsent, .image, .page, .widget, .card])
        #expect(page.tailSeq == 57)
        #expect(page.epoch == "e7a1c0de-0000-4000-8000-000000000001")
        #expect(page.nextBefore == "compaction:e-0042")
        #expect(page.running?.turnId == "7a1e0001-0000-4000-8000-00000000a003")
        #expect(page.running?.partialText == "Working on a shorter")
        #expect(page.running?.activity == .tool("web_search", detail: "Searching the web"))
        #expect(page.queued.map(\.text) == ["Then list three next steps"])
        #expect(page.openQuestion == nil)

        let user = try #require(page.rows.first { $0.kind == .user })
        #expect(user.clientId == "c1c1c1c1-0000-4000-8000-0000000000c1")
        #expect(user.attachments == [RowAttachment(name: "notes.txt", mediaType: "text/plain", size: 812)])
        let queued = try #require(page.rows.last)
        #expect(queued.kind == .user && queued.queued)
        let assistant = try #require(page.rows.first { $0.kind == .assistant })
        #expect(assistant.searchResults.count == 2)
        let failure = try #require(page.rows.first { $0.kind == .failure })
        #expect(failure.failure.code == "upstream_unavailable")
        #expect(failure.failure.retryAfterMs == 4000)
        let question = try #require(page.rows.first { $0.kind == .question }?.question)
        #expect(question.options.map(\.id) == ["desktop", "docs"])
        #expect(question.options[1].detail == "~/Documents/Reports")
        let image = try #require(page.rows.first { $0.kind == .image })
        #expect(image.imageId == "img-0001" && image.prompt == "A small robot reading a map")
        let page2 = try #require(page.rows.first { $0.kind == .page })
        #expect(page2.mediaId == "media-0001" && page2.title == "Pi notes")
        let widget = try #require(page.rows.first { $0.kind == .widget })
        #expect(widget.widgetId == "wdg-0001" && widget.callId == "call-excal-1")
        let card = try #require(page.rows.first { $0.kind == .card })
        #expect(card.proposalId == "prop-0001")
    }

    @Test func anOlderPageCarriesOnlyRowsAndTheCursor() throws {
        let page = try ChatFixtures.decode(RowsPage.self, "rows-page-older.json")
        #expect(page.rows.count == 2)
        #expect(page.tailSeq == nil && page.running == nil && page.queued.isEmpty)
        #expect(page.nextBefore == nil)
    }

    @Test func aRowOfAKindThisBuildDoesNotKnowIsKeptButNeverDrawn() throws {
        let json = #"{"rows":[{"rowId":"x:1","kind":"hologram","at":"2026-10-25T12:00:00.000Z"},{"rowId":"x:2","kind":"note","text":"hi","source":"system"}]}"#
        let page = try JSONDecoder().decode(RowsPage.self, from: Data(json.utf8))
        #expect(page.rows.map(\.kind) == [nil, .note])
        var projection = ChatProjection()
        projection.load(page)
        #expect(projection.transcript().map(\.id) == ["x:2"])
    }

    @Test func theListSearchAndStatusDecode() throws {
        let list = try ChatFixtures.decode(ChatsPage.self, "chats-list.json")
        #expect(list.current == "c4a7f00d-1111-4111-8111-111111111111")
        #expect(list.chats.map(\.routineId) == [nil, "r1"])
        #expect(list.chats[0].updatedAt == ChatClock.date(from: "2026-10-25T12:00:18.000Z"))
        #expect(list.nextBefore == nil)

        let hits = try ChatFixtures.decode(ChatSearchResponseForTest.self, "chats-search.json").hits
        #expect(hits.count == 1)
        #expect(hits[0].rowId.hasSuffix(":a0") && hits[0].snippet == "Here are two sources.")

        let status = try ChatFixtures.decode(EngineStatus.self, "engine-status.json")
        #expect(status.chats.count == 2)
        let first = status.chats[0]
        #expect(first.running?.activity == .tool("bash", detail: "Running a command"))
        #expect(first.waitingOnOwner == "approval")
        #expect(first.mark == .waiting)
        #expect(first.lastTurn?.failed == true)
        let second = status.chats[1]
        #expect(second.running == nil && second.replyReadySince != nil)
        #expect(second.mark == .replyReady)
    }

    @Test func everyEventFileDecodesLineByLine() throws {
        for name in ["events-turn", "events-failure", "events-queue", "events-compaction", "events-resync", "events-routine"] {
            let events = try ChatFixtures.events("\(name).ndjson")
            #expect(!events.isEmpty, "\(name)")
            #expect(events.first?.type == "stream.ready", "\(name)")
        }
    }

    @Test func aMarkPriorityFollowsTheSpec() throws {
        let json = #"{"epoch":"e","chats":[{"chatId":"a","running":{"turnId":"t"},"replyReadySince":"2026-10-25T12:00:00.000Z","lastTurn":{"turnId":"t0","outcome":"failed"}},{"chatId":"b","lastTurn":{"turnId":"t1","outcome":"failed"},"replyReadySince":"2026-10-25T12:00:00.000Z"},{"chatId":"c","waitingOnOwner":"question","running":{"turnId":"t"}},{"chatId":"d","lastTurn":{"turnId":"t2","outcome":"completed"}}]}"#
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8))
        #expect(status.chats.map(\.mark) == [.working, .failed, .waiting, nil])
    }
}

private struct ChatSearchResponseForTest: Decodable {
    let hits: [ChatSearchHit]
}

import Foundation
import Testing
@testable import UsefulBotCore

/// A chat opened from its snapshot has to be the chat a replay from zero
/// would have built, and has to keep behaving like it as the session goes on.
@Suite struct ChatSnapshotTests {
    /// A settled first turn with a search and a finished reply. Every event is
    /// stamped, as eve stamps them, so no row takes the client clock.
    private static let firstTurn: [EveEvent] = [
        EveEvent(type: "session.started", id: "e0", metaAt: "2026-09-20T10:00:00.000Z"),
        EveEvent(type: "turn.started", id: "e1", metaAt: "2026-09-20T10:00:01.000Z", turnId: "turn_1"),
        EveEvent(type: "message.received", id: "e2", metaAt: "2026-09-20T10:00:01.100Z", message: "Find flights", turnId: "turn_1"),
        EveEvent(type: "reasoning.appended", id: "e3", metaAt: "2026-09-20T10:00:02.000Z", turnId: "turn_1", data: .object(["reasoningDelta": .string("Looking")])),
        EveEvent(
            type: "action.result",
            id: "e4",
            metaAt: "2026-09-20T10:00:02.500Z",
            turnId: "turn_1",
            data: .object([
                "toolName": .string("web_search"),
                "result": .object(["results": .array([
                    .object(["title": .string("Fares"), "url": .string("https://example.com"), "snippet": .string("Cheap")]),
                ])]),
            ])
        ),
        EveEvent(type: "message.appended", id: "e5", metaAt: "2026-09-20T10:00:03.000Z", messageDelta: "Two options", turnId: "turn_1"),
        EveEvent(type: "message.appended", id: "e6", metaAt: "2026-09-20T10:00:03.100Z", messageDelta: " found.", turnId: "turn_1"),
        EveEvent(type: "message.completed", id: "e7", metaAt: "2026-09-20T10:00:04.000Z", message: "Two options found.", turnId: "turn_1"),
        EveEvent(type: "turn.completed", id: "e8", metaAt: "2026-09-20T10:00:04.100Z", turnId: "turn_1"),
        EveEvent(type: "session.waiting", id: "e9", metaAt: "2026-09-20T10:00:04.200Z"),
    ]

    /// What the session gains after the snapshot: a second turn.
    private static let secondTurn: [EveEvent] = [
        EveEvent(type: "turn.started", id: "f1", metaAt: "2026-09-20T11:00:00.000Z", turnId: "turn_2"),
        EveEvent(type: "message.received", id: "f2", metaAt: "2026-09-20T11:00:00.100Z", message: "Book the first", turnId: "turn_2"),
        EveEvent(type: "message.appended", id: "f3", metaAt: "2026-09-20T11:00:01.000Z", messageDelta: "Booked", turnId: "turn_2"),
        EveEvent(type: "message.completed", id: "f4", metaAt: "2026-09-20T11:00:02.000Z", message: "Booked.", turnId: "turn_2"),
        EveEvent(type: "turn.completed", id: "f5", metaAt: "2026-09-20T11:00:02.100Z", turnId: "turn_2"),
        EveEvent(type: "session.waiting", id: "f6", metaAt: "2026-09-20T11:00:02.200Z"),
    ]

    /// Applies events at their session positions, starting at `from`.
    private static func project(
        _ events: [EveEvent],
        from: Int = 0,
        onto start: StreamProjection = StreamProjection()
    ) -> StreamProjection {
        var projection = start
        for (offset, event) in events.enumerated() {
            var event = event
            event.index = from + offset
            event.sessionId = "wrun_1"
            projection.apply(event, live: true)
        }
        return projection
    }

    private static func roundTrip(_ projection: StreamProjection) throws -> StreamProjection {
        try JSONDecoder().decode(StreamProjection.self, from: JSONEncoder().encode(projection))
    }

    @Test func aDecodedProjectionIsTheOneThatWasSaved() throws {
        let saved = Self.project(Self.firstTurn)
        #expect(!saved.messages.isEmpty)
        #expect(try Self.roundTrip(saved) == saved)
    }

    /// The point of the snapshot: reading on from it lands exactly where
    /// reading the whole session would have, private state included.
    @Test func resumingFromASnapshotMatchesAReplayFromZero() throws {
        let saved = Self.project(Self.firstTurn)
        let resumed = Self.project(Self.secondTurn, from: Self.firstTurn.count, onto: try Self.roundTrip(saved))
        let replayed = Self.project(Self.secondTurn, from: Self.firstTurn.count, onto: saved)
        #expect(resumed == replayed)
        #expect(resumed.messages.map(\.text) == ["Find flights", "Two options found.", "Book the first", "Booked."])
        #expect(!resumed.pending)
    }

    /// The id dedupe survives the trip, so events a resume meets again (a
    /// cursor that sat before a local send's turn) change nothing.
    @Test func eventsSeenBeforeTheSnapshotAreStillRecognised() throws {
        let saved = Self.project(Self.firstTurn)
        let again = Self.project(
            Array(Self.firstTurn.suffix(4)),
            from: Self.firstTurn.count - 4,
            onto: try Self.roundTrip(saved)
        )
        #expect(again.messages == saved.messages)
    }

    /// Every stored property of the projection is in the snapshot, so a new
    /// one changes what an old file means. This list failing is the reminder
    /// to bump `ChatSnapshot.formatVersion` and then update it.
    @Test func theStoredShapeIsPinnedToTheFormatVersion() {
        #expect(ChatSnapshot.formatVersion == 4)
        let stored = Mirror(reflecting: StreamProjection()).children.compactMap(\.label).sorted()
        #expect(stored == [
            "activity", "continuationRowId", "currentTurnId", "discardedUserMessageId", "failed", "failure", "failureMarks", "firstSession",
            "indexById", "journalBase", "journalSession", "journalTop", "liveFailureMarkId", "messages", "minted", "newestTurnStart",
            "pending", "questions", "rowJournal", "runningTasks", "searchHits", "seen", "seenCursor", "seenOrder",
            "settledTasks", "taskReplyRowIds", "tasksSession", "turn", "turnOrder", "turnStartedAt", "turns", "widgets",
        ])
    }

    /// The same for every type stored inside the projection: an optional
    /// field added to one of these would decode from an old file as nil with
    /// no error, so it has to bump the version too.
    @Test func theNestedStoredShapesArePinnedToTheFormatVersion() throws {
        func labels(_ value: Any) -> [String] {
            Mirror(reflecting: value).children.compactMap(\.label).sorted()
        }
        #expect(ChatSnapshot.formatVersion == 4)
        let turn = try #require(Mirror(reflecting: StreamProjection()).children.first { $0.label == "turn" }?.value)
        #expect(labels(turn) == [
            "assistantId", "carriedUserMessageId", "ended", "fromTask", "lastRowId", "openUserRows",
            "producedWork", "replayingMessage", "sawMessage", "superseded", "taskReplyMarked",
        ])
        #expect(labels(ChatMessage(id: "m", role: .user, text: "t")) == ["at", "id", "role", "text"])
        #expect(labels(SearchChip(title: "t", url: "u", snippet: "s")) == ["snippet", "title", "url"])
        #expect(labels(TurnFailure(code: "c", detail: "d")) == ["code", "detail"])
        #expect(labels(FailureMark(id: "f", anchorId: nil, failure: TurnFailure(code: "c", detail: "d"), at: nil))
            == ["anchorId", "at", "failure", "id"])
        #expect(labels(LiveWidget(id: "w", connectionId: "c", toolName: "t", arguments: [:], callId: "k"))
            == ["arguments", "callId", "connectionId", "id", "toolName"])
        #expect(labels(OwnerQuestion(id: "q", prompt: "p", options: [], allowFreeform: true))
            == ["allowFreeform", "id", "options", "prompt"])
        #expect(labels(OwnerQuestion.Option(id: "o", label: "l", detail: "d")) == ["detail", "id", "label"])
        // An enum's payloads are its stored shape.
        let tool = try #require(Mirror(reflecting: TurnActivity.tool("bash", detail: "ls")).children.first?.value)
        #expect(Mirror(reflecting: tool).children.map { $0.label ?? "" } == [".0", "detail"])
    }

    @Test func aJSONValueEncodesToWhatItWasReadFrom() throws {
        let value = JSONValue.object([
            "a": .array([.number(1.5), .bool(true), .null, .string("x")]),
            "b": .object(["c": .string("d")]),
        ])
        #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) == value)
    }

    // MARK: - Store

    private static func tempStore() -> ChatSnapshotStore {
        ChatSnapshotStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-snapshots-\(UUID().uuidString)", isDirectory: true))
    }

    private static func snapshot(bot: String = "bot_1", session: String = "wrun_1") -> ChatSnapshot {
        ChatSnapshot(
            botId: bot,
            sessionId: session,
            cursor: firstTurn.count,
            lastEventId: firstTurn.last?.id,
            projection: project(firstTurn),
            durableEvents: [],
            seenTurnIds: ["turn_1"],
            localTurnIds: []
        )
    }

    @Test func aSavedSnapshotLoadsBackForItsOwnSessionOnly() throws {
        let store = Self.tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let saved = Self.snapshot()
        try store.save(saved)
        #expect(store.load(botId: "bot_1", sessionId: "wrun_1") == saved)
        // The bot's pointer moved to a new chat: the old rows are not it.
        #expect(store.load(botId: "bot_1", sessionId: "wrun_2") == nil)
        #expect(store.load(botId: "bot_2", sessionId: "wrun_1") == nil)
        #expect(store.load(botId: "bot_1", sessionId: "") == nil)
    }

    @Test func theFileIsOwnerOnlyAndReplacedWhole() throws {
        let store = Self.tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try store.save(Self.snapshot())
        var newer = Self.snapshot()
        newer.cursor += 5
        try store.save(newer)
        #expect(store.load(botId: "bot_1", sessionId: "wrun_1")?.cursor == newer.cursor)
        let url = store.fileURL(botId: "bot_1")
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
        // No temp file is left behind by the swap.
        let names = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        #expect(names == ["bot_1.json"])
    }

    @Test func anotherFormatOrAnUnreadableFileIsNoSnapshot() throws {
        let store = Self.tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        var old = Self.snapshot()
        old.version = ChatSnapshot.formatVersion + 1
        try store.save(old)
        #expect(store.load(botId: "bot_1", sessionId: "wrun_1") == nil)
        try store.save(Data("{not json".utf8), botId: "bot_1")
        #expect(store.load(botId: "bot_1", sessionId: "wrun_1") == nil)
    }

    /// A file whose bookkeeping points past its rows would crash the first
    /// fold that indexes by it; it is refused instead, and the chat replays.
    @Test func aDamagedProjectionIsNoSnapshot() throws {
        let saved = Self.snapshot()
        #expect(saved.projection.isConsistent)
        var object = try #require(try JSONSerialization.jsonObject(with: ChatSnapshotStore.encode(saved)) as? [String: Any])
        var projection = try #require(object["projection"] as? [String: Any])
        var indexById = try #require(projection["indexById"] as? [String: Any])
        indexById["e2"] = 999
        projection["indexById"] = indexById
        object["projection"] = projection
        let damaged = try JSONSerialization.data(withJSONObject: object)
        #expect(ChatSnapshotStore.decode(damaged, botId: "bot_1", sessionId: "wrun_1") == nil)
        #expect(ChatSnapshotStore.decode(try ChatSnapshotStore.encode(saved), botId: "bot_1", sessionId: "wrun_1") == saved)
    }

    /// A session left on a turn still open is skipped only while nothing new
    /// has been recorded in it: the turn ending moves its newest event.
    @Test func aSessionNotedUnbuildableIsSkippedUntilItMovesOn() throws {
        let store = Self.tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        #expect(!store.isMarkedUnbuildable(botId: "bot_1", sessionId: "wrun_1", newestEventId: "evt_5"))
        try store.markUnbuildable(botId: "bot_1", sessionId: "wrun_1", newestEventId: "evt_5")
        #expect(store.isMarkedUnbuildable(botId: "bot_1", sessionId: "wrun_1", newestEventId: "evt_5"))
        #expect(!store.isMarkedUnbuildable(botId: "bot_1", sessionId: "wrun_1", newestEventId: "evt_6"))
        #expect(!store.isMarkedUnbuildable(botId: "bot_1", sessionId: "wrun_2", newestEventId: "evt_5"))
        store.remove(botId: "bot_1")
        #expect(!store.isMarkedUnbuildable(botId: "bot_1", sessionId: "wrun_1", newestEventId: "evt_5"))
    }

    /// Chats deleted while the app was closed leave no file behind.
    @Test func pruningKeepsOnlyTheBotsThatExist() throws {
        let store = Self.tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try store.save(Self.snapshot(bot: "bot_1"))
        try store.save(Self.snapshot(bot: "bot_2"))
        try store.markUnbuildable(botId: "bot_2", sessionId: "wrun_1", newestEventId: "evt_1")
        try store.markUnbuildable(botId: "bot_3", sessionId: "wrun_1", newestEventId: "evt_1")
        store.prune(keeping: ["bot_1"])
        let names = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        #expect(names == ["bot_1.json"])
    }

    /// Another build's fold logic may differ, and a week is as long as any
    /// snapshot goes without being replayed from zero.
    @Test func aSnapshotIsTrustedOnlyByItsOwnBuildAndForAWeek() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chat-snapshots-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let this = ChatSnapshotStore(directory: dir, build: "b1")
        try this.save(Self.snapshot())
        #expect(this.load(botId: "bot_1", sessionId: "wrun_1")?.build == "b1")
        #expect(ChatSnapshotStore(directory: dir, build: "b2").load(botId: "bot_1", sessionId: "wrun_1") == nil)
        let data = try Data(contentsOf: this.fileURL(botId: "bot_1"))
        let later = Date().addingTimeInterval(8 * 24 * 3600)
        #expect(ChatSnapshotStore.decode(data, botId: "bot_1", sessionId: "wrun_1", build: "b1", maxAge: this.maxAge, now: later) == nil)
    }

    @Test func aBotIdIsNeverUsedAsAPathUnchecked() {
        let store = Self.tempStore()
        #expect(store.fileURL(botId: "bot_01M2-x").lastPathComponent == "bot_01M2-x.json")
        let odd = store.fileURL(botId: "../../etc/passwd")
        #expect(odd.deletingLastPathComponent() == store.directory)
        #expect(!odd.lastPathComponent.contains("/"))
        #expect(odd.lastPathComponent.hasPrefix("x"))
    }
}

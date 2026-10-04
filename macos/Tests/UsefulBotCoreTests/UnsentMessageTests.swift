import Foundation
import Testing
@testable import UsefulBotCore

/// A send refused before eve took the turn leaves a failed bubble: the text
/// lives there, not back in the composer. These pin where that bubble goes,
/// that it outlives a rebuild and a relaunch, and what Retry and Edit do.
@Suite struct UnsentMessageTests {
    private func item(
        _ id: String = "m1",
        message: String = "hello",
        anchor: String? = "a1",
        files: [UsefulBotCore.Attachment] = [],
        at: Date = Date(timeIntervalSince1970: 1_000)
    ) -> UnsentMessage {
        UnsentMessage(
            id: id, message: message, echo: message, draft: message, files: files,
            reason: "The local server refused it.", at: at, anchorId: anchor
        )
    }

    private func replay() -> StreamProjection {
        var p = StreamProjection()
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"))
        p.apply(EveEvent(type: "message.completed", id: "a1", message: "Hello", turnId: "t1", index: 2, sessionId: "s"))
        p.apply(EveEvent(type: "turn.completed", id: "c1", turnId: "t1", index: 3, sessionId: "s"))
        return p
    }

    private func rows(_ p: StreamProjection, _ unsent: [UnsentMessage]) -> [String] {
        Transcript.merge(events: [], messages: p.messages, failures: p.failureMarks, unsent: unsent)
            .map { "\($0.kind.rawValue):\($0.id)" }
    }

    // MARK: placement

    /// One refused send is one user bubble and one failed line, under its
    /// anchor, with the reason in plain words.
    @Test func aRefusalIsOneBubbleAndOneLineUnderItsAnchor() {
        let merged = Transcript.merge(events: [], messages: replay().messages, unsent: [item()])
        #expect(merged.map { "\($0.kind.rawValue):\($0.id)" } == [
            "user:u1", "assistant:a1", "user:unsent-m1", "unsent:unsent-line-m1",
        ])
        #expect(merged[2].text == "hello")
        #expect(merged[3].text == "Not sent. The local server refused it.")
    }

    /// A reload replays the session into a fresh projection. The failed
    /// bubble was never stored by eve, so it has to come from the ledger and
    /// land in the same place.
    @Test func theMarkSurvivesATranscriptRebuild() {
        let before = rows(replay(), [item()])
        let after = rows(replay(), [item()])
        #expect(before == after)
        #expect(after.filter { $0 == "user:unsent-m1" }.count == 1)
    }

    /// An anchor the transcript no longer has puts the bubble at the end.
    @Test func aMissingAnchorPutsItAtTheEnd() {
        let got = rows(replay(), [item(anchor: "gone")])
        #expect(got.suffix(2) == ["user:unsent-m1", "unsent:unsent-line-m1"])
        #expect(got.count == 4)
        #expect(rows(replay(), [item(anchor: nil)]).suffix(2) == ["user:unsent-m1", "unsent:unsent-line-m1"])
    }

    /// Two refusals under one anchor keep the order they were sent in.
    @Test func severalUnderOneAnchorKeepTheirOrder() {
        let got = rows(replay(), [item("m1", message: "one"), item("m2", message: "two")])
        #expect(got == [
            "user:u1", "assistant:a1",
            "user:unsent-m1", "unsent:unsent-line-m1", "user:unsent-m2", "unsent:unsent-line-m2",
        ])
    }

    /// A turn that started and failed is the existing failure row, never a
    /// "Not sent" mark.
    @Test func aTurnThatStartedAndFailedKeepsItsFailureRow() {
        var p = StreamProjection()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "\(EveStream.optimisticUserPrefix)x", message: "hi"), live: true)
        p.apply(EveEvent(type: "message.received", id: "u1", message: "hi", turnId: "t1", index: 1, sessionId: "s"), live: true)
        p.apply(EveEvent(type: "turn.failed", id: "f1", message: "upstream_protocol_error (400 invalid_request_error)", turnId: "t1", index: 2, sessionId: "s"), live: true)
        let got = rows(p, [])
        #expect(got.contains("failure:failure-f1"))
        #expect(!got.contains { $0.hasPrefix("unsent:") })
    }

    // MARK: timestamp placement

    private func timed(_ id: String, _ kind: TranscriptRow.Kind, _ t: Double?) -> TranscriptRow {
        TranscriptRow(id: id, kind: kind, text: id, at: t.map { Date(timeIntervalSince1970: $0) })
    }

    private func ids(_ rows: [TranscriptRow]) -> [String] { rows.map(\.id) }

    /// A refusal in an empty chat has no anchor. When a good exchange lands
    /// later, the refusal stays before it, by time.
    @Test func aRefusalInAnEmptyChatStaysBeforeALaterExchange() {
        let later = [timed("u1", .user, 5_000), timed("a1", .assistant, 5_010)]
        let got = Transcript.placeUnsent([item(anchor: nil, at: Date(timeIntervalSince1970: 1_000))], in: later)
        #expect(ids(got) == ["unsent-m1", "unsent-line-m1", "u1", "a1"])
    }

    /// With no anchor, a refusal goes after the last row at or before it.
    @Test func aGoneAnchorFallsBackToTheTimeOrder() {
        let rows = [timed("u1", .user, 100), timed("a1", .assistant, 200), timed("u2", .user, 5_000)]
        let got = Transcript.placeUnsent([item(anchor: "gone", at: Date(timeIntervalSince1970: 1_000))], in: rows)
        #expect(ids(got) == ["u1", "a1", "unsent-m1", "unsent-line-m1", "u2"])
    }

    /// Rows with no times at all leave only the end.
    @Test func undatedRowsPutItAtTheEnd() {
        let rows = [timed("u1", .user, nil), timed("a1", .assistant, nil)]
        let got = Transcript.placeUnsent([item(anchor: nil)], in: rows)
        #expect(ids(got) == ["u1", "a1", "unsent-m1", "unsent-line-m1"])
    }

    /// Two time-placed refusals keep the order they were sent in.
    @Test func timePlacedRefusalsKeepTheirOrder() {
        let rows = [timed("u1", .user, 5_000)]
        let got = Transcript.placeUnsent([
            item("m1", anchor: nil, at: Date(timeIntervalSince1970: 1_000)),
            item("m2", anchor: nil, at: Date(timeIntervalSince1970: 2_000)),
        ], in: rows)
        #expect(ids(got) == ["unsent-m1", "unsent-line-m1", "unsent-m2", "unsent-line-m2", "u1"])
    }

    // MARK: retry bookkeeping, quote, caps

    /// A refusal on Retry changes the reason and keeps the one entry.
    @Test func replacingKeepsOneEntry() {
        var list = UnsentList()
        list.add(item("m1"))
        var again = item("m1")
        again.reason = "Couldn't reach the local server."
        list.replace(again)
        #expect(list.items.count == 1)
        #expect(list.items[0].reason == "Couldn't reach the local server.")
    }

    /// The reply quote rides with the message through the disk.
    @Test func theQuoteRoundTrips() throws {
        let store = tempStore()
        var original = item("m1")
        original.quote = UnsentQuote(botId: "bot1", text: "an earlier reply", author: "Ada")
        try store.save([original], botId: "bot1")
        #expect(store.load(botId: "bot1")[0].quote == UnsentQuote(botId: "bot1", text: "an earlier reply", author: "Ada"))
        // Files saved before the field existed still load.
        #expect(store.load(botId: "bot2").isEmpty)
    }

    /// The file keeps the newest 20, and no bytes or file bodies reach it.
    @Test func theStoreCapsTheListAndDropsBodies() throws {
        let store = tempStore()
        let doc = UsefulBotCore.Attachment(id: "f2", name: "notes.txt", bytes: 5, text: "secret body")
        let picture = UsefulBotCore.Attachment(id: "f1", name: "c.png", bytes: 9, text: nil, mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA")
        let many = (0..<25).map { item("m\($0)", files: $0 == 24 ? [doc, picture] : []) }
        try store.save(many, botId: "bot1")
        let loaded = store.load(botId: "bot1")
        #expect(loaded.count == UnsentList.cap)
        #expect(loaded.first?.id == "m5")
        #expect(loaded.last?.files[0].text == nil)
        #expect(loaded.last?.files[0].mediaType == nil)
        #expect(loaded.last?.files[1].dataUrl == nil)
        #expect(loaded.last?.files[1].mediaType == "image/png")
        var list = UnsentList()
        for message in many { list.add(message) }
        #expect(list.items.count == UnsentList.cap)
    }

    /// What a held file needs before a resend or an Edit.
    @Test func heldFilesSayWhatTheyNeed() {
        let live = UsefulBotCore.Attachment(id: "f1", name: "c.png", bytes: 9, text: nil, mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA")
        let reloadedImage = UsefulBotCore.Attachment(id: "f1", name: "c.png", bytes: 9, text: nil, mediaType: "image/png", dataUrl: nil)
        let liveDoc = UsefulBotCore.Attachment(id: "f2", name: "n.txt", bytes: 5, text: "x")
        let reloadedDoc = UsefulBotCore.Attachment(id: "f2", name: "n.txt", bytes: 5, text: nil)
        #expect(UnsentMessage.heldState(of: live) == .ready)
        #expect(UnsentMessage.heldState(of: reloadedImage) == .restoreImage)
        #expect(UnsentMessage.heldState(of: liveDoc) == .ready)
        #expect(UnsentMessage.heldState(of: reloadedDoc) == .attachAgain)
    }

    // MARK: ledger

    /// Retry takes the one message out, so the next send is the only copy.
    @Test func retryLeavesExactlyOneCopy() {
        var list = UnsentList()
        list.add(item())
        let sent = list.item("m1")
        #expect(sent?.message == "hello")
        list.remove("m1")
        #expect(list.items.isEmpty)
        // The retried send shows as its own optimistic row, once.
        var p = replay()
        p.beginTurn()
        p.apply(EveEvent(type: "message.received", id: "\(EveStream.optimisticUserPrefix)y", message: "hello"), live: true)
        let got = Transcript.merge(events: [], messages: p.messages, unsent: list.items)
        #expect(got.filter { $0.text == "hello" }.count == 1)
        #expect(!got.contains { $0.kind == .unsent })
    }

    /// Edit fills an empty composer and takes the message out of the ledger.
    @Test func editFillsAnEmptyComposer() {
        var list = UnsentList()
        list.add(item())
        #expect(UnsentMessage.canEdit(draft: "  \n", attachmentCount: 0))
        let taken = list.edit("m1", draft: "", attachmentCount: 0)
        #expect(taken?.draft == "hello")
        #expect(list.items.isEmpty)
    }

    /// With text or files already in the composer Edit is refused and nothing
    /// moves: pasting the old text in front would be the stacking this
    /// replaces.
    @Test func editIsRefusedWhenTheComposerHoldsSomething() {
        var list = UnsentList()
        list.add(item())
        #expect(list.edit("m1", draft: "typing", attachmentCount: 0) == nil)
        #expect(list.edit("m1", draft: "", attachmentCount: 1) == nil)
        #expect(list.items.count == 1)
        #expect(UnsentMessage.editBlockedHint == "Clear the composer to edit this message")
    }

    /// New Chat and delete wipe the bot's whole list.
    @Test func clearEmptiesTheList() {
        var list = UnsentList()
        list.add(item("m1"))
        list.add(item("m2"))
        list.clear()
        #expect(list.items.isEmpty)
    }

    // MARK: persistence

    private func tempStore() -> UnsentStore {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("unsent-\(UUID().uuidString)")
        return UnsentStore(directory: dir)
    }

    /// A relaunch reads back text, reason, time and anchor. Image bytes stay
    /// out of the file (the sent-image store holds them), but their names and
    /// types come back.
    @Test func theStoreRoundTrips() throws {
        let store = tempStore()
        let picture = UsefulBotCore.Attachment(id: "f1", name: "cat-ab12.png", bytes: 9, text: nil, mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA")
        let doc = UsefulBotCore.Attachment(id: "f2", name: "notes.txt", bytes: 5, text: "notes", mediaType: nil, dataUrl: nil)
        let original = item("m1", message: "look", anchor: "a1", files: [picture, doc])
        try store.save([original, item("m2")], botId: "bot1")
        let loaded = store.load(botId: "bot1")
        #expect(loaded.count == 2)
        #expect(loaded[0].message == "look")
        #expect(loaded[0].reason == original.reason)
        #expect(loaded[0].anchorId == "a1")
        #expect(loaded[0].at == original.at)
        #expect(loaded[0].files.map(\.name) == ["cat-ab12.png", "notes.txt"])
        #expect(loaded[0].files[0].dataUrl == nil)
        #expect(loaded[0].files[0].mediaType == "image/png")
        // A file body stays in memory only.
        #expect(loaded[0].files[1].text == nil)
        // Another bot's list is its own.
        #expect(store.load(botId: "bot2").isEmpty)
    }

    /// Saving an empty list removes the file, and clear drops it for good.
    @Test func clearingTheStoreForgetsTheBot() throws {
        let store = tempStore()
        try store.save([item()], botId: "bot1")
        try store.save([], botId: "bot1")
        #expect(store.load(botId: "bot1").isEmpty)
        try store.save([item()], botId: "bot1")
        store.clear(botId: "bot1")
        #expect(store.load(botId: "bot1").isEmpty)
    }

    /// A bot id with path pieces cannot reach outside the folder.
    @Test func aHostileBotIdStaysInsideTheFolder() throws {
        let store = tempStore()
        try store.save([item()], botId: "../../escape")
        #expect(store.load(botId: "../../escape").count == 1)
        #expect(!FileManager.default.fileExists(atPath: store.directory.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("escape.json").path))
    }

    // MARK: copy

    private func hasDigit(_ s: String) -> Bool { s.contains { $0.isNumber } }

    /// No send refusal reads as a bare status code.
    @Test func refusalReasonsHaveNoStatusNumbers() {
        for status in [400, 401, 403, 404, 500, 501, 418] {
            let reason = UnsentMessage.reason(for: BackendError.http(status))
            #expect(!hasDigit(reason), "status \(status): \(reason)")
        }
        #expect(UnsentMessage.reason(for: BackendError.http(403)) == "The local server refused it.")
        #expect(UnsentMessage.reason(for: BackendError.http(400)) == "The local server couldn't accept it.")
        #expect(UnsentMessage.reason(for: BackendError.http(401)) == "The local server rejected the device token.")
        #expect(UnsentMessage.reason(for: BackendError.http(500)) == "The local server couldn't take it right now.")
    }

    /// The statuses that already had their own words keep them.
    @Test func existingStatusCopyIsUnchanged() {
        #expect(UnsentMessage.reason(for: BackendError.http(409)) == "That request conflicted with one already in flight.")
        #expect(UnsentMessage.reason(for: BackendError.http(502)) == "The local server could not complete this request.")
        #expect(UnsentMessage.reason(for: BackendError.http(504)) == "The local server could not complete this request.")
        #expect(UnsentMessage.reason(for: BackendError.http(429)).hasPrefix("The router refused this"))
    }

    /// A server that never answered is said plainly, and the note and line
    /// do not claim the message is back in the composer.
    @Test func aDeadServerIsSaidPlainly() {
        let reason = UnsentMessage.reason(for: URLError(.cannotConnectToHost))
        #expect(reason == "Couldn't reach the local server.")
        let note = UnsentMessage.note(reason: reason)
        #expect(note == "Your message wasn't sent. Couldn't reach the local server.")
        #expect(!note.contains("composer"))
        #expect(item().line == "Not sent. The local server refused it.")
    }

    /// The row ids round-trip so the view can find its message.
    @Test func lineRowIdsMapBackToTheMessage() {
        let m = item("abc")
        #expect(UnsentMessage.id(fromLineRowId: m.lineRowId) == "abc")
        #expect(UnsentMessage.id(fromLineRowId: m.bubbleRowId) == nil)
        #expect(UnsentMessage.isUnsentRowId(m.bubbleRowId))
        #expect(UnsentMessage.isUnsentRowId(m.lineRowId))
        #expect(!UnsentMessage.isUnsentRowId("u1"))
    }
}

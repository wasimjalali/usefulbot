import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct TranscriptTests {
    private func projection(_ rows: [ChatRow]) -> ChatProjection {
        var projection = ChatProjection()
        projection.load(RowsPage(rows: rows, tailSeq: 1, epoch: "e1"))
        return projection
    }

    private func row(_ id: String, _ kind: ChatRow.Kind, _ text: String = "", at: String? = nil) -> ChatRow {
        ChatRow(rowId: id, kind: kind, turnId: nil, at: at, text: text)
    }

    @Test func everyKindBecomesItsTranscriptRowInOrder() {
        var page = row("page:m1", .page)
        page.title = "Q3 report"
        page.mediaId = "m1"
        var image = row("image:i1", .image)
        image.imageId = "i1"
        image.prompt = "A small robot"
        var widget = row("widget:call-1", .widget)
        widget.widgetId = "wdg-1"
        var card = row("card:p1", .card)
        card.proposalId = "p1"
        var failure = row("t1:f", .failure)
        failure.code = "upstream_unavailable"
        failure.detail = ""
        let rows = projection([
            row("t1:u", .user, "hello", at: "2026-09-14T10:00:00.000Z"),
            row("t1:a0", .assistant, "hi", at: "2026-09-14T10:00:05.000Z"),
            row("note:1", .note, "Routine ran."),
            page, image, widget, card, failure,
        ]).transcript()
        #expect(rows.map(\.kind) == [.user, .assistant, .note, .page, .image, .widget, .card, .failure])
        #expect(rows[0].at == TranscriptBlocks.date(fromISO8601: "2026-09-14T10:00:00Z"))
        let pageRow = rows[3]
        #expect(pageRow.text == "Q3 report" && pageRow.imageId == "m1")
        #expect(rows[4].imageId == "i1" && rows[4].text == "A small robot")
        #expect(rows[5].text == "wdg-1")
        #expect(rows[6].text == "p1")
        #expect(rows[7].text == "Couldn't reach ChatGPT just now. Send again in a moment.")
    }

    @Test func aRowWithNoTimeHasNone() {
        let rows = projection([row("t1:a0", .assistant, "done")]).transcript()
        #expect(rows.first?.at == nil)
    }

    @Test func ownerAttachmentsRideOnTheirBubble() {
        var user = row("t1:u", .user, "look")
        user.attachments = [
            RowAttachment(name: "shot-3fa2c1d0.png", mediaType: "image/png", size: 10),
            RowAttachment(name: "notes.txt", mediaType: "text/plain", size: 20),
        ]
        let bubble = projection([user]).transcript()[0]
        #expect(bubble.text == "look")
        #expect(bubble.attachments.filter(\.isImage).map(\.name) == ["shot-3fa2c1d0.png"])
        #expect(bubble.attachments.filter { !$0.isImage }.map(\.name) == ["notes.txt"])
    }

    @Test func anEngineUnsentMessageIsABubbleWithItsLine() {
        var unsent = row("unsent:c3", .unsent, "and email it to me", at: "2026-09-14T10:00:00.000Z")
        unsent.clientId = "c3"
        unsent.reason = "cancelled"
        let rows = projection([row("t1:a0", .assistant, "hi"), unsent]).transcript()
        #expect(rows.map(\.kind) == [.assistant, .user, .unsent])
        #expect(rows[1].id == "unsent-c3" && rows[1].text == "and email it to me")
        #expect(UnsentMessage.id(fromLineRowId: rows[2].id) == "c3")
        // Dismissed ones are not drawn.
        let hidden = projection([unsent]).transcript(hiddenUnsent: ["c3"])
        #expect(hidden.isEmpty)
    }

    @Test func aRefusedMessageGoesUnderTheRowItWasSentAfter() {
        let held = UnsentMessage(
            id: "m1", message: "hello", echo: "hello", draft: "hello", files: [], reason: "No.",
            at: Date(), anchorId: "t1:a0"
        )
        let rows = projection([
            row("t1:a0", .assistant, "first"),
            row("t2:a0", .assistant, "second"),
        ]).transcript(localUnsent: [held])
        #expect(rows.map(\.id) == ["t1:a0", "unsent-m1", "unsent-line-m1", "t2:a0"])
    }

    @Test func aRefusedMessageWhoseRowIsGoneGoesByItsTime() {
        let at = TranscriptBlocks.date(fromISO8601: "2026-09-14T10:30:00Z")!
        let held = UnsentMessage(
            id: "m1", message: "x", echo: "x", draft: "x", files: [], reason: "No.", at: at, anchorId: "gone"
        )
        let rows = projection([
            row("a", .assistant, "early", at: "2026-09-14T10:00:00.000Z"),
            row("b", .assistant, "late", at: "2026-09-14T11:00:00.000Z"),
        ]).transcript(localUnsent: [held])
        #expect(rows.map(\.id) == ["a", "unsent-m1", "unsent-line-m1", "b"])
    }

    @Test func aNoteOfTheEngineKeepsItsText() {
        let rows = projection([row("compaction:e1", .note, "Conversation compacted to fit the model's window")]).transcript()
        #expect(rows.first?.kind == .note)
        #expect(rows.first?.text == "Conversation compacted to fit the model's window")
    }
}

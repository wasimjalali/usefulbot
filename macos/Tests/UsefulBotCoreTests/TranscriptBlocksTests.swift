import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct TranscriptBlocksTests {
    private let utc = TimeZone(identifier: "UTC")!
    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar
    }

    private func date(_ iso: String) -> Date {
        TranscriptBlocks.date(fromISO8601: iso)!
    }

    private func build(_ rows: [TranscriptRow]) -> [TranscriptBlock] {
        TranscriptBlocks.build(
            rows: rows,
            now: date("2026-09-14T12:00:00Z"),
            calendar: calendar,
            timeZone: utc,
            locale: locale
        )
    }

    /// Dividers key to the day, never to the row that started it: the live
    /// echo of the owner's turn replaces that row's id mid-stream, and a
    /// divider keyed to it would tear the list down and reset the scroll.
    private func dayID(_ iso: String) -> String {
        "day-\(Int(calendar.startOfDay(for: date(iso)).timeIntervalSince1970))"
    }

    @Test func dayDividerMarksNewDatedDays() {
        let rows = [
            TranscriptRow(id: "a", kind: .user, text: "one", at: date("2026-09-14T17:10:00Z")),
            TranscriptRow(id: "b", kind: .assistant, text: "two", at: date("2026-09-14T17:11:00Z")),
            TranscriptRow(id: "c", kind: .assistant, text: "three", at: date("2026-09-12T09:17:00Z")),
        ]
        let blocks = build(rows)
        #expect(blocks.map(\.id) == [dayID("2026-09-14T00:00:00Z"), "a", "b", dayID("2026-09-12T00:00:00Z"), "c"])
        guard case .dayDivider(_, let first) = blocks[0],
              case .dayDivider(_, let second) = blocks[3] else {
            Issue.record("expected day dividers")
            return
        }
        // The rule carries the day and nothing else; a wall clock there reads
        // as the time of the message below it, which it is not.
        #expect(first == "Today")
        #expect(second == "Sat, Sep 12")
    }

    @Test func undatedRowsDoNotSplitOrMarkDays() {
        let rows = [
            TranscriptRow(id: "a", kind: .user, text: "one"),
            TranscriptRow(id: "b", kind: .assistant, text: "two"),
        ]
        let blocks = build(rows)
        #expect(blocks.map(\.id) == ["a", "b"])
    }

    /// Rows that used to collapse or summarize (fan-out, posts) are gone, so a
    /// run of bubbles is exactly one block per row, whoever the row names.
    @Test func everyRowIsItsOwnBlockWithNoStripsOrSummaries() {
        let rows = [
            TranscriptRow(id: "u", kind: .user, text: "kick off"),
            TranscriptRow(id: "a1", kind: .assistant, text: "done"),
            TranscriptRow(id: "a2", kind: .assistant, text: "done"),
            TranscriptRow(id: "n", kind: .note, text: "Confirmed connectApp."),
            TranscriptRow(id: "a3", kind: .assistant, text: "done"),
        ]
        let blocks = build(rows)
        #expect(blocks.map(\.id) == ["u", "a1", "a2", "n", "a3"])
    }

    @Test func parsesBothISO8601Shapes() {
        #expect(TranscriptBlocks.date(fromISO8601: "2026-09-14T17:10:00.123Z") != nil)
        #expect(TranscriptBlocks.date(fromISO8601: "2026-09-14T17:10:00Z") != nil)
        #expect(TranscriptBlocks.date(fromISO8601: "") == nil)
        #expect(TranscriptBlocks.date(fromISO8601: nil) == nil)
    }

    @Test func bubblesFromOneBotStackUnderTheFirst() {
        let rows = [
            TranscriptRow(id: "u1", kind: .user, text: "Is Gmail connected?"),
            TranscriptRow(id: "a1", kind: .assistant, text: "Checking."),
            TranscriptRow(id: "a2", kind: .assistant, text: "It is not."),
            TranscriptRow(id: "u2", kind: .user, text: "Thanks"),
            TranscriptRow(id: "a4", kind: .assistant, text: "Any time."),
        ]
        let blocks = TranscriptBlocks.build(rows: rows)
        #expect(TranscriptBlocks.continuationIds(blocks) == ["a2"])
        #expect(TranscriptBlocks.latestReplyRunIds(blocks) == ["a4"])
    }

    @Test func aNoteBreaksTheStackOfBotBubbles() {
        let rows = [
            TranscriptRow(id: "u1", kind: .user, text: "Connect Gmail"),
            TranscriptRow(id: "a1", kind: .assistant, text: "Adding Gmail now."),
            TranscriptRow(id: "n1", kind: .note, text: "Connected Gmail."),
            TranscriptRow(id: "a2", kind: .assistant, text: "Gmail is ready."),
            TranscriptRow(id: "a3", kind: .assistant, text: "Done."),
        ]
        let blocks = TranscriptBlocks.build(rows: rows)
        #expect(TranscriptBlocks.continuationIds(blocks) == ["a3"])
        #expect(TranscriptBlocks.latestReplyRunIds(blocks) == ["a1", "a2", "a3"])
    }

    @Test func aBlockKnowsTheRowsItDraws() {
        let pictures = [
            TranscriptRow(id: "i1", kind: .image, text: "one", imageId: "x"),
            TranscriptRow(id: "i2", kind: .image, text: "two", imageId: "y"),
        ]
        let blocks = TranscriptBlocks.build(rows: pictures)
        #expect(blocks.contains { $0.holds(rowId: "i2") })
        #expect(!blocks.contains { $0.holds(rowId: "missing") })
    }

    // MARK: - Stamps

    @Test func theHandParserAgreesWithTheFormatter() {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        let stamps = [
            "2026-09-17T16:22:05.123Z", "2026-09-17T16:22:05Z", "2024-02-29T23:59:59.999Z",
            "2000-01-01T00:00:00Z", "1999-12-31T23:59:59.5Z", "2100-03-01T00:00:00.000Z",
            "1970-01-01T00:00:00Z", "1969-12-31T23:59:59Z", "2026-01-31T12:00:00.000001Z",
        ]
        for stamp in stamps {
            let expected = formatter.date(from: stamp) ?? plain.date(from: stamp)!
            let parsed = TranscriptBlocks.utcStamp(stamp)!
            #expect(abs(parsed.timeIntervalSince(expected)) < 0.000_01, Comment(rawValue: stamp))
        }
        // Not the server's shape: the formatters decide, and reject.
        for other in ["2026-09-17T16:22:05+02:00", "2026-09-17 16:22:05Z", "2026-13-01T00:00:00Z", "2026-09-17T16:22:05.Z", "", "Z", "2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-17T16:22:05z", "2026-09-17T24:00:00Z"] {
            #expect(TranscriptBlocks.utcStamp(other) == nil, Comment(rawValue: other))
        }
        #expect(TranscriptBlocks.date(fromISO8601: "2026-09-17T16:22:05+02:00") == plain.date(from: "2026-09-17T16:22:05+02:00"))
    }

    // MARK: - Window

    /// `turns` user and reply pairs, one a minute, across two days.
    private func longChat(turns: Int) -> [TranscriptBlock] {
        var rows: [TranscriptRow] = []
        for turn in 0..<turns {
            let day = turn < turns / 2 ? "12" : "13"
            let minute = String(format: "%02d", turn % 60)
            let hour = String(format: "%02d", turn / 60)
            rows.append(TranscriptRow(id: "u\(turn)", kind: .user, text: "q", at: date("2026-09-\(day)T\(hour):\(minute):00Z")))
            rows.append(TranscriptRow(id: "a\(turn)", kind: .assistant, text: "a", at: date("2026-09-\(day)T\(hour):\(minute):30Z")))
        }
        return build(rows)
    }

    @Test func aShortChatIsMountedWhole() {
        let blocks = longChat(turns: 10)
        let window = TranscriptBlocks.window(blocks, startId: nil, minimum: 60)
        #expect(window.blocks == blocks)
        #expect(window.hidden == 0)
    }

    @Test func aLongChatMountsItsNewestBlocksUnderTheirDayDivider() {
        let blocks = longChat(turns: 100)
        let window = TranscriptBlocks.window(blocks, startId: nil, minimum: 20)
        #expect(window.hidden == blocks.count - 20)
        // The cut lands inside the second day, so its divider is put back.
        #expect(window.blocks.first == .dayDivider(id: dayID("2026-09-13T00:00:00Z"), label: "Yesterday"))
        #expect(window.blocks.dropFirst().map(\.id) == blocks.suffix(20).map(\.id))
        // The newest reply is in, so its height and its anchor are measurable.
        #expect(window.blocks.map(\.id).contains("a99"))
    }

    @Test func theNewestTurnIsAlwaysWhole() {
        var rows: [TranscriptRow] = [TranscriptRow(id: "u0", kind: .user, text: "q")]
        rows.append(TranscriptRow(id: "u1", kind: .user, text: "long one"))
        for reply in 0..<30 {
            rows.append(TranscriptRow(id: "a\(reply)", kind: .assistant, text: "part"))
        }
        let blocks = build(rows)
        let window = TranscriptBlocks.window(blocks, startId: nil, minimum: 5)
        #expect(window.blocks.first?.id == "u1")
        #expect(window.hidden == 1)
    }

    @Test func theWindowHoldsItsFirstBlockWhileTheChatGrows() {
        let blocks = longChat(turns: 100)
        let held = TranscriptBlocks.window(blocks, startId: "u70", minimum: 20)
        #expect(held.blocks.dropFirst().first?.id == "u70")
        #expect(held.hidden == blocks.firstIndex(where: { $0.id == "u70" }))
        // Twenty more turns land: the same first block, nothing slides away.
        let grown = longChat(turns: 120)
        let after = TranscriptBlocks.window(grown, startId: "u70", minimum: 20)
        #expect(after.blocks.dropFirst().first?.id == "u70")
        #expect(after.blocks.count == held.blocks.count + 40)
    }

    @Test func expandingToTheFirstMessageMountsTheChatWhole() {
        let blocks = longChat(turns: 20)
        // The chat opens with a day divider; holding it is holding the top.
        let window = TranscriptBlocks.window(blocks, startId: blocks[0].id, minimum: 10)
        #expect(window.hidden == 0)
        #expect(window.blocks == blocks)
    }

    @Test func aHeldBlockThatLeftTheListFallsBackToTheNewest() {
        let blocks = longChat(turns: 100)
        let window = TranscriptBlocks.window(blocks, startId: "gone", minimum: 20)
        #expect(window.hidden == blocks.count - 20)
    }
}

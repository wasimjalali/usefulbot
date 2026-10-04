import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct SettingsPaneTests {
    // MARK: Palette

    private struct Entry: Decodable {
        let label: String
        let fill: String
        let legacy: Bool?
    }

    private func palette() throws -> [String: Entry] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("brand/source/avatar-palette.json")
        return try JSONDecoder().decode([String: Entry].self, from: Data(contentsOf: url))
    }

    @Test func gridAndLegacyIdsAllResolveInThePaletteFile() throws {
        let palette = try palette()
        #expect(FacePalette.gridColors.count == 30)
        #expect(Set(FacePalette.gridColors).count == 30)
        #expect(FacePalette.legacyColors.count == 10)
        #expect(Set(palette.keys) == Set(FacePalette.colors))
        for id in FacePalette.gridColors {
            #expect(palette[id] != nil, "grid id \(id) missing")
            #expect(palette[id]?.legacy != true, "grid id \(id) is marked legacy")
        }
        for id in FacePalette.legacyColors {
            #expect(palette[id]?.legacy == true, "legacy id \(id) is not marked legacy")
        }
        for (id, entry) in palette {
            #expect(entry.fill.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil, "bad fill for \(id)")
        }
    }

    @Test func gridKeepsTheOriginalIdAndNamesEachTone() throws {
        let palette = try palette()
        #expect(FacePalette.gridColors.first == "ink")
        #expect(palette["ink"]?.label == "Original")
        #expect(palette["red-light"]?.label == "Light red")
        #expect(palette["teal-deep"]?.label == "Deep teal")
        #expect(palette["neutral-mid"]?.label == "Mid neutral")
        // Row-major: ten hues per tone row.
        #expect(FacePalette.gridColors[10] == "neutral-mid")
        #expect(FacePalette.gridColors[29] == "lilac-deep")
    }

    @Test func newBotsPickOnlyGridColors() {
        for seed in stride(from: UInt64(0), through: 20_000, by: 37) {
            let color = FacePalette.randomFace(seed: seed &* 2_654_435_761).color
            #expect(FacePalette.gridColors.contains(color), "legacy color \(color) for seed \(seed)")
        }
    }

    // MARK: Notifier decision

    private func decide(
        on: Bool = true, selected: Bool = false, active: Bool = true, visible: Bool = true,
        failed: Bool = false, reply: Bool = true
    ) -> Bool {
        TurnNotifyPolicy.shouldNotify(
            notifyOn: on, isSelected: selected, appActive: active,
            windowVisible: visible, failed: failed, hasAssistantReply: reply
        )
    }

    @Test func notifiesOnlyWhenTheChatIsOutOfSight() {
        #expect(decide(on: false) == false)                        // switch off
        #expect(decide(selected: true, active: true) == false)     // selected and active
        #expect(decide(selected: true, active: false) == true)     // selected, app inactive
        #expect(decide(selected: true, active: true, visible: false) == true) // window hidden
        #expect(decide(selected: false, active: true) == true)     // another chat on screen
        #expect(decide(failed: true) == false)                     // failed turn
        #expect(decide(reply: false) == false)                     // no assistant reply
    }

    // MARK: Counter

    @Test func counterShowsOnlyNearTheLimit() {
        #expect(InstructionsLimit.footer(for: String(repeating: "a", count: 6_999)) == .none)
        #expect(InstructionsLimit.footer(for: String(repeating: "a", count: 7_640))
            == .near("7,640 of 8,000 characters"))
        #expect(InstructionsLimit.footer(for: String(repeating: "a", count: 8_000))
            == .near("8,000 of 8,000 characters"))
        #expect(InstructionsLimit.footer(for: String(repeating: "a", count: 8_120))
            == .over("8,120 of 8,000. Shorten by 120 to save."))
    }

    @Test func theCountIsOfTheTrimmedText() {
        #expect(InstructionsLimit.count("  \n abc \n") == 3)
        #expect(InstructionsLimit.canSave("  " + String(repeating: "a", count: 8_000) + "\n\n"))
    }

    @Test func saveIsRefusedOnlyOverTheLimit() {
        #expect(InstructionsLimit.canSave(String(repeating: "a", count: 8_000)))
        #expect(!InstructionsLimit.canSave(String(repeating: "a", count: 8_001)))
        // The server counts UTF-16 units: one emoji is two.
        #expect(InstructionsLimit.count("🙂") == 2)
        #expect(!InstructionsLimit.canSave(String(repeating: "🙂", count: 4_001)))
    }

    @Test func aTooLongDescriptionHasPlainCopy() {
        #expect(BackendError.shell("shell_description_too_long").errorDescription
            == "Instructions can be up to 8,000 characters.")
    }

    // MARK: Memory

    @Test func memoryDatesReadTodayThenMonthDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-10-02T10:00:00Z")!
        #expect(MemoryDateLabel.label(iso: "2026-10-02T01:15:00.000Z", now: now, calendar: calendar) == "Today")
        #expect(MemoryDateLabel.label(iso: "2026-09-30T20:00:00.000Z", now: now, calendar: calendar) == "Sep 30")
        #expect(MemoryDateLabel.label(iso: "2025-12-24T20:00:00Z", now: now, calendar: calendar) == "Dec 24, 2025")
        #expect(MemoryDateLabel.label(iso: "garbage", now: now, calendar: calendar) == "garbage")
    }

    @Test func memoryDeleteBodyCarriesTheRevisionUntouched() throws {
        let number = try BackendClient.memoryDeleteBody(botId: "bot-a", id: "n1", revision: .number(3))
        #expect(String(decoding: number, as: UTF8.self) == #"{"botId":"bot-a","id":"n1","revision":3}"#)
        let text = try BackendClient.memoryDeleteBody(botId: "bot-a", id: "n1", revision: .text("r-9"))
        #expect(String(decoding: text, as: UTF8.self) == #"{"botId":"bot-a","id":"n1","revision":"r-9"}"#)
    }

    @Test func memoryNoteDecodesRevisionAndSource() throws {
        let note = try JSONDecoder().decode(MemoryNote.self, from: Data("""
        {"id":"n1","title":"T","body":"B","updatedAt":"2026-09-30T08:00:00.000Z",
         "truncated":true,"revision":7,"source":"model-after-outside-content"}
        """.utf8))
        #expect(note.revision == .number(7))
        #expect(note.afterOutsideContent)
        #expect(note.truncated)
        let sparse = try JSONDecoder().decode(MemoryNote.self, from: Data(#"{"id":"n2"}"#.utf8))
        #expect(sparse.revision == nil)
        #expect(!sparse.afterOutsideContent)
    }

    @Test func botContextDecodesTheSeed() throws {
        let info = try JSONDecoder().decode(BotContextInfo.self, from: Data("""
        {"descriptionChars":120,"max":8000,"envelopeTokens":900,"windowTokens":128000,
         "modelLabel":"M","fits":true,"seed":{"differs":true,"text":"Shipped"}}
        """.utf8))
        #expect(info.seed == BotContextInfo.Seed(differs: true, text: "Shipped"))
        let none = try JSONDecoder().decode(BotContextInfo.self, from: Data(#"{"descriptionChars":0,"max":8000,"seed":null}"#.utf8))
        #expect(none.seed == nil)
    }
}

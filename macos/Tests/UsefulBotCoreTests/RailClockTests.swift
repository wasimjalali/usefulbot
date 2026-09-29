import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct RailClockTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private var now: Date {
        RailClock.date(from: "2026-09-14T18:00:00Z")!
    }

    @Test func todayRendersTheLocaleTime() {
        let label = RailClock.label(
            iso: "2026-09-14T12:34:56Z",
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "en_US")
        )
        // macOS 14 localizes the gap before AM/PM as a narrow no-break space.
        let normalized = label.replacingOccurrences(of: "\u{202F}", with: " ")
        #expect(normalized == "12:34 PM")
    }

    @Test func anotherDayRendersMonthAndDay() {
        let label = RailClock.label(
            iso: "2026-09-13T12:34:56Z",
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "en_US")
        )
        #expect(label == "Sep 13")
    }

    @Test func malformedOrMissingValuesRenderNothing() {
        #expect(RailClock.label(iso: nil, now: now, calendar: calendar, locale: .current).isEmpty)
        #expect(RailClock.label(iso: "not-a-date", now: now, calendar: calendar, locale: .current).isEmpty)
        #expect(RailClock.label(iso: "", now: now, calendar: calendar, locale: .current).isEmpty)
    }

    @Test func fractionalSecondsParse() {
        #expect(RailClock.date(from: "2026-09-14T12:34:56.789Z") != nil)
        #expect(RailClock.date(from: "2026-09-14T12:34:56Z") != nil)
    }
}

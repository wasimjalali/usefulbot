import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct RoutinesTests {
    /// macOS puts a narrow no-break space before AM/PM; compare on plain
    /// spaces so the expectations stay readable.
    private func plain(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func decode(_ json: String) throws -> Routine {
        try JSONDecoder().decode(Routine.self, from: Data(json.utf8))
    }

    @Test func decodeToleratesUnknownAndMissingFields() throws {
        // A newer server adds `nextRunAt`; only `id` is required here.
        let routine = try decode("""
        {"id":"rtn_1","botId":"bot-a","name":"Weekly SEO check and draft",
         "instruction":"Check rankings.","timezone":"Europe/Berlin","active":true,
         "nextRunAt":"2026-09-21T07:00:00.000Z",
         "schedules":[{"kind":"weekly","days":[1],"time":"09:00"}],
         "runHistory":[{"at":"2026-09-14T07:07:00.000Z","status":"ok","sessionId":"ses_1","error":""}]}
        """)
        #expect(routine.name == "Weekly SEO check and draft")
        #expect(routine.schedules == [.weekly(days: [1], time: "09:00")])
        #expect(routine.runHistory.first?.succeeded == true)

        let sparse = try decode(#"{"id":"rtn_2"}"#)
        #expect(sparse.name == "Routine")
        #expect(sparse.schedules.isEmpty)
        #expect(sparse.runHistory.isEmpty)
        // A row that exists is treated as live, never silently paused.
        #expect(sparse.active)
        #expect(sparse.timezone == TimeZone.current.identifier)
    }

    @Test func decodeDropsAnUnknownScheduleKind() throws {
        let routine = try decode("""
        {"id":"rtn_3","schedules":[
          {"kind":"monthly","time":"08:15"},
          {"kind":"weekly","days":[1,9,3],"time":"09:00"},
          {"kind":"once","date":"2026-12-24","time":"18:00"}]}
        """)
        // The server drops a kind it does not know, so the pane drops it too:
        // showing it as a daily run would invent a schedule that never fires.
        // The rest of the list survives.
        #expect(routine.schedules.count == 2)
        // Out-of-range weekdays are discarded, the rest keep their order.
        #expect(routine.schedules[0] == .weekly(days: [1, 3], time: "09:00"))
        #expect(routine.schedules[1] == .once(date: "2026-12-24", time: "18:00"))
    }

    @Test func aMalformedRunRowStillDecodes() throws {
        let routine = try decode("""
        {"id":"rtn_4","runHistory":[{"at":"2026-09-14T07:07:00.000Z","status":"failed","error":"eve_send_500"}]}
        """)
        #expect(routine.runHistory.count == 1)
        #expect(routine.runHistory[0].succeeded == false)
        #expect(routine.runHistory[0].sessionId == nil)
    }

    @Test func wireBodyMatchesTheServerShape() {
        #expect(RoutineSchedule.weekly(days: [1, 3], time: "09:00").wire["kind"] as? String == "weekly")
        #expect(RoutineSchedule.weekly(days: [1, 3], time: "09:00").wire["days"] as? [Int] == [1, 3])
        #expect(RoutineSchedule.daily(time: "07:30").wire["days"] == nil)
        #expect(RoutineSchedule.once(date: "2026-12-24", time: "18:00").wire["date"] as? String == "2026-12-24")
    }

    @Test func scheduleCopyReadsLikeTheReference() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let locale = Locale(identifier: "en_US")
        #expect(plain(RoutineCopy.scheduleRow(.weekly(days: [1], time: "09:00"), calendar: calendar, locale: locale))
            == "Every Monday at 9:00 AM")
        #expect(plain(RoutineCopy.scheduleRow(.daily(time: "09:00"), calendar: calendar, locale: locale))
            == "Every day at 9:00 AM")
        #expect(plain(RoutineCopy.scheduleRow(.weekly(days: [1, 2, 3, 4, 5], time: "07:30"), calendar: calendar, locale: locale))
            == "Every weekday at 7:30 AM")
        #expect(plain(RoutineCopy.scheduleRow(.weekly(days: [1, 3], time: "18:05"), calendar: calendar, locale: locale))
            == "Every Monday and Wednesday at 6:05 PM")
        #expect(RoutineCopy.scheduleLine([], calendar: calendar, locale: locale) == "No schedule yet")
    }

    @Test func runLabelsAreRelativeToToday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let now = RailClock.date(from: "2026-09-14T12:00:00.000Z")!
        #expect(plain(RoutineCopy.runLabel(iso: "2026-09-14T09:07:00.000Z", now: now, calendar: calendar, locale: locale))
            == "Today at 9:07 AM")
        #expect(plain(RoutineCopy.runLabel(iso: "2026-09-13T09:07:00.000Z", now: now, calendar: calendar, locale: locale))
            == "Yesterday at 9:07 AM")
        #expect(plain(RoutineCopy.runLabel(iso: "2026-09-10T09:07:00.000Z", now: now, calendar: calendar, locale: locale))
            == "Sep 10 at 9:07 AM")
        // An unparseable stamp renders nothing rather than a placeholder date.
        #expect(RoutineCopy.runLabel(iso: "", now: now, calendar: calendar, locale: locale).isEmpty)
    }

    @Test func timeValidationMatchesTheServerRegex() {
        #expect(RoutineTime.isValid("09:00"))
        #expect(RoutineTime.isValid("23:59"))
        #expect(RoutineTime.isValid("00:00"))
        #expect(!RoutineTime.isValid("9:00"))
        #expect(!RoutineTime.isValid("24:00"))
        #expect(!RoutineTime.isValid("09:60"))
        #expect(!RoutineTime.isValid("0900"))
        #expect(!RoutineTime.isValid(""))
        #expect(!RoutineTime.isValid("ab:cd"))
    }
}

import Foundation

/// Wire types and copy for `/api/routines`. Decoding is tolerant the same way
/// the shell types are: an unknown field is ignored and a missing one falls
/// back, so one odd row never fails the whole list.

public enum RoutineSchedule: Codable, Equatable, Sendable, Identifiable {
    case weekly(days: [Int], time: String)
    case daily(time: String)
    case once(date: String, time: String)

    public var id: String {
        switch self {
        case .weekly(let days, let time): return "weekly-\(days.map(String.init).joined(separator: "."))-\(time)"
        case .daily(let time): return "daily-\(time)"
        case .once(let date, let time): return "once-\(date)-\(time)"
        }
    }

    public var time: String {
        switch self {
        case .weekly(_, let time), .daily(let time), .once(_, let time): return time
        }
    }

    /// The JSON body the server parses. Kept next to the decode so the two
    /// shapes cannot drift.
    public var wire: [String: Any] {
        switch self {
        case .weekly(let days, let time): return ["kind": "weekly", "days": days, "time": time]
        case .daily(let time): return ["kind": "daily", "time": time]
        case .once(let date, let time): return ["kind": "once", "date": date, "time": time]
        }
    }

    enum CodingKeys: String, CodingKey { case kind, days, time, date }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decode(String.self, forKey: .kind)) ?? "daily"
        let time = (try? c.decode(String.self, forKey: .time)) ?? "09:00"
        switch kind {
        case "weekly":
            let days = (try? c.decode([Int].self, forKey: .days)) ?? []
            self = .weekly(days: days.filter { (0...6).contains($0) }.sorted(), time: time)
        case "once":
            self = .once(date: (try? c.decode(String.self, forKey: .date)) ?? "", time: time)
        case "daily":
            self = .daily(time: time)
        default:
            // The server drops a kind it does not know. Reading it as a daily
            // run here would show a schedule that does not exist on the other
            // side and fire at a time nobody chose; `TolerantSchedule` turns
            // this into the same drop without losing the rest of the list.
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: c,
                debugDescription: "unknown schedule kind \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .weekly(let days, let time):
            try c.encode("weekly", forKey: .kind)
            try c.encode(days, forKey: .days)
            try c.encode(time, forKey: .time)
        case .daily(let time):
            try c.encode("daily", forKey: .kind)
            try c.encode(time, forKey: .time)
        case .once(let date, let time):
            try c.encode("once", forKey: .kind)
            try c.encode(date, forKey: .date)
            try c.encode(time, forKey: .time)
        }
    }
}

/// One element of a `schedules` array, or nothing. Swift decodes an array all
/// or nothing, so a single row this build cannot read would otherwise take the
/// whole schedule with it.
struct TolerantSchedule: Decodable {
    let schedule: RoutineSchedule?

    init(from decoder: Decoder) throws {
        schedule = try? RoutineSchedule(from: decoder)
    }
}

public struct RoutineRun: Codable, Identifiable, Equatable, Sendable {
    public let at: String
    public let status: String
    public let sessionId: String?
    public let error: String

    public var id: String { "\(at)-\(status)" }
    public var succeeded: Bool { status != "failed" }

    enum CodingKeys: String, CodingKey { case at, status, sessionId, error }

    public init(at: String, status: String, sessionId: String?, error: String) {
        self.at = at
        self.status = status
        self.sessionId = sessionId
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = (try? c.decode(String.self, forKey: .at)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? "ok"
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        error = (try? c.decode(String.self, forKey: .error)) ?? ""
    }
}

public struct Routine: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var botId: String
    public var name: String
    public var instruction: String
    public var schedules: [RoutineSchedule]
    public var timezone: String
    public var active: Bool
    public var lastRunAt: String?
    public var runHistory: [RoutineRun]

    enum CodingKeys: String, CodingKey {
        case id, botId, name, instruction, schedules, timezone, active, lastRunAt, runHistory
    }

    public init(
        id: String,
        botId: String,
        name: String,
        instruction: String,
        schedules: [RoutineSchedule],
        timezone: String,
        active: Bool,
        lastRunAt: String?,
        runHistory: [RoutineRun]
    ) {
        self.id = id
        self.botId = botId
        self.name = name
        self.instruction = instruction
        self.schedules = schedules
        self.timezone = timezone
        self.active = active
        self.lastRunAt = lastRunAt
        self.runHistory = runHistory
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "Routine"
        instruction = (try? c.decode(String.self, forKey: .instruction)) ?? ""
        schedules = ((try? c.decode([TolerantSchedule].self, forKey: .schedules)) ?? []).compactMap(\.schedule)
        timezone = (try? c.decode(String.self, forKey: .timezone)) ?? TimeZone.current.identifier
        // The server only ever omits `active` on a row it could not parse; a
        // routine that exists is assumed live rather than silently paused.
        active = (try? c.decode(Bool.self, forKey: .active)) ?? true
        lastRunAt = try? c.decodeIfPresent(String.self, forKey: .lastRunAt)
        runHistory = (try? c.decode([RoutineRun].self, forKey: .runHistory)) ?? []
    }
}

/// Copy for the routines pane. Pure so the wording is tested without a view.
public enum RoutineCopy {
    /// "Every Monday at 9:00 AM" and friends, one line per schedule.
    public static func scheduleLine(
        _ schedules: [RoutineSchedule],
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        if schedules.isEmpty { return "No schedule yet" }
        return schedules
            .map { scheduleRow($0, calendar: calendar, locale: locale) }
            .joined(separator: ", ")
    }

    public static func scheduleRow(
        _ schedule: RoutineSchedule,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let clock = timeLabel(schedule.time, locale: locale)
        switch schedule {
        case .daily:
            return "Every day at \(clock)"
        case .weekly(let days, _):
            return "Every \(dayPhrase(days, calendar: calendar, locale: locale)) at \(clock)"
        case .once(let date, _):
            return "Once on \(dateLabel(date, calendar: calendar, locale: locale)) at \(clock)"
        }
    }

    /// "Today at 9:07 AM", "Yesterday at 9:07 AM", else "Sep 12 at 9:07 AM".
    public static func runLabel(
        iso raw: String,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard let date = RailClock.date(from: raw) else { return "" }
        let clock = shortTime(date, calendar: calendar, locale: locale)
        if calendar.isDate(date, inSameDayAs: now) { return "Today at \(clock)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday at \(clock)"
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return "\(formatter.string(from: date)) at \(clock)"
    }

    static func dayPhrase(_ days: [Int], calendar: Calendar, locale: Locale) -> String {
        let ordered = Array(Set(days.filter { (0...6).contains($0) })).sorted()
        if ordered.isEmpty { return "day" }
        if ordered.count == 7 { return "day" }
        if ordered == [1, 2, 3, 4, 5] { return "weekday" }
        if ordered == [0, 6] { return "weekend" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        // `weekdaySymbols` is Sunday-first, which is the index the server uses.
        let names = ordered.compactMap { index -> String? in
            let symbols = formatter.weekdaySymbols ?? []
            return index < symbols.count ? symbols[index] : nil
        }
        if names.count <= 1 { return names.first ?? "day" }
        return "\(names.dropLast().joined(separator: ", ")) and \(names[names.count - 1])"
    }

    /// Format an "HH:MM" wall clock in the viewer's 12/24-hour convention.
    /// The value is already local to the routine's zone, so it is read as UTC
    /// and printed as UTC: no conversion may happen here.
    static func timeLabel(_ time: String, locale: Locale) -> String {
        let parts = time.split(separator: ":")
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return time }
        var components = DateComponents()
        components.year = 2000
        components.month = 1
        components.day = 1
        components.hour = hour
        components.minute = minute
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let date = utc.date(from: components) else { return time }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = utc
        formatter.timeZone = utc.timeZone
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    static func dateLabel(_ date: String, calendar: Calendar, locale: Locale) -> String {
        let parts = date.split(separator: "-")
        guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
            return date
        }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let at = utc.date(from: DateComponents(year: year, month: month, day: day)) else { return date }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = utc
        formatter.timeZone = utc.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter.string(from: at)
    }

    private static func shortTime(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

/// Wall-clock validation, mirroring the server's `HH:MM` schedule regex. The
/// pane checks locally so a typo never silently drops a schedule server-side.
public enum RoutineTime {
    public static func isValid(_ value: String) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2 else { return false }
        guard let hour = Int(parts[0]), let minute = Int(parts[1]) else { return false }
        guard parts[0].allSatisfy(\.isNumber), parts[1].allSatisfy(\.isNumber) else { return false }
        return (0...23).contains(hour) && (0...59).contains(minute)
    }
}

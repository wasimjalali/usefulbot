import Foundation

/// Rail time labels:
/// today renders the locale time, any other day renders "Mon D".
public enum RailClock {
    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func date(from raw: String) -> Date? {
        iso.date(from: raw) ?? isoPlain.date(from: raw)
    }

    /// The same shape the server sends, so the optimistic stamp can be read
    /// back by `date(from:)` and by the server.
    public static func stamp(_ date: Date) -> String {
        iso.string(from: date)
    }

    public static func label(
        iso raw: String?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard let raw, let date = date(from: raw) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.locale = locale
            formatter.timeZone = calendar.timeZone
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter.string(from: date)
    }
}

import Foundation

/// When a finished turn earns a macOS notification. Pure, so the rule is
/// tested without a notification center.
public enum TurnNotifyPolicy {
    /// `onScreen` is the chat being selected, the app active and the window
    /// visible. A turn that failed, or that ended with no assistant reply,
    /// never notifies.
    public static func shouldNotify(
        notifyOn: Bool,
        isSelected: Bool,
        appActive: Bool,
        windowVisible: Bool,
        failed: Bool,
        hasAssistantReply: Bool
    ) -> Bool {
        guard notifyOn, !failed, hasAssistantReply else { return false }
        let onScreen = isSelected && appActive && windowVisible
        return !onScreen
    }
}

/// The instructions editor's footer text and save rule. The server counts
/// JavaScript string length, which is UTF-16 code units, after trimming
/// whitespace at both ends, so the count is of what would be stored.
public enum InstructionsLimit {
    public static let max = 8_000
    public static let showCounterFrom = 7_000

    public enum Footer: Equatable, Sendable {
        case none
        case near(String)
        case over(String)
    }

    public static func count(_ text: String) -> Int {
        text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    }

    public static func canSave(_ text: String, max limit: Int = max) -> Bool {
        count(text) <= limit
    }

    public static func footer(for text: String, max limit: Int = max) -> Footer {
        let used = count(text)
        if used > limit {
            return .over("\(grouped(used)) of \(grouped(limit)). Shorten by \(grouped(used - limit)) to save.")
        }
        if used >= showCounterFrom {
            return .near("\(grouped(used)) of \(grouped(limit)) characters")
        }
        return .none
    }

    static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

/// "Today", or "Sep 30" ("Sep 30, 2025" in another year).
public enum MemoryDateLabel {
    public static func label(
        iso: String,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        guard let date = parse(iso) else { return String(iso.prefix(10)) }
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "MMMdyyyy")
        return formatter.string(from: date)
    }

    static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }
}

/// A note's revision as the server sent it, handed back untouched on delete.
public enum MemoryRevision: Codable, Equatable, Sendable {
    case number(Int)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .number(n); return }
        self = .text(try c.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .number(let n): try c.encode(n)
        case .text(let s): try c.encode(s)
        }
    }

    var json: Any {
        switch self {
        case .number(let n): return n
        case .text(let s): return s
        }
    }
}

/// `GET /api/bots/context`: what the bot's instructions cost and the shipped
/// default for a bot that has one.
public struct BotContextInfo: Decodable, Equatable, Sendable {
    public struct Seed: Decodable, Equatable, Sendable {
        public let differs: Bool
        public let text: String
    }

    public let descriptionChars: Int
    public let max: Int
    public let seed: Seed?
}

import Foundation

/// One render unit of the chat transcript: day dividers, bubbles and picture
/// runs.
///
/// The grouping is a pure function of the rows, so the view only decides
/// which bubble to draw.
public enum TranscriptBlock: Equatable, Sendable, Identifiable {
    case dayDivider(id: String, label: String)
    /// A row that renders as a bubble.
    case message(row: TranscriptRow)
    /// Pictures posted one after another, laid out side by side in rows
    /// instead of stacked. Keyed to the first, so a picture that joins the
    /// run does not remount the ones already on screen.
    case images(rows: [TranscriptRow])

    public var id: String {
        switch self {
        case .dayDivider(let id, _): return id
        case .message(let row): return row.id
        case .images(let rows): return rows.first?.id ?? "images"
        }
    }

    var isDayDivider: Bool {
        if case .dayDivider = self { return true }
        return false
    }

    public var isMessage: Bool {
        switch self {
        case .message, .images: return true
        case .dayDivider: return false
        }
    }
}

extension TranscriptBlock {
    /// Whether this block draws the row: an image run holds every picture in it.
    public func holds(rowId: String) -> Bool {
        switch self {
        case .images(let rows): return rows.contains { $0.id == rowId }
        default: return id == rowId
        }
    }
}

public enum TranscriptBlocks {
    /// Build the render list: a day divider whenever the date changes, one
    /// block per row, and pictures posted one after another joined in a run.
    public static func build(
        rows: [TranscriptRow],
        now: Date = Date(),
        calendar: Calendar = .current,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var lastDatedDay: Date?
        var lastMessageBlockIndex: Int?

        for row in rows {
            if let date = row.at,
               lastDatedDay == nil || !calendar.isDate(date, inSameDayAs: lastDatedDay!) {
                lastMessageBlockIndex = nil
                // The divider is keyed to the day itself, not to the row that
                // happened to start it: the live echo of the owner's turn
                // replaces that row's id mid-stream, and a divider whose id
                // moved with it tore the whole list down and reset the
                // transcript's scroll to the top.
                blocks.append(.dayDivider(
                    id: "day-\(Int(calendar.startOfDay(for: date).timeIntervalSince1970))",
                    label: dayLabel(date, now: now, calendar: calendar, timeZone: timeZone, locale: locale)
                ))
                lastDatedDay = date
            }

            if row.kind == .user || row.kind == .note {
                lastMessageBlockIndex = nil
                blocks.append(.message(row: row))
                continue
            }

            // A picture straight after another joins its row. A single
            // picture stays a message and keeps its full size.
            if row.kind == .image, let index = lastMessageBlockIndex, index == blocks.count - 1 {
                if case .images(let run) = blocks[index] {
                    blocks[index] = .images(rows: run + [row])
                    continue
                }
                if case .message(let previous) = blocks[index], previous.kind == .image {
                    blocks[index] = .images(rows: [previous, row])
                    continue
                }
            }

            blocks.append(.message(row: row))
            lastMessageBlockIndex = blocks.count - 1
        }

        return blocks
    }

    /// What the transcript mounts of a long chat: the newest blocks, behind a
    /// "Show earlier messages" row for the rest.
    public struct Window: Equatable, Sendable {
        public var blocks: [TranscriptBlock]
        /// How many blocks sit above the window.
        public var hidden: Int
        /// The first block on screen, so the window can be held there while
        /// the chat grows underneath.
        public var startId: String? { blocks.first(where: { !$0.isDayDivider })?.id }

        public init(blocks: [TranscriptBlock], hidden: Int) {
            self.blocks = blocks
            self.hidden = hidden
        }
    }

    /// How many blocks a chat shows before the rest go behind the row.
    public static let windowMinimum = 60

    /// How much history text, above the newest turn, a chat mounts before the
    /// rest go behind the row. A block count alone let a chat of long markdown
    /// answers (tables, code) mount dozens of screens at once: every one is
    /// measured before anything shows, which froze a switch for seconds. Sixty
    /// ordinary messages stay well under it.
    public static let historyCharacterBudget = 20_000

    /// A block's share of the budget: its text, or a fixed cost for pictures.
    public static func weight(_ block: TranscriptBlock) -> Int {
        switch block {
        case .message(let row): return row.text.utf16.count
        case .images(let rows): return rows.count * 500
        case .dayDivider: return 0
        }
    }

    /// The last `minimum` blocks, or everything from `startId` on once the
    /// reader has asked for more, extended so the newest turn is always whole
    /// (the reply's height is summed from every one of its bubbles, and the
    /// completion scroll targets its first) and so the window opens under the
    /// day divider its first row belongs to. The window never slides: a chat
    /// that grows keeps its first block, so a row the reader is looking at is
    /// not pulled out from under them, and a `startId` that has left the list
    /// (a cleared chat) falls back to the newest blocks.
    public static func window(
        _ blocks: [TranscriptBlock],
        startId: String?,
        minimum: Int = windowMinimum,
        historyBudget: Int = historyCharacterBudget
    ) -> Window {
        // The newest turn: from the last thing said to the bot to the end.
        let turn = blocks.lastIndex(where: { block in
            if case .message(let row) = block { return row.kind == .user }
            return false
        })
        // The budget counts only the history above the newest turn, so a reply
        // streaming in never moves the window's start. A chat nobody has
        // written to (a routine's run) anchors on its newest message instead,
        // so the budget can never cut the window down to nothing.
        let anchor = turn ?? blocks.lastIndex(where: \.isMessage)
        var budgetStart = 0
        var spent = 0
        for index in stride(from: (anchor ?? blocks.count) - 1, through: 0, by: -1) {
            spent += weight(blocks[index])
            if spent > historyBudget { budgetStart = index + 1; break }
        }
        guard blocks.count > minimum || budgetStart > 0 else { return Window(blocks: blocks, hidden: 0) }
        var start = max(blocks.count - minimum, budgetStart)
        // A reader who asked for more keeps it, budget or not.
        if let startId, let held = blocks.firstIndex(where: { $0.id == startId }) {
            start = min(start, held)
        }
        if let anchor {
            start = min(start, anchor)
        }
        // A window opens on a message; a divider is put back below instead.
        while start < blocks.count - 1, !blocks[start].isMessage { start += 1 }
        // Nothing but dividers above the cut means nothing to show: the
        // row would otherwise stay up over a chat that is already whole.
        guard blocks[..<start].contains(where: \.isMessage) else {
            return Window(blocks: blocks, hidden: 0)
        }
        var window = Array(blocks[start...])
        if let divider = blocks[..<start].last(where: { $0.isDayDivider }) {
            window.insert(divider, at: 0)
        }
        return Window(blocks: window, hidden: start)
    }

    /// The bubbles that follow another bubble from the bot with nothing
    /// between them. A turn posts several messages; these stack close under
    /// the first instead of standing a full turn's gap apart.
    public static func continuationIds(_ blocks: [TranscriptBlock]) -> Set<String> {
        var ids = Set<String>()
        var previous: TranscriptRow?
        for block in blocks {
            guard case .message(let row) = block, row.kind == .assistant else {
                previous = nil
                continue
            }
            if previous != nil { ids.insert(row.id) }
            previous = row
        }
        return ids
    }

    /// Every bubble of the newest reply: the bot's messages since the last
    /// thing said to it. The first is the reply anchor; together they are the
    /// answer whose height decides whether it overflows the window.
    public static func latestReplyRunIds(_ blocks: [TranscriptBlock]) -> Set<String> {
        var run = Set<String>()
        for block in blocks {
            guard case .message(let row) = block else { continue }
            switch row.kind {
            case .user:
                run = []
            case .assistant:
                run.insert(row.id)
            case .note, .widget, .image, .page, .failure, .unsent, .card: continue
            }
        }
        return run
    }

    /// "Today" / "Yesterday" / "Wed, Aug 26".
    public static func dayLabel(
        _ date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        // The day, never the clock. A wall time on the rule reads as the time
        // of the message under it, which it is not: it is the time of the
        // first message of that day, and knowing it helps nobody.
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        return string(from: date, format: "EEE, MMM d", calendar: calendar, timeZone: timeZone, locale: locale)
    }

    /// Parse the server's `new Date().toISOString()`, with and without the
    /// fractional seconds older writers omit.
    public static func date(fromISO8601 value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        // Every event carries a stamp and a replay parses thousands of them:
        // `ISO8601DateFormatter` goes through ICU and cost a quarter of a
        // second per chat switch. The server's exact shape is read by hand;
        // anything else still goes through the formatters.
        if let date = utcStamp(value) { return date }
        if let date = isoFractional.date(from: value) { return date }
        return isoPlain.date(from: value)
    }

    /// `YYYY-MM-DDTHH:MM:SS[.fff]Z`, the shape of `Date.toISOString()`.
    /// Days from the civil date by Howard Hinnant's algorithm, so no calendar
    /// is touched. Anything out of range is left to the formatters to reject.
    static func utcStamp(_ value: String) -> Date? {
        let bytes = Array(value.utf8)
        guard bytes.count >= 20, bytes.last == UInt8(ascii: "Z"),
              bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
              bytes[10] == UInt8(ascii: "T"), bytes[13] == UInt8(ascii: ":"), bytes[16] == UInt8(ascii: ":")
        else { return nil }
        func digits(_ range: Range<Int>) -> Int? {
            var number = 0
            for index in range {
                let digit = Int(bytes[index]) - 48
                guard (0...9).contains(digit) else { return nil }
                number = number * 10 + digit
            }
            return number
        }
        guard let year = digits(0..<4), let month = digits(5..<7), let day = digits(8..<10),
              let hour = digits(11..<13), let minute = digits(14..<16), let second = digits(17..<19),
              (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 60
        else { return nil }
        // Days from civil rolls an impossible day into the next month; the
        // formatters reject it, so it has to be theirs.
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let monthLength = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        guard day <= monthLength else { return nil }
        var fraction = 0.0
        if bytes.count > 20 {
            guard bytes[19] == UInt8(ascii: "."), bytes.count > 21 else { return nil }
            var scale = 0.1
            for index in 20..<(bytes.count - 1) {
                let digit = Int(bytes[index]) - 48
                guard (0...9).contains(digit) else { return nil }
                fraction += Double(digit) * scale
                scale /= 10
            }
        } else if bytes.count != 20 {
            return nil
        }
        let shiftedYear = month <= 2 ? year - 1 : year
        let era = (shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400
        let yearOfEra = shiftedYear - era * 400
        let dayOfYear = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        let days = era * 146_097 + dayOfEra - 719_468
        let seconds = Double(days) * 86_400 + Double(hour * 3_600 + minute * 60 + second)
        return Date(timeIntervalSince1970: seconds + fraction)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static func string(
        from date: Date,
        format: String,
        calendar: Calendar,
        timeZone: TimeZone,
        locale: Locale
    ) -> String {
        DateFormatterCache.shared.string(
            from: date,
            key: .init(template: format, calendar: calendar, timeZone: timeZone, locale: locale)
        )
    }
}

/// Every bubble formats its own stamp on every rebuild, and building the
/// formatter is the expensive part; keep one per locale, time zone, calendar
/// and template behind a lock instead of one per call.
private final class DateFormatterCache: @unchecked Sendable {
    struct Key: Hashable {
        /// A localized date template, or nil for the short time style.
        let template: String?
        let calendar: Calendar?
        let timeZone: TimeZone
        let locale: Locale
    }

    static let shared = DateFormatterCache()

    private let lock = NSLock()
    private var formatters: [Key: DateFormatter] = [:]

    func string(from date: Date, key: Key) -> String {
        lock.lock()
        defer { lock.unlock() }
        if let formatter = formatters[key] { return formatter.string(from: date) }
        let formatter = DateFormatter()
        formatter.locale = key.locale
        if let calendar = key.calendar { formatter.calendar = calendar }
        formatter.timeZone = key.timeZone
        if let template = key.template {
            formatter.setLocalizedDateFormatFromTemplate(template)
        } else {
            formatter.dateStyle = .none
            formatter.timeStyle = .short
        }
        formatters[key] = formatter
        return formatter.string(from: date)
    }
}

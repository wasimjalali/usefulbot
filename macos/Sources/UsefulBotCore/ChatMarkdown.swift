import Foundation

/// Block-level markdown, first ported from the removed web parser. The renderer
/// handles inline spans with AttributedString; this parser decides the blocks.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case unorderedList([String])
    /// `start` is the first item's number as written: a list broken by a
    /// paragraph carries on from 2, 3, not from 1 again.
    case orderedList([String], start: Int = 1)
    case code(lang: String, text: String)
    case table(MarkdownTable)
    case quote([MarkdownBlock])
    case rule
}

/// A pipe table. Every row is padded to the header's column count, so the
/// renderer can lay out a grid without re-checking each row.
public struct MarkdownTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable {
        case leading, center, trailing
    }

    public var headers: [String]
    public var alignments: [Alignment]
    public var rows: [[String]]

    public init(headers: [String], alignments: [Alignment], rows: [[String]]) {
        self.headers = headers
        self.alignments = alignments
        self.rows = rows
    }
}

public enum ChatMarkdownParser {
    private static let heading = try! NSRegularExpression(pattern: "^(#{1,3})\\s+(.+)$")
    private static let unordered = try! NSRegularExpression(pattern: "^\\s*[-*]\\s+")
    private static let ordered = try! NSRegularExpression(pattern: "^\\s*\\d+\\.\\s+")
    private static let quote = try! NSRegularExpression(pattern: "^\\s*>\\s?")
    /// Three or more of the same mark, alone on the line.
    private static let rule = try! NSRegularExpression(pattern: "^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$")
    /// The row under a table header: pipes, dashes, and optional alignment
    /// colons, and nothing else.
    private static let tableDelimiter = try! NSRegularExpression(
        pattern: "^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$"
    )

    public static func blocks(from source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var buffer: [String] = []
                i += 1
                while i < lines.count && !lines[i].hasPrefix("```") {
                    buffer.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }
                blocks.append(.code(lang: lang, text: buffer.joined(separator: "\n")))
                continue
            }
            // A pipe table is the header row plus the delimiter under it; both
            // have to be there, or a sentence containing a pipe becomes a
            // one-column table.
            if i + 1 < lines.count,
               let table = parseTable(lines, from: &i) {
                blocks.append(.table(table))
                continue
            }
            if matches(rule, in: line) {
                blocks.append(.rule)
                i += 1
                continue
            }
            if matches(quote, in: line) {
                var quoted: [String] = []
                while i < lines.count, matches(quote, in: lines[i]) {
                    quoted.append(replace(quote, in: lines[i], with: ""))
                    i += 1
                }
                // The de-quoted lines go back through the same block parser,
                // so a fenced code block inside a quote stays a code block
                // instead of rendering as loose backticks and inline code.
                blocks.append(.quote(Self.blocks(from: quoted.joined(separator: "\n"))))
                continue
            }
            if let match = firstMatch(heading, in: line) {
                let hashes = substring(line, match.range(at: 1))
                let text = substring(line, match.range(at: 2))
                blocks.append(.heading(level: hashes.count, text: text))
                i += 1
                continue
            }
            if matches(unordered, in: line) {
                var items: [String] = []
                while i < lines.count, matches(unordered, in: lines[i]) {
                    items.append(replace(unordered, in: lines[i], with: ""))
                    i += 1
                }
                blocks.append(.unorderedList(items))
                continue
            }
            if matches(ordered, in: line) {
                let digits = line.drop(while: { $0 == " " || $0 == "\t" }).prefix(while: \.isNumber)
                let start = Int(digits.prefix(9)) ?? 1
                var items: [String] = []
                while i < lines.count, matches(ordered, in: lines[i]) {
                    items.append(replace(ordered, in: lines[i], with: ""))
                    i += 1
                }
                blocks.append(.orderedList(items, start: start))
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
                continue
            }
            var paragraph = [line]
            i += 1
            while i < lines.count {
                let next = lines[i]
                if next.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if next.hasPrefix("```") { break }
                if firstMatch(heading, in: next) != nil { break }
                if matches(unordered, in: next) { break }
                if matches(ordered, in: next) { break }
                if matches(quote, in: next) { break }
                if matches(rule, in: next) { break }
                // A table's header row is an ordinary line until the delimiter
                // under it proves otherwise, so the paragraph has to let go of
                // it rather than swallow the whole table as prose.
                if i + 1 < lines.count, next.contains("|"), matches(tableDelimiter, in: lines[i + 1]) { break }
                paragraph.append(next)
                i += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    /// Read a pipe table starting at `i`, or leave `i` alone and return nil.
    ///
    /// A table is a header row, a delimiter row, then body rows until the first
    /// line that is not one. Rows are padded or trimmed to the header's column
    /// count so the renderer never has to check a row's length.
    private static func parseTable(_ lines: [String], from i: inout Int) -> MarkdownTable? {
        let header = lines[i]
        guard header.contains("|"), matches(tableDelimiter, in: lines[i + 1]) else { return nil }
        let headers = splitRow(header)
        guard headers.count > 1 else { return nil }
        let alignments = splitRow(lines[i + 1]).map { cell -> MarkdownTable.Alignment in
            let trimmed = cell.trimmingCharacters(in: .whitespaces)
            let left = trimmed.hasPrefix(":")
            let right = trimmed.hasSuffix(":")
            if left && right { return .center }
            if right { return .trailing }
            return .leading
        }
        var rows: [[String]] = []
        var j = i + 2
        while j < lines.count {
            let line = lines[j]
            if !line.contains("|") || line.trimmingCharacters(in: .whitespaces).isEmpty { break }
            var cells = splitRow(line)
            if cells.count < headers.count {
                cells.append(contentsOf: Array(repeating: "", count: headers.count - cells.count))
            } else if cells.count > headers.count {
                cells = Array(cells.prefix(headers.count))
            }
            rows.append(cells)
            j += 1
        }
        i = j
        return MarkdownTable(
            headers: headers,
            alignments: normalized(alignments, to: headers.count),
            rows: rows
        )
    }

    /// Cells of one table row, without the outer pipes. An escaped `\|` stays
    /// inside its cell rather than splitting it.
    private static func splitRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|") { trimmed.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in trimmed {
            if escaped {
                // Only the pipe loses its escape; any other escaped character
                // keeps its backslash (`C:\path` stays `C:\path`).
                current.append(character == "|" ? "|" : "\\\(character)")
                escaped = false
                continue
            }
            if character == "\\" {
                escaped = true
                continue
            }
            if character == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                continue
            }
            current.append(character)
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func normalized(
        _ alignments: [MarkdownTable.Alignment],
        to count: Int
    ) -> [MarkdownTable.Alignment] {
        if alignments.count == count { return alignments }
        if alignments.count > count { return Array(alignments.prefix(count)) }
        return alignments + Array(repeating: .leading, count: count - alignments.count)
    }

    private static func firstMatch(_ regex: NSRegularExpression, in line: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line))
    }

    private static func matches(_ regex: NSRegularExpression, in line: String) -> Bool {
        firstMatch(regex, in: line) != nil
    }

    private static func substring(_ line: String, _ range: NSRange) -> String {
        guard let range = Range(range, in: line) else { return line }
        return String(line[range])
    }

    private static func replace(_ regex: NSRegularExpression, in line: String, with value: String) -> String {
        regex.stringByReplacingMatches(
            in: line,
            range: NSRange(line.startIndex..., in: line),
            withTemplate: value
        )
    }
}

/// Parsed markdown, kept between renders.
///
/// A streamed reply republishes the whole transcript on every delta, and the
/// eager `VStack` behind the chat rebuilds every row's body when it does. At
/// 300 rows that measured about 80ms of main-thread work per publish, almost
/// all of it in `AttributedString(markdown:)`, which is what made a streaming
/// reply render in visible steps. Both layers are memoized on the text itself,
/// so an unchanged row costs a dictionary lookup.
public enum ChatMarkdownCache {
    /// Room for a full transcript plus the inline spans inside it. Entries are
    /// small, and a streamed reply only ever adds one new key per delta.
    private static let capacity = 2048

    /// One bounded cache. Eviction is first-in-first-out: a streamed reply
    /// only ever adds one key per delta, so the stable rows stay resident.
    private final class Cache<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private let capacity: Int
        private var values: [String: Value] = [:]
        private var order: [String] = []

        init(capacity: Int) {
            self.capacity = capacity
        }

        func value(for key: String, build: (String) -> Value) -> Value {
            lock.lock()
            if let hit = values[key] {
                lock.unlock()
                return hit
            }
            lock.unlock()
            // Built outside the lock: parsing is the slow part and two callers
            // racing on the same key only costs one duplicate parse.
            let built = build(key)
            lock.lock()
            defer { lock.unlock() }
            if values[key] == nil {
                values[key] = built
                order.append(key)
                while order.count > capacity {
                    values[order.removeFirst()] = nil
                }
            }
            return built
        }

        func reset() {
            lock.lock()
            defer { lock.unlock() }
            values.removeAll()
            order.removeAll()
        }

        func count() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return order.count
        }
    }

    private static let blockCache = Cache<[MarkdownBlock]>(capacity: capacity)
    private static let inlineCache = Cache<[InlineSpan]>(capacity: capacity)

    /// The parse of a reply that is still growing. Every delta is a new
    /// text, and each one used to take a slot in the caches above: a long
    /// answer pushed the whole transcript's stable rows out behind its own
    /// prefixes. A streaming row keeps one slot per row instead, replaced on
    /// each delta. Its inline spans are kept for the current text and the
    /// one before it, so a paragraph that did not change is not re-parsed
    /// while the paragraph after it grows.
    private final class Transient: @unchecked Sendable {
        struct Entry {
            var source: String
            var blocks: [MarkdownBlock]
            var inline: [String: [InlineSpan]] = [:]
            var previousInline: [String: [InlineSpan]] = [:]
        }

        private let lock = NSLock()
        private let capacity: Int
        private var entries: [String: Entry] = [:]
        private var order: [String] = []

        init(capacity: Int) {
            self.capacity = capacity
        }

        func blocks(for key: String, source: String) -> [MarkdownBlock] {
            lock.lock()
            if let entry = entries[key], entry.source == source {
                lock.unlock()
                return entry.blocks
            }
            lock.unlock()
            let built = ChatMarkdownParser.blocks(from: source)
            lock.lock()
            defer { lock.unlock() }
            if var entry = entries[key] {
                entry.source = source
                entry.blocks = built
                entry.previousInline = entry.inline
                entry.inline = [:]
                entries[key] = entry
            } else {
                entries[key] = Entry(source: source, blocks: built)
                order.append(key)
                while order.count > capacity {
                    entries[order.removeFirst()] = nil
                }
            }
            return built
        }

        func inline(for key: String, source: String) -> [InlineSpan] {
            lock.lock()
            if let hit = entries[key]?.inline[source] {
                lock.unlock()
                return hit
            }
            if let carried = entries[key]?.previousInline[source] {
                entries[key]?.inline[source] = carried
                lock.unlock()
                return carried
            }
            lock.unlock()
            let built = ChatInline.parse(source)
            lock.lock()
            defer { lock.unlock() }
            // A row that was never given blocks under this key has no entry
            // to hold the spans; the parse is simply returned.
            entries[key]?.inline[source] = built
            return built
        }

        func reset() {
            lock.lock()
            defer { lock.unlock() }
            entries.removeAll()
            order.removeAll()
        }

        func count() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return order.count
        }
    }

    /// A few replies can stream at once (a group, a handoff), never many.
    private static let transient = Transient(capacity: 8)

    /// `streamingKey` names a row whose text is still growing: its parse
    /// lives in the transient slot for that key, not in the shared cache.
    public static func blocks(from source: String, streamingKey: String? = nil) -> [MarkdownBlock] {
        if let streamingKey { return transient.blocks(for: streamingKey, source: source) }
        return blockCache.value(for: source, build: ChatMarkdownParser.blocks(from:))
    }

    /// The inline spans. The renderer turns
    /// these into styled `AttributedString` runs. Apple's own markdown parser
    /// is not used (it italicizes `_snake_case_` and accepts emphasis forms the
    /// chat never draws).
    public static func inline(from source: String, streamingKey: String? = nil) -> [InlineSpan] {
        if let streamingKey { return transient.inline(for: streamingKey, source: source) }
        return inlineCache.value(for: source, build: ChatInline.parse)
    }

    /// Test hooks.
    public static func reset() {
        blockCache.reset()
        inlineCache.reset()
        transient.reset()
    }

    public static func entryCount() -> Int { blockCache.count() + inlineCache.count() }
    public static func streamingRowCount() -> Int { transient.count() }
}

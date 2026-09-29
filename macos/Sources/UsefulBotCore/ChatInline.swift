import Foundation

/// Inline spans (`ChatInline.parse`), first ported from the removed web parser.
///
/// Apple's `AttributedString(markdown:)` parses full CommonMark, which the chat
/// does not want: it italicizes `_snake_case_` identifiers, mangles stray `#`
/// and `*`, and accepts emphasis forms the chat never draws. This port keeps
/// only the four spans the chat renders: code, bold, emphasis, and http(s)
/// links.
public enum InlineSpanKind: Equatable, Sendable {
    case text
    case code
    case strong
    case emphasized
    case link
}

public struct InlineSpan: Equatable, Sendable {
    public var kind: InlineSpanKind
    public var text: String
    /// Link target for `.link` spans, empty otherwise.
    public var href: String

    public init(kind: InlineSpanKind, text: String, href: String = "") {
        self.kind = kind
        self.text = text
        self.href = href
    }
}

public enum ChatInline {
    // Order matters: the first alternative wins at a tie, mirroring the JS
    // regex. Single underscores are deliberately absent: snake_case names
    // (my_var_name) must not turn into italics.
    private static let spans = try! NSRegularExpression(
        pattern: "`([^`]+)`|\\*\\*([^*]+)\\*\\*|__([^_]+)__|\\*([^*]+)\\*|\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)"
    )

    public static func parse(_ source: String) -> [InlineSpan] {
        guard !source.isEmpty else { return [] }
        var result: [InlineSpan] = []
        var rest = source
        while !rest.isEmpty {
            let range = NSRange(rest.startIndex..., in: rest)
            guard let match = spans.firstMatch(in: rest, options: [], range: range),
                  let matchRange = Range(match.range, in: rest) else {
                result.append(InlineSpan(kind: .text, text: rest))
                break
            }
            if matchRange.lowerBound > rest.startIndex {
                result.append(InlineSpan(kind: .text, text: String(rest[rest.startIndex..<matchRange.lowerBound])))
            }
            func group(_ index: Int) -> String? {
                guard let groupRange = Range(match.range(at: index), in: rest) else { return nil }
                return String(rest[groupRange])
            }
            if let text = group(1) {
                result.append(InlineSpan(kind: .code, text: text))
            } else if let text = group(2) ?? group(3) {
                result.append(InlineSpan(kind: .strong, text: text))
            } else if let text = group(4) {
                result.append(InlineSpan(kind: .emphasized, text: text))
            } else if let label = group(5), let href = group(6) {
                result.append(InlineSpan(kind: .link, text: label, href: href))
            } else {
                result.append(InlineSpan(kind: .text, text: String(rest[matchRange])))
            }
            rest = String(rest[matchRange.upperBound...])
        }
        return result
    }
}

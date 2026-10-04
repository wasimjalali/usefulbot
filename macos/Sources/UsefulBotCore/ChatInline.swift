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
    //
    // Group 7 is a URL (a scheme URL, or a bare domain followed by a path) that
    // is kept as plain text so `__x__` and `*x*` inside it never split it; the
    // autolinker decides afterwards whether it is a link. It only wins where it
    // starts before any other span, so `**https://a.com**` is still bold, and
    // it only starts a word: at the start of the text, after whitespace, or after
    // one of `([{<"'` (so not `foohttps://x`, `src/a.com/x` or `bob@a.com/x`).
    private static let spans = try! NSRegularExpression(
        pattern: "`([^`]+)`|\\*\\*([^*]+)\\*\\*|__([^_]+)__|\\*([^*]+)\\*|\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)"
            + "|((?<![^\\s(\\[{<\"'])(?:(?i:https?)://|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?::[0-9]+)?/)[^\\s`]*)"
    )

    public static func parse(_ source: String) -> [InlineSpan] {
        let spans = parseMarkdown(source).flatMap { $0.kind == .text ? autolink($0.text) : [$0] }
        // A protected URL that did not become a link leaves two text spans side
        // by side; they read as one.
        var merged: [InlineSpan] = []
        for span in spans {
            if span.kind == .text, let last = merged.last, last.kind == .text {
                merged[merged.count - 1].text += span.text
            } else {
                merged.append(span)
            }
        }
        return merged
    }

    private static func parseMarkdown(_ source: String) -> [InlineSpan] {
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
            } else if let url = group(7) {
                result.append(InlineSpan(kind: .text, text: url))
            } else {
                result.append(InlineSpan(kind: .text, text: String(rest[matchRange])))
            }
            rest = String(rest[matchRange.upperBound...])
        }
        return result
    }

    /// Autolink grammar, applied to plain text only (never code, strong,
    /// emphasis or an existing Markdown link). Text is cut into
    /// whitespace-separated words; in each word, leading `([{<"'` is skipped,
    /// then trailing `. , ; : ! ? ' "` and `> ` are dropped, plus any `)` `]`
    /// `}` that has no opener inside the link (balanced ones stay).
    /// - `http://` or `https://` (any case) followed by a URL Foundation parses
    ///   with a host: linked as written, href is the text.
    /// - Otherwise a bare domain: no `@`, 2+ dot-separated labels of letters,
    ///   digits and inner hyphens, an optional `:port`, then nothing or a
    ///   path/query/fragment starting `/`, `?` or `#`; the last label must be a
    ///   real TLD (`tlds`). Labels like `e.g`, `1.2.3`, `foo.bar` fail, and so
    ///   do emails. A TLD that is also a common file extension (`fileLikeTLDs`:
    ///   README.md, setup.py, run.sh, notes.zip) needs a `/` path to count.
    ///   The href is `https://` + the text.
    /// - A scheme URL links only when its authority (host, port, userinfo) is
    ///   ASCII, so `https://аpple.com` (Cyrillic а) never shows lookalike text
    ///   over a punycode target. Non-ASCII in the path or query is fine.
    /// - A TLD that is also a common identifier word (`ambiguousTLDs`: `req.id`,
    ///   `user.name`, `Dockerfile.dev`) needs a `/` path or a `www.` first label
    ///   to count, the same way file-like TLDs need a path.
    /// - A word longer than `maxWordLength` is never linked: trimming and
    ///   validating it is not worth the main-thread time, and no real link is
    ///   that long.
    /// Other schemes never match, so `javascript:` and `data:` stay text.
    private static func autolink(_ text: String) -> [InlineSpan] {
        var result: [InlineSpan] = []
        var pending = ""
        var index = text.startIndex
        while index < text.endIndex {
            if text[index].isWhitespace {
                pending.append(text[index])
                index = text.index(after: index)
                continue
            }
            var end = index
            while end < text.endIndex, !text[end].isWhitespace { end = text.index(after: end) }
            let word = text[index..<end]
            index = end
            guard word.utf8.count <= maxWordLength, let (lead, link) = linkRange(in: word) else {
                pending += word
                continue
            }
            pending += word[word.startIndex..<lead]
            if !pending.isEmpty { result.append(InlineSpan(kind: .text, text: pending)); pending = "" }
            let visible = String(word[lead..<link])
            let lower = visible.lowercased()
            let isScheme = lower.hasPrefix("http://") || lower.hasPrefix("https://")
            result.append(InlineSpan(kind: .link, text: visible, href: isScheme ? visible : "https://" + visible))
            pending += word[link...]
        }
        if result.isEmpty { return text.isEmpty ? [] : [InlineSpan(kind: .text, text: text)] }
        if !pending.isEmpty { result.append(InlineSpan(kind: .text, text: pending)) }
        return result
    }

    /// The linked part of a word as (start, end), or nil when it is not a link.
    private static func linkRange(in word: Substring) -> (String.Index, String.Index)? {
        var start = word.startIndex
        while start < word.endIndex, "([{<\"'".contains(word[start]) { start = word.index(after: start) }
        var end = word.endIndex
        // Counted once and kept up to date as characters are dropped, so the
        // trim is linear however many closers a word ends in.
        var opened = [Character: Int]()
        var closed = [Character: Int]()
        for character in word[start...] {
            switch character {
            case "(", "[", "{": opened[character, default: 0] += 1
            case ")", "]", "}": closed[character, default: 0] += 1
            default: break
            }
        }
        while start < end {
            let last = word[word.index(before: end)]
            let drop: Bool
            switch last {
            case ".", ",", ";", ":", "!", "?", "'", "\"", ">": drop = true
            case ")": drop = closed[")", default: 0] > opened["(", default: 0]
            case "]": drop = closed["]", default: 0] > opened["[", default: 0]
            case "}": drop = closed["}", default: 0] > opened["{", default: 0]
            default: drop = false
            }
            guard drop else { break }
            if closed[last] != nil { closed[last, default: 0] -= 1 }
            end = word.index(before: end)
        }
        let candidate = String(word[start..<end])
        guard !candidate.isEmpty else { return nil }
        let lower = candidate.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            guard authorityIsASCII(candidate),
                  let url = URL(string: candidate), url.host?.isEmpty == false else { return nil }
            return (start, end)
        }
        return isBareDomain(candidate) ? (start, end) : nil
    }

    /// The part of a scheme URL between `://` and the first `/`, `?` or `#`.
    private static func authorityIsASCII(_ url: String) -> Bool {
        guard let scheme = url.range(of: "://") else { return false }
        let rest = url[scheme.upperBound...]
        let authority = rest[rest.startIndex..<(rest.firstIndex(where: { "/?#".contains($0) }) ?? rest.endIndex)]
        return authority.allSatisfy(\.isASCII)
    }

    private static func isBareDomain(_ candidate: String) -> Bool {
        let hostEnd = candidate.firstIndex(where: { "/?#".contains($0) }) ?? candidate.endIndex
        var host = candidate[candidate.startIndex..<hostEnd]
        let hasPath = hostEnd < candidate.endIndex && candidate[hostEnd] == "/"
        if let colon = host.lastIndex(of: ":") {
            let port = host[host.index(after: colon)...]
            guard !port.isEmpty, port.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
            host = host[host.startIndex..<colon]
        }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        for label in labels {
            guard !label.isEmpty, label.first != "-", label.last != "-",
                  label.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return false }
        }
        let tld = labels[labels.count - 1].lowercased()
        guard tlds.contains(tld) else { return false }
        // `Xcode.app/Contents/Developer` is a path inside an app bundle, not a site.
        // Case-insensitive and on a path boundary: `Foo.app/contents/x` is a bundle path,
        // `usefulbuild.app/ContentsPage` is a site.
        if tld == "app" {
            let rest = candidate[hostEnd...].lowercased()
            if rest.hasPrefix("/contents") {
                let next = rest.dropFirst("/contents".count).first
                if next == nil || "/?#".contains(next!) { return false }
            }
        }
        if hasPath { return true }
        // `www.` is a site whatever the TLD (`www.orf.at`, `www.example.am`).
        if labels[0].lowercased() == "www" { return true }
        if fileLikeTLDs.contains(tld) { return false }
        return !ambiguousTLDs.contains(tld)
    }

    /// A word of this length or more is left as text (see `autolink`).
    private static let maxWordLength = 2_048

    /// TLDs that are also words programmers put after a dot: a bare
    /// `name.<word>` is usually a property or a file, so it links only with a
    /// path or a `www.` first label (`example.dev/docs`, `www.example.dev`).
    /// `ai` stays out on purpose: `x.ai` is a real site people write bare.
    private static let ambiguousTLDs: Set<String> = [
        "id", "name", "dev", "app", "host", "page", "link", "top", "is", "in", "me", "site", "co", "to", "it", "my", "us",
    ]

    /// TLDs that are also file extensions: a bare `name.<ext>` is a file.
    private static let fileLikeTLDs: Set<String> = [
        "md", "py", "sh", "zip", "mov", "rs", "pl", "cc", "cs", "so", "pm", "ps", "cr", "ml", "mm", "sc", "mk",
        // main.tf, Makefile.am, player.gd, Code.gs, obj.at
        "tf", "am", "gd", "gs", "at",
    ]

    /// Generic TLDs people actually write, plus every country code.
    private static let tlds: Set<String> = Set((
        "com org net edu gov mil int info biz io ai app dev co me tv xyz online site tech store blog cloud page "
        + "news live world shop club top pro name mobi design agency studio email solutions services systems "
        + "network digital media works team tools zone link click host space website fun life today wiki social "
        + "software academy company center group ltd inc llc zip mov "
        + "ac ad ae af ag al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz "
        + "ca cc cd cf cg ch ci ck cl cm cn cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk "
        + "fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in iq ir "
        + "is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md mg mh mk "
        + "ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk "
        + "pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy "
        + "sz tc td tf tg th tj tk tl tm tn to tr tt tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za "
        + "zm zw"
    ).split(separator: " ").map(String.init))
}

import Foundation
import Testing
@testable import UsefulBotCore

/// Plain URLs and bare domains in bot text become `.link` spans, the same
/// span kind a Markdown link produces, so rendering and opening are shared.
@Suite(.serialized) struct ChatAutolinkTests {
    private func links(_ source: String) -> [InlineSpan] {
        ChatInline.parse(source).filter { $0.kind == .link }
    }

    private func plain(_ source: String) -> Bool {
        let spans = ChatInline.parse(source)
        return spans == [InlineSpan(kind: .text, text: source)]
    }

    @Test func schemeUrlsKeepEverythingExactly() {
        #expect(ChatInline.parse("https://example.com/path?x=1#frag") == [
            InlineSpan(kind: .link, text: "https://example.com/path?x=1#frag", href: "https://example.com/path?x=1#frag"),
        ])
        #expect(ChatInline.parse("go to http://example.com now") == [
            InlineSpan(kind: .text, text: "go to "),
            InlineSpan(kind: .link, text: "http://example.com", href: "http://example.com"),
            InlineSpan(kind: .text, text: " now"),
        ])
    }

    @Test func bareDomainsGetHttps() {
        for domain in ["example.com", "a.com", "httpbin.org", "https-tools.io/x", "docs.example.co.uk/path", "x.ai", "example.io", "example.com:8080/x", "Example.COM"] {
            #expect(ChatInline.parse("see \(domain) ok") == [
                InlineSpan(kind: .text, text: "see "),
                InlineSpan(kind: .link, text: domain, href: "https://" + domain),
                InlineSpan(kind: .text, text: " ok"),
            ], "\(domain)")
        }
    }

    @Test func trailingPunctuationIsExcluded() {
        for tail in [".", ",", ";", ":", "!", "?", "'", "\"", ".\"", "?!"] {
            #expect(links("see https://a.com/x\(tail)").map(\.href) == ["https://a.com/x"], "\(tail)")
            #expect(links("see a.com\(tail)").map(\.href) == ["https://a.com"], "\(tail)")
        }
    }

    @Test func unmatchedClosingParenIsExcludedBalancedKept() {
        #expect(links("(see https://a.com/x)").map(\.href) == ["https://a.com/x"])
        #expect(links("(see https://a.com/x).").map(\.href) == ["https://a.com/x"])
        #expect(links("(example.com)").map(\.href) == ["https://example.com"])
        #expect(links("https://en.wikipedia.org/wiki/Foo_(bar)").map(\.href) == ["https://en.wikipedia.org/wiki/Foo_(bar)"])
        #expect(links("(https://en.wikipedia.org/wiki/Foo_(bar)).").map(\.href) == ["https://en.wikipedia.org/wiki/Foo_(bar)"])
    }

    @Test func angleBracketedUrlLinksTheUrl() {
        #expect(links("<https://a.com/x>").map(\.href) == ["https://a.com/x"])
    }

    @Test func codeSpansAreUntouched() {
        #expect(ChatInline.parse("`https://a.com` and `b.com`") == [
            InlineSpan(kind: .code, text: "https://a.com"),
            InlineSpan(kind: .text, text: " and "),
            InlineSpan(kind: .code, text: "b.com"),
        ])
    }

    @Test func markdownLinksAreNeverDoubleWrapped() {
        #expect(ChatInline.parse("[example.com](https://example.com/a)") == [
            InlineSpan(kind: .link, text: "example.com", href: "https://example.com/a"),
        ])
        #expect(ChatInline.parse("[docs](https://a.com/x) then b.com.") == [
            InlineSpan(kind: .link, text: "docs", href: "https://a.com/x"),
            InlineSpan(kind: .text, text: " then "),
            InlineSpan(kind: .link, text: "b.com", href: "https://b.com"),
            InlineSpan(kind: .text, text: "."),
        ])
    }

    @Test func mixedAndMultilineMessages() {
        let spans = ChatInline.parse("Read **this** at docs.example.com/a,\nthen [x](https://x.org) and https://y.org/z?q=1.\nbye")
        #expect(spans.filter { $0.kind == .link }.map(\.href) == [
            "https://docs.example.com/a", "https://x.org", "https://y.org/z?q=1",
        ])
        #expect(spans.map(\.text).joined() == "Read this at docs.example.com/a,\nthen x and https://y.org/z?q=1.\nbye")
    }

    @Test func unsafeSchemesNeverLink() {
        for text in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "vbscript:x", "ftp://a.com/x", "mailto:a@b.com", "[x](javascript:alert(1))"] {
            #expect(links(text).isEmpty, "\(text)")
        }
    }

    @Test func dottedTextIsNotALink() {
        for text in [
            "e.g.", "i.e.", "1.2.3", "v2.0.1", "3.14", "file.txt", "config.json", "index.ts", "foo.bar",
            "window.location", "README.md", "setup.py", "run.sh", "notes.zip", "clip.mov", "main.rs",
            "node.js", "package.json", "next.config.js", "a..com", "-a.com", "a-.com", "a_b.com", "end.",
            "user@example.com", "first.last@example.com", "mail me: bob@example.com.", "@example.com",
            "~/notes.md", "../foo.com", "https://", "foo.com@x",
        ] {
            #expect(links(text).isEmpty, "\(text)")
        }
    }

    @Test func fileNameCollisionsLinkWithAPathOrScheme() {
        #expect(links("see example.md/x").map(\.href) == ["https://example.md/x"])
        #expect(links("https://example.md").map(\.href) == ["https://example.md"])
        #expect(links("see example.sh/install").map(\.href) == ["https://example.sh/install"])
    }

    @Test func linksInsideBlocks() {
        let blocks = ChatMarkdownParser.blocks(from: "# Title b.com\n\n- item https://a.com/x\n\n> quote c.org")
        var found: [String] = []
        func collect(_ block: MarkdownBlock) {
            switch block {
            case .heading(_, let text), .paragraph(let text): found += links(text).map(\.href)
            case .unorderedList(let items), .orderedList(let items, _): items.forEach { found += links($0).map(\.href) }
            case .quote(let inner): inner.forEach(collect)
            default: break
            }
        }
        blocks.forEach(collect)
        #expect(found == ["https://b.com", "https://a.com/x", "https://c.org"])
    }

    @Test func fencedCodeBlocksStayCode() {
        let blocks = ChatMarkdownParser.blocks(from: "```\nhttps://a.com b.com\n```")
        #expect(blocks == [.code(lang: "", text: "https://a.com b.com")])
    }

    @Test func streamedPrefixesEndWithTheRightLink() {
        ChatMarkdownCache.reset()
        let message = "Docs are at https://docs.example.com/guide?a=1#top (see also example.org)."
        var text = ""
        for character in message {
            text.append(character)
            let streamed = ChatMarkdownCache.inline(from: text, streamingKey: "row-1")
            #expect(streamed == ChatInline.parse(text))
        }
        let final = ChatMarkdownCache.inline(from: message, streamingKey: "row-1")
        #expect(final.filter { $0.kind == .link }.map(\.href) == [
            "https://docs.example.com/guide?a=1#top", "https://example.org",
        ])
        // The shared cache keys on text, so a partial never answers for the whole.
        _ = ChatMarkdownCache.inline(from: "https://exa")
        #expect(ChatMarkdownCache.inline(from: "https://example.com/a").filter { $0.kind == .link }.map(\.href) == ["https://example.com/a"])
    }
}

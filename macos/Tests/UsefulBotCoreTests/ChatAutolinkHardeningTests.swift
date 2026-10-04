import Foundation
import Testing
@testable import UsefulBotCore

/// Review fixes for the autolinker: linear trimming, ASCII hosts, identifiers
/// that are not domains, and URLs that emphasis must not split.
@Suite(.serialized) struct ChatAutolinkHardeningTests {
    private func links(_ source: String) -> [InlineSpan] {
        ChatInline.parse(source).filter { $0.kind == .link }
    }

    private func isPlain(_ source: String) -> Bool {
        ChatInline.parse(source) == [InlineSpan(kind: .text, text: source)]
    }

    private func seconds(_ body: () -> Void) -> Double {
        let clock = ContinuousClock()
        let elapsed = clock.measure(body)
        return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    }

    // MARK: - 1. Linear trimming and a word cap

    @Test(.timeLimit(.minutes(1))) func aHugeRunOfClosingBracketsParsesQuickly() {
        for closer in [")", "]", "}"] {
            let word = String(repeating: closer, count: 100_000)
            let elapsed = seconds { _ = ChatInline.parse(word) }
            #expect(elapsed < 1, "100k \(closer) took \(elapsed)s")
            let url = "https://a.com/x" + word
            let elapsedUrl = seconds { _ = ChatInline.parse(url) }
            #expect(elapsedUrl < 1, "url + 100k \(closer) took \(elapsedUrl)s")
        }
    }

    @Test func aWordPastTheCapIsNeverAutolinked() {
        let long = "https://a.com/" + String(repeating: "a", count: 3_000)
        #expect(isPlain(long))
        let ok = "https://a.com/" + String(repeating: "a", count: 1_500)
        #expect(links(ok).map(\.href) == [ok])
    }

    @Test func trimmingStillDropsOnlyUnbalancedClosers() {
        let tail = String(repeating: ")", count: 1_500)
        #expect(links("see https://a.com/x\(tail)").map(\.href) == ["https://a.com/x"])
        #expect(links("https://a.com/f(1)(2)))").map(\.href) == ["https://a.com/f(1)(2)"])
        #expect(links("https://a.com/[x]]").map(\.href) == ["https://a.com/[x]"])
        #expect(links("https://a.com/{x}}.").map(\.href) == ["https://a.com/{x}"])
    }

    // MARK: - 2. ASCII hosts only

    @Test func aSchemeUrlWithANonAsciiHostIsNotLinked() {
        #expect(isPlain("https://\u{0430}pple.com"))
        #expect(isPlain("see https://\u{0430}pple.com/login now"))
        #expect(isPlain("https://user@\u{0430}pple.com"))
        #expect(isPlain("https://m\u{00FC}nchen.de"))
    }

    @Test func aNonAsciiPathOnAnAsciiHostStillLinks() {
        #expect(links("https://a.com/\u{043F}\u{0443}\u{0442}\u{044C}").count == 1)
        #expect(links("https://xn--pple-43d.com").map(\.href) == ["https://xn--pple-43d.com"])
    }

    // MARK: - 3. Identifiers that look like domains

    @Test func dottedIdentifiersWithAmbiguousTldsAreNotLinks() {
        for text in [
            "req.id", "user.name", "Dockerfile.dev", "cfg.app", "self.host", "obj.page", "node.link", "a.top",
            "x.is", "y.in", "z.me", "foo.site", "bar.co", "baz.to", "my.it", "a.my", "b.us", "item.id:",
        ] {
            #expect(links(text).isEmpty, "\(text)")
            #expect(links("see \(text) here").isEmpty, "\(text)")
        }
    }

    @Test func moreFileExtensionsThatAreCountryCodesAreNotLinks() {
        for text in ["main.tf", "Makefile.am", "player.gd", "Code.gs", "obj.at"] {
            #expect(links(text).isEmpty, "\(text)")
            #expect(links("see \(text) here").isEmpty, "\(text)")
        }
        // With a path they are still a site.
        #expect(links("see example.at/wien").map(\.href) == ["https://example.at/wien"])
    }

    @Test func anAppBundlePathIsNotALink() {
        for text in ["Xcode.app/Contents/Developer", "Safari.app/Contents", "Xcode.app/Contents/"] {
            #expect(links(text).isEmpty, "\(text)")
            #expect(links("run \(text) now").isEmpty, "\(text)")
        }
        // The Contents rule ignores case and needs a path boundary.
        for text in ["Foo.app/contents/x", "Foo.app/CONTENTS", "Foo.app/contents?x"] {
            #expect(links(text).isEmpty, "\(text)")
        }
        #expect(links("see usefulbuild.app/ContentsPage").map(\.href) == ["https://usefulbuild.app/ContentsPage"])
        #expect(links("see usefulbuild.app/contents-of").map(\.href) == ["https://usefulbuild.app/contents-of"])
    }

    @Test func wwwLinksEvenOnAFileLikeTld() {
        #expect(links("see www.orf.at").map(\.href) == ["https://www.orf.at"])
        #expect(links("see www.example.am ok").map(\.href) == ["https://www.example.am"])
        #expect(links("see WWW.example.tf").map(\.href) == ["https://WWW.example.tf"])
        // Without www. a file-like name is still a file.
        #expect(links("see main.tf").isEmpty)
    }

    @Test func ambiguousTldsLinkWithAPathOrWww() {
        #expect(links("see example.dev/docs").map(\.href) == ["https://example.dev/docs"])
        #expect(links("see www.example.dev").map(\.href) == ["https://www.example.dev"])
        #expect(links("see WWW.example.id").map(\.href) == ["https://WWW.example.id"])
        #expect(links("https://example.dev").map(\.href) == ["https://example.dev"])
        #expect(links("see usefulbuild.app/pricing").map(\.href) == ["https://usefulbuild.app/pricing"])
    }

    @Test func obviousDomainsStillLink() {
        for domain in ["example.com", "a.com", "x.ai", "example.org", "example.net", "example.io", "docs.example.co.uk"] {
            #expect(links("see \(domain) ok").map(\.href) == ["https://" + domain], "\(domain)")
        }
    }

    // MARK: - 4. URLs win over emphasis

    @Test func underscoresInsideAUrlDoNotSplitIt() {
        #expect(ChatInline.parse("https://a.com/x__y__z") == [
            InlineSpan(kind: .link, text: "https://a.com/x__y__z", href: "https://a.com/x__y__z"),
        ])
        #expect(ChatInline.parse("see https://a.com/__init__ now") == [
            InlineSpan(kind: .text, text: "see "),
            InlineSpan(kind: .link, text: "https://a.com/__init__", href: "https://a.com/__init__"),
            InlineSpan(kind: .text, text: " now"),
        ])
    }

    @Test func asterisksInsideAUrlDoNotSplitIt() {
        #expect(ChatInline.parse("https://a.com/x*y*z") == [
            InlineSpan(kind: .link, text: "https://a.com/x*y*z", href: "https://a.com/x*y*z"),
        ])
        #expect(links("https://a.com/a*b and *c*").map(\.href) == ["https://a.com/a*b"])
    }

    @Test func aBareDomainWithAPathIsProtectedToo() {
        #expect(ChatInline.parse("example.com/a__b__c") == [
            InlineSpan(kind: .link, text: "example.com/a__b__c", href: "https://example.com/a__b__c"),
        ])
    }

    @Test func realEmphasisAroundAUrlStillWorks() {
        let spans = ChatInline.parse("**bold** and __strong__ and *em* then https://a.com/x__y__z.")
        #expect(spans.filter { $0.kind == .strong }.map(\.text) == ["bold", "strong"])
        #expect(spans.filter { $0.kind == .emphasized }.map(\.text) == ["em"])
        #expect(spans.filter { $0.kind == .link }.map(\.href) == ["https://a.com/x__y__z"])
        // Emphasis that wraps the URL wins, as before: it renders bold, unlinked.
        #expect(ChatInline.parse("**https://a.com**") == [InlineSpan(kind: .strong, text: "https://a.com")])
        #expect(ChatInline.parse("(https://a.com/x__y__)") == [
            InlineSpan(kind: .text, text: "("),
            InlineSpan(kind: .link, text: "https://a.com/x__y__", href: "https://a.com/x__y__"),
            InlineSpan(kind: .text, text: ")"),
        ])
    }

    @Test func aSchemeGluedToAWordIsNotProtected() {
        // Not a URL start: the old behaviour for text like `foohttps://x`.
        #expect(links("foohttps://a.com/x").isEmpty)
        // Nor does a bare domain after a path separator or an @.
        #expect(links("see src/a.com/x and ../b.com/y and bob@c.com/z").isEmpty)
    }
}

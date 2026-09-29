import Testing
@testable import UsefulBotCore

@Suite struct LocalHostTests {
    @Test func blocksLoopbackInEverySpelling() {
        let hosts = [
            "localhost", "LOCALHOST.", "localhost.",
            "127.0.0.1", "127.1", "127.0.0.1.", "0x7f.0.0.1", "0177.0.0.1", "2130706433", "0.0.0.0",
        ]
        for host in hosts {
            #expect(LocalHost.isLocal(host), "expected \(host) to be local")
        }
    }

    @Test func blocksPrivateLinkLocalAndLocalNames() {
        let hosts = [
            "10.0.0.5", "192.168.1.20", "172.16.0.1", "172.31.255.255", "169.254.10.10",
            "printer.local", "thing.localhost",
        ]
        for host in hosts {
            #expect(LocalHost.isLocal(host), "expected \(host) to be local")
        }
    }

    @Test func blocksLocalIPv6() {
        let hosts = [
            "::", "::1", "fe80::1", "fc00::1", "fd00::1",
            "::ffff:127.0.0.1", "::ffff:192.168.0.1", "::127.0.0.1",
            "::ffff:0:127.0.0.1", "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:0:0:1",
            "0:0:0:0:0:ffff:7f00:1", "[::1]", "fe80::1%en0",
        ]
        for host in hosts {
            #expect(LocalHost.isLocal(host), "expected \(host) to be local")
        }
    }

    @Test func allowsThePublicWeb() {
        let hosts = [
            "example.com", "www.example.com", "8.8.8.8", "1.1.1.1",
            "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8",
        ]
        for host in hosts {
            #expect(!LocalHost.isLocal(host), "expected \(host) to be public")
        }
    }

    @Test func unknownHostsFailClosed() {
        #expect(LocalHost.isLocal(nil))
        #expect(LocalHost.isLocal(""))
        #expect(LocalHost.isLocal("   "))
        #expect(LocalHost.isLocal("::ffff:999.0.0.1"))
        #expect(LocalHost.isLocal("gggg::1"))
        #expect(LocalHost.isLocal("08.0.0.1"))
        #expect(LocalHost.isLocal("127..0.1"))
        #expect(LocalHost.isLocal("127.0.0.1\u{200B}"))
        #expect(!LocalHost.isLocal("cafe.de"))
    }
    @Test func loopbackIsNarrowerThanLocal() {
        // Credential-bearing bases allow loopback only.
        for host in ["localhost", "127.0.0.1", "127.1", "0x7f.0.0.1", "[::1]", "::1"] {
            #expect(LocalHost.isLoopback(host), "expected \(host) to be loopback")
        }
        for host in ["192.168.1.4", "10.0.0.5", "printer.local", "example.com", "169.254.1.1"] {
            #expect(!LocalHost.isLoopback(host), "expected \(host) to be non-loopback")
        }
        // The unspecified address is local but not loopback: a credential-
        // bearing base must not be built on a wildcard bind.
        #expect(LocalHost.isLocal("::"))
        #expect(!LocalHost.isLoopback("::"))
    }
}

@Suite struct ComposerDraftTests {
    @Test func exactDraftClears() {
        #expect(ComposerDraft.remainder("hello", afterSending: "hello") == "")
    }

    @Test func keptTypingOnlyLosesTheSentPart() {
        #expect(ComposerDraft.remainder("hellonext", afterSending: "hello") == "next")
    }

    @Test func editedTextIsLeftAlone() {
        #expect(ComposerDraft.remainder("rewritten", afterSending: "hello") == "rewritten")
        #expect(ComposerDraft.remainder("", afterSending: "hello") == "")
    }

    @Test func clipCountsUTF16UnitsWithoutSplittingGraphemes() {
        #expect(ComposerDraft.clip("hello", toUTF16: 3) == "hel")
        #expect(ComposerDraft.clip("a😀b", toUTF16: 3) == "a😀")
        #expect(ComposerDraft.clip("a😀b", toUTF16: 2) == "a")
        #expect(ComposerDraft.clip("abc", toUTF16: 10) == "abc")
    }
}

@Suite struct LongMessageTests {
    @Test func shortMessagesNeverMeasure() {
        #expect(!LongMessage.mayFold("one\n\ntwo\n\nthree"))
        #expect(!LongMessage.mayFold(String(repeating: "x", count: 150)))
        #expect(LongMessage.mayFold(String(repeating: "x", count: 151)))
        #expect(LongMessage.mayFold((1...9).map(String.init).joined(separator: "\n")))
        #expect(LongMessage.mayFold((1...9).map(String.init).joined(separator: "\r")))
        #expect(LongMessage.mayFold((1...9).map(String.init).joined(separator: "\r\n")))
    }

    @Test func aFoldHasToHideAboutTwoLines() {
        #expect(!LongMessage.hidesEnough(full: 220, preview: 200))
        #expect(LongMessage.hidesEnough(full: 240, preview: 200))
    }
}

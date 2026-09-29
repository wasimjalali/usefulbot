import Foundation
import Testing
@testable import UsefulBotCore

/// Serialized: the cache is process-wide by design, so these cannot run
/// alongside each other and still reason about its size.
@Suite(.serialized) struct ChatMarkdownCacheTests {
    @Test func theCacheReturnsTheSameBlocksAsTheParser() {
        ChatMarkdownCache.reset()
        let source = """
        # Title

        Some **bold** text with `code`.

        - one
        - two
        """
        let direct = ChatMarkdownParser.blocks(from: source)
        #expect(ChatMarkdownCache.blocks(from: source) == direct)
        // The second call is the memoized one and must not drift.
        #expect(ChatMarkdownCache.blocks(from: source) == direct)
        #expect(ChatMarkdownCache.entryCount() == 1)
    }

    @Test func inlineSpansAreParsedOncePerDistinctText() {
        ChatMarkdownCache.reset()
        let source = "a **bold** word"
        let first = ChatMarkdownCache.inline(from: source)
        let second = ChatMarkdownCache.inline(from: source)
        #expect(first.map(\.text).joined() == "a bold word")
        #expect(first == second)
        #expect(ChatMarkdownCache.entryCount() == 1)
        // A different text is its own entry, which is what a streamed delta is.
        _ = ChatMarkdownCache.inline(from: "a **bold** word!")
        #expect(ChatMarkdownCache.entryCount() == 2)
    }

    @Test func theCacheStaysBounded() {
        ChatMarkdownCache.reset()
        // A long reply streams one new key per delta; the cache must not grow
        // with the session.
        for index in 0..<5_000 {
            _ = ChatMarkdownCache.blocks(from: "delta \(index)")
            _ = ChatMarkdownCache.inline(from: "delta \(index)")
        }
        #expect(ChatMarkdownCache.entryCount() <= 4_096)
        // Still correct after eviction.
        #expect(ChatMarkdownCache.blocks(from: "delta 4999") == [.paragraph("delta 4999")])
        ChatMarkdownCache.reset()
        #expect(ChatMarkdownCache.entryCount() == 0)
    }

    @Test func aStreamingRowKeepsOneSlotAndLeavesTheSharedCacheAlone() {
        ChatMarkdownCache.reset()
        var text = ""
        for word in ["The", "answer", "is", "**forty", "two**."] {
            text += (text.isEmpty ? "" : " ") + word
            let blocks = ChatMarkdownCache.blocks(from: text, streamingKey: "msg-1")
            #expect(blocks == ChatMarkdownParser.blocks(from: text))
            for case .paragraph(let content) in blocks {
                #expect(ChatMarkdownCache.inline(from: content, streamingKey: "msg-1") == ChatInline.parse(content))
            }
        }
        // Five prefixes, five inline parses: none of them in the shared cache.
        #expect(ChatMarkdownCache.entryCount() == 0)
        #expect(ChatMarkdownCache.streamingRowCount() == 1)
        // The same text again is the slot, not a parse.
        #expect(ChatMarkdownCache.blocks(from: text, streamingKey: "msg-1") == ChatMarkdownParser.blocks(from: text))
        // Once the row settles it renders through the shared cache like any other.
        #expect(ChatMarkdownCache.blocks(from: text) == ChatMarkdownParser.blocks(from: text))
        #expect(ChatMarkdownCache.entryCount() == 1)
    }

    @Test func aParagraphThatDidNotChangeCarriesItsSpansToTheNextDelta() {
        ChatMarkdownCache.reset()
        let first = "Stable **first** paragraph.\n\nSecond"
        let second = "Stable **first** paragraph.\n\nSecond paragraph grew"
        _ = ChatMarkdownCache.blocks(from: first, streamingKey: "msg-2")
        let spans = ChatMarkdownCache.inline(from: "Stable **first** paragraph.", streamingKey: "msg-2")
        _ = ChatMarkdownCache.inline(from: "Second", streamingKey: "msg-2")
        _ = ChatMarkdownCache.blocks(from: second, streamingKey: "msg-2")
        // Carried over, not re-parsed (same value either way; this pins the path).
        #expect(ChatMarkdownCache.inline(from: "Stable **first** paragraph.", streamingKey: "msg-2") == spans)
        #expect(ChatMarkdownCache.inline(from: "Second paragraph grew", streamingKey: "msg-2") == ChatInline.parse("Second paragraph grew"))
        #expect(ChatMarkdownCache.entryCount() == 0)
    }

    @Test func streamingSlotsAreBoundedByRow() {
        ChatMarkdownCache.reset()
        for row in 0..<50 {
            _ = ChatMarkdownCache.blocks(from: "row \(row)", streamingKey: "msg-\(row)")
        }
        #expect(ChatMarkdownCache.streamingRowCount() <= 8)
        #expect(ChatMarkdownCache.blocks(from: "row 49", streamingKey: "msg-49") == [.paragraph("row 49")])
    }
}

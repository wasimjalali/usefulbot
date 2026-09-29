import Foundation

public struct TranscriptRow: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case user, assistant, handoff, post, note, widget, image, page
        /// A failed turn, where its reply would have been.
        case failure
    }

    public var id: String
    public var kind: Kind
    public var text: String
    public var author: String?
    public var authorBotId: String?
    public var targetBotIds: [String]
    public var handoffId: String?
    /// Parsed server write time. Live stream rows have none until the durable
    /// event lands, so the transcript renders timestamps only when dated.
    public var at: Date?
    /// The app or server the host just added. A note that carries one is
    /// drawn as a card, not as a line of text.
    public var connectedName: String?
    public var connectedLogo: String?
    /// The generated image this row renders, when it is one. `text` keeps the
    /// prompt, so a reader that ignores the id still says what was drawn. On
    /// a page row, the Library item of the HTML file, and `text` its title.
    public var imageId: String?

    public init(
        id: String,
        kind: Kind,
        text: String,
        author: String? = nil,
        authorBotId: String? = nil,
        targetBotIds: [String] = [],
        handoffId: String? = nil,
        at: Date? = nil,
        connectedName: String? = nil,
        connectedLogo: String? = nil,
        imageId: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.author = author
        self.authorBotId = authorBotId
        self.targetBotIds = targetBotIds
        self.handoffId = handoffId
        self.at = at
        self.connectedName = connectedName
        self.connectedLogo = connectedLogo
        self.imageId = imageId
    }
}

/// Merge the durable agent transcript with the live session projection.
/// User and assistant messages are matched one-to-one by text, so two
/// identical turns both survive while a replayed echo does not duplicate.
///
/// The two sides interleave by time. Concatenating them put every durable row
/// before every live row, so a handoff or a routine run that landed just now
/// rendered at the very top of the chat and auto-scroll jumped with it.
public enum Transcript {
    /// Text with nothing to see: whitespace, the zero-width space and joiners,
    /// the word joiner and the byte-order mark. Other format characters can
    /// draw a glyph.
    static func isBlank(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { scalar in
            scalar.properties.isWhitespace || (0x200B...0x200D).contains(scalar.value)
                || scalar.value == 0x2060 || scalar.value == 0xFEFF
        }
    }

    public static func merge(
        events: [AgentEvent],
        messages: [ChatMessage],
        failures: [FailureMark] = []
    ) -> [TranscriptRow] {
        var durable: [TranscriptRow] = []
        var durableUserCounts: [String: Int] = [:]
        var durableAssistantCounts: [String: Int] = [:]
        var durableIds = Set<String>()
        for event in events {
            durableIds.insert(event.id)
            let kind = kindFor(event.kind)
            // Strip on both sides of the merge: if a durable row ever stored
            // the proxy-injected prefix, it must still pair with its live echo.
            let text = EveStream.stripThreadPrefix(event.text)
            // A reply stored with its thinking inline shows only its answer,
            // and one that was all thinking shows nothing. Pairing below
            // still counts the stored text, which is what the echo carries.
            let shown = kind == .assistant ? EveStream.withoutLeadingThink(text) : text
            // A model can write only a blank line before a tool call; it has
            // nothing to show and rendered as an empty bubble.
            if kind == .assistant, Self.isBlank(shown) {
                durableAssistantCounts[text, default: 0] += 1
                continue
            }
            durable.append(TranscriptRow(
                id: event.id,
                kind: kind,
                text: kind == .widget ? (event.widgetId ?? text) : shown,
                // Only a durable author label renders; the web treats an
                // unattributed stream echo as unlabelled.
                author: event.authorName,
                authorBotId: event.authorBotId,
                targetBotIds: event.targetBotIds,
                handoffId: event.handoffId,
                at: TranscriptBlocks.date(fromISO8601: event.at),
                connectedName: kind == .note ? event.connectedName : nil,
                connectedLogo: kind == .note ? event.connectedLogo : nil,
                imageId: kind == .image || kind == .page ? event.imageId : nil
            ))
            if kind == .user {
                durableUserCounts[text, default: 0] += 1
            } else if kind == .assistant {
                durableAssistantCounts[text, default: 0] += 1
            }
        }
        var live: [TranscriptRow] = []
        // Each failure goes under the row it names, whether or not that row
        // renders from this side: one the durable side holds still places it.
        var failuresByAnchor: [String: [FailureMark]] = [:]
        var unplaced: [FailureMark] = []
        let messageIds = Set(messages.map(\.id))
        for mark in failures {
            if let anchor = mark.anchorId, messageIds.contains(anchor) {
                failuresByAnchor[anchor, default: []].append(mark)
            } else {
                unplaced.append(mark)
            }
        }
        func failureRow(_ mark: FailureMark, after message: ChatMessage?) -> TranscriptRow {
            TranscriptRow(id: mark.rowId, kind: .failure, text: mark.failure.rowMessage, at: mark.at ?? message?.at)
        }
        for message in messages {
            defer {
                for mark in failuresByAnchor.removeValue(forKey: message.id) ?? [] {
                    live.append(failureRow(mark, after: message))
                }
            }
            // The same event id must never render twice, even if the stream
            // rewrote its text between the delta and the completion.
            if durableIds.contains(message.id) { continue }
            switch message.role {
            case .user:
                if consume(&durableUserCounts, message.text) { continue }
                // A turn the pump sent (handoff, connect resume) is background
                // plumbing, not something the owner typed.
                if EveStream.isHandoffEnvelope(message.text) { continue }
                live.append(TranscriptRow(id: message.id, kind: .user, text: message.text, at: message.at))
            case .assistant:
                if consume(&durableAssistantCounts, message.text) { continue }
                let shown = EveStream.withoutLeadingThink(message.text)
                if Self.isBlank(shown) { continue }
                live.append(TranscriptRow(
                    id: message.id,
                    kind: .assistant,
                    text: shown,
                    at: message.at
                ))
            }
        }
        // A mark whose row is gone still says what happened, at the end.
        live.append(contentsOf: unplaced.map { failureRow($0, after: nil) })
        return interleave(durable: durable, live: live)
    }

    /// Stable chronological merge of two lists that are each already in order.
    /// Ties go to the durable side, so a reply and the row it was written from
    /// keep the order the server wrote them in.
    static func interleave(durable: [TranscriptRow], live: [TranscriptRow]) -> [TranscriptRow] {
        if durable.isEmpty { return live }
        if live.isEmpty { return durable }
        // An undated durable row is history the server never stamped; an
        // undated live row is the turn happening right now.
        let durableKeys = sortKeys(durable, undated: .distantPast)
        let liveKeys = sortKeys(live, undated: .distantFuture)
        var merged: [TranscriptRow] = []
        merged.reserveCapacity(durable.count + live.count)
        var left = 0
        var right = 0
        while left < durable.count, right < live.count {
            if durableKeys[left] <= liveKeys[right] {
                merged.append(durable[left])
                left += 1
            } else {
                merged.append(live[right])
                right += 1
            }
        }
        merged.append(contentsOf: durable[left...])
        merged.append(contentsOf: live[right...])
        return merged
    }

    /// A sort key per row: its own time, or the newest time seen before it in
    /// the same list. Carrying forward keeps an undated row where it was
    /// appended, and clamping keeps each list non-decreasing, which is what the
    /// merge needs to stay stable.
    private static func sortKeys(_ rows: [TranscriptRow], undated: Date) -> [Date] {
        var keys: [Date] = []
        keys.reserveCapacity(rows.count)
        // Nil until the first dated row: `undated` is the fallback for rows
        // ahead of it, not a floor the real stamps have to beat.
        var carried: Date?
        for row in rows {
            if let at = row.at, carried == nil || at > carried! { carried = at }
            keys.append(carried ?? undated)
        }
        return keys
    }

    /// Attribute an untagged group reply by the member mention in the user turn
    /// that produced it.
    public static func attributeGroupReplies(_ rows: [TranscriptRow], roster: [Speaker]) -> [TranscriptRow] {
        guard !roster.isEmpty else { return rows }
        var next = rows
        // One forward pass. The user turn in force is carried along and its
        // mentions are resolved once, on the first reply that needs them: a
        // backward search plus a fresh regex parse per bubble made a long run
        // of replies under one message quadratic, on every publish.
        var previousUserText: String?
        var resolved = false
        var speaker: Speaker?
        for (index, row) in rows.enumerated() {
            if row.kind == .user {
                previousUserText = row.text
                resolved = false
                speaker = nil
                continue
            }
            if row.kind != .assistant || row.authorBotId != nil { continue }
            guard let previousUserText else { continue }
            if !resolved {
                resolved = true
                let mentions = Threads.parseMentions(previousUserText, bots: roster).mentionIds
                speaker = mentions.count == 1 ? roster.first(where: { $0.id == mentions[0] }) : nil
            }
            guard let speaker else { continue }
            next[index].authorBotId = speaker.id
            next[index].author = speaker.name
        }
        return next
    }

    private static func kindFor(_ raw: String) -> TranscriptRow.Kind {
        switch raw {
        case "user": return .user
        case "assistant": return .assistant
        case "handoff": return .handoff
        case "post": return .post
        case "widget": return .widget
        case "image": return .image
        case "page": return .page
        default: return .note
        }
    }

    private static func consume(_ counts: inout [String: Int], _ text: String) -> Bool {
        guard let remaining = counts[text], remaining > 0 else { return false }
        counts[text] = remaining - 1
        return true
    }
}

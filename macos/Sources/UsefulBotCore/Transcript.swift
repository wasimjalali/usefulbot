import Foundation

public struct TranscriptRow: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case user, assistant, note, widget, image, page
        /// A failed turn, where its reply would have been.
        case failure
        /// The line under an owner message that never reached the bot, with
        /// its Send again and Edit.
        case unsent
        /// A proposal card (connect an app or a server); `text` is its id.
        case card
    }

    public var id: String
    public var kind: Kind
    public var text: String
    /// Parsed server write time. Live stream rows have none until the durable
    /// event lands, so the transcript renders timestamps only when dated.
    public var at: Date?
    /// The generated image this row renders, when it is one. `text` keeps the
    /// prompt, so a reader that ignores the id still says what was drawn. On
    /// a page row, the Library item of the HTML file, and `text` its title.
    public var imageId: String?
    /// What an owner message carried besides its words.
    public var attachments: [RowAttachment]
    /// An owner message the engine holds behind a running turn.
    public var queued: Bool

    public init(
        id: String,
        kind: Kind,
        text: String,
        at: Date? = nil,
        imageId: String? = nil,
        attachments: [RowAttachment] = [],
        queued: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.at = at
        self.imageId = imageId
        self.attachments = attachments
        self.queued = queued
    }
}

/// Helpers the transcript is drawn with. The rows themselves come from
/// `ChatProjection.transcript`.
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

    /// Each refused message goes under the row it was sent after, as the
    /// owner's bubble and its failed line. One whose row is gone goes by its
    /// time: after the last timed row at or before it, or before the first
    /// timed row when every one is later. Only when no row has a time does it
    /// go last.
    static func placeUnsent(_ unsent: [UnsentMessage], in rows: [TranscriptRow]) -> [TranscriptRow] {
        guard !unsent.isEmpty else { return rows }
        let ids = Set(rows.map(\.id))
        var byAnchor: [String: [UnsentMessage]] = [:]
        var afterIndex: [Int: [UnsentMessage]] = [:]
        var beforeIndex: [Int: [UnsentMessage]] = [:]
        var atEnd: [UnsentMessage] = []
        let firstTimed = rows.firstIndex { $0.at != nil }
        for message in unsent {
            if let anchor = message.anchorId, ids.contains(anchor) {
                byAnchor[anchor, default: []].append(message)
            } else if let firstTimed {
                if let index = rows.lastIndex(where: { ($0.at ?? .distantFuture) <= message.at }) {
                    afterIndex[index, default: []].append(message)
                } else {
                    beforeIndex[firstTimed, default: []].append(message)
                }
            } else {
                atEnd.append(message)
            }
        }
        func pair(_ message: UnsentMessage) -> [TranscriptRow] {
            [
                TranscriptRow(
                    id: message.bubbleRowId, kind: .user, text: message.echo, at: message.at,
                    attachments: message.files.map { RowAttachment(name: $0.name, mediaType: $0.mediaType ?? "", size: $0.bytes) }
                ),
                TranscriptRow(id: message.lineRowId, kind: .unsent, text: message.line, at: message.at),
            ]
        }
        var placed: [TranscriptRow] = []
        placed.reserveCapacity(rows.count + unsent.count * 2)
        for (index, row) in rows.enumerated() {
            for message in beforeIndex[index] ?? [] { placed.append(contentsOf: pair(message)) }
            placed.append(row)
            for message in byAnchor[row.id] ?? [] { placed.append(contentsOf: pair(message)) }
            for message in afterIndex[index] ?? [] { placed.append(contentsOf: pair(message)) }
        }
        for message in atEnd { placed.append(contentsOf: pair(message)) }
        return placed
    }
}

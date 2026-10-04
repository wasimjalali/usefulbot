import Foundation

/// The reply a refused message was quoting, kept so Edit and a refused Retry
/// can put it back.
public struct UnsentQuote: Codable, Equatable, Sendable {
    public var botId: String
    public var text: String
    public var author: String?

    public init(botId: String, text: String, author: String?) {
        self.botId = botId
        self.text = text
        self.author = author
    }
}

/// A message the owner sent that the server refused before eve took the turn.
/// eve never stored it, so a reload cannot bring it back: it is kept here,
/// per bot, and drawn as the owner's bubble with a failed line under it.
public struct UnsentMessage: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    /// What a resend posts: the composed text, files and quote included.
    public var message: String
    /// What the bubble shows: the message with a `[file: ...]` line per image.
    public var echo: String
    /// The composer's own text, which is what Edit puts back.
    public var draft: String
    /// The files that went with it. Image bytes are not persisted; the
    /// sent-image store holds them and they are read back by name.
    public var files: [Attachment]
    public var reason: String
    public var at: Date
    /// The transcript row the bubble sits under; nil or gone means the end.
    public var anchorId: String?
    /// The reply this message was quoting, if any.
    public var quote: UnsentQuote?

    public init(
        id: String,
        message: String,
        echo: String,
        draft: String,
        files: [Attachment],
        reason: String,
        at: Date,
        anchorId: String?,
        quote: UnsentQuote? = nil
    ) {
        self.id = id
        self.message = message
        self.echo = echo
        self.draft = draft
        self.files = files
        self.reason = reason
        self.at = at
        self.anchorId = anchorId
        self.quote = quote
    }

    /// What a held file needs before it can go out again.
    public enum HeldState: Equatable, Sendable {
        /// Its bytes or body are here.
        case ready
        /// A picture read back from disk: the sent-image store holds its bytes.
        case restoreImage
        /// A file whose body was never written to disk.
        case attachAgain
    }

    public static func heldState(of file: Attachment) -> HeldState {
        if file.isImage { return .ready }
        if file.mediaType != nil { return .restoreImage }
        return file.text == nil ? .attachAgain : .ready
    }

    private static let bubblePrefix = "unsent-"
    private static let linePrefix = "unsent-line-"

    /// The transcript row of the owner's bubble.
    public var bubbleRowId: String { Self.bubblePrefix + id }
    /// The transcript row of the failed line under it.
    public var lineRowId: String { Self.linePrefix + id }

    public static func isUnsentRowId(_ rowId: String) -> Bool { rowId.hasPrefix(bubblePrefix) }

    /// The message a failed line's row belongs to; nil for any other row.
    public static func id(fromLineRowId rowId: String) -> String? {
        guard rowId.hasPrefix(linePrefix) else { return nil }
        return String(rowId.dropFirst(linePrefix.count))
    }

    /// The line under the bubble. Nothing in it implies the bot got the text.
    public var line: String { "Not sent. \(reason)" }

    public static let editBlockedHint = "Clear the composer to edit this message"

    /// Edit puts the message in the composer, which only works when nothing
    /// is there: text put in front of or behind a draft is the stacking this
    /// replaces.
    public static func canEdit(draft: String, attachmentCount: Int) -> Bool {
        attachmentCount == 0 && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The composer note for a send that never reached eve.
    public static func note(reason: String) -> String { "Your message wasn't sent. \(reason)" }

    /// Why a send was refused, in words. A server that never answered has no
    /// description of its own, so it is named here.
    public static func reason(for error: Error) -> String {
        if !(error is URLError), let described = (error as? LocalizedError)?.errorDescription {
            return described
        }
        return "Couldn't reach the local server."
    }

    /// The copy that goes to disk: files keep their name and type, never their
    /// bytes or body. A picture is read back from the sent-image store; any
    /// other file has to be attached again.
    fileprivate var persistable: UnsentMessage {
        var copy = self
        copy.files = files.map { file in
            var kept = file
            kept.dataUrl = nil
            if file.mediaType == nil { kept.text = nil }
            return kept
        }
        return copy
    }
}

/// One bot's refused messages, oldest first.
public struct UnsentList: Equatable, Sendable {
    public private(set) var items: [UnsentMessage]

    public init(_ items: [UnsentMessage] = []) { self.items = items }

    /// Most refused messages kept per bot; the oldest go first.
    public static let cap = 20

    public mutating func add(_ message: UnsentMessage) {
        items.append(message)
        if items.count > Self.cap { items.removeFirst(items.count - Self.cap) }
    }

    /// Puts an updated copy of a message where the old one was.
    public mutating func replace(_ message: UnsentMessage) {
        if let index = items.firstIndex(where: { $0.id == message.id }) {
            items[index] = message
        } else {
            add(message)
        }
    }

    public func item(_ id: String) -> UnsentMessage? { items.first { $0.id == id } }

    public mutating func remove(_ id: String) { items.removeAll { $0.id == id } }

    /// Takes a message out for Edit, only when the composer is empty.
    public mutating func edit(_ id: String, draft: String, attachmentCount: Int) -> UnsentMessage? {
        guard UnsentMessage.canEdit(draft: draft, attachmentCount: attachmentCount),
              let found = item(id) else { return nil }
        remove(id)
        return found
    }

    public mutating func clear() { items = [] }
}

/// The refused messages on disk, one JSON file per bot, so they outlive a
/// chat switch and a relaunch.
public struct UnsentStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    private func file(_ botId: String) -> URL {
        // A bot id is a path piece here, never a path.
        directory.appendingPathComponent(URL(fileURLWithPath: botId).lastPathComponent + ".json")
    }

    public func load(botId: String) -> [UnsentMessage] {
        let url = file(botId)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        do {
            return try JSONDecoder().decode([UnsentMessage].self, from: Data(contentsOf: url))
        } catch {
            NSLog("Useful Bot: could not read unsent messages for a chat: \(error.localizedDescription)")
            return []
        }
    }

    /// An empty list removes the file.
    public func save(_ messages: [UnsentMessage], botId: String) throws {
        let url = file(botId)
        guard !messages.isEmpty else {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(messages.suffix(UnsentList.cap).map(\.persistable))
        try data.write(to: url, options: .atomic)
    }

    public func clear(botId: String) {
        let url = file(botId)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            NSLog("Useful Bot: could not clear unsent messages for a chat: \(error.localizedDescription)")
        }
    }
}

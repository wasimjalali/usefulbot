import Foundation

/// The chat protocol v1 wire types (SPEC 5.12 and 6, fixtures in
/// `test/fixtures/chat-protocol/`). Decoding is tolerant: an unknown field is
/// ignored, an unknown row kind or event type is skipped by its reader.

/// A file the owner attached, as a row and the turn body carry it.
public struct RowAttachment: Codable, Equatable, Sendable {
    public var name: String
    public var mediaType: String
    public var size: Int

    public init(name: String, mediaType: String, size: Int) {
        self.name = name
        self.mediaType = mediaType
        self.size = size
    }

    public var isImage: Bool { mediaType.hasPrefix("image/") }
}

/// One transcript row from `GET /api/chats/:id/rows` or a `row` event. One
/// flat shape for every kind; each kind reads its own fields.
public struct ChatRow: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case user, assistant, note, failure, question, unsent, image, page, widget, card
    }

    public var rowId: String
    /// Nil for a kind this build does not know; such a row is kept for its
    /// place and never drawn.
    public var kind: Kind?
    public var turnId: String?
    public var at: String?
    public var text: String = ""
    public var clientId: String?
    public var attachments: [RowAttachment] = []
    /// A user row still waiting behind a running turn.
    public var queued = false
    public var searchResults: [SearchChip] = []
    // note
    public var source: String?
    // failure
    public var code: String?
    public var detail: String?
    public var retryAfterMs: Int?
    public var resetsAt: Date?
    // question
    public var requestId: String?
    public var prompt: String?
    public var options: [OwnerQuestion.Option] = []
    public var allowFreeform = false
    // unsent
    public var reason: String?
    // image, page, widget, card
    public var imageId: String?
    public var mediaId: String?
    public var title: String?
    public var widgetId: String?
    public var callId: String?
    public var connectionId: String?
    public var toolName: String?
    public var proposalId: String?

    public var id: String { rowId }

    public init(rowId: String, kind: Kind?, turnId: String? = nil, at: String? = nil, text: String = "") {
        self.rowId = rowId
        self.kind = kind
        self.turnId = turnId
        self.at = at
        self.text = text
    }

    /// The failure this row records.
    public var failure: TurnFailure {
        TurnFailure(code: code ?? "engine_error", detail: detail ?? "", retryAfterMs: retryAfterMs, resetsAt: resetsAt)
    }

    /// The question this row asked.
    public var question: OwnerQuestion? {
        guard let requestId, !requestId.isEmpty else { return nil }
        return OwnerQuestion(id: requestId, prompt: prompt ?? "", options: options, allowFreeform: allowFreeform)
    }
}

extension ChatRow: Decodable {
    enum CodingKeys: String, CodingKey {
        case rowId, kind, turnId, at, text, clientId, attachments, queued, searchResults, source
        case code, detail, retryAfterMs, resetsAt, requestId, prompt, options, allowFreeform
        case reason, imageId, mediaId, title, widgetId, callId, connectionId, toolName, proposalId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rowId = try c.decode(String.self, forKey: .rowId)
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(Kind.init(rawValue:))
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        clientId = try? c.decodeIfPresent(String.self, forKey: .clientId)
        attachments = (try? c.decode([RowAttachment].self, forKey: .attachments)) ?? []
        queued = (try? c.decode(Bool.self, forKey: .queued)) ?? false
        searchResults = ChatText.parseSearchChips((try? c.decodeIfPresent(JSONValue.self, forKey: .searchResults)) ?? nil)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        retryAfterMs = try? c.decodeIfPresent(Int.self, forKey: .retryAfterMs)
        resetsAt = Self.date(from: c, key: .resetsAt)
        requestId = try? c.decodeIfPresent(String.self, forKey: .requestId)
        prompt = try? c.decodeIfPresent(String.self, forKey: .prompt)
        options = (try? c.decode([OwnerQuestion.Option].self, forKey: .options)) ?? []
        allowFreeform = (try? c.decode(Bool.self, forKey: .allowFreeform)) ?? false
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        imageId = try? c.decodeIfPresent(String.self, forKey: .imageId)
        mediaId = try? c.decodeIfPresent(String.self, forKey: .mediaId)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        widgetId = try? c.decodeIfPresent(String.self, forKey: .widgetId)
        callId = try? c.decodeIfPresent(String.self, forKey: .callId)
        connectionId = try? c.decodeIfPresent(String.self, forKey: .connectionId)
        toolName = try? c.decodeIfPresent(String.self, forKey: .toolName)
        proposalId = try? c.decodeIfPresent(String.self, forKey: .proposalId)
    }

    /// `resetsAt` as epoch seconds (the router's own unit) or milliseconds, or
    /// an ISO 8601 string.
    static func date<K: CodingKey>(from container: KeyedDecodingContainer<K>, key: K) -> Date? {
        if let number = try? container.decodeIfPresent(Double.self, forKey: key), number > 0 {
            return Date(timeIntervalSince1970: number > 1e12 ? number / 1000 : number)
        }
        if let text = try? container.decodeIfPresent(String.self, forKey: key) {
            return ChatClock.date(from: text)
        }
        return nil
    }
}

/// ISO 8601 times with milliseconds, as the engine writes them.
public enum ChatClock {
    public static func date(from text: String?) -> Date? {
        TranscriptBlocks.date(fromISO8601: text)
    }
}

/// What a running turn was doing when the page was cut.
public struct RunningTurn: Decodable, Equatable, Sendable {
    public var turnId: String
    /// When this attempt started (a Retry is a new attempt of the same owner message).
    public var startedAt: String?
    public var partialText: String
    public var activity: TurnActivity?
    /// The row the partial text belongs to, when the engine says. Otherwise
    /// it is the turn's next assistant row.
    public var rowId: String?

    enum CodingKeys: String, CodingKey { case turnId, startedAt, partialText, activity, rowId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turnId = try c.decode(String.self, forKey: .turnId)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        partialText = (try? c.decode(String.self, forKey: .partialText)) ?? ""
        activity = (try? c.decodeIfPresent(ActivityWire.self, forKey: .activity))?.activity
        rowId = try? c.decodeIfPresent(String.self, forKey: .rowId)
    }
}

/// `{kind, tool?, detail?}` as rows pages and the status route carry it.
public struct ActivityWire: Decodable, Equatable, Sendable {
    public var kind: String
    public var tool: String?
    public var detail: String?

    public var activity: TurnActivity { TurnActivity(kind: kind, tool: tool, detail: detail) }
}

public struct QueuedMessage: Decodable, Equatable, Sendable {
    public var clientId: String
    public var text: String
}

/// A page of rows. Only the newest page carries `running`, `queued` and
/// `openQuestion`.
public struct RowsPage: Decodable, Equatable, Sendable {
    public var rows: [ChatRow]
    public var tailSeq: Int?
    public var epoch: String?
    public var running: RunningTurn?
    public var queued: [QueuedMessage]
    public var openQuestion: OwnerQuestion?
    public var nextBefore: String?

    enum CodingKeys: String, CodingKey { case rows, tailSeq, epoch, running, queued, openQuestion, nextBefore }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A row this build cannot read is dropped, not the page.
        rows = (try? c.decode([Lossy<ChatRow>].self, forKey: .rows))?.compactMap(\.value) ?? []
        tailSeq = try? c.decodeIfPresent(Int.self, forKey: .tailSeq)
        epoch = try? c.decodeIfPresent(String.self, forKey: .epoch)
        running = (try? c.decodeIfPresent(RunningTurn.self, forKey: .running)) ?? nil
        queued = (try? c.decode([QueuedMessage].self, forKey: .queued)) ?? []
        openQuestion = (try? c.decodeIfPresent(QuestionWire.self, forKey: .openQuestion))?.question
        nextBefore = try? c.decodeIfPresent(String.self, forKey: .nextBefore)
    }

    public init(
        rows: [ChatRow], tailSeq: Int? = nil, epoch: String? = nil, running: RunningTurn? = nil,
        queued: [QueuedMessage] = [], openQuestion: OwnerQuestion? = nil, nextBefore: String? = nil
    ) {
        self.rows = rows
        self.tailSeq = tailSeq
        self.epoch = epoch
        self.running = running
        self.queued = queued
        self.openQuestion = openQuestion
        self.nextBefore = nextBefore
    }
}

struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

struct QuestionWire: Decodable {
    var requestId: String
    var prompt: String
    var options: [OwnerQuestion.Option]
    var allowFreeform: Bool

    enum CodingKeys: String, CodingKey { case requestId, prompt, options, allowFreeform }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        prompt = (try? c.decode(String.self, forKey: .prompt)) ?? ""
        options = (try? c.decode([OwnerQuestion.Option].self, forKey: .options)) ?? []
        allowFreeform = (try? c.decode(Bool.self, forKey: .allowFreeform)) ?? options.isEmpty
    }

    var question: OwnerQuestion { OwnerQuestion(id: requestId, prompt: prompt, options: options, allowFreeform: allowFreeform) }
}

/// One NDJSON line of `GET /api/chats/:id/events`.
public struct ChatEvent: Decodable, Equatable, Sendable {
    public var seq: Int
    public var epoch: String
    public var at: String?
    public var chatId: String
    public var turnId: String?
    public var type: String

    public var origin: String?
    public var clientId: String?
    public var retry = false
    public var rowId: String?
    public var text: String?
    public var attachments: [RowAttachment] = []
    public var delta: String?
    /// `activity`: thinking, tool, compacting, retrying. On `input.requested`: question.
    public var kind: String?
    public var tool: String?
    public var detail: String?
    public var callId: String?
    public var name: String?
    public var isError = false
    public var widget: LiveWidgetCall?
    public var searchResults: [SearchChip] = []
    public var row: ChatRow?
    public var question: OwnerQuestion?
    public var requestId: String?
    public var code: String?
    public var retryAfterMs: Int?
    public var resetsAt: Date?
    public var messageKept = true
    // stream.ready
    public var tailSeq: Int?
    public var resync = false
    public var runningTurnId: String?

    public struct LiveWidgetCall: Decodable, Equatable, Sendable {
        public var connectionId: String
        public var toolName: String
        public var arguments: [String: JSONValue]

        enum CodingKeys: String, CodingKey { case connectionId, toolName, arguments }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            connectionId = try c.decode(String.self, forKey: .connectionId)
            toolName = try c.decode(String.self, forKey: .toolName)
            arguments = (try? c.decode([String: JSONValue].self, forKey: .arguments)) ?? [:]
        }
    }

    enum CodingKeys: String, CodingKey {
        case seq, epoch, at, chatId, turnId, type, origin, clientId, retry, rowId, text, attachments, delta
        case kind, tool, detail, callId, name, isError, widget, searchResults, row, requestId, prompt, options
        case allowFreeform, code, retryAfterMs, resetsAt, messageKept, tailSeq, resync, running
    }

    struct RunningRef: Decodable { var turnId: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = (try? c.decode(Int.self, forKey: .seq)) ?? 0
        epoch = (try? c.decode(String.self, forKey: .epoch)) ?? ""
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        chatId = (try? c.decode(String.self, forKey: .chatId)) ?? ""
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        type = try c.decode(String.self, forKey: .type)
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        clientId = try? c.decodeIfPresent(String.self, forKey: .clientId)
        retry = (try? c.decode(Bool.self, forKey: .retry)) ?? false
        rowId = try? c.decodeIfPresent(String.self, forKey: .rowId)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        attachments = (try? c.decode([RowAttachment].self, forKey: .attachments)) ?? []
        delta = try? c.decodeIfPresent(String.self, forKey: .delta)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        callId = try? c.decodeIfPresent(String.self, forKey: .callId)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        isError = (try? c.decode(Bool.self, forKey: .isError)) ?? false
        widget = (try? c.decodeIfPresent(LiveWidgetCall.self, forKey: .widget)) ?? nil
        searchResults = ChatText.parseSearchChips((try? c.decodeIfPresent(JSONValue.self, forKey: .searchResults)) ?? nil)
        row = (try? c.decodeIfPresent(ChatRow.self, forKey: .row)) ?? nil
        requestId = try? c.decodeIfPresent(String.self, forKey: .requestId)
        if type == "input.requested", let requestId, !requestId.isEmpty {
            let prompt = (try? c.decode(String.self, forKey: .prompt)) ?? ""
            let options = (try? c.decode([OwnerQuestion.Option].self, forKey: .options)) ?? []
            let freeform = (try? c.decode(Bool.self, forKey: .allowFreeform)) ?? options.isEmpty
            question = OwnerQuestion(id: requestId, prompt: prompt, options: options, allowFreeform: freeform)
        }
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        retryAfterMs = try? c.decodeIfPresent(Int.self, forKey: .retryAfterMs)
        resetsAt = ChatRow.date(from: c, key: .resetsAt)
        messageKept = (try? c.decode(Bool.self, forKey: .messageKept)) ?? true
        tailSeq = try? c.decodeIfPresent(Int.self, forKey: .tailSeq)
        resync = (try? c.decode(Bool.self, forKey: .resync)) ?? false
        runningTurnId = (try? c.decodeIfPresent(RunningRef.self, forKey: .running))?.turnId
    }

    /// One NDJSON line, or nil for a blank line or one this build cannot read.
    public static func parse(line: String) -> ChatEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ChatEvent.self, from: data)
    }

    public var activity: TurnActivity { TurnActivity(kind: kind ?? "thinking", tool: tool, detail: detail) }
}

/// One chat in the sidebar list, from `GET /api/chats`.
public struct ChatListItem: Decodable, Identifiable, Equatable, Sendable {
    public var chatId: String
    public var title: String
    public var preview: String
    public var routineId: String?
    public var updatedAt: Date?

    public var id: String { chatId }

    enum CodingKeys: String, CodingKey { case chatId, title, preview, routineId, updatedAt }

    public init(chatId: String, title: String, preview: String = "", routineId: String? = nil, updatedAt: Date? = nil) {
        self.chatId = chatId
        self.title = title
        self.preview = preview
        self.routineId = routineId
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try c.decode(String.self, forKey: .chatId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        preview = (try? c.decode(String.self, forKey: .preview)) ?? ""
        routineId = (try? c.decodeIfPresent(String.self, forKey: .routineId)) ?? nil
        updatedAt = ChatClock.date(from: try? c.decodeIfPresent(String.self, forKey: .updatedAt))
    }
}

public struct ChatsPage: Decodable, Equatable, Sendable {
    public var current: String?
    public var chats: [ChatListItem]
    public var nextBefore: String?

    enum CodingKeys: String, CodingKey { case current, chats, nextBefore }

    public init(current: String?, chats: [ChatListItem], nextBefore: String?) {
        self.current = current
        self.chats = chats
        self.nextBefore = nextBefore
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = (try? c.decodeIfPresent(String.self, forKey: .current)) ?? nil
        chats = (try? c.decode([Lossy<ChatListItem>].self, forKey: .chats))?.compactMap(\.value) ?? []
        nextBefore = (try? c.decodeIfPresent(String.self, forKey: .nextBefore)) ?? nil
    }
}

/// A message-text hit from `GET /api/chats/search`.
public struct ChatSearchHit: Decodable, Identifiable, Equatable, Sendable {
    public var chatId: String
    public var rowId: String
    public var title: String
    public var snippet: String
    public var at: Date?

    public var id: String { "\(chatId)/\(rowId)" }

    enum CodingKeys: String, CodingKey { case chatId, rowId, title, snippet, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try c.decode(String.self, forKey: .chatId)
        rowId = try c.decode(String.self, forKey: .rowId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        snippet = (try? c.decode(String.self, forKey: .snippet)) ?? ""
        at = ChatClock.date(from: try? c.decodeIfPresent(String.self, forKey: .at))
    }
}

/// One chat's live state from `GET /api/engine/status`.
public struct ChatStatus: Decodable, Equatable, Sendable {
    public struct Running: Decodable, Equatable, Sendable {
        public var turnId: String
        public var activity: TurnActivity?

        enum CodingKeys: String, CodingKey { case turnId, activity }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            turnId = try c.decode(String.self, forKey: .turnId)
            activity = (try? c.decodeIfPresent(ActivityWire.self, forKey: .activity))?.activity
        }
    }

    public struct LastTurn: Decodable, Equatable, Sendable {
        public var turnId: String
        /// completed, cancelled, failed, refused or interrupted.
        public var outcome: String
        public var endedAt: Date?

        enum CodingKeys: String, CodingKey { case turnId, outcome, endedAt }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            turnId = try c.decode(String.self, forKey: .turnId)
            outcome = (try? c.decode(String.self, forKey: .outcome)) ?? ""
            endedAt = ChatClock.date(from: try? c.decodeIfPresent(String.self, forKey: .endedAt))
        }

        public var failed: Bool { outcome == "failed" || outcome == "interrupted" || outcome == "refused" }
    }

    public var chatId: String
    public var running: Running?
    /// "question" or "approval" while the chat waits on the owner.
    public var waitingOnOwner: String?
    public var replyReadySince: Date?
    public var lastTurn: LastTurn?

    enum CodingKeys: String, CodingKey { case chatId, running, waitingOnOwner, replyReadySince, lastTurn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try c.decode(String.self, forKey: .chatId)
        running = (try? c.decodeIfPresent(Running.self, forKey: .running)) ?? nil
        waitingOnOwner = (try? c.decodeIfPresent(String.self, forKey: .waitingOnOwner)) ?? nil
        replyReadySince = ChatClock.date(from: (try? c.decodeIfPresent(String.self, forKey: .replyReadySince)) ?? nil)
        lastTurn = (try? c.decodeIfPresent(LastTurn.self, forKey: .lastTurn)) ?? nil
    }
}

public struct EngineStatus: Decodable, Equatable, Sendable {
    public var epoch: String
    public var cleanSlateNotice: Bool
    public var chats: [ChatStatus]

    enum CodingKeys: String, CodingKey { case epoch, cleanSlateNotice, chats }

    public init(epoch: String = "", cleanSlateNotice: Bool = false, chats: [ChatStatus] = []) {
        self.epoch = epoch
        self.cleanSlateNotice = cleanSlateNotice
        self.chats = chats
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        epoch = (try? c.decode(String.self, forKey: .epoch)) ?? ""
        cleanSlateNotice = (try? c.decode(Bool.self, forKey: .cleanSlateNotice)) ?? false
        chats = (try? c.decode([Lossy<ChatStatus>].self, forKey: .chats))?.compactMap(\.value) ?? []
    }
}

/// What the sidebar shows beside a chat's title, by the spec's priority:
/// waiting on the owner, working, failed, reply ready.
public enum ChatMark: Equatable, Sendable {
    case waiting, working, failed, replyReady
}

extension ChatStatus {
    /// The mark for this chat, or nil when it is idle (the row shows its
    /// time). A failed newest turn counts until a later turn starts, which is
    /// when `lastTurn` moves on.
    public var mark: ChatMark? {
        if waitingOnOwner != nil { return .waiting }
        if running != nil { return .working }
        if lastTurn?.failed == true { return .failed }
        if replyReadySince != nil { return .replyReady }
        return nil
    }
}

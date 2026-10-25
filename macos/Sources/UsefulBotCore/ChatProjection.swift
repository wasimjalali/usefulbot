import Foundation

/// The open chat as the engine serves it: the rows of `GET /api/chats/:id/rows`
/// plus the live events of `GET /api/chats/:id/events` applied after the
/// page's `tailSeq` (SPEC 6.2). The engine builds the rows, so there is
/// nothing to replay or fold here: an event adds, rewrites or removes a row,
/// moves the working state, or says the stream has to be read again.
public struct ChatProjection: Equatable, Sendable {
    /// An owner message sent from this app that no `message.user` has
    /// confirmed yet, or one the engine holds behind a running turn.
    public struct PendingSend: Equatable, Sendable {
        public var clientId: String
        public var text: String
        public var attachments: [RowAttachment]
        public var at: Date
        public var queued: Bool

        public init(clientId: String, text: String, attachments: [RowAttachment] = [], at: Date = Date(), queued: Bool = false) {
            self.clientId = clientId
            self.text = text
            self.attachments = attachments
            self.at = at
            self.queued = queued
        }

        /// The row id the bubble has until the engine names it.
        public var rowId: String { "local-\(clientId)" }
    }

    /// What an event did to the projection.
    public enum Applied: Equatable, Sendable {
        case applied
        /// Already seen, or not one that changes anything.
        case ignored
        /// Events were skipped: read the rows again.
        case gap
        /// The engine restarted, or the stream says its buffer no longer
        /// reaches back: read the rows again.
        case resync
    }

    public private(set) var rows: [ChatRow] = []
    public private(set) var epoch: String?
    /// The last event applied, or the page's `tailSeq` before any.
    public private(set) var tailSeq = 0
    /// The row to ask for the next older page from, nil at the start of the chat.
    public private(set) var nextBefore: String?
    public private(set) var loaded = false
    /// A turn is running in this chat.
    public private(set) var pending = false
    public private(set) var turnId: String?
    public private(set) var turnStartedAt: Date?
    public private(set) var activity: TurnActivity = .thinking
    /// The running step's call id, so the working mark can tell one command
    /// from the next even when the label is the same.
    public private(set) var activityCall: String?
    public private(set) var openQuestion: OwnerQuestion?
    /// Web results the newest turn surfaced, shown as chips under the transcript.
    public private(set) var searchHits: [SearchChip] = []
    /// Drawings the live turn made that the engine has not filed as rows yet.
    public private(set) var widgets: [LiveWidget] = []
    public private(set) var pendingSends: [PendingSend] = []

    public init() {}

    // MARK: - Loading

    /// The newest page replaces everything. Events with a `seq` above the
    /// page's `tailSeq` are the ones to apply after it.
    public mutating func load(_ page: RowsPage) {
        rows = page.rows
        epoch = page.epoch
        tailSeq = page.tailSeq ?? 0
        nextBefore = page.nextBefore
        loaded = true
        openQuestion = page.openQuestion
        widgets = []
        activityCall = nil
        pendingSends = pendingSends.filter { send in !page.rows.contains { $0.clientId == send.clientId } }
        for item in page.queued where !rows.contains(where: { $0.clientId == item.clientId }) {
            pendingSends.removeAll { $0.clientId == item.clientId }
            pendingSends.append(PendingSend(clientId: item.clientId, text: item.text, queued: true))
        }
        if let running = page.running {
            pending = true
            turnId = running.turnId
            turnStartedAt = ChatClock.date(from: running.startedAt)
                ?? rows.last { $0.turnId == running.turnId && $0.kind == .user }.flatMap { ChatClock.date(from: $0.at) }
                ?? turnStartedAt ?? Date()
            activity = running.activity ?? .thinking
            // With `rowId` the partial row is added when that row is missing; without it
            // the turn's first assistant row is the fallback.
            let missing = running.rowId.map { id in !rows.contains { $0.rowId == id } }
                ?? !rows.contains { $0.turnId == running.turnId && $0.kind == .assistant }
            if !running.partialText.isEmpty, missing {
                var partial = ChatRow(rowId: running.rowId ?? "\(running.turnId):a0", kind: .assistant, turnId: running.turnId)
                partial.text = running.partialText
                rows.append(partial)
            }
        } else {
            settle()
        }
        searchHits = newestSearchHits()
    }

    /// An older page goes in front.
    public mutating func prepend(_ page: RowsPage) {
        let known = Set(rows.map(\.rowId))
        rows = page.rows.filter { !known.contains($0.rowId) } + rows
        nextBefore = page.nextBefore
    }

    /// The owner sent a message from this app. It shows at the end at once and
    /// the engine's `message.user` takes it over.
    public mutating func addPending(_ send: PendingSend) {
        pendingSends.removeAll { $0.clientId == send.clientId }
        pendingSends.append(send)
    }

    public mutating func removePending(clientId: String) {
        pendingSends.removeAll { $0.clientId == clientId }
    }

    public mutating func markQueued(clientId: String) {
        if let index = rows.firstIndex(where: { $0.clientId == clientId && $0.kind == .user }) {
            rows[index].queued = true
        } else if let index = pendingSends.firstIndex(where: { $0.clientId == clientId }) {
            pendingSends[index].queued = true
        }
    }

    // MARK: - Events

    @discardableResult
    /// `resumed` is a stream opened with `after`: its replay follows `stream.ready`,
    /// so a tail past ours is not a gap there.
    public mutating func apply(_ event: ChatEvent, resumed: Bool = false) -> Applied {
        if event.type == "ping" {
            // A ping past the tail means events were missed (a settle among them).
            return loaded && event.seq > tailSeq ? .gap : .ignored
        }
        if event.type == "stream.ready" {
            if event.resync { return .resync }
            if let epoch, !event.epoch.isEmpty, event.epoch != epoch { return .resync }
            if loaded, !resumed, let ready = event.tailSeq, ready > tailSeq { return .gap }
            return .applied
        }
        guard loaded else { return .ignored }
        if let epoch, !event.epoch.isEmpty, event.epoch != epoch { return .resync }
        if event.seq <= tailSeq { return .ignored }
        if event.seq > tailSeq + 1 { return .gap }
        // The engine drops a failed attempt's rows when the owner retries: read
        // the rows again so the view and the fetched rows agree.
        if event.type == "turn.started", event.retry || event.resync { return .resync }
        tailSeq = event.seq
        switch event.type {
        case "turn.started": turnStarted(event)
        case "message.user": messageUser(event)
        case "message.queued": messageQueued(event)
        case "message.dropped": dropMessage(clientId: event.clientId)
        case "message.delta": messageDelta(event)
        case "message.final": messageFinal(event)
        case "activity":
            activity = event.activity
            if case .tool = activity {} else { activityCall = nil }
        case "tool.call": toolCall(event)
        case "tool.result": toolResult(event)
        case "row":
            if let row = event.row { upsert(row) }
        case "row.removed":
            // An attempt Pi retried and hid from the model: its streamed bubble goes.
            if let rowId = event.rowId { rows.removeAll { $0.rowId == rowId } }
        case "input.requested":
            if let question = event.question { openQuestion = question }
        case "input.resolved":
            if openQuestion?.id == event.requestId { openQuestion = nil }
        case "compaction.done":
            if case .compacting = activity { activity = .thinking }
        case "turn.completed", "turn.cancelled": settle()
        case "turn.failed": turnFailed(event)
        default: break
        }
        return .applied
    }

    private mutating func turnStarted(_ event: ChatEvent) {
        pending = true
        turnId = event.turnId
        turnStartedAt = ChatClock.date(from: event.at) ?? Date()
        activity = .thinking
        activityCall = nil
        searchHits = []
    }

    private mutating func settle() {
        pending = false
        turnId = nil
        turnStartedAt = nil
        activity = .thinking
        activityCall = nil
    }

    private mutating func messageUser(_ event: ChatEvent) {
        guard let rowId = event.rowId else { return }
        var row = ChatRow(rowId: rowId, kind: .user, turnId: event.turnId, at: event.at, text: event.text ?? "")
        row.clientId = event.clientId
        row.attachments = event.attachments
        if let clientId = event.clientId {
            pendingSends.removeAll { $0.clientId == clientId }
            // A retry sends the same message again: the bubble the first try
            // made takes the new row id.
            if let index = rows.firstIndex(where: { $0.clientId == clientId && $0.kind == .user }) {
                let wasQueued = rows[index].queued
                rows[index].rowId = rowId
                rows[index].turnId = event.turnId
                rows[index].queued = false
                // A dequeued message belongs after the rows the running turn added.
                if wasQueued, index != rows.count - 1 { rows.append(rows.remove(at: index)) }
                return
            }
        }
        upsert(row)
    }

    private mutating func messageQueued(_ event: ChatEvent) {
        guard let clientId = event.clientId else { return }
        if rows.contains(where: { $0.clientId == clientId && $0.kind == .user }) || pendingSends.contains(where: { $0.clientId == clientId }) {
            markQueued(clientId: clientId)
        } else {
            pendingSends.append(PendingSend(clientId: clientId, text: event.text ?? "", queued: true))
        }
    }

    /// The engine took a queued message back: an `unsent` row carries it now.
    private mutating func dropMessage(clientId: String?) {
        guard let clientId else { return }
        pendingSends.removeAll { $0.clientId == clientId }
        rows.removeAll { $0.clientId == clientId && $0.kind == .user && $0.queued }
    }

    private mutating func messageDelta(_ event: ChatEvent) {
        guard let rowId = event.rowId, let delta = event.delta else { return }
        activity = .working
        activityCall = nil
        if let index = rows.firstIndex(where: { $0.rowId == rowId }) {
            rows[index].text += delta
        } else {
            var row = ChatRow(rowId: rowId, kind: .assistant, turnId: event.turnId, at: event.at, text: delta)
            row.searchResults = searchHits
            rows.append(row)
        }
    }

    private mutating func messageFinal(_ event: ChatEvent) {
        guard let rowId = event.rowId, let text = event.text else { return }
        if let index = rows.firstIndex(where: { $0.rowId == rowId }) {
            rows[index].text = text
        } else {
            var row = ChatRow(rowId: rowId, kind: .assistant, turnId: event.turnId, at: event.at, text: text)
            row.searchResults = searchHits
            rows.append(row)
        }
    }

    private mutating func toolCall(_ event: ChatEvent) {
        if case .tool(let name, _) = activity, name == event.name { activityCall = event.callId }
        guard let call = event.widget, let callId = event.callId else { return }
        let id = String(callId.replacingOccurrences(of: "[^a-zA-Z0-9_-]", with: "", options: .regularExpression).prefix(80))
        // The server refuses a shorter id, and without one there is nothing
        // stable to key the drawing on.
        guard id.count >= 8, !widgets.contains(where: { $0.id == id }),
              !rows.contains(where: { $0.kind == .widget && $0.callId == callId }) else { return }
        widgets.append(LiveWidget(id: id, connectionId: call.connectionId, toolName: call.toolName, arguments: call.arguments, callId: id))
    }

    private mutating func toolResult(_ event: ChatEvent) {
        if !event.searchResults.isEmpty { searchHits = event.searchResults }
        if event.callId == activityCall, case .tool = activity {
            activity = .thinking
            activityCall = nil
        }
    }

    private mutating func turnFailed(_ event: ChatEvent) {
        settle()
        let rowId = event.rowId ?? "\(event.turnId ?? "turn"):f"
        guard !rows.contains(where: { $0.rowId == rowId }) else { return }
        var row = ChatRow(rowId: rowId, kind: .failure, turnId: event.turnId, at: event.at)
        row.code = event.code
        row.detail = event.detail
        row.retryAfterMs = event.retryAfterMs
        row.resetsAt = event.resetsAt
        rows.append(row)
    }

    private mutating func upsert(_ row: ChatRow) {
        if let index = rows.firstIndex(where: { $0.rowId == row.rowId }) {
            rows[index] = row
        } else {
            rows.append(row)
        }
        if row.kind == .widget, let callId = row.callId {
            widgets.removeAll { $0.callId == callId || $0.id == callId }
        }
        if row.kind == .unsent, let clientId = row.clientId {
            pendingSends.removeAll { $0.clientId == clientId }
        }
    }

    // MARK: - What the views read

    /// The one failure row whose Retry is live: the newest turn's, while
    /// nothing runs and no later message has been answered.
    public var retryableFailureRowId: String? {
        guard !pending, let index = rows.lastIndex(where: { $0.kind == .failure }) else { return nil }
        let later = rows[(index + 1)...]
        guard !later.contains(where: { ($0.kind == .user && !$0.queued) || $0.kind == .assistant }) else { return nil }
        return rows[index].rowId
    }

    /// What Retry sends again: the owner's message of the failed turn, with
    /// the id it had.
    public var retryTarget: (clientId: String, text: String)? {
        guard let failureId = retryableFailureRowId,
              let index = rows.firstIndex(where: { $0.rowId == failureId }) else { return nil }
        let turn = rows[index].turnId
        guard let user = rows[..<index].last(where: { $0.kind == .user && (turn == nil || $0.turnId == turn) }),
              let clientId = user.clientId, !clientId.isEmpty else { return nil }
        return (clientId, user.text)
    }

    /// The newest turn's web results, for the chips under the transcript.
    private func newestSearchHits() -> [SearchChip] {
        for row in rows.reversed() {
            if row.kind == .user && !row.queued { return [] }
            if row.kind == .assistant, !row.searchResults.isEmpty { return row.searchResults }
        }
        return []
    }

    /// The row a search hit or a notification points at, if it is loaded.
    public func contains(rowId: String) -> Bool { rows.contains { $0.rowId == rowId } }

    // MARK: - Transcript

    /// The rows the views draw. Messages still queued behind a running turn
    /// sit at the end, after the turn's own rows, so a message sent while the
    /// bot writes never lands in the middle of the answer.
    public func transcript(localUnsent: [UnsentMessage] = [], hiddenUnsent: Set<String> = []) -> [TranscriptRow] {
        var out: [TranscriptRow] = []
        var queuedRows: [TranscriptRow] = []
        out.reserveCapacity(rows.count + widgets.count + pendingSends.count)
        for row in rows {
            switch row.kind {
            case .user:
                let shown = TranscriptRow(
                    id: row.rowId, kind: .user, text: row.text, at: ChatClock.date(from: row.at),
                    attachments: row.attachments, queued: row.queued
                )
                if row.queued { queuedRows.append(shown) } else { out.append(shown) }
            case .assistant:
                guard !Transcript.isBlank(row.text) else { continue }
                out.append(TranscriptRow(id: row.rowId, kind: .assistant, text: row.text, at: ChatClock.date(from: row.at)))
            case .note:
                out.append(TranscriptRow(id: row.rowId, kind: .note, text: row.text, at: ChatClock.date(from: row.at)))
            case .failure:
                out.append(TranscriptRow(id: row.rowId, kind: .failure, text: row.failure.rowMessage, at: ChatClock.date(from: row.at)))
            case .unsent:
                guard let clientId = row.clientId, !hiddenUnsent.contains(clientId) else { continue }
                let held = UnsentMessage(
                    id: clientId, message: row.text, echo: row.text, draft: row.text, files: [],
                    reason: Self.unsentReason(row.reason), at: ChatClock.date(from: row.at) ?? Date(), anchorId: nil
                )
                out.append(TranscriptRow(id: held.bubbleRowId, kind: .user, text: held.echo, at: held.at))
                out.append(TranscriptRow(id: held.lineRowId, kind: .unsent, text: held.line, at: held.at))
            case .image:
                out.append(TranscriptRow(id: row.rowId, kind: .image, text: row.prompt ?? "", at: ChatClock.date(from: row.at), imageId: row.imageId))
            case .page:
                out.append(TranscriptRow(id: row.rowId, kind: .page, text: row.title ?? "", at: ChatClock.date(from: row.at), imageId: row.mediaId))
            case .widget:
                out.append(TranscriptRow(id: row.rowId, kind: .widget, text: row.widgetId ?? "", at: ChatClock.date(from: row.at)))
            case .card:
                out.append(TranscriptRow(id: row.rowId, kind: .card, text: row.proposalId ?? "", at: ChatClock.date(from: row.at)))
            case .question, .none:
                continue
            }
        }
        for widget in widgets {
            out.append(TranscriptRow(id: "live-\(widget.id)", kind: .widget, text: widget.id, at: Date()))
        }
        out.append(contentsOf: queuedRows)
        for send in pendingSends {
            out.append(TranscriptRow(
                id: send.rowId, kind: .user, text: send.text, at: send.at,
                attachments: send.attachments, queued: send.queued
            ))
        }
        return Transcript.placeUnsent(localUnsent, in: out)
    }

    /// Why a message came back unsent, in words.
    static func unsentReason(_ code: String?) -> String {
        switch code {
        case "cancelled": return "The turn before it was stopped."
        case "interrupted": return "Useful Bot stopped before it could send this."
        default: return "It didn't go through."
        }
    }
}

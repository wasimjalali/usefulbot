import Foundation

/// Minimal JSON tree so event payloads with unknown shapes (search results,
/// tool output) can be walked for search chips.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? c.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        case .null: try c.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var jsonObject: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .array(let value): return value.map(\.jsonObject)
        case .object(let value): return value.mapValues(\.jsonObject)
        case .null: return NSNull()
        }
    }
}

/// One web result chip from an `action.result` event.
public struct SearchChip: Codable, Equatable, Sendable {
    public let title: String
    public let url: String
    public let snippet: String

    public init(title: String, url: String, snippet: String) {
        self.title = title
        self.url = url
        self.snippet = snippet
    }
}

/// What the live turn is doing right now, read off the session stream and
/// shown in the working row while the reply is still on its way.
public enum TurnActivity: Codable, Equatable, Sendable {
    case thinking
    case working
    /// The tool by name, and what it was pointed at when the call says so: the
    /// command, the query, the path. "Running a command" names the step;
    /// "Running a command: npm test" is the step.
    case tool(String, detail: String? = nil)
    /// eve is summarizing older messages so the chat fits the model's window.
    /// It can take a while on a long chat, and a bare "Thinking" through it
    /// read as a hang.
    case compacting
    /// A background sub-agent the bot started. Its work is between the bot
    /// and the sub-agent: the owner only sees that it runs and when it is back.
    case subagent(finished: Bool)

    public var isSubagent: Bool {
        if case .subagent = self { return true }
        return false
    }

    /// Sentence case, no trailing period: the row swaps between these while
    /// the turn runs, and a period on every one of them reads as a stutter.
    public var label: String {
        switch self {
        case .thinking: return "Thinking"
        // Only reached while text is streaming in, and the row now stays up
        // under the bubble being written.
        case .working: return "Writing"
        case .compacting: return "Compacting the conversation"
        case .subagent(let finished): return finished ? "Sub-agent finished" : "Sub-agent working"
        case .tool(let name, let detail):
            guard let detail else { return Self.toolLabel(name) }
            if name == "connector_execute" { return Self.connectorStep(detail, toolkits: []).label }
            return "\(Self.toolLabel(name)): \(detail)"
        }
    }

    /// A connected app's tool, by its slug (`GMAIL_FETCH_EMAILS`), as the
    /// app and what it is doing: "Gmail: fetch emails". The app is the
    /// longest known toolkit the slug starts with, the way the server reads
    /// it (`toolkitOf` in shared/composio.ts); without a match, the slug's
    /// first word.
    public static func connectorStep(
        _ slug: String,
        toolkits: [(slug: String, name: String)]
    ) -> (toolkit: String?, label: String) {
        let lower = slug.trimmingCharacters(in: .whitespaces).lowercased()
        let match = toolkits
            .sorted { $0.slug.count > $1.slug.count }
            .first { lower == $0.slug.lowercased() || lower.hasPrefix($0.slug.lowercased() + "_") }
        let app: String
        let rest: Substring
        if let match {
            app = match.name
            rest = lower.dropFirst(match.slug.count).drop { $0 == "_" }
        } else {
            let head = lower.prefix { $0 != "_" }
            app = head.prefix(1).uppercased() + head.dropFirst()
            rest = lower.dropFirst(head.count).drop { $0 == "_" }
        }
        let action = rest.replacingOccurrences(of: "_", with: " ")
        return (match?.slug, action.isEmpty ? "Using \(app)" : "\(app): \(action)")
    }

    /// Says what the bot is doing, not which function it called. Tools the
    /// table does not know still read as English rather than as a symbol.
    public static func toolLabel(_ name: String) -> String {
        if let known = known[name] { return known }
        let spoken = name
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespaces)
        guard !spoken.isEmpty else { return "Working" }
        return "Using \(spoken.lowercased())"
    }

    private static let known: [String: String] = [
        "agent": "Starting a sub-agent",
        "todo": "Planning",
        "bash": "Running a command",
        "clear_history": "Clearing a chat",
        "connector_execute": "Using a connector",
        "connector_search": "Looking through connectors",
        "create_routine": "Writing a routine",
        "delete_bot": "Removing a bot",
        "delete_routine": "Removing a routine",
        "install_cli": "Setting up a tool",
        "list_bots": "Checking the roster",
        "list_dir": "Reading a folder",
        "list_models": "Checking the models",
        "list_routines": "Checking the routines",
        "memory_read": "Reading memory",
        "memory_search": "Searching memory",
        "memory_upsert": "Saving to memory",
        "post_to_group": "Posting to the group",
        "propose_bot": "Drafting a proposal",
        "propose_connector": "Drafting a proposal",
        "propose_connection": "Drafting a proposal",
        "propose_group": "Drafting a proposal",
        "connection_search": "Looking through connections",
        "rail_action": "Rearranging the rail",
        "read_file": "Reading a file",
        "review": "Asking the reviewer",
        "run_routine": "Running a routine",
        "send_to_bot": "Messaging a teammate",
        "update_bot_profile": "Updating a profile",
        "update_routine": "Updating a routine",
        "web_search": "Searching the web",
        "write_file": "Writing a file",
    ]
}

/// Why a turn failed, in words the owner can act on.
public struct TurnFailure: Codable, Equatable, Sendable {
    public let code: String
    public let detail: String

    public init(code: String, detail: String) {
        self.code = code
        self.detail = detail
    }

    /// The router refuses a turn with `caller_budget_exhausted` when the day's
    /// token budget is spent, and eve wraps that in its retry error. Saying
    /// "the turn failed" for that leaves the owner with nothing to do, when in
    /// fact one setting fixes it. `nil` when the cause is not one this app can
    /// explain, so the caller keeps its own wording rather than repeating it.
    /// eve kept a tool call with no result in the session's history (a step
    /// cut off mid-call), and every later turn is refused before any model
    /// runs. Nothing sent to this session can succeed again; only a fresh
    /// session can.
    /// One orphaned call reads "Tool result is missing for tool call"; a
    /// step cut off after several parallel calls reads "Tool results are
    /// missing for tool calls". Drive Admin sat on the second for a day:
    /// unrecognised, its Retry resent into the same session and the bare
    /// banner came straight back.
    public var historyBroken: Bool {
        let haystack = "\(code) \(detail)".lowercased()
        return haystack.contains("tool result is missing") || haystack.contains("tool results are missing")
    }

    /// Whether the router has stopped calling the provider for a moment. Only
    /// this failure may hold Retry back: every other one the owner can act on
    /// now, and a few of them (a caller rate limit, a search limit) carry a
    /// `retry_after_ms` of their own that would otherwise arm the same gate
    /// and show them the cool-down wording instead of their own reason.
    public var coolingDown: Bool {
        "\(code) \(detail)".lowercased().contains("circuit_open")
    }

    /// How long to hold Retry, in whole seconds, for a cool-down that said.
    public var coolDownSeconds: Int? { coolingDown ? retryAfterSeconds : nil }

    /// How long the router said to wait, in whole seconds, when its error body
    /// carried a `retry_after_ms`. eve wraps the body into the failure detail,
    /// so the number survives the trip even though the field does not.
    public var retryAfterSeconds: Int? {
        guard let range = detail.range(of: "retry_after_ms") else { return nil }
        let digits = detail[range.upperBound...].drop { !$0.isNumber }.prefix { $0.isNumber }
        guard let ms = Int(digits), ms > 0 else { return nil }
        // No router cool-down lasts a day. A bigger number is garbled
        // provider text, and taken as it stands it held Retry for years.
        return min(86_400, max(1, Int((Double(ms) / 1000).rounded(.up))))
    }

    /// When the provider said a used-up plan limit resets, from the router's
    /// `resets_at=<epoch seconds>` in the failure text.
    public var resetsAt: Date? {
        guard let range = detail.range(of: "resets_at=") else { return nil }
        let digits = detail[range.upperBound...].prefix { $0.isNumber }
        guard let seconds = TimeInterval(digits), seconds > 0 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    /// "18:40" today, "Thu 09:15" within a week, a date beyond that.
    static func resetCopy(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) {
            formatter.dateFormat = "HH:mm"
        } else if date.timeIntervalSince(now) < 6 * 24 * 3600 {
            formatter.dateFormat = "EEE HH:mm"
        } else {
            formatter.dateFormat = "d MMM HH:mm"
        }
        return formatter.string(from: date)
    }

    /// Also what a refused send says, so the composer note and a failed
    /// turn's row read the same.
    public static let modelSelectionUnavailableCopy = "This bot's model isn't available any more. Pick another model below."

    /// The ChatGPT usage page: the copy names the host, the failure row's button matches on it.
    public static let chatgptUsageHost = "chatgpt.com/settings/usage"
    public static let chatgptUsageURL = "https://" + chatgptUsageHost

    public var reason: String? {
        let haystack = "\(code) \(detail)".lowercased()
        // The bot's own pick is gone (its connection was removed or
        // disconnected). Nothing was substituted, so the owner chooses.
        if haystack.contains("model_selection_unavailable") {
            return Self.modelSelectionUnavailableCopy
        }
        if haystack.contains("model_unavailable") {
            return "The provider doesn't offer this model right now. Pick another model."
        }
        if haystack.contains("upstream_unavailable") {
            return "Couldn't reach ChatGPT just now. Send again in a moment."
        }
        if haystack.contains("upstream_chatgpt_not_permitted") {
            return "ChatGPT didn't allow this request from Useful Bot. Check Useful Bot in ChatGPT settings, or pick another model."
        }
        if haystack.contains("upstream_chatgpt_usage_limit") {
            return "You've reached the ChatGPT plan limit for Useful Bot. Manage usage at \(Self.chatgptUsageHost), or pick another model."
        }
        if haystack.contains("upstream_chatgpt_not_eligible") {
            return "This ChatGPT account can't use its plan in Useful Bot. Pick another model."
        }
        if haystack.contains("upstream_auth_failed") || haystack.contains("upstream_credential_missing") {
            return "Sign-in to the model provider expired. Reconnect it in Settings."
        }
        if haystack.contains("provider_disconnected") {
            return "The model provider is disconnected. Reconnect it in Settings."
        }
        // The provider's own limits, from the 429 body: no wait lifts these
        // in a turn's time, so the copy says what ran out and what to do.
        if haystack.contains("upstream_usage_limit") {
            // A failure kept in the transcript outlives its reset; a time
            // already past would read as the next such weekday.
            if let resetsAt, resetsAt > Date() {
                return "Your plan's usage limit for this model is used up. It resets at \(Self.resetCopy(resetsAt)). Pick another model to keep going."
            }
            return "Your plan's usage limit for this model is used up. Pick another model to keep going."
        }
        if haystack.contains("upstream_usage_not_included") {
            return "Your plan doesn't include this model. Pick another model."
        }
        if haystack.contains("upstream_quota_exhausted") {
            return "The provider account is out of credit or over its spend limit. Top it up, or pick another model."
        }
        if historyBroken {
            return "This chat's last step was cut off and can't continue. Retry sends your message in a fresh chat."
        }
        // The two concurrency refusals come first. Neither is about spend, and
        // both arrive wrapped in text that can also carry `rate_limit_error`,
        // the router's TYPE for every 429, so a later branch would claim them.
        // The ceiling used to be coded `global_budget_exhausted` and read as
        // the daily token limit; it has its own code now.
        if haystack.contains("session_busy") {
            return "This bot is still working on its last step."
        }
        if haystack.contains("global_concurrency_limit") {
            return "Ten bots are already working. Try again in a moment."
        }
        // The router stops calling a provider that failed three times in a
        // minute, and every turn inside that window is refused before it
        // reaches a model. Retry fires straight back into it and fails in
        // milliseconds, so a cool-down that is really seconds long read as a
        // dead app. Name it, and say when it lifts.
        // Not a pause. The router stops an alias outright when a turn reports
        // more usage than it reserved, and nothing but a restart clears that,
        // so telling the owner to retry in a moment would be a lie.
        if haystack.contains("circuit_disabled") {
            return "The router stopped this model: a turn used more than it reserved. Restart the local services to clear it."
        }
        if haystack.contains("circuit_open") {
            if let seconds = retryAfterSeconds {
                return "The model provider failed repeatedly, so sending is paused for \(seconds) more seconds. Retry after that."
            }
            return "The model provider failed repeatedly, so sending is paused briefly. Retry in a moment."
        }
        // The router caps how many messages one request may carry. eve retires
        // a session that gets a non-retryable 400, so this one ends the chat
        // rather than the turn, and the owner has to be told that plainly.
        if haystack.contains("messages_count") {
            return "This chat is too long to continue. Start a fresh chat with this bot."
        }
        if haystack.contains("budget_exhausted") {
            return "The daily token limit is used up. Raise it in Settings, under Usage."
        }
        // The agent already waited out the provider's limit as long as a turn
        // can, so this one is the provider's, and it is longer. Another model
        // on the same alias is paused too, so the copy does not offer one.
        if haystack.contains("upstream_rate_limited") {
            return "The model provider is rate limiting. Wait a minute and send again."
        }
        if haystack.contains("rate_limit") {
            return "The router is rate limiting. Wait a moment and send again."
        }
        if haystack.contains("unauthorized") {
            return "The router rejected this app. Restart the local services."
        }
        // The turn never reached a model, or reached one that answered with
        // nothing. Neither is the app's to fix, and both left the owner with a
        // bare "the turn failed" and no idea where to look.
        // The router names what the provider refused with, as status and
        // error type or code: "upstream_protocol_error (400 invalid_request_error)".
        // A model that refuses every call is not one that did not answer.
        if let refusal = providerRefusal {
            return "The model provider refused the request (\(refusal)). Send again, or pick another model."
        }
        if haystack.contains("upstream_protocol_error") || haystack.contains("upstream_timeout") {
            return "The model provider did not answer. Check its status or your usage limit, then send again."
        }
        // The provider closed the stream part way through an answer: eve gets
        // no finish reason, so the reply on screen stops mid-sentence. Nothing
        // is wrong locally and sending it again usually works, but a bare "the
        // turn failed" under a half-written answer reads as the app losing it.
        if haystack.contains("ended without a finish reason") {
            return "The model's answer was cut off before it finished. Send it again."
        }
        // The agent's call never reached the router, or the router hung up
        // on it: the local services, not the provider, and a retry is the
        // first thing to try.
        if haystack.contains("cannot connect to api") {
            return "The bot lost its connection to the local router. If it keeps happening, restart the local services."
        }
        if haystack.contains("empty-model-response") || haystack.contains("did not return a response") {
            return "The model returned nothing. Send it again."
        }
        return nil
    }

    /// The provider's refusal the router put in brackets after
    /// `upstream_protocol_error`: a 4xx status plus the provider's own error
    /// type or code. A bare status, or a 5xx, is the provider not answering.
    var providerRefusal: String? {
        guard let range = detail.range(of: "upstream_protocol_error (") else { return nil }
        let inside = detail[range.upperBound...].prefix { $0 != ")" }
        let refusal = String(inside).trimmingCharacters(in: .whitespaces)
        guard let status = Int(refusal.prefix { $0.isNumber }), (400..<500).contains(status) else { return nil }
        guard refusal.count <= 140, refusal.allSatisfy({ $0.isLetter || $0.isNumber || " /._-".contains($0) }) else { return nil }
        return refusal
    }

    /// What to show when this failure is the whole message.
    public var message: String { reason ?? "The turn failed." }

    /// What a failure row says once the moment has passed. A cool-down's
    /// copy counts seconds that were only true when it happened, so a row
    /// kept in the transcript says what happened instead; the live row
    /// counts down on its own.
    public var rowMessage: String {
        guard coolingDown else { return message }
        return "The model provider failed repeatedly, so sending was paused."
    }
}

/// A failed turn's place in the transcript: the row it goes under, and what
/// went wrong. Kept beside the messages rather than among them, because the
/// retry folds key on the owner's row being the last message.
public struct FailureMark: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    /// The row the failure sits under: the last thing the failed turn put in
    /// the transcript, or the owner's message when it put nothing.
    public var anchorId: String?
    public var failure: TurnFailure
    public var at: Date?

    public init(id: String, anchorId: String?, failure: TurnFailure, at: Date?) {
        self.id = id
        self.anchorId = anchorId
        self.failure = failure
        self.at = at
    }

    /// The transcript row id this mark renders as.
    public var rowId: String { "failure-\(id)" }
}

/// Where eve compacted a conversation: the row it goes under and when. The
/// summary replaces the history for good, so the transcript keeps a quiet
/// line at that point. Keyed by the event's id, so a replay of the same
/// event never adds a second line.
public struct CompactionMark: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    /// The last row the transcript held when compaction finished.
    public var anchorId: String?
    public var at: Date?

    public init(id: String, anchorId: String?, at: Date?) {
        self.id = id
        self.anchorId = anchorId
        self.at = at
    }

    /// The transcript row id this mark renders as.
    public var rowId: String { "compaction-\(id)" }

    public static let text = "Conversation compacted to fit the model's window"
}

/// How a send ended, and whether the banner it put up may be retried by
/// sending the turn again.
public struct SendFailure: Equatable, Sendable {
    public let message: String
    /// True only for a turn that ran and failed. Everything else leaves the
    /// owner's last transcript row belonging to some other turn, and resending
    /// from there files a second copy of a turn the server already answered:
    /// "The reply could not be read" and "The session pointer could not be
    /// saved" both leave the turn running, "The turn did not start" means the
    /// POST was taken but its echo never arrived, and a send that failed
    /// before delivery hands its text back to the composer instead.
    public let resendable: Bool
    /// Whether the note stays when the chat is read again. A send that never
    /// arrived put its draft back, and a pointer that did not save still is
    /// not saved; a reload answers neither. "The reply could not be read" and
    /// "The turn did not start" are answered by the reload showing the turn.
    public let survivesReload: Bool

    public init(message: String, resendable: Bool, survivesReload: Bool = false) {
        self.message = message
        self.resendable = resendable
        self.survivesReload = survivesReload
    }

    /// Whether the failure banner on screen may be answered by resending the
    /// owner's last message. A replay that ends on a failed turn is reason
    /// enough on its own; otherwise only a failure that says the turn never
    /// ran qualifies. Everything else reloads, which is what the button did
    /// before it learned to resend, and never duplicates a turn.
    public static func mayResend(failure: SendFailure?, replayEndedFailed: Bool) -> Bool {
        if replayEndedFailed { return true }
        return failure?.resendable == true
    }
}

/// One NDJSON event from an eve session stream.
public struct EveEvent: Decodable, Equatable, Sendable {
    public let type: String
    public let id: String?
    /// Server-stamped event time from `meta.at`, when the stream carries it.
    public let metaAt: String?
    public let message: String?
    public let messageDelta: String?
    public var turnId: String?
    public let data: JSONValue?
    /// The event's absolute position in its session stream, stamped by the
    /// reader rather than decoded: eve's `startIndex` counts events from zero,
    /// so `index + 1` is where a later read resumes without replaying history.
    public var index: Int?
    /// The session `index` counts in, stamped with it. eve counts every
    /// session from zero, so a position means nothing without the session
    /// it was read from, and a projection outlives a session: a send that
    /// lands on a retired one posts the same message to a fresh session.
    public var sessionId: String?
    /// How many recorded events were still ahead of this one when the read
    /// connected: positive inside the history, zero on its last event, below
    /// zero for an event that happened after. Nil when the server did not say
    /// where its history ended. It is the one hard line between a replay of
    /// what already happened and a turn that is happening now.
    public var historyRemaining: Int?

    enum CodingKeys: String, CodingKey { case type, data, meta }
    enum DataKeys: String, CodingKey { case message, messageDelta, turnId }
    enum MetaKeys: String, CodingKey { case id, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        let meta = try? c.nestedContainer(keyedBy: MetaKeys.self, forKey: .meta)
        id = try? meta?.decodeIfPresent(String.self, forKey: .id)
        metaAt = try? meta?.decodeIfPresent(String.self, forKey: .at)
        let data = try? c.nestedContainer(keyedBy: DataKeys.self, forKey: .data)
        message = try? data?.decodeIfPresent(String.self, forKey: .message)
        messageDelta = try? data?.decodeIfPresent(String.self, forKey: .messageDelta)
        turnId = try? data?.decodeIfPresent(String.self, forKey: .turnId)
        self.data = try? c.decodeIfPresent(JSONValue.self, forKey: .data)
        index = nil
        sessionId = nil
    }

    public init(
        type: String,
        id: String? = nil,
        metaAt: String? = nil,
        message: String? = nil,
        messageDelta: String? = nil,
        turnId: String? = nil,
        data: JSONValue? = nil,
        index: Int? = nil,
        sessionId: String? = nil
    ) {
        self.type = type
        self.id = id
        self.metaAt = metaAt
        self.message = message
        self.messageDelta = messageDelta
        self.turnId = turnId
        self.data = data
        self.index = index
        self.sessionId = sessionId
    }
}

public struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public var id: String
    public var role: Role
    public var text: String
    /// When the stream or the client knows it. Replays of old sessions have
    /// none unless the server stamped the event.
    public var at: Date?

    public init(id: String, role: Role, text: String, at: Date? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
    }
}

public enum EveStream {
    /// Id prefix for the optimistic user row a send inserts before the stream
    /// echoes the authoritative event; only rows with this prefix collapse.
    public static let optimisticUserPrefix = "local-"

    public static func parseLine(_ line: String) -> EveEvent? {
        guard let payload = payload(of: line),
              let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(EveEvent.self, from: data)
    }

    /// Only an event's `meta.id`, for a line whose full shape this build may
    /// not read.
    private struct MetaIdOnly: Decodable {
        struct Meta: Decodable { let id: String? }
        let meta: Meta?
    }

    /// The `meta.id` of the event in a stream payload, whether or not the rest
    /// of it decodes.
    public static func eventId(ofPayload payload: String) -> String? {
        guard let data = payload.data(using: .utf8) else { return nil }
        return (try? JSONDecoder().decode(MetaIdOnly.self, from: data))?.meta?.id
    }

    /// The event text a stream line carries, or nil for a blank line, a
    /// comment or the end marker. Every line with a payload is one event in
    /// eve's count whether or not this build can decode it, so a reader that
    /// keeps a cursor counts these and not the events it managed to parse.
    public static func payload(of line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix(":") else { return nil }
        let payload = trimmed.hasPrefix("data:")
            ? String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            : trimmed
        guard !payload.isEmpty, payload != "[DONE]" else { return nil }
        return payload
    }

    /// Ports of `BOT_TURN_PREFIX` and `GROUP_TURN_PREFIX` in
    /// `shared/threads.ts`: the identity has to be the first line, end with a
    /// period, and for a bot turn the marker must start line two.
    private static let botTurnPrefix = try! NSRegularExpression(
        pattern: "^You are [^\\n]+\\.\\nStanding instructions: "
    )
    private static let groupTurnPrefix = try! NSRegularExpression(
        pattern: "^Group chat: [^\\n]+\\.\\n"
    )
    /// The default bot's hidden prefix, present only when the proxy folded
    /// app notes into its turn (`shared/continuation-brief.ts`).
    private static let sessionNotePrefix = try! NSRegularExpression(
        pattern: "^Session note: the lines below come from the app, not from the owner\\.\\n"
    )

    /// Port of `BRIEF_MARKER` in `shared/continuation-brief.ts`.
    static let continuationMarker = "Continued session brief:"

    /// True when a stored user turn opened a session carried over from an
    /// older one: its hidden prefix, the part before the first blank line,
    /// holds the brief. Text the owner typed sits after it and never counts.
    public static func isContinuationTurn(_ text: String) -> Bool {
        guard let blank = text.range(of: "\n\n") else { return false }
        return text[..<blank.lowerBound].contains(continuationMarker)
    }

    /// Port of `handoffEnvelope` in `web/lib/agent-exec.ts`: a user turn the
    /// handoff pump sent on the owner's behalf. Its first two lines are fixed.
    private static let handoffEnvelope = try! NSRegularExpression(
        pattern: "^Handoff from [^\\n]+\\.\\n(This arrives in your own chat\\.|This belongs to the group chat [^\\n]+\\.)\\n"
    )

    /// True for a user turn the pump delivered (a teammate handoff, a connect
    /// resume). The durable thread already carries that message as its own
    /// row, so the transcript does not show the envelope as an owner bubble.
    public static func isHandoffEnvelope(_ text: String) -> Bool {
        let whole = NSRange(text.startIndex..., in: text)
        return handoffEnvelope.firstMatch(in: text, range: whole) != nil
    }

    /// The `kind` eve puts on a `message.received` it sent on a background
    /// task's behalf (patched in by scripts/patch-eve.mjs).
    public static let backgroundTaskKind = "execution.background_task"

    /// eve's own wording for a background task reporting back
    /// (`formatTaskNotification` and the update and authorization wakes in
    /// eve's `execution/tasks/child/steps.js`, 0.54). Streams from before the
    /// `kind` mark carry nothing else to tell such a report by.
    static let taskReportPattern = try! NSRegularExpression(
        pattern: "^Background task (task_[A-Za-z0-9]+)(?: \\([^\\n]*?\\))? (is completed\\.|failed\\.|is cancelled\\.|needs input\\.|needs authorization\\.|update: )",
        options: [.anchorsMatchLines]
    )

    /// The tasks a sub-agent's report is about, and whether each is over.
    /// eve hands several reports that land together to one turn, joined by a
    /// blank line, so every report after the first starts a paragraph. Empty
    /// unless the text opens with a report, the owner's own messages included.
    /// A result that itself quotes eve's wording for another task, at the start
    /// of a paragraph, would settle that task early: its working row goes, and
    /// its real report still arrives and is still hidden. Result text is free
    /// form, so nothing on the stream tells the two apart.
    public static func taskReports(_ text: String) -> [(taskId: String, settled: Bool)] {
        let whole = NSRange(text.startIndex..., in: text)
        var reports: [(taskId: String, settled: Bool)] = []
        for match in taskReportPattern.matches(in: text, range: whole) {
            guard let id = Range(match.range(at: 1), in: text),
                  let verb = Range(match.range(at: 2), in: text),
                  let start = Range(match.range, in: text)?.lowerBound else { continue }
            if reports.isEmpty ? start != text.startIndex : !text[..<start].hasSuffix("\n\n") { continue }
            let settled = ["is completed.", "failed.", "is cancelled."].contains(String(text[verb]))
            reports.append((String(text[id]), settled))
        }
        return reports
    }

    /// Remove the identity prefix the web proxy injects into a stored user
    /// turn, so the transcript shows the owner's original message.
    public static func stripThreadPrefix(_ text: String) -> String {
        let whole = NSRange(text.startIndex..., in: text)
        let isBotPrefix = botTurnPrefix.firstMatch(in: text, range: whole) != nil
        let isGroupPrefix = groupTurnPrefix.firstMatch(in: text, range: whole) != nil
        let isNotePrefix = sessionNotePrefix.firstMatch(in: text, range: whole) != nil
        guard isBotPrefix || isGroupPrefix || isNotePrefix else { return text }
        guard let range = text.range(of: "\n\n") else { return text }
        return String(text[range.upperBound...])
    }

    /// A reply stored before the router moved inline thinking to the reasoning field
    /// still opens with `<think>…</think>`: its bubble shows the answer after
    /// it, and nothing while the block is unclosed or its opening tag is still
    /// arriving. A tag further into the reply is the reply's own text.
    public static func withoutLeadingThink(_ text: String) -> String {
        let trimmed = text.drop { $0.isWhitespace || $0.isNewline }
        for (open, close) in thinkTags where trimmed.hasPrefix(open) {
            let body = trimmed.dropFirst(open.count)
            guard let after = thinkEnd(body, open: open, close: close) else { return "" }
            return String(body[after...].drop { $0.isWhitespace || $0.isNewline })
        }
        guard trimmed.hasPrefix("<") else { return text }
        return thinkTags.contains { $0.open.hasPrefix(trimmed) } ? "" : text
    }

    /// Port of `scanThink` in `shared/inline-think.ts` for a complete
    /// message: where the text after the closing tag starts, or nil when the
    /// block never closes. The same tag quoted inside the thinking is counted
    /// in pairs; a close followed by a blank line, or by nothing but
    /// whitespace, ends it whatever the count; a count that never returns to
    /// zero ends at the last close, so the answer is never swallowed.
    private static func thinkEnd(_ body: Substring, open: String, close: String) -> Substring.Index? {
        var depth = 1
        var lastPassed: Substring.Index?
        var index = body.startIndex
        while index < body.endIndex {
            let rest = body[index...]
            if rest.hasPrefix(close) {
                let after = body.index(index, offsetBy: close.count)
                let tail = body[after...]
                if depth <= 1 || tail.hasPrefix("\n\n") || tail.hasPrefix("\r\n\r\n")
                    || tail.allSatisfy({ $0.isWhitespace || $0.isNewline }) {
                    return after
                }
                lastPassed = after
                depth -= 1
                index = after
                continue
            }
            if rest.hasPrefix(open) {
                depth += 1
                index = body.index(index, offsetBy: open.count)
                continue
            }
            index = body.index(after: index)
        }
        return lastPassed
    }

    private static let thinkTags: [(open: String, close: String)] = [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
    ]

    /// Port of `parseSearchChips` from `shared/eve-stream.ts`: accept a result
    /// payload as an array, `{results}`, `{result:{results}}` or
    /// `{output:{results}}`, keep up to five http(s) rows.
    public static func parseSearchChips(_ value: JSONValue?) -> [SearchChip] {
        guard var payload = value else { return [] }
        if case .string(let text) = payload {
            guard let data = text.data(using: .utf8),
                  let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
            payload = parsed
        }
        let record = payload.objectValue
        let nested = record?["result"]?.objectValue ?? record?["output"]?.objectValue
        let list: [JSONValue]
        if let array = payload.arrayValue {
            list = array
        } else if let results = record?["results"]?.arrayValue {
            list = results
        } else if let results = nested?["results"]?.arrayValue {
            list = results
        } else {
            list = []
        }
        var chips: [SearchChip] = []
        for item in list {
            guard let row = item.objectValue else { continue }
            let url = (row["url"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let parsed = URL(string: url),
                  let scheme = parsed.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  let host = parsed.host,
                  !LocalHost.isLocal(host) else { continue }
            let title = String((chipText(row["title"]) ?? url).prefix(200))
            let snippet = String((chipText(row["snippet"]) ?? chipText(row["description"]) ?? "").prefix(800))
            chips.append(SearchChip(title: title, url: String(url.prefix(2048)), snippet: snippet))
            if chips.count >= 5 { break }
        }
        return chips
    }

    /// The tool an `actions.requested` event is about. One step can request
    /// several calls; the row names the first, because it is the one the reader
    /// sees start. Subagent and remote-agent calls carry a name instead of a
    /// tool name, and that name is just as good a label.
    static func requestedToolName(_ data: JSONValue?) -> String? {
        guard let actions = data?["actions"]?.arrayValue else { return nil }
        for action in actions {
            for key in ["toolName", "subagentName", "remoteAgentName", "name"] {
                if let name = action[key]?.stringValue, !name.isEmpty {
                    return String(name.prefix(80))
                }
            }
        }
        return nil
    }

    /// What the first named call was pointed at, in one short line. Only the
    /// fields that read as a sentence are used; ids and payloads are not. A
    /// shell line is cut to its program and subcommand: its arguments are
    /// where a token or a password would be, and this text is drawn on screen.
    static func requestedToolDetail(_ data: JSONValue?) -> String? {
        guard let actions = data?["actions"]?.arrayValue else { return nil }
        let named = actions.first { action in
            ["toolName", "subagentName", "remoteAgentName", "name"].contains {
                !(action[$0]?.stringValue ?? "").isEmpty
            }
        }
        guard let input = named?["input"] else { return nil }
        for key in ["command", "query", "path", "url", "use_case", "tool"] {
            guard let value = input[key]?.stringValue else { continue }
            var words = value.split(whereSeparator: \.isWhitespace).map(String.init)
            if key == "command" { words = commandHead(words) }
            let line = words.joined(separator: " ")
            if line.isEmpty { continue }
            return line.count > 60 ? String(line.prefix(59)) + "…" : line
        }
        return nil
    }

    /// `git status`, `npm run`, `find`: the program, plus the word after it
    /// only when that word is a bare subcommand and not a flag, a path or an
    /// assignment.
    private static func commandHead(_ words: [String]) -> [String] {
        guard let program = words.first(where: { !$0.contains("=") }) else { return [] }
        var head = [String(program.split(separator: "/").last ?? "")]
        if let index = words.firstIndex(of: program), index + 1 < words.count {
            let next = words[index + 1]
            if next.allSatisfy({ $0.isLetter || $0 == "-" }), !next.hasPrefix("-") { head.append(next) }
        }
        return head
    }

    /// Like JavaScript's `String(value)` for scalar fields: numbers and booleans
    /// stringify, compound and null values fall back to the next source.
    private static func chipText(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let text):
            return text
        case .number(let number):
            if number.rounded() == number, abs(number) < 1e15 {
                return String(Int(number))
            }
            return String(number)
        case .bool(let flag):
            return flag ? "true" : "false"
        case .array, .object, .null, .none:
            return nil
        }
    }
}

/// Live projection of a session stream: a delta stream
/// accumulates, message.completed is authoritative, replays dedupe by event id.
/// Codable so a chat can be put back exactly as it was left (`ChatSnapshot`).
/// Every stored property is part of that snapshot: a change to one must bump
/// `ChatSnapshot.formatVersion`, which `ChatSnapshotTests` enforces.
public struct StreamProjection: Codable, Equatable, Sendable {
    public private(set) var messages: [ChatMessage] = []
    /// The owner row that opened a session carried over from an older one:
    /// its hidden prefix held the brief. The chat marks where that happened.
    public private(set) var continuationRowId: String?
    public private(set) var pending = false
    /// Set when the turn or session failed, so callers can surface it instead
    /// of treating the empty turn as a delivered reply.
    public private(set) var failed = false
    /// Why the turn failed, as eve reported it. Kept so the reader is told
    /// that the day's token budget ran out rather than just that something
    /// went wrong.
    public private(set) var failure: TurnFailure?
    /// Every failed turn still worth showing, in the order they failed. A
    /// retry that gets somewhere takes its failure's mark away.
    public private(set) var failureMarks: [FailureMark] = []
    /// Every compaction eve ran in this session, in order.
    public private(set) var compactionMarks: [CompactionMark] = []
    /// The mark of the failure `failed` is about, while it is.
    private var liveFailureMarkId: String?
    /// The one failure row that may still be retried: the newest turn's, and
    /// only while nothing has started since.
    public var retryableMarkId: String? { failed ? liveFailureMarkId : nil }
    /// Web results the turn surfaced, shown as chips under the transcript.
    public private(set) var searchHits: [SearchChip] = []
    /// What the turn is doing right now. Reasoning and tool calls both reach
    /// us on this stream, so the working row can say which one it is.
    public private(set) var activity: TurnActivity = .thinking
    /// MCP App widgets the live turn produced, shown in the transcript.
    public private(set) var widgets: [LiveWidget] = []
    /// Questions the bot asked with eve's `ask_question` that nobody has
    /// answered yet. The turn is over while one is open: the bot is waiting on
    /// the owner, not working.
    public private(set) var questions: [OwnerQuestion] = []
    /// Background sub-agents started in this session that have not reported
    /// back, by task id, with when each started. Their result arrives as a
    /// message of its own, which is not the owner's and never becomes a row.
    public private(set) var runningTasks: [String: Date] = [:]
    /// The session those tasks belong to. A task wakes only the session that
    /// started it, so a new session means none of them will report back.
    private var tasksSession: String?
    /// When the turn in flight began, from its message's own stamp: the
    /// working row counts from it, and a chat switched away from and back
    /// to keeps counting instead of starting again at 0.
    public private(set) var turnStartedAt: Date?
    /// The first row the bot wrote in each turn a sub-agent's report opened.
    /// No owner row sits above it, so this marks where that reply begins,
    /// one per turn, even when two reports arrive back to back.
    public private(set) var taskReplyRowIds: Set<String> = []
    /// Tasks that already reported that they are done. A report of theirs
    /// delivered again, or an update wake that trails the completion, is
    /// still the bot's and never an owner row.
    private var settledTasks: Set<String> = []
    /// Every background sub-agent this session launched, one row per agent id,
    /// in the order they first started. A relaunch of the same agent moves its
    /// row back to working.
    public private(set) var subagentRuns: [SubagentRun] = []
    /// The same runs grouped by the turn that launched them, for one card each.
    public var subagentBatches: [SubagentBatch] {
        var batches: [SubagentBatch] = []
        for run in subagentRuns {
            if let at = batches.firstIndex(where: { $0.id == run.groupId }) {
                batches[at].runs.append(run)
            } else {
                batches.append(SubagentBatch(id: run.groupId, runs: [run]))
            }
        }
        return batches
    }
    /// The row each launching turn's card sits under: the last row that turn
    /// put in the transcript. Missing once the turn is forgotten.
    public func subagentAnchor(forGroup id: String) -> String? {
        id == (currentTurnId ?? "") ? turn.lastRowId : (turns[id]?.lastRowId ?? groupAnchors[id])
    }
    /// Requests from eve that are not questions (a session limit, a tool
    /// approval, a kind not known yet), open until `input.resolved`. Unlike a
    /// question, the owner's next message does not answer one: eve keeps it
    /// pending and queues what the owner writes.
    public private(set) var pendingRequests: [PendingRequest] = []
    /// Owner rows whose turn ended with no model step while a request was
    /// open: eve held them for later. They stay marked once it is answered.
    public private(set) var queuedMessageIds: Set<String> = []
    /// The held rows in the order they were held, until eve replays them,
    /// drops them or the session ends. A row raised the request itself (its
    /// turn had no step) or was queued behind it.
    private var heldOrder: [String] = []
    /// Held rows eve never replayed: the bot never got them.
    public private(set) var droppedMessageIds: Set<String> = []
    /// A request was answered with rows still held: the next turn eve runs is
    /// its replay. `replayTurn` is that turn once it has begun; its end is
    /// when rows it did not include are judged dropped.
    private var replayOpen = false
    /// Held rows whose own turn raised the request: eve never replays these.
    private var heldOrigins: Set<String> = []
    /// The row each launching turn ended on, kept after the turn table lets
    /// the turn go (it holds the newest 256).
    private var groupAnchors: [String: String] = [:]
    /// The session the last event came from. A different one is a new chat.
    private var activeSession: String?
    private var replayTurn: String?
    /// The brief of each sub-agent call, by call id, until its receipt claims it.
    private var callBriefs: [String: String] = [:]
    /// The turn each task's receipt was seen under, keyed by call id.
    private var callTurns: [String: String] = [:]
    /// Which agent each task id belongs to, every task it ever ran.
    private var taskAgents: [String: String] = [:]
    /// The child session eve named for each agent.
    private var childSessions: [String: String] = [:]
    /// Where each agent's `subagent.called` sits on its parent's stream.
    private var childCalls: [String: SubagentCallSite] = [:]
    private var seen = Set<String>()
    private var seenOrder: [String] = []
    private var seenCursor = 0
    private static let seenCap = 2000

    /// What this projection holds, roughly: the message text and the ids it
    /// remembers for dedupe. For the per-bot cache budget, not accounting.
    public var estimatedBytes: Int {
        messages.reduce(0) { $0 + $1.text.utf8.count + 96 }
            + seenOrder.count * 48
            // A fold leaves the id it replaced pointing at the same row, so
            // this map grows with retries and not only with rows.
            + indexById.count * 48
            // A stepped-off turn's record, its id held twice: in the map and
            // in the eviction order.
            + turns.count * 128
            + failureMarks.reduce(0) { $0 + $1.failure.detail.utf8.count + 128 }
            + compactionMarks.count * 128
    }
    /// The one session every positioned event here was read from, or nil when
    /// there were none or more than one. A send that moved to a fresh session
    /// keeps the old session's rows in this projection, and a replay of the
    /// fresh one would not: only a one-session projection is what a replay of
    /// its session reproduces, so only that one may be saved and resumed.
    public var soleSession: String? { journalBase == 0 ? journalSession : nil }

    /// Whether the bookkeeping that the lookups index by agrees with the rows.
    /// A projection decoded from a snapshot that fails this (a damaged file,
    /// or one whose fields meant something else) is never restored: the
    /// folds and discards index `messages` through these without checking.
    public var isConsistent: Bool {
        rowJournal.count == messages.count
            && indexById.values.allSatisfy { $0 >= 0 && $0 < messages.count }
            && seenOrder.count <= Self.seenCap
            && seenCursor >= 0
            && (seenOrder.count < Self.seenCap ? seenCursor == 0 : seenCursor < seenOrder.count)
            && turnOrder.count == turns.count
            && turnOrder.allSatisfy { turns[$0] != nil }
            && (liveFailureMarkId == nil || failureMarks.contains { $0.id == liveFailureMarkId })
    }

    /// Ids minted for rows whose events carried none. A count, not the row's
    /// position: a late discard removes a row, and a positional id then
    /// repeated one a surviving row already held.
    private var minted = 0
    /// Where each message id sits in `messages`, first holder wins, the way
    /// `firstIndex(where:)` answered it. Every streamed delta looks its bubble
    /// up, and a scan of the whole history per delta is what ten bots
    /// streaming into long chats were paying on the main actor.
    private var indexById: [String: Int] = [:]
    /// The journal position of the event that made each row, in step with
    /// `messages`. Nil for a row the journal has not placed yet: the send's
    /// own optimistic row, or any row from a stream that carries no
    /// positions. It is what puts a backfilled turn's row above the rows of
    /// the turns that came after it.
    private var rowJournal: [Int?] = []
    /// Where the newest tagged turn this projection knows began in the
    /// journal. An unknown turn whose event sits before it is not the next
    /// turn but an older one arriving late: a send whose stream died before
    /// its echo armed left nothing of its turn here, and the follower brings
    /// that turn in after the resend has painted its own.
    private var newestTurnStart: Int?
    /// The session whose journal `rowJournal` and `newestTurnStart` are
    /// read in, and where its positions start in the projection's own count.
    /// eve counts every session from zero, and this projection outlives a
    /// session: a send that lands on a retired one posts the same message to
    /// a fresh session, and so does the retry a broken history gets. Read
    /// raw, the fresh session's first turn sat before the old session's
    /// newest and was taken for backfill: its echo went to the top, the
    /// optimistic row was never adopted, and the working row never cleared.
    /// So a session's positions are shifted past everything the projection
    /// has placed, and a later session reads as later.
    private var journalSession: String?
    private var journalBase = 0
    /// The first session any event here named. Turn ids are per session in
    /// eve, so a turn of any other session is keyed by its session too.
    private var firstSession: String?
    /// The highest position placed so far, in the projection's count: where
    /// the next session's positions start after.
    private var journalTop: Int?
    /// What one turn has done so far, kept apart from what the projection
    /// shows: which row it carried, whether it got anywhere, whether it is
    /// over. Everything its failure needs to know in order to fold a retry.
    ///
    /// One record per turn, not one slot for the turn in flight, because a
    /// turn's boundary events do not arrive in journal order. A send's armed
    /// stream skips its own `turn.started`, so the follower delivers it late,
    /// mid-turn; a follower that rewinds past the bounded id cache delivers
    /// it twice; and a failure can land after the owner has resent and the
    /// next turn's message is on screen. A slot reset by every boundary lost
    /// the carried row on each of those orderings, and the retry stacked.
    private struct TurnRecord: Codable, Equatable {
        /// The user row this turn carried, while nothing has been said back.
        /// Nil when more than one row is open at once and the answer would be
        /// a guess.
        var carriedUserMessageId: String?
        /// User rows since the turn began, or since the bot last answered or
        /// asked. Two or more mean a failure cannot be pinned on any of them,
        /// and a third must not look like a fresh start.
        var openUserRows = 0
        /// Whether the turn got further than the owner's message: text, a
        /// tool call, a question. A turn that did none of that leaves the
        /// session exactly as it found it. One that reached a tool call can
        /// leave the call behind, which is the shape `historyBroken` names,
        /// so its message is not the app's to fold away. Reasoning is not
        /// work: it leaves no row, and eve rolls a turn that failed on
        /// reasoning alone back to before its message, the same as one that
        /// never answered. A turn that reasoned, failed and was resent left
        /// the question standing twice with nothing between.
        var producedWork = false
        /// Whether a model step began in it. A turn eve queued behind a
        /// pending request runs none.
        var sawStep = false
        /// Whether a non-question request was raised in it.
        var raisedRequest = false
        /// Whether a message arrived in this turn at all. A turn refused
        /// before its own echo (`session_busy`, an open circuit) would
        /// otherwise be read as having thrown away a message an earlier turn
        /// had already delivered.
        var sawMessage = false
        /// Opened by a sub-agent's report, not by the owner: there is no
        /// message of theirs to send again, so its failure offers no Retry.
        var fromTask = false
        /// Whether that turn's first reply row has been marked.
        var taskReplyMarked = false
        /// Whether a terminal has been applied for it. Any boundary event
        /// arriving after that is a replay, and acts on nothing.
        var ended = false
        /// Whether another turn's message has arrived since. eve runs one
        /// turn at a time, so the turn is over even though its end has not
        /// been seen: what still arrives for it is late, and goes under its
        /// own rows, but a straggler start does not make it the turn in
        /// flight again.
        var superseded = false
        /// The assistant block its deltas append to, while one is open.
        var assistantId: String?
        /// While a replay re-sends a block this projection already holds,
        /// its remaining deltas are that same text arriving again and must
        /// not be appended a second time.
        var replayingMessage = false
        /// The last row this turn put in the transcript. Its late content,
        /// arriving after the next turn's message, goes under this row, the
        /// way a replay puts it, not after the next turn's.
        var lastRowId: String?

        /// Nothing has happened in it yet.
        var isBlank: Bool { self == TurnRecord() }
    }
    /// The turn in flight. Named by `currentTurnId` when the stream tags its
    /// events; anonymous when it does not, which is how the projection read
    /// before turn ids were looked at.
    private var turn = TurnRecord()
    /// The turn these events say they belong to, when they say. A follower
    /// that rewinds past the bounded id cache replays an older turn's
    /// reasoning, tool calls and questions; they carry that turn's id, which
    /// is how work that is long over stops counting as this turn's.
    private var currentTurnId: String?
    /// Every tagged turn this projection has stepped off, over or not, by id.
    /// A late terminal finds its turn here, and a straggler start for a turn
    /// that is over is recognised as one. Bounded, oldest forgotten first: a
    /// straggler older than that reads as it did before, which is no worse.
    private var turns: [String: TurnRecord] = [:]
    private var turnOrder: [String] = []
    private static let turnCap = 256
    /// The user row of a failed turn, while it is still the last thing in the
    /// transcript. eve rolls a failed turn's session back to what it held
    /// before the send, so that row names a message the bot does not have:
    /// sending the same text again is a retry of it, not a second question.
    private var discardedUserMessageId: String?

    public init() {}

    private mutating func mintId(_ prefix: String) -> String {
        minted += 1
        return "\(prefix)-\(minted)"
    }

    private mutating func appendMessage(_ message: ChatMessage, journal: Int?) {
        if indexById[message.id] == nil { indexById[message.id] = messages.count }
        messages.append(message)
        rowJournal.append(journal)
    }

    /// Put a turn's row under the last row that turn owns. For the turn in
    /// flight that is the end of the transcript, as it always was; for a
    /// turn stepped off, it is the place a replay would have put the row,
    /// above the next turn's message. A turn with no row yet goes where its
    /// journal position says: ahead of the first row a later event made,
    /// which is where the replay would have put it too. Nothing known to sit
    /// under and no position: the end.
    private mutating func insertMessage(_ message: ChatMessage, under anchor: String?, journal: Int?) {
        let at: Int
        if let anchor, let held = indexById[anchor] {
            at = held + 1
        } else if let journal {
            // A row the journal has not placed is the send's own optimistic
            // row, which is later than anything the journal already holds.
            at = rowJournal.firstIndex { $0.map { $0 > journal } ?? true } ?? messages.count
        } else {
            at = messages.count
        }
        guard at < messages.count else {
            appendMessage(message, journal: journal)
            return
        }
        for (id, index) in indexById where index >= at { indexById[id] = index + 1 }
        if indexById[message.id] == nil { indexById[message.id] = at }
        messages.insert(message, at: at)
        rowJournal.insert(journal, at: at)
    }

    /// Step off the turn in flight. A tagged turn keeps its record, because
    /// its end can still arrive late, or its start again; an untagged one has
    /// nothing it could be found by.
    private mutating func leaveCurrentTurn() {
        if let id = currentTurnId { stash(id, turn) }
        currentTurnId = nil
        turn = TurnRecord()
    }

    private mutating func stash(_ id: String, _ record: TurnRecord) {
        if turns.updateValue(record, forKey: id) == nil {
            turnOrder.append(id)
            if turnOrder.count > Self.turnCap {
                let old = turnOrder.removeFirst()
                // A card's anchor outlives its turn's record.
                if let row = turns[old]?.lastRowId, subagentRuns.contains(where: { $0.groupId == old }) {
                    groupAnchors[old] = row
                }
                turns[old] = nil
            }
        }
    }

    private mutating func unstash(_ id: String) -> TurnRecord? {
        guard let record = turns.removeValue(forKey: id) else { return nil }
        turnOrder.removeAll { $0 == id }
        return record
    }

    private enum TurnOwner {
        case current
        case steppedOff(String)
        case ignored
    }

    /// Which turn an event speaks for. Untagged, it is the turn in flight,
    /// as it always was. Tagged, it can name the turn in flight; a turn this
    /// projection stepped off, whose reply, question or end is arriving
    /// late; a turn that is already over, which a rewind re-sends and which
    /// changes nothing; or another turn while this one runs, the same
    /// rewind, the same nothing.
    private mutating func turnOwner(of event: EveEvent) -> TurnOwner {
        guard let named = event.turnId, named != currentTurnId else { return .current }
        if let known = turns[named] {
            if known.ended { return .ignored }
            // Nothing has begun since the projection stepped off it, so it is
            // the turn in flight after all; only its start went unseen.
            if canResume(known), let stepped = unstash(named) {
                turn = stepped
                currentTurnId = named
                return .current
            }
            return .steppedOff(named)
        }
        if currentTurnId != nil { return .ignored }
        // A turn named only by its end: the stream started mid-way, or its
        // message came untagged. What the record holds so far is its.
        currentTurnId = named
        noteTurnStart(event.index)
        return .current
    }

    /// Whether a stepped-off turn is the turn in flight after all: no other
    /// turn's message has passed it, and nothing has been claimed since.
    private func canResume(_ known: TurnRecord) -> Bool {
        !known.ended && !known.superseded && currentTurnId == nil && turn.isBlank
    }

    private func record(of owner: TurnOwner) -> TurnRecord? {
        switch owner {
        case .current: return turn
        case .steppedOff(let id): return turns[id]
        case .ignored: return nil
        }
    }

    private mutating func store(_ record: TurnRecord, for owner: TurnOwner) {
        switch owner {
        case .current: turn = record
        case .steppedOff(let id): turns[id] = record
        case .ignored: break
        }
    }

    /// The owner's row for a turn: the first open one is the row a failure
    /// can be pinned on, a second means neither can be.
    private static func claimUserRow(_ id: String, on record: inout TurnRecord) {
        // More than one user row open at once, which a queued send or a
        // teammate writing into this chat can do, and a failure cannot be
        // pinned on any of them: claim none rather than the wrong one.
        record.openUserRows += 1
        record.carriedUserMessageId = record.openUserRows == 1 ? id : nil
        record.sawMessage = true
        record.producedWork = false
        record.lastRowId = id
    }

    /// Whether an event is the turn getting further than the owner's message,
    /// the same reading the turn in flight gets in `apply`.
    private static func isWork(_ event: EveEvent) -> Bool {
        switch event.type {
        case "actions.requested", "action.result", "action.partial", "input.requested":
            return true
        case "message.appended":
            return !(event.messageDelta ?? "").isEmpty
        case "message.completed":
            return !(event.message ?? "").isEmpty
        default:
            return false
        }
    }

    /// A turn failed, and eve stores the session as it stood before its
    /// message: the owner's row names something the bot does not have. Only
    /// a turn that got no further than that message qualifies, which is the
    /// shape that stacked copies. One that reached text or a tool call may
    /// have left work behind, and its row keeps that work under it.
    ///
    /// When the failure is on time the row is still the last thing on
    /// screen, and the same text arriving next rewrites it. When it is late
    /// the owner has resent already and the retry sits right under the row;
    /// then the row goes now, and its id keeps pointing at the retry, the way
    /// a fold leaves it, so a redelivery of the failed message still lands
    /// nowhere.
    /// Returns true when the row went, because the retry under it replaced it.
    @discardableResult
    private mutating func discardMessage(of record: TurnRecord) -> Bool {
        guard record.sawMessage, !record.producedWork,
              let carried = record.carriedUserMessageId,
              let index = indexById[carried], messages[index].id == carried else { return false }
        if index == messages.count - 1 {
            discardedUserMessageId = carried
        } else if messages[index + 1].role == .user, messages[index + 1].text == messages[index].text {
            messages.remove(at: index)
            rowJournal.remove(at: index)
            for (id, held) in indexById where held > index { indexById[id] = held - 1 }
            // A failure row under the removed message belongs under the
            // retry that took its place.
            reanchorFailures(from: carried, to: messages[index].id)
            return true
        }
        return false
    }

    /// Put a failure row in the transcript under the last row its turn
    /// made. A failure already under that same row is an earlier attempt of
    /// the same message, and this one replaces it rather than stacking.
    /// `standing` is the failure that was live before this one arrived, if
    /// any. A stepped-off turn's late failure never takes it: the turn in
    /// flight is somebody else's, and its Retry is the one that works. A
    /// failure with no row of its own replaces only that one: it is eve
    /// failing the session right after the turn, the same failure twice.
    private mutating func markFailure(
        _ failure: TurnFailure,
        event: EveEvent,
        record: TurnRecord,
        at stamp: Date?,
        live: Bool,
        standing: String?
    ) -> String {
        // The id map keeps a folded or re-keyed row's id pointing at the row
        // that took its place, which is where this failure belongs now.
        let own = record.lastRowId.flatMap { id in indexById[id].map { messages[$0].id } }
        let anchor = own ?? messages.last?.id
        let id = event.id ?? mintId("f")
        failureMarks.removeAll { mark in
            guard let anchor, mark.anchorId == anchor else { return false }
            if own != nil { return live || mark.id != standing }
            return live && mark.id == standing
        }
        failureMarks.append(FailureMark(id: id, anchorId: anchor, failure: failure, at: stamp))
        if let live = liveFailureMarkId, !failureMarks.contains(where: { $0.id == live }) { liveFailureMarkId = nil }
        return id
    }

    private mutating func reanchorFailures(from old: String, to new: String) {
        for index in failureMarks.indices where failureMarks[index].anchorId == old {
            failureMarks[index].anchorId = new
        }
        for index in compactionMarks.indices where compactionMarks[index].anchorId == old {
            compactionMarks[index].anchorId = new
        }
    }

    /// The turn in flight got somewhere, so a failure it was the retry of is
    /// behind it. A retry is the same words as the failed turn's message,
    /// sent again with nothing but other attempts at them in between: a
    /// different question after a failure leaves that failure standing.
    private mutating func foldRetriedFailures() {
        guard !failureMarks.isEmpty,
              let carried = turn.carriedUserMessageId,
              let carriedIndex = indexById[carried], messages[carriedIndex].role == .user else { return }
        let text = messages[carriedIndex].text
        failureMarks.removeAll { mark in
            guard let anchor = mark.anchorId, let anchorIndex = indexById[anchor],
                  anchorIndex <= carriedIndex,
                  // The message the failed turn answered: its anchor, or the
                  // owner's row above whatever the turn wrote.
                  let asked = messages[...anchorIndex].last(where: { $0.role == .user }),
                  asked.text == text else { return false }
            // The folded retry: its message is the failed one's row.
            guard anchorIndex < carriedIndex else { return true }
            return messages[(anchorIndex + 1)..<carriedIndex].allSatisfy { $0.role != .user || $0.text == text }
        }
        if let live = liveFailureMarkId, !failureMarks.contains(where: { $0.id == live }) { liveFailureMarkId = nil }
    }

    /// Whether an event names a turn this projection never recorded that
    /// sits in the journal before the newest turn it knows. That is not the
    /// next turn but an older one arriving late, and it must neither unseat
    /// the turn in flight nor end it. A stream without positions cannot tell
    /// the two apart, and reads as it always did.
    private func isBackfill(_ event: EveEvent) -> Bool {
        guard let named = event.turnId, named != currentTurnId, turns[named] == nil,
              let index = event.index, let newest = newestTurnStart else { return false }
        return index < newest
    }

    /// A tagged turn has become known as the newest: where it began is what
    /// an older turn's backfill is measured against.
    private mutating func noteTurnStart(_ index: Int?) {
        guard let index else { return }
        newestTurnStart = max(newestTurnStart ?? index, index)
    }

    /// An event's journal position in the projection's own count, so that
    /// positions from two sessions never meet raw. The first position from
    /// another session starts that session past the highest one placed;
    /// nothing else moves, and a stream that names no session reads as one.
    private mutating func journalPosition(of event: EveEvent) -> Int? {
        guard let index = event.index else { return nil }
        if event.sessionId != journalSession {
            journalSession = event.sessionId
            journalBase = journalTop.map { $0 + 1 } ?? 0
        }
        let position = journalBase + index
        journalTop = max(journalTop ?? position, position)
        return position
    }

    /// A message eve filed under a turn this projection has stepped off,
    /// arriving after the next turn's message. It goes under the rows that
    /// turn owns, where a replay puts it, and is that turn's to answer or to
    /// lose: the turn in flight, its banner and its working row are not
    /// touched.
    private mutating func lateUserRow(_ event: EveEvent, text: String, at stamp: Date?, for id: String) {
        guard var stepped = turns[id] else { return }
        let userId = event.id ?? mintId("u")
        insertMessage(
            ChatMessage(id: userId, role: .user, text: text, at: stamp),
            under: stepped.lastRowId,
            journal: event.index
        )
        Self.claimUserRow(userId, on: &stepped)
        turns[id] = stepped
    }

    /// Give the last row the echo's identity without moving it, so a message
    /// this projection already shows folds into the row it names.
    private mutating func adoptLastUserRow(id: String, text: String, at: Date?, journal: Int?) {
        guard !messages.isEmpty else { return }
        // The id it leaves behind keeps pointing here. The durable stream can
        // redeliver that event once the bounded id cache has evicted it, and
        // this mapping is then the only thing that still recognises it.
        if indexById[id] == nil { indexById[id] = messages.count - 1 }
        // A retried carry-over re-keys its row; the divider follows it, and
        // so does a failure row under it.
        if continuationRowId == messages[messages.count - 1].id { continuationRowId = id }
        reanchorFailures(from: messages[messages.count - 1].id, to: id)
        messages[messages.count - 1] = ChatMessage(id: id, role: .user, text: text, at: at)
        // The echo is where the journal placed the row the app put up early.
        if let journal { rowJournal[messages.count - 1] = journal }
    }

    /// A turn is starting from this app.
    ///
    /// The `turn.started` event that would clear the last turn's outcome sits
    /// ahead of this turn's user message in the replayed stream, and the reader
    /// of that stream skips everything before that message. So without this the
    /// projection kept `failed` from a turn that ended hours ago, and the next
    /// successful reply was still reported as "The turn failed."
    private mutating func settle(_ task: String) {
        runningTasks[task] = nil
        settledTasks.insert(task)
    }

    /// A message from eve on a sub-agent's behalf: settle what it finished
    /// and record what each report said on its run.
    private mutating func settleReports(_ reports: [(taskId: String, settled: Bool)], text: String, at stamp: Date?) {
        for report in reports where report.settled { settle(report.taskId) }
        for detail in EveStream.taskReportDetails(text) {
            // A task nobody here launched, or one a relaunch replaced, is
            // not a row's to change.
            guard let agent = taskAgents[detail.taskId],
                  let index = subagentRuns.firstIndex(where: { $0.agentId == agent }),
                  subagentRuns[index].taskId == detail.taskId else { continue }
            switch detail.outcome {
            case .completed:
                subagentRuns[index].state = .reported(at: stamp)
                subagentRuns[index].result = cutReplayedOwnerText(detail.body)
            case .failed:
                // eve words an owner's Stop as a failure; it is a stop.
                subagentRuns[index].state = EveStream.isCancellation(detail.body)
                    ? .cancelled(at: stamp)
                    : .failed(at: stamp, message: detail.body)
            case .cancelled:
                subagentRuns[index].state = .cancelled(at: stamp)
            case .other:
                break
            }
        }
    }

    /// A merged report turn runs its last report's body to the end of the
    /// message, and eve's replay of held owner text sits there. The body ends
    /// where a held message begins as its own blank-line segment.
    private func cutReplayedOwnerText(_ body: String) -> String {
        guard replayOpen, pendingRequests.isEmpty, !heldOrder.isEmpty else { return body }
        let held = Set(heldOrder.compactMap { id in indexById[id].map { Self.replayKey(messages[$0].text) } }.filter { !$0.isEmpty })
        guard !held.isEmpty else { return body }
        let parts = body.components(separatedBy: "\n\n")
        for start in parts.indices.dropFirst() {
            for end in start..<min(parts.count, start + 8) {
                if held.contains(parts[start...end].map(Self.replayKey).joined(separator: " ")) {
                    return parts[..<start].joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }
        return body
    }

    /// A sub-agent's admission receipt, from the tool result or from
    /// `subagent.completed`, whichever arrives first. The other is the same task.
    private mutating func noteLaunch(agent: String, task: String, call: String?, turn: String?, at stamp: Date?) {
        taskAgents[task] = agent
        let group = turn ?? call.flatMap { callTurns[$0] } ?? currentTurnId ?? ""
        if let index = subagentRuns.firstIndex(where: { $0.agentId == agent }) {
            // Steered again: one row, back to work.
            if subagentRuns[index].taskId != task {
                subagentRuns[index].taskId = task
                subagentRuns[index].taskStartedAt = stamp
                subagentRuns[index].state = .working
                subagentRuns[index].result = nil
            }
        } else {
            let brief = call.flatMap { callBriefs[$0] }
            subagentRuns.append(SubagentRun(
                agentId: agent,
                childSessionId: childSessions[agent],
                childCall: childCalls[agent],
                taskId: task,
                title: SubagentRun.title(fromBrief: brief, fallbackIndex: subagentRuns.count + 1),
                startedAt: stamp,
                groupId: group
            ))
        }
        if let call {
            callBriefs[call] = nil
            callTurns[call] = nil
        }
    }

    /// The session is gone or replaced: nothing it started will report back.
    private mutating func abandonRuns() {
        for index in subagentRuns.indices where subagentRuns[index].state == .working {
            subagentRuns[index].state = .cancelled(at: nil)
        }
    }

    /// An owner row whose turn ended with no model step while a request was
    /// open was held by eve, not answered.
    private mutating func markQueued(_ record: TurnRecord) {
        // The turn that raised the request before doing any work is held
        // too, and eve never replays it. It may show a `step.started` (the
        // pause lands before the model call) or none, so the step is no test.
        guard !pendingRequests.isEmpty, record.sawMessage,
              record.raisedRequest || (!record.sawStep && !record.producedWork),
              let carried = record.carriedUserMessageId,
              let index = indexById[carried] else { return }
        let id = messages[index].id
        queuedMessageIds.insert(id)
        if !heldOrder.contains(id) { heldOrder.append(id) }
        if record.raisedRequest { heldOrigins.insert(id) }
    }

    /// The held rows are gone for good: the answer was Stop, or eve went on
    /// without replaying them.
    public mutating func dropHeldMessages() {
        for id in heldOrder { droppedMessageIds.insert(id) }
        heldOrder = []
        heldOrigins = []
        queuedMessageIds = []
        replayOpen = false
        replayTurn = nil
    }

    /// Owner text as eve repeats it: without the thread prefix, whitespace
    /// folded, so a stray newline or a doubled space is the same message.
    private static func replayKey(_ text: String) -> String {
        EveStream.stripThreadPrefix(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// eve answers a request by replaying what it held as one new message
    /// (several joined by a blank line), and never replays the message whose
    /// turn raised the request. A message that is that replay joins the rows
    /// it repeats instead of adding new ones. `within` is a report turn eve
    /// merged the replay into: the held text is found inside it. Nothing is
    /// dropped here; the replay turn's end decides (`settleReplay`).
    private mutating func attachReplay(_ text: String, within: Bool, at stamp: Date?) -> Bool {
        guard replayOpen, pendingRequests.isEmpty, !heldOrder.isEmpty else { return false }
        let here = currentTurnId ?? ""
        // Once a turn has been taken for the replay, no other turn is.
        if let taken = replayTurn, taken != here { return false }
        let texts = heldOrder.map { id in indexById[id].map { Self.replayKey(messages[$0].text) } ?? "" }
        let wanted = Self.replayKey(text)
        var matched: [Int] = []
        search: for length in stride(from: texts.count, through: 1, by: -1) {
            for start in 0...(texts.count - length) where texts[start..<start + length].joined(separator: " ") == wanted {
                matched = Array(start..<start + length)
                break search
            }
        }
        if matched.isEmpty, within {
            // Inside a merged report turn the held text stands as its own
            // blank-line-separated segment, never as a word inside another's.
            // A held text of several paragraphs is a run of consecutive segments.
            let parts = text.components(separatedBy: "\n\n").map(Self.replayKey)
            var runs = Set<String>()
            for start in parts.indices {
                for end in start..<min(parts.count, start + 8) {
                    runs.insert(parts[start...end].joined(separator: " "))
                }
            }
            matched = texts.indices.filter { !texts[$0].isEmpty && runs.contains(texts[$0]) }
        }
        guard !matched.isEmpty else { return false }
        replayTurn = here
        let attached = matched.map { heldOrder[$0] }
        heldOrder = heldOrder.enumerated().filter { !matched.contains($0.offset) }.map(\.element)
        queuedMessageIds = Set(heldOrder)
        if heldOrder.isEmpty { replayOpen = false; replayTurn = nil }
        if !within {
            for id in attached { Self.claimUserRow(id, on: &turn) }
            turn.lastRowId = attached.last
            turnStartedAt = stamp ?? Date()
            failed = false
            failure = nil
            pending = true
            activity = .thinking
        }
        return true
    }

    /// The replay turn ended: whatever it did not include never reached the bot.
    private mutating func settleReplay(_ event: EveEvent) {
        guard replayOpen, let turnId = replayTurn, (event.turnId ?? currentTurnId ?? "") == turnId else { return }
        dropHeldMessages()
    }

    public mutating func beginTurn() {
        pending = true
        turnStartedAt = Date()
        failed = false
        failure = nil
        searchHits = []
        activity = .thinking
        // The owner's message is the answer to anything the bot had asked.
        // eve confirms that with `input.resolved`, but it files it ahead of
        // this turn's user message, where the send's reader never looks, so
        // the card stayed up, greyed out, until the reply finished.
        questions = []
        // The turn that was in flight is not this one, so its claim on a row
        // is not this turn's either. Its record is kept rather than dropped,
        // open block and all: its failure can still arrive after this send's
        // message, and has to find the row it carried; the rest of its reply
        // can too, and continues the block it was in. (The row itself stays,
        // and an immediate resend of the same text still folds into it
        // through the optimistic branch below, as it always has.)
        leaveCurrentTurn()
    }

    /// Dedupe identity with a bounded FIFO: the oldest remembered id is
    /// evicted first, so a long replay can neither grow without bound nor
    /// re-apply the events it already saw.
    private mutating func remember(_ id: String) {
        seen.insert(id)
        if seenOrder.count < Self.seenCap {
            seenOrder.append(id)
        } else {
            let evicted = seenOrder[seenCursor]
            seenOrder[seenCursor] = id
            seen.remove(evicted)
            seenCursor = (seenCursor + 1) % Self.seenCap
        }
    }

    public mutating func apply(_ event: EveEvent, live: Bool = false) {
        var event = event
        // Dedupe every identified event by id;
        // a replayed chunk id must not append its delta twice.
        if let id = event.id {
            if seen.contains(id) { return }
            remember(id)
        }
        // The position on the event's own session stream, before it becomes
        // the projection's count: a sub-agent's call site is named by it.
        let streamIndex = event.index
        // Every journal comparison below reads this, so it is the one place a
        // session's positions are put in the projection's count.
        event.index = journalPosition(of: event)
        // eve numbers turns per session, so a fresh session's first turn is
        // `turn_0` again, and here that id already belonged to an old turn
        // that ended: every event of the new turn was dropped as a replay of
        // it, and a chat moved to a new session showed nothing until it was
        // reopened ("it doesn't refresh"). Turns of any session after this
        // projection's first are keyed by their session too. The first stays
        // raw, so a saved one-session snapshot keeps matching its events.
        // Keyed off the first session named, not off a switch having been
        // seen, so a late event of the first session stays raw too.
        if let session = event.sessionId {
            if let tasks = tasksSession, tasks != session {
                runningTasks = [:]
                abandonRuns()
                tasksSession = nil
            }
            // Another session is another chat: what the last one was waiting
            // on, and the rows it held, will never be answered or replayed.
            if let active = activeSession, active != session {
                pendingRequests = []
                dropHeldMessages()
            }
            activeSession = session
            if firstSession == nil { firstSession = session }
            if session != firstSession, let turnId = event.turnId, !turnId.isEmpty {
                event.turnId = "\(session)/\(turnId)"
            }
        }
        // A server stamp wins; otherwise a turn that is happening now is
        // stamped from the client clock, while a replay of old history is not
        // (the durable events already carry their own times).
        let stamp = TranscriptBlocks.date(fromISO8601: event.metaAt) ?? (live ? Date() : nil)
        // A turn this projection never recorded, arriving from before the
        // newest turn it knows. Taken for the next turn it stepped off the
        // live one, appended its rows under the live rows where a replay
        // puts them above, and its end then cleared the working row while the
        // live turn's end was still owed. It is a turn the next one has
        // passed, so it gets the record such a turn keeps: its rows go where
        // the journal says, and its end is its own.
        if isBackfill(event), let named = event.turnId {
            stash(named, TurnRecord(superseded: true))
        }
        // Work for a turn this projection has stepped off (its send's stream
        // dropped, and the follower is bringing the rest of it in under the
        // next turn's message) is still that turn's work. Its failure, when
        // it comes, then keeps its row rather than folding it.
        if let named = event.turnId, named != currentTurnId,
           var stepped = turns[named], !stepped.ended, Self.isWork(event) {
            stepped.producedWork = true
            turns[named] = stepped
        }
        switch event.type {
        case "turn.started":
            if let named = event.turnId {
                // The start of the turn already in flight, arriving late (a
                // send's armed stream skips it and the follower brings it
                // after the echo) or again (a rewind). The turn began when
                // its message did; resetting it here threw away the row it
                // carried, and its failure then had nothing to fold.
                if named == currentTurnId { break }
                if let known = turns[named] {
                    // A turn that is over does not start again: taken for
                    // real, a rewound start of the turn before wiped the
                    // banner of the one that had actually failed. A turn
                    // stepped off before its start arrived is still running
                    // only if nothing else has begun since; one another
                    // turn's message has passed is over too, its end late.
                    guard canResume(known), let stepped = unstash(named) else { break }
                    turn = stepped
                } else {
                    // Another turn's start, while this one is in flight, is
                    // a follower that rewound past the id cache. Taken for
                    // real it made that turn the current one, and the rest
                    // of this turn's reply was gated out as somebody else's.
                    // eve runs one turn at a time, and the next real one
                    // names itself in its message anyway.
                    guard currentTurnId == nil else { break }
                    // Nothing is named yet, so what the anonymous record
                    // holds is this turn's: a send that died before its echo
                    // armed leaves its optimistic claim there, and the
                    // follower then brings this start ahead of the echo.
                    // Reset, the claim was gone, its failure could fold
                    // nothing, and the retry stacked.
                    noteTurnStart(event.index)
                    // A turn beginning is every open turn ending, the same
                    // as at a message. Left open, a turn stepped off with its
                    // start still owed was resumed by that start after this
                    // turn had begun and ended, and a rewound start wiped
                    // the banner of the turn that had actually failed.
                    for (id, open) in turns where !open.ended && !open.superseded {
                        turns[id]?.superseded = true
                    }
                }
                currentTurnId = named
            } else {
                leaveCurrentTurn()
            }
            // A turn starting is where its clock starts: a follower sees this
            // ahead of the message, and the last turn's start showed until then.
            turnStartedAt = stamp ?? Date()
            pending = true
            failed = false
            failure = nil
            searchHits = []
            activity = .thinking
        case "message.received":
            // A message this projection already holds is a redelivery of it,
            // not a turn. The id cache above is bounded, so this is the check
            // that survives a session longer than the cache, and it comes
            // before the folds: a redelivery is not a retry and must not take
            // a failure banner down with it.
            if let id = event.id, indexById[id] != nil { return }
            // The message names the turn it belongs to, and it is the only
            // event that always reaches this projection: a send arms its
            // stream at its own `message.received`, so the `turn.started`
            // ahead of it is never applied and the id would stay unknown for
            // the whole live turn.
            let text = EveStream.stripThreadPrefix(event.message ?? "")
            // A sub-agent or background tool reporting back. eve marks it
            // (`kind`, scripts/patch-eve.mjs); an owner's own send never carries
            // the mark. eve drops it when an owner message and a report are
            // merged into one turn, and such a message then goes by the wording
            // like streams written before the mark: known by eve's wording and
            // by a task this session started. An owner who pastes that wording
            // is still the owner.
            let reports = EveStream.taskReports(text)
            let fromTask = event.data?["kind"]?.stringValue == EveStream.backgroundTaskKind
                || reports.first.map { runningTasks[$0.taskId] != nil || settledTasks.contains($0.taskId) } == true
            if let id = event.id, EveStream.isContinuationTurn(event.message ?? "") {
                continuationRowId = id
            }
            if let named = event.turnId, named != currentTurnId {
                if let known = turns[named] {
                    // A message for a turn that is over is a rewind re-sending
                    // it, and the row it names is here or was folded away.
                    if known.ended { return }
                    // A message eve filed under a turn this projection has
                    // stepped off, arriving late. A send's own echo, still
                    // under the optimistic row it answers, means that turn is
                    // the one in flight after all and the row is its. Not a
                    // turn another turn's message has passed: eve runs one
                    // turn at a time, so its echo cannot be this send's.
                    // Anything else goes under the rows that turn already
                    // owns, and the turn in flight keeps the projection:
                    // taking it away gated out the rest of the live reply as
                    // somebody else's.
                    let ownEcho = currentTurnId == nil && !turn.isBlank && !known.superseded
                        && messages.last.map {
                            $0.role == .user && $0.text == text && $0.id.hasPrefix(EveStream.optimisticUserPrefix)
                        } == true
                    guard canResume(known) || ownEcho, var stepped = unstash(named) else {
                        // A late report is still the bot's, never an owner row.
                        if fromTask {
                            settleReports(reports, text: text, at: stamp)
                            return
                        }
                        lateUserRow(event, text: text, at: stamp, for: named)
                        return
                    }
                    if ownEcho, let optimistic = messages.last?.id {
                        Self.claimUserRow(optimistic, on: &stepped)
                    }
                    turn = stepped
                } else if currentTurnId != nil {
                    // eve runs one turn at a time, so a message for another
                    // turn means the one in flight is over and its end went
                    // unseen; its record waits for that end, and so does every
                    // other open one. From no turn at all, what the record
                    // holds so far is this turn's: a send claims its
                    // optimistic row before the echo names the turn.
                    leaveCurrentTurn()
                }
                for (id, open) in turns where !open.ended && !open.superseded {
                    turns[id]?.superseded = true
                }
                currentTurnId = named
                noteTurnStart(event.index)
            }
            // A background sub-agent reporting back. eve sends that as a
            // message into the session, and it is the bot's to read, not the
            // owner's: it opens the turn in which the bot answers, and shows
            // only in the working row.
            if fromTask {
                settleReports(reports, text: text, at: stamp)
                _ = attachReplay(text, within: true, at: stamp)
                turn.fromTask = true
                failed = false
                failure = nil
                pending = true
                turnStartedAt = stamp ?? Date()
                // A background tool's own message names no task: the bot is
                // reading it, not waiting on a sub-agent.
                activity = reports.isEmpty ? .thinking : .subagent(finished: reports.allSatisfy(\.settled))
                return
            }
            // The last turn failed before the bot said anything, and eve threw
            // the message away with it. The same text arriving again is that
            // message being sent a second time, so it rewrites the row that is
            // already on screen. Without this, eight minutes of a provider
            // outage left the one question standing six times over, under a
            // single failure banner, none of it in the session.
            if let discarded = discardedUserMessageId,
               let last = messages.last, last.role == .user,
               last.id == discarded, last.text == text {
                // Without an id there is nothing to adopt: the row already
                // reads right, so the marker stays armed and the echo that
                // does carry one folds into it rather than beside it.
                if let id = event.id {
                    adoptLastUserRow(id: id, text: text, at: stamp ?? last.at, journal: event.index)
                    turn.carriedUserMessageId = id
                    discardedUserMessageId = nil
                } else {
                    turn.carriedUserMessageId = last.id
                }
                // The row is this turn's again, and nothing else is open.
                turn.openUserRows = 1
                turn.sawMessage = true
                turn.lastRowId = turn.carriedUserMessageId
                // This attempt supersedes the one that failed, the way
                // `turn.started` supersedes it on a stream that sends one.
                failed = false
                failure = nil
                turn.producedWork = false
                pending = true
                turnStartedAt = stamp ?? Date()
                activity = .thinking
                return
            }
            // Only the optimistic row this app synthesised for the send is
            // folded into the authoritative echo; a legitimate repeat of the
            // same text still appends as its own turn.
            if let last = messages.last, last.role == .user, last.text == text,
               last.id.hasPrefix(EveStream.optimisticUserPrefix) {
                if turn.openUserRows == 0 {
                    // Nothing claims the row this turn is folding into: a send
                    // that died before its echo left it, and its claim went
                    // with the turn `beginTurn` stepped off. The row is this
                    // turn's now, so it claims it; unclaimed, its failure had
                    // nothing to discard and the next retry stacked.
                    Self.claimUserRow(event.id ?? last.id, on: &turn)
                } else if let id = event.id, turn.carriedUserMessageId == last.id {
                    // Only re-point a claim that named this row: a nil slot
                    // means two rows are open and neither may be claimed.
                    turn.carriedUserMessageId = id
                }
                if let id = event.id {
                    adoptLastUserRow(id: id, text: text, at: stamp ?? last.at, journal: event.index)
                    turn.lastRowId = id
                }
                turn.sawMessage = true
                pending = true
                activity = .thinking
                return
            }
            if attachReplay(text, within: false, at: stamp) { return }
            let userId = event.id ?? mintId("u")
            turnStartedAt = stamp ?? Date()
            appendMessage(ChatMessage(
                id: userId,
                role: .user,
                text: text,
                at: stamp
            ), journal: event.index)
            // A message is a turn starting, so the last one's outcome goes
            // with it. Only the matching retry used to clear this, which left
            // a failure banner standing over a different question on a stream
            // that sends no `turn.started` of its own.
            failed = false
            failure = nil
            Self.claimUserRow(userId, on: &turn)
            // A different message is a new question: the failed row stays put
            // as the record of an attempt, and nothing folds into it again.
            discardedUserMessageId = nil
            pending = true
            activity = .thinking
        case "compaction.requested":
            // Not work: a turn that fails here left nothing under its message.
            guard case .current = turnOwner(of: event) else { break }
            activity = .compacting
        case "compaction.completed":
            // The history was replaced whichever turn this belonged to, so
            // the note is kept for a stepped-off turn too. The event's id
            // already deduped a replay at the top of `apply`.
            compactionMarks.append(CompactionMark(
                id: event.id ?? mintId("c"),
                anchorId: messages.last?.id,
                at: stamp
            ))
            guard case .current = turnOwner(of: event) else { break }
            activity = .thinking
        case "reasoning.appended", "reasoning.completed":
            // Thinking shows in the working row and nowhere else, so a turn
            // that fails here leaves nothing under its message: not work.
            guard case .current = turnOwner(of: event) else { break }
            activity = .thinking
        case "actions.requested":
            // An older turn's call, replayed by a follower that rewound past
            // the bounded id cache, is not what this turn is doing and not a
            // drawing this turn made. It counted as neither, but it was still
            // putting that turn's tool name in the working row and its widget
            // on screen. A stepped-off turn's late call is a drawing that
            // turn made, and a replay shows it; what the working row says is
            // still the live turn's.
            for action in event.data?["actions"]?.arrayValue ?? [] {
                guard action["toolName"]?.stringValue == "agent" || action["subagentName"]?.stringValue != nil,
                      let call = action["callId"]?.stringValue, !call.isEmpty else { continue }
                if let brief = action["input"]?["message"]?.stringValue { callBriefs[call] = brief }
                if let turn = event.turnId { callTurns[call] = turn }
            }
            let owner = turnOwner(of: event)
            guard var record = record(of: owner) else { break }
            record.producedWork = true
            store(record, for: owner)
            if case .current = owner { foldRetriedFailures() }
            if case .current = owner, let name = EveStream.requestedToolName(event.data) {
                activity = .tool(name, detail: EveStream.requestedToolDetail(event.data))
            }
            // The validated call is the one place a drawing is complete and
            // carries its call id. Input deltas are partial JSON, one event
            // per chunk, and a result carries no arguments.
            for widget in EveStream.parseLiveWidgets(event.data) {
                if let index = widgets.firstIndex(where: { $0.id == widget.id }) {
                    widgets[index] = widget
                } else {
                    widgets.append(widget)
                }
            }
        case "action.input.appended":
            guard case .current = turnOwner(of: event) else { break }
            if let name = event.data?["toolName"]?.stringValue, !name.isEmpty {
                // A late input delta must not wipe the detail the validated
                // call already gave this same tool.
                if case .tool(name, _) = activity { break }
                activity = .tool(name)
            }
        case "message.appended":
            let delta = event.messageDelta ?? ""
            guard !delta.isEmpty else { return }
            // Another turn's text is not this turn's reply. A rewind that
            // re-sends an older block's deltas was taken for the live answer:
            // it stole the current block, and the rest of this turn's text
            // then appended to that older row, splitting the reply in two.
            // A stepped-off turn's text is its reply arriving late, and goes
            // under its own rows: gated out, the answer eve held never showed
            // until a reload put it there.
            let owner = turnOwner(of: event)
            guard var record = record(of: owner) else { return }
            defer { store(record, for: owner) }
            // The first delta of a block this projection already holds names
            // that block: the rest of its deltas follow, and the text is
            // already here.
            if let id = event.id, let index = indexById[id] {
                record.assistantId = messages[index].id
                record.replayingMessage = true
                if case .current = owner { activity = .working }
                return
            }
            if record.replayingMessage {
                // A delta this turn owns, dropped because a replayed block is
                // still being read past. Whatever the reader sees, the turn
                // did start answering, so its message is not the app's to
                // fold away.
                record.producedWork = true
                return
            }
            // Text is arriving: the row is about to be replaced by the reply
            // itself, so it must not still claim a tool is running. Only new
            // text counts as this turn's work; a redelivery of an old block
            // returned above, and letting it through would make an untouched
            // turn look like one that got somewhere.
            let firstWork = !record.producedWork
            record.producedWork = true
            record.openUserRows = 0
            if case .current = owner {
                activity = .working
                if firstWork { foldRetriedFailures() }
            }
            if let current = record.assistantId,
               let index = indexById[current] {
                messages[index].text += delta
            } else {
                let id = event.id ?? mintId("a")
                record.assistantId = id
                insertMessage(
                    ChatMessage(id: id, role: .assistant, text: delta, at: stamp),
                    under: record.lastRowId,
                    journal: event.index
                )
                record.lastRowId = id
                if record.fromTask, !record.taskReplyMarked {
                    taskReplyRowIds.insert(id)
                    record.taskReplyMarked = true
                }
            }
        case "message.completed":
            let full = EveStream.stripThreadPrefix(event.message ?? "")
            // Another turn's completion rewrites that turn's own row, which is
            // its text either way, and touches nothing else: ending this
            // turn's block on it wrote an older answer over the live one.
            let owner = turnOwner(of: event)
            guard var record = record(of: owner) else {
                if !full.isEmpty, let id = event.id, let index = indexById[id] {
                    messages[index].text = full
                    if messages[index].at == nil { messages[index].at = stamp }
                }
                return
            }
            defer { store(record, for: owner) }
            record.replayingMessage = false
            if !full.isEmpty {
                // The completion is authoritative: a replay of a message
                // already here rewrites it in place rather than appending a
                // copy of the same reply. It is that older turn's work, not
                // this one's.
                if let id = event.id, let index = indexById[id] {
                    messages[index].text = full
                    if messages[index].at == nil { messages[index].at = stamp }
                    record.assistantId = nil
                    if case .current = owner { activity = .thinking }
                    return
                }
                record.producedWork = true
                record.openUserRows = 0
                if case .current = owner { foldRetriedFailures() }
                if let current = record.assistantId,
                   let index = indexById[current] {
                    messages[index].text = full
                    // The deltas may have been undated (a replay without
                    // `meta.at`); the completion's stamp still lands.
                    if messages[index].at == nil { messages[index].at = stamp }
                } else {
                    let id = event.id ?? mintId("a")
                    insertMessage(
                        ChatMessage(id: id, role: .assistant, text: full, at: stamp),
                        under: record.lastRowId,
                        journal: event.index
                    )
                    record.lastRowId = id
                    if record.fromTask, !record.taskReplyMarked {
                        taskReplyRowIds.insert(id)
                        record.taskReplyMarked = true
                    }
                }
            }
            // Also on an empty completion: a later delta must not append to a
            // stale bubble.
            record.assistantId = nil
        case "turn.failed", "session.failed":
            if event.type == "turn.failed" { settleReplay(event) }
            switch turnOwner(of: event) {
            case .ignored:
                // Another turn's failure, replayed mid-turn, neither ends
                // this one nor banners it, and must not wipe the claim this
                // turn's own failure needs to fold its retry.
                break
            case .steppedOff(let id):
                // The failure of a turn the owner has already resent past:
                // its stream dropped, eve failed it server-side, and the
                // follower brought the failure only after the next turn's
                // message. That next turn is the live one, so no banner. But
                // eve still threw this turn's message away, and its row goes.
                // And a session that failed is retired whichever turn it
                // failed on, so a question card goes down here as below.
                if event.type == "session.failed" {
                    questions = []
                    // A retired session wakes for nothing again.
                    runningTasks = [:]
                    abandonRuns()
                    pendingRequests = []
                    dropHeldMessages()
                }
                guard var stepped = turns[id] else { break }
                stepped.ended = true
                turns[id] = stepped
                // Its rows stay unless the retry under them replaced them,
                // and a failure under rows that stay is still news. Never
                // the live one: the turn in flight is somebody else's.
                if !discardMessage(of: stepped) {
                    _ = markFailure(
                        TurnFailure(code: event.data?["code"]?.stringValue ?? event.type, detail: event.message ?? ""),
                        event: event,
                        record: stepped,
                        at: stamp,
                        live: false,
                        standing: retryableMarkId
                    )
                }
            case .current:
                // eve retires a session that failed, and the next message
                // opens a fresh one with none of this history. A question
                // card left up would send its option label into that empty
                // session, where it answers nothing. A failed turn alone
                // keeps the card: the session lives on, so the label still
                // lands beside the question.
                if event.type == "session.failed" {
                    questions = []
                    // A retired session wakes for nothing again.
                    runningTasks = [:]
                    abandonRuns()
                    pendingRequests = []
                    dropHeldMessages()
                }
                let standing = retryableMarkId
                pending = false
                failed = true
                let reported = TurnFailure(
                    code: event.data?["code"]?.stringValue ?? event.type,
                    detail: event.message ?? ""
                )
                failure = reported
                discardMessage(of: turn)
                liveFailureMarkId = markFailure(reported, event: event, record: turn, at: stamp, live: true, standing: standing)
                // Nothing of the owner's to resend: Retry would send their
                // last message, already answered, a second time.
                if turn.fromTask { liveFailureMarkId = nil }
                // A turn that ended takes its id with it. Left behind, it
                // makes the next turn's work look like somebody else's and
                // stops it counting, which is the direction that folds a
                // turn that acted.
                turn.ended = true
                leaveCurrentTurn()
            }
        case "action.result", "action.partial":
            // A sub-agent started in the background: the call returns at
            // once, and the task runs on after the turn ends. Any turn's, so
            // a replay puts back the ones still out.
            if event.type == "action.result",
               let output = event.data?["result"]?["output"],
               output["status"]?.stringValue == "working",
               let task = output["taskId"]?.stringValue, task.hasPrefix("task_") {
                runningTasks[task] = runningTasks[task] ?? stamp ?? Date()
                if let session = event.sessionId { tasksSession = session }
                if let agent = output["agentId"]?.stringValue, !agent.isEmpty {
                    noteLaunch(agent: agent, task: task, call: event.data?["result"]?["callId"]?.stringValue, turn: event.turnId, at: stamp)
                }
            }
            // Another turn's results are not this turn's chips.
            guard case .current = turnOwner(of: event) else { break }
            turn.producedWork = true
            foldRetriedFailures()
            let chips = EveStream.parseSearchChips(event.data)
            if !chips.isEmpty { searchHits = chips }
            if event.type == "action.result" { activity = .thinking }
        case "subagent.completed":
            // The admission receipt, not a completion: `backgroundTask.status`
            // says the task is working.
            if let task = event.data?["backgroundTask"]?["taskId"]?.stringValue, task.hasPrefix("task_"),
               event.data?["backgroundTask"]?["status"]?.stringValue == "working",
               let output = event.data?["output"]?.stringValue,
               let raw = output.data(using: .utf8),
               let agent = (try? JSONDecoder().decode(JSONValue.self, from: raw))?["agentId"]?.stringValue, !agent.isEmpty {
                noteLaunch(agent: agent, task: task, call: event.data?["callId"]?.stringValue, turn: event.turnId, at: stamp)
            }
        case "subagent.called":
            // May arrive after the receipt and after the parent's turn ended;
            // its turn is the next one's, so it only names the child session.
            if let agent = event.data?["agentId"]?.stringValue, !agent.isEmpty,
               let child = event.data?["childSessionId"]?.stringValue, !child.isEmpty {
                childSessions[agent] = child
                let site = streamIndex.map { SubagentCallSite(sessionId: event.sessionId, index: $0) }
                childCalls[agent] = site
                if let index = subagentRuns.firstIndex(where: { $0.agentId == agent }) {
                    subagentRuns[index].childSessionId = child
                    subagentRuns[index].childCall = site
                }
            }
        case "step.started":
            let owner = turnOwner(of: event)
            guard var record = record(of: owner) else { break }
            record.sawStep = true
            store(record, for: owner)
        case "input.requested":
            // A question an older turn asked and the owner has already
            // answered must not come back as a live card on this one. A
            // stepped-off turn's late question is still open: the owner's
            // answer, when there is one, follows as `input.resolved`.
            let owner = turnOwner(of: event)
            // Not a question: eve holds it until `input.resolved`, whatever
            // turns begin meanwhile, so neither the owner nor the turn rule
            // below closes it. A replayed one is removed by its own resolve.
            for request in EveStream.parsePendingRequests(event.data, eventId: event.id) {
                replayOpen = false
                replayTurn = nil
                if let index = pendingRequests.firstIndex(where: { $0.id == request.id }) {
                    pendingRequests[index] = request
                } else {
                    pendingRequests.append(request)
                }
            }
            guard var record = record(of: owner) else { break }
            // Only a request raised before the turn did anything holds its
            // message: one raised mid-turn resumes that turn once answered.
            if !record.producedWork, !EveStream.parsePendingRequests(event.data, eventId: event.id).isEmpty {
                record.raisedRequest = true
            }
            // A question ends the turn: the bot is waiting on the owner, not
            // working. So it closes the rows above it, the way an answer does.
            record.producedWork = true
            record.openUserRows = 0
            store(record, for: owner)
            if case .current = owner { foldRetriedFailures() }
            // A question journaled before the newest turn began is not open:
            // eve waits on a question, and the message that began that turn
            // is what answered it. A backfilled turn's question came up as a
            // card on the turn that followed it. Without positions the
            // question shows until its `input.resolved` arrives, as before.
            if let index = event.index, let newest = newestTurnStart, index < newest { break }
            for question in EveStream.parseQuestions(event.data) {
                if let index = questions.firstIndex(where: { $0.id == question.id }) {
                    questions[index] = question
                } else {
                    questions.append(question)
                }
            }
        case "input.resolved":
            let resolved = Set((event.data?["resolutions"]?.arrayValue ?? [])
                .compactMap { $0["requestId"]?.stringValue })
            questions.removeAll { resolved.contains($0.id) }
            pendingRequests.removeAll { resolved.contains($0.id) }
            // Stop is in the resolution, so a replay reads it the way a live
            // stream does: nothing held will ever be replayed.
            let stopped = (event.data?["resolutions"]?.arrayValue ?? []).contains {
                $0["kind"]?.stringValue == "session-limit" && $0["response"]?["optionId"]?.stringValue == "stop"
            }
            if stopped {
                dropHeldMessages()
            } else if pendingRequests.isEmpty, !heldOrder.isEmpty {
                // eve never replays the message whose turn raised the request:
                // it is gone now, and the owner can send it again.
                for id in heldOrigins { droppedMessageIds.insert(id) }
                heldOrder.removeAll { heldOrigins.contains($0) }
                queuedMessageIds.subtract(heldOrigins)
                heldOrigins = []
                replayOpen = !heldOrder.isEmpty
                replayTurn = nil
            }
        case "turn.completed", "turn.cancelled", "session.waiting", "session.completed":
            // The session ended with rows still held: eve will not replay them.
            if event.type == "session.completed", pendingRequests.isEmpty { dropHeldMessages() }
            if event.type == "turn.completed" || event.type == "turn.cancelled" { settleReplay(event) }
            switch turnOwner(of: event) {
            case .ignored:
                // The same for another turn's end: this turn is still running.
                break
            case .steppedOff(let id):
                // A stepped-off turn ending without failing kept its message,
                // so a marker still on the row it carried names a message the
                // session holds.
                guard var stepped = turns[id] else { break }
                stepped.ended = true
                turns[id] = stepped
                if event.type == "turn.completed" { markQueued(stepped) }
                if let carried = stepped.carriedUserMessageId, discardedUserMessageId == carried {
                    discardedUserMessageId = nil
                }
            case .current:
                // A turn that carried a message and ended without failing
                // kept it, so a row still armed from an earlier failure (a
                // fold whose echo had no id to adopt) names a message the
                // session now holds. Not on `session.waiting`: it follows a
                // failure too, and the fold already requires the discarded
                // row to still be the last one, which any answer pushes it
                // out of.
                if turn.sawMessage, event.type != "session.waiting" {
                    discardedUserMessageId = nil
                    // Only an answer: Stop on a retry leaves its failure the
                    // last word on that message.
                    if event.type == "turn.completed" { foldRetriedFailures() }
                }
                if event.type == "turn.completed" { markQueued(turn) }
                pending = false
                turn.ended = true
                leaveCurrentTurn()
            }
        default:
            break
        }
    }
}

/// One `ask_question` request from an `input.requested` event.
public struct OwnerQuestion: Identifiable, Codable, Equatable, Sendable {
    public struct Option: Identifiable, Codable, Equatable, Sendable {
        public var id: String
        public var label: String
        public var detail: String

        public init(id: String, label: String, detail: String) {
            self.id = id
            self.label = label
            self.detail = detail
        }
    }

    /// eve's `requestId`.
    public var id: String
    public var prompt: String
    public var options: [Option]
    public var allowFreeform: Bool

    public init(id: String, prompt: String, options: [Option], allowFreeform: Bool) {
        self.id = id
        self.prompt = prompt
        self.options = options
        self.allowFreeform = allowFreeform
    }
}

public struct LiveWidget: Codable, Equatable, Sendable {
    public var id: String
    public var connectionId: String
    public var toolName: String
    public var arguments: [String: JSONValue]
    public var callId: String

    public init(id: String, connectionId: String, toolName: String, arguments: [String: JSONValue], callId: String) {
        self.id = id
        self.connectionId = connectionId
        self.toolName = toolName
        self.arguments = arguments
        self.callId = callId
    }
}

extension EveStream {
    /// The questions in an `input.requested` event. Tool approvals ride the
    /// same event with another `kind`; this app gates tools with its own
    /// approval cards, so only questions are read here.
    public static func parseQuestions(_ data: JSONValue?) -> [OwnerQuestion] {
        guard let requests = data?["requests"]?.arrayValue else { return [] }
        var found: [OwnerQuestion] = []
        for request in requests where request["kind"]?.stringValue == "question" {
            guard let id = request["requestId"]?.stringValue, !id.isEmpty,
                  let prompt = request["prompt"]?.stringValue,
                  !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let options = (request["options"]?.arrayValue ?? []).compactMap { option -> OwnerQuestion.Option? in
                guard let optionId = option["id"]?.stringValue, !optionId.isEmpty,
                      let label = option["label"]?.stringValue, !label.isEmpty else { return nil }
                return OwnerQuestion.Option(
                    id: optionId,
                    label: label,
                    detail: option["description"]?.stringValue ?? ""
                )
            }
            // eve's own default when the model leaves it out: a question with
            // no options can only be answered in words.
            let freeform = request["allowFreeform"]?.boolValue ?? options.isEmpty
            found.append(OwnerQuestion(id: id, prompt: prompt, options: options, allowFreeform: freeform))
        }
        return found
    }

    /// The MCP App calls in an `actions.requested` event. The id is eve's
    /// tool call id, so a replay or a retry of the same call is one drawing.
    public static func parseLiveWidgets(_ data: JSONValue?) -> [LiveWidget] {
        guard let actions = data?["actions"]?.arrayValue else { return [] }
        var found: [LiveWidget] = []
        for action in actions {
            let name = action["toolName"]?.stringValue ?? ""
            guard let cut = name.range(of: "__") else { continue }
            let connectionId = String(name[..<cut.lowerBound])
            guard connectionId.range(of: "^[a-z][a-z0-9-]{0,63}$", options: .regularExpression) != nil else {
                continue
            }
            let args = action["input"]?.objectValue ?? [:]
            guard name.hasSuffix("__create_view") || args["elements"] != nil else { continue }
            let callId = (action["callId"]?.stringValue ?? "")
                .replacingOccurrences(of: "[^a-zA-Z0-9_-]", with: "", options: .regularExpression)
            // The server refuses a shorter id, and without one there is
            // nothing stable to key the drawing on.
            guard callId.count >= 8 else { continue }
            let widgetId = String(callId.prefix(80))
            found.append(LiveWidget(
                id: widgetId,
                connectionId: connectionId,
                toolName: name,
                arguments: args,
                callId: widgetId
            ))
        }
        return found
    }
}

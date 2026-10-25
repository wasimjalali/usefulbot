import Foundation

/// Minimal JSON tree so payloads with unknown shapes (search results, a
/// widget's arguments) can be walked and sent back.
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

/// One web result chip from a `web_search` result.
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

/// What the live turn is doing right now, read off the chat stream and shown
/// in the working row while the reply is still on its way.
public enum TurnActivity: Codable, Equatable, Sendable {
    case thinking
    case working
    /// The tool by name, and the engine's own short label for the step when
    /// it sent one ("Running a command", "Searching the web").
    case tool(String, detail: String? = nil)
    /// The engine is summarizing older messages so the chat fits the model's
    /// window. It can take a while on a long chat, and a bare "Thinking"
    /// through it read as a hang.
    case compacting
    /// The provider failed and the engine is trying the request again.
    case retrying

    /// A shell command is running (the `bash` tool): the working mark shows
    /// its four-dot figure. Only `bash` counts. `install_cli` also runs a
    /// command, but it reads as "Setting up a tool", a step of its own.
    public var runsCommand: Bool {
        if case .tool("bash", _) = self { return true }
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
        case .retrying: return "Trying again"
        case .tool(let name, let detail):
            if let detail, !detail.trimmingCharacters(in: .whitespaces).isEmpty { return detail }
            return Self.toolLabel(name)
        }
    }

    /// The activity an `activity` event or a status row names.
    public init(kind: String, tool: String?, detail: String?) {
        switch kind {
        case "tool": self = .tool(String((tool ?? "").prefix(80)), detail: detail.map { String($0.prefix(80)) })
        case "compacting": self = .compacting
        case "retrying": self = .retrying
        default: self = .thinking
        }
    }

    /// Says what the bot is doing, not which function it called. The 16
    /// tools of the engine have a label each; a connected server's tool is
    /// named `<connection>__<tool>` and reads as the connection.
    public static func toolLabel(_ name: String) -> String {
        if let known = known[name] { return known }
        if let cut = name.range(of: "__") {
            let connection = name[..<cut.lowerBound].replacingOccurrences(of: "-", with: " ")
            guard !connection.isEmpty else { return "Working" }
            return "Using \(connection.prefix(1).uppercased() + connection.dropFirst())"
        }
        let spoken = name
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespaces)
        guard !spoken.isEmpty else { return "Working" }
        return "Using \(spoken.lowercased())"
    }

    private static let known: [String: String] = [
        "ask": "Asking you",
        "apps": "Using an app",
        "bash": "Running a command",
        "connect_server": "Connecting a server",
        "find_tools": "Looking for tools",
        "generate_image": "Drawing an image",
        "install_cli": "Setting up a tool",
        "list_dir": "Reading a folder",
        "load_skill": "Loading a skill",
        "memory": "Using memory",
        "read_file": "Reading a file",
        "routine": "Working on a routine",
        "todo": "Planning",
        "web_fetch": "Reading a web page",
        "web_search": "Searching the web",
        "write_file": "Writing a file",
    ]
}

/// Why a turn failed, in words the owner can act on. Codes are the router's
/// (every router code passes through) plus the engine's own: `engine_error`,
/// `interrupted`, `refused` and `unreadable`.
public struct TurnFailure: Codable, Equatable, Sendable {
    public let code: String
    public let detail: String
    /// How long the router said to wait, in milliseconds.
    public let retryAfterMs: Int?
    /// When the provider said a used-up plan limit resets.
    public let resetsAt: Date?

    public init(code: String, detail: String, retryAfterMs: Int? = nil, resetsAt: Date? = nil) {
        self.code = code
        self.detail = detail
        self.retryAfterMs = retryAfterMs
        self.resetsAt = resetsAt
    }

    /// Whether the router has stopped calling the provider for a moment. Only
    /// this failure may hold Retry back: every other one the owner can act on
    /// now, and a few of them (a caller rate limit, a search limit) carry a
    /// `retryAfterMs` of their own that would otherwise arm the same gate and
    /// show them the cool-down wording instead of their own reason.
    public var coolingDown: Bool { code == "circuit_open" }

    /// How long to hold Retry, in whole seconds, for a cool-down that said.
    public var coolDownSeconds: Int? { coolingDown ? retryAfterSeconds : nil }

    /// How long the router said to wait, in whole seconds.
    public var retryAfterSeconds: Int? {
        guard let ms = retryAfterMs, ms > 0 else { return nil }
        // No router cool-down lasts a day. A bigger number is garbled
        // provider text, and taken as it stands it held Retry for years.
        return min(86_400, max(1, Int((Double(ms) / 1000).rounded(.up))))
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

    /// The router refuses a turn on a turned-off route with
    /// `provider_route_retired: <the route's sentence>`; this reads the sentence back out of the failure text.
    static func retiredRouteSentence(_ text: String) -> String? {
        guard let range = text.range(of: "provider_route_retired:") else { return nil }
        let rest = text[range.upperBound...].drop { $0 == " " }
        let sentence = rest.prefix { $0 != "\"" && $0 != "\n" && $0 != "\\" }
        let trimmed = sentence.trimmingCharacters(in: .whitespaces)
        // Cut at an escape (a JSON-escaped apostrophe, say) it is a half
        // sentence: only one that ends like a sentence is shown.
        guard let last = trimmed.last, ".!?".contains(last) else { return nil }
        return trimmed
    }

    public var reason: String? {
        let haystack = "\(code) \(detail)".lowercased()
        if haystack.contains("provider_route_retired") {
            return Self.retiredRouteSentence(detail) ?? Self.retiredRouteSentence(code)
                ?? "Useful Bot can't use this provider connection any more. Pick another model."
        }
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
        if haystack.contains("upstream_chatgpt_model_not_in_plan") {
            return "Your ChatGPT plan can't use this model in Useful Bot. Pick another model."
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
        // Neither of the next two is about spend, and the router's wording
        // for a 429 can carry `rate_limit_error` too, so they come first.
        if haystack.contains("global_concurrency_limit") {
            return "Too many turns are running at once. Try again in a moment."
        }
        // Not a pause. The router stops an alias outright when a turn reports
        // more usage than it reserved, and nothing but a restart clears that,
        // so telling the owner to retry in a moment would be a lie.
        if haystack.contains("circuit_disabled") {
            return "The router stopped this model: a turn used more than it reserved. Restart the local services to clear it."
        }
        // The router stops calling a provider that failed three times in a
        // minute, and every turn inside that window is refused before it
        // reaches a model. Name it, and say when it lifts.
        if haystack.contains("circuit_open") {
            if let seconds = retryAfterSeconds {
                return "The model provider failed repeatedly, so sending is paused for \(seconds) more seconds. Retry after that."
            }
            return "The model provider failed repeatedly, so sending is paused briefly. Retry in a moment."
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
        // The router names what the provider refused with, as status and
        // error type or code: "upstream_protocol_error (400 invalid_request_error)".
        // A model that refuses every call is not one that did not answer.
        if let refusal = providerRefusal {
            return "The model provider refused the request (\(refusal)). Send again, or pick another model."
        }
        if haystack.contains("upstream_protocol_error") || haystack.contains("upstream_timeout") {
            return "The model provider did not answer. Check its status or your usage limit, then send again."
        }
        // The provider closed the stream part way through an answer.
        if haystack.contains("ended without a finish reason") {
            return "The model's answer was cut off before it finished. Send it again."
        }
        // The engine's call never reached the router, or the router hung up
        // on it: the local services, not the provider, and a retry is the
        // first thing to try.
        if haystack.contains("cannot connect to api") {
            return "The bot lost its connection to the local router. If it keeps happening, restart the local services."
        }
        if haystack.contains("empty-model-response") || haystack.contains("did not return a response") {
            return "The model returned nothing. Send it again."
        }
        switch code {
        case "interrupted":
            return "Useful Bot stopped before this reply was finished. Retry picks it up from your message."
        case "unreadable":
            return "This chat's file couldn't be read."
        case "engine_error":
            return "Something went wrong while the bot was working. Retry, or send a new message."
        default:
            return nil
        }
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

/// How a send ended, and whether the banner it put up may be retried by
/// sending the turn again.
public struct SendFailure: Equatable, Sendable {
    public let message: String
    /// True only for a turn that ran and failed.
    public let resendable: Bool
    /// Whether the note stays when the chat is read again. A send that never
    /// arrived put its draft back; a reload answers neither it nor a lost
    /// reply stream.
    public let survivesReload: Bool

    public init(message: String, resendable: Bool, survivesReload: Bool = false) {
        self.message = message
        self.resendable = resendable
        self.survivesReload = survivesReload
    }
}

/// One `ask` question from an `input.requested` event or the rows page.
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

        enum CodingKeys: String, CodingKey { case id, label, detail }

        /// A wire option may leave out its label or detail.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let id = try c.decode(String.self, forKey: .id)
            self.init(
                id: id,
                label: (try? c.decode(String.self, forKey: .label)) ?? id,
                detail: (try? c.decode(String.self, forKey: .detail)) ?? ""
            )
        }
    }

    /// The engine's `requestId`.
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

/// An MCP App call the live turn made (a drawing), shown as a card until the
/// engine files the saved widget row for it.
public struct LiveWidget: Codable, Equatable, Sendable {
    public var id: String
    public var connectionId: String
    /// The server's own tool name (`create_view`), as the call carried it.
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

    /// The name `POST /api/agent/widget` reads: the tool qualified with its
    /// connection, the way a model sees a picked tool.
    public var qualifiedToolName: String {
        toolName.contains("__") ? toolName : "\(connectionId)__\(toolName)"
    }
}

public enum ChatText {
    /// Accept a result payload as an array, `{results}`, `{result:{results}}`
    /// or `{output:{results}}`, keep up to five http(s) rows that do not point
    /// at this Mac. The engine sends `searchResults` as an array; the other
    /// shapes stay readable for a saved payload.
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

import Foundation

/// Where eve's `subagent.called` for a child sits: the parent session whose
/// stream carried it and its index on that stream. The proxy serves the
/// child's stream once that one event checks out (web/lib/eve-session-auth.ts).
public struct SubagentCallSite: Codable, Hashable, Sendable {
    public var sessionId: String?
    public var index: Int

    public init(sessionId: String?, index: Int) {
        self.sessionId = sessionId
        self.index = index
    }
}

/// One background sub-agent, stable across relaunches: eve reuses the same
/// agent id with a new task id when the parent steers it again.
public struct SubagentRun: Identifiable, Codable, Equatable, Sendable {
    public enum State: Codable, Equatable, Sendable {
        case working
        case reported(at: Date?)
        case failed(at: Date?, message: String)
        case cancelled(at: Date?)
    }

    public var id: String { agentId }
    public var agentId: String
    /// Nil until eve's `subagent.called` names the child session, which can
    /// arrive after the parent's turn ended.
    public var childSessionId: String?
    /// Where the `subagent.called` that named the child sits; nil when no
    /// stream position came with it.
    public var childCall: SubagentCallSite?
    /// The task the run is on now. A relaunch replaces it.
    public var taskId: String
    public var title: String
    /// The first receipt's event time; a relaunch keeps it.
    public var startedAt: Date?
    /// When the task it is on now was admitted. A relaunch moves it, so the
    /// child's earlier end is not taken for this task's.
    public var taskStartedAt: Date?
    public var state: State
    /// The report's text, once it has reported.
    public var result: String?
    /// The turn that launched it, so a card can be drawn per launching turn.
    public var groupId: String

    public init(
        agentId: String,
        childSessionId: String? = nil,
        childCall: SubagentCallSite? = nil,
        taskId: String,
        title: String,
        startedAt: Date? = nil,
        taskStartedAt: Date? = nil,
        state: State = .working,
        result: String? = nil,
        groupId: String
    ) {
        self.agentId = agentId
        self.childSessionId = childSessionId
        self.childCall = childCall
        self.taskId = taskId
        self.title = title
        self.startedAt = startedAt
        self.taskStartedAt = taskStartedAt ?? startedAt
        self.state = state
        self.result = result
        self.groupId = groupId
    }

    private static let maxTitle = 40
    private static let leadingAdjectives: Set<String> = ["senior", "expert", "lead", "seasoned", "skilled", "meticulous"]
    private static let roleEnders: Set<String> = [
        "who", "that", "whose", "tasked", "reviewing", "critiquing", "evaluating", "assessing",
        "checking", "analysing", "analyzing", "auditing", "with", "focused", "in", "for", "on", "to",
    ]

    /// A short role name from the brief the parent wrote: "You are a senior UX
    /// and accessibility critic reviewing ..." reads "UX and accessibility
    /// critic". A brief that does not open with a role gets "Sub-agent N".
    public static func title(fromBrief brief: String?, fallbackIndex: Int) -> String {
        let fallback = "Sub-agent \(fallbackIndex)"
        guard let first = brief?.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }),
              first.lowercased().hasPrefix("you are ") else { return fallback }
        var words = first.dropFirst("You are ".count).split(separator: " ").map(String.init)
        if let article = words.first?.lowercased(), ["a", "an", "the"].contains(article) { words.removeFirst() }
        while let word = words.first?.lowercased(), leadingAdjectives.contains(word) { words.removeFirst() }
        var role: [String] = []
        for word in words {
            if roleEnders.contains(word.lowercased()) { break }
            role.append(word)
            if let last = word.last, ".,;:".contains(last) { break }
        }
        var text = role.joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: ".,;:"))
        guard !text.isEmpty else { return fallback }
        if text.count > maxTitle {
            // Cut at a word, never mid-word.
            var cut = ""
            for word in text.split(separator: " ") {
                let next = cut.isEmpty ? String(word) : cut + " " + word
                if next.count > maxTitle { break }
                cut = next
            }
            text = cut.isEmpty ? String(text.prefix(maxTitle)) : cut
        }
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}

/// The sub-agents one turn launched.
public struct SubagentBatch: Identifiable, Equatable, Sendable {
    public var id: String
    public var runs: [SubagentRun]
}

/// A request from eve that is not a question: a session limit, a tool
/// approval, or a kind this build does not know yet. It stays until eve's
/// `input.resolved` names it.
public struct PendingRequest: Identifiable, Codable, Equatable, Sendable {
    public struct Option: Identifiable, Codable, Equatable, Sendable {
        public var id: String
        public var label: String
        /// eve's `style` ("primary", "danger"), when it gave one.
        public var style: String?

        public init(id: String, label: String, style: String? = nil) {
            self.id = id
            self.label = label
            self.style = style
        }
    }

    /// eve's `requestId`.
    public var id: String
    public var kind: String
    public var prompt: String
    public var options: [Option]

    public init(id: String, kind: String, prompt: String, options: [Option]) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.options = options
    }
}

/// One sub-agent's report inside a message eve sent on its behalf.
public struct TaskReportDetail: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable { case completed, failed, cancelled, other }
    public var taskId: String
    public var outcome: Outcome
    /// The result text, the error's message, or the update's words.
    public var body: String
}

extension EveStream {
    /// Whether an error message is eve's own wording for a cancelled agent,
    /// "The agent invocation was cancelled.", which is the owner's Stop. Only
    /// that sentence: the server matches the same one.
    public static func isCancellation(_ message: String) -> Bool {
        message.lowercased().contains("the agent invocation was cancelled")
    }

    /// The same reports `taskReports` finds, with what each one said.
    public static func taskReportDetails(_ text: String) -> [TaskReportDetail] {
        let whole = NSRange(text.startIndex..., in: text)
        var found: [(id: String, verb: String, bodyStart: String.Index, start: String.Index)] = []
        for match in taskReportPattern.matches(in: text, range: whole) {
            guard let id = Range(match.range(at: 1), in: text),
                  let verb = Range(match.range(at: 2), in: text),
                  let all = Range(match.range, in: text) else { continue }
            if found.isEmpty ? all.lowerBound != text.startIndex : !text[..<all.lowerBound].hasSuffix("\n\n") { continue }
            found.append((String(text[id]), String(text[verb]), all.upperBound, all.lowerBound))
        }
        var details: [TaskReportDetail] = []
        for (index, report) in found.enumerated() {
            let end = index + 1 < found.count ? found[index + 1].start : text.endIndex
            var body = String(text[report.bodyStart..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            let outcome: TaskReportDetail.Outcome
            switch report.verb {
            case "is completed.":
                outcome = .completed
                if body.hasPrefix("Result:") { body = String(body.dropFirst("Result:".count)).trimmingCharacters(in: .whitespacesAndNewlines) }
            case "failed.":
                outcome = .failed
                if body.hasPrefix("Error:") { body = String(body.dropFirst("Error:".count)).trimmingCharacters(in: .whitespacesAndNewlines) }
                body = errorMessage(body)
            case "is cancelled.":
                outcome = .cancelled
            default:
                outcome = .other
            }
            details.append(TaskReportDetail(taskId: report.id, outcome: outcome, body: body))
        }
        return details
    }

    /// eve's error payload is JSON with a `message`; anything else is shown
    /// as it came, cut short.
    private static func errorMessage(_ body: String) -> String {
        if let data = body.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data),
           let message = value["message"]?.stringValue, !message.isEmpty {
            return message
        }
        return String(body.prefix(400))
    }

    /// The non-question requests in an `input.requested` event. Every kind
    /// but `question` surfaces, known or not: eve is waiting on the owner
    /// either way, and a dropped request is a chat that looks dead.
    public static func parsePendingRequests(_ data: JSONValue?, eventId: String?) -> [PendingRequest] {
        guard let requests = data?["requests"]?.arrayValue else { return [] }
        var found: [PendingRequest] = []
        for (index, request) in requests.enumerated() {
            let kind = request["kind"]?.stringValue ?? "unknown"
            if kind == "question" { continue }
            let requestId = request["requestId"]?.stringValue ?? ""
            let id = requestId.isEmpty ? "\(eventId ?? "request")-\(index)" : requestId
            let prompt = (request["prompt"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let options = (request["options"]?.arrayValue ?? []).compactMap { option -> PendingRequest.Option? in
                guard let optionId = option["id"]?.stringValue, !optionId.isEmpty,
                      let label = option["label"]?.stringValue, !label.isEmpty else { return nil }
                return PendingRequest.Option(id: optionId, label: label, style: option["style"]?.stringValue)
            }
            found.append(PendingRequest(
                id: id,
                kind: kind,
                prompt: prompt.isEmpty ? "Waiting for your answer." : prompt,
                options: options
            ))
        }
        return found
    }
}

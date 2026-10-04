import Foundation

/// What a sub-agent's own stream says it is doing, read for the group card.
/// Only the step, when the stream last spoke, how it ended and the final
/// answer are kept: the child's transcript is never held or drawn.
public struct ChildProgress: Equatable, Sendable {
    /// The task this progress belongs to. A relaunch starts a new one.
    public var taskId: String
    public var activity: TurnActivity = .thinking
    /// Arrival time of the newest child event; nil until one has arrived.
    public var lastEventAt: Date?
    /// The child's last answer that ended on `stop`, not a tool call.
    public var finalAnswer: String?
    /// When the child's turn completed after that answer (its own stamp).
    public var finishedAt: Date?
    /// Eve's code or words when the child's turn or session failed.
    public var failure: String?
    /// The child's turn was cancelled.
    public var cancelled = false
    /// When it failed or was cancelled.
    public var endedAt: Date?

    public init(taskId: String) { self.taskId = taskId }

    public var label: String? { lastEventAt == nil ? nil : activity.label }
}

/// Folds a child's events into `ChildProgress`, event by event, with no
/// projection behind it.
public struct ChildTracker: Sendable {
    public private(set) var progress: ChildProgress
    private var stopAnswer: String?

    public init(taskId: String) { progress = ChildProgress(taskId: taskId) }

    // One of each, made once: a child can send thousands of events.
    private nonisolated(unsafe) static let fractionalStamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private nonisolated(unsafe) static let plainStamp = ISO8601DateFormatter()

    private static func parseStamp(_ text: String) -> Date? {
        fractionalStamp.date(from: text) ?? plainStamp.date(from: text)
    }

    public mutating func apply(_ event: EveEvent, at now: Date) {
        let stamp = event.metaAt.flatMap(Self.parseStamp) ?? now
        // The event's own time when it is older: a tail read after a relaunch
        // must not make an idle child look fresh. One ahead of the clock is skew.
        progress.lastEventAt = min(now, stamp)
        switch event.type {
        case "turn.started", "message.received":
            // The child went on to another turn: what ended the last one is over.
            stopAnswer = nil
            progress.finalAnswer = nil
            progress.finishedAt = nil
            progress.failure = nil
            progress.cancelled = false
            progress.endedAt = nil
            progress.activity = .thinking
        case "reasoning.appended", "reasoning.completed", "action.result", "step.started":
            progress.activity = .thinking
        case "actions.requested":
            if let name = EveStream.requestedToolName(event.data) {
                progress.activity = .tool(name, detail: EveStream.requestedToolDetail(event.data))
            }
        case "message.appended":
            progress.activity = .working
        case "compaction.requested":
            progress.activity = .compacting
        case "message.completed":
            progress.activity = .thinking
            let text = (event.message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if event.data?["finishReason"]?.stringValue == "stop", !text.isEmpty {
                stopAnswer = text
                progress.finalAnswer = text
            }
        case "turn.completed":
            // The child's own clock: eve holds a finished child's report until
            // its siblings settle, so the parent's arrival says nothing about
            // when the child was done.
            if stopAnswer != nil, progress.finishedAt == nil { progress.finishedAt = stamp }
        case "turn.failed", "session.failed":
            progress.failure = event.data?["code"]?.stringValue ?? event.message ?? event.type
            progress.endedAt = stamp
        case "turn.cancelled":
            progress.cancelled = true
            progress.endedAt = stamp
        default:
            break
        }
    }
}

/// How one run reads on the card.
public enum SubagentRowStatus: Equatable, Sendable {
    case working(label: String?)
    /// A working run whose stream has said nothing for `quietAfter`.
    case quiet(minutes: Int, lastStep: String?)
    case reported
    /// The child's stream shows its answer; the parent has no report yet.
    /// `answer` is the child's text when known, for View.
    case awaitingReport(answer: String?)
    case failed(reason: String)
    case stopped
    /// Its stream finished with an answer the parent never received.
    case notDelivered
    /// Nothing heard from it for the card's patience: given up on, not working.
    case noWord

    /// Still counted as at work in the header.
    public var isWorking: Bool {
        switch self {
        case .working, .quiet: return true
        case .reported, .awaitingReport, .notDelivered, .failed, .stopped, .noWord: return false
        }
    }
}

public enum SubagentStatus {
    public static let quietAfter: TimeInterval = 5 * 60
    public static let undeliveredAfter: TimeInterval = 60

    /// How long a run may say nothing before the card gives up on it. The
    /// rail and the working row use the same figure.
    public static let patience: TimeInterval = 3 * 3600

    /// The first pass over one batch: what each run reads as, and when each
    /// finished, with no "not delivered" yet (that is judged chat-wide).
    private static func pass(
        runs: [SubagentRun],
        progress: (SubagentRun) -> ChildProgress?,
        now: Date
    ) -> (statuses: [SubagentRowStatus], finishes: [Date?]) {
        var finishes: [Date?] = []
        var statuses: [SubagentRowStatus] = []
        for run in runs {
            switch run.state {
            case .reported(let at):
                statuses.append(.reported); finishes.append(at)
            case .failed(let at, let message):
                // A snapshot from before cancellations were told apart.
                statuses.append(EveStream.isCancellation(message) ? .stopped : .failed(reason: plainFailure(message)))
                finishes.append(at)
            case .cancelled(let at):
                statuses.append(.stopped); finishes.append(at)
            case .working:
                let began = run.taskStartedAt ?? run.startedAt
                // Progress of an earlier task of the same agent says nothing about this one.
                guard var p = progress(run), p.taskId == run.taskId, p.lastEventAt != nil else {
                    if let began, now.timeIntervalSince(began) >= patience {
                        statuses.append(.noWord)
                    } else {
                        statuses.append(.working(label: nil))
                    }
                    finishes.append(nil); continue
                }
                // An end the child reached before this task began is the
                // earlier task's.
                if let since = run.taskStartedAt {
                    if let at = p.finishedAt, at < since { p.finishedAt = nil; p.finalAnswer = nil }
                    if let at = p.endedAt, at < since { p.endedAt = nil; p.failure = nil; p.cancelled = false }
                }
                if let reason = p.failure {
                    statuses.append(EveStream.isCancellation(reason) ? .stopped : .failed(reason: plainFailure(reason)))
                    finishes.append(p.endedAt)
                } else if p.cancelled {
                    statuses.append(.stopped); finishes.append(p.endedAt)
                } else if let finished = p.finishedAt, let answer = p.finalAnswer, !answer.isEmpty {
                    statuses.append(.awaitingReport(answer: answer)); finishes.append(finished)
                } else if let last = p.lastEventAt, p.finishedAt == nil, now.timeIntervalSince(last) >= patience {
                    statuses.append(.noWord); finishes.append(nil)
                } else if let last = p.lastEventAt, p.finishedAt == nil, now.timeIntervalSince(last) >= quietAfter {
                    statuses.append(.quiet(minutes: max(5, Int(now.timeIntervalSince(last) / 60)), lastStep: p.label))
                    finishes.append(nil)
                } else {
                    statuses.append(.working(label: p.label)); finishes.append(nil)
                }
            }
        }
        return (statuses, finishes)
    }

    /// Every batch of a chat at once. A run whose child has finished waits for
    /// the parent's report (`awaitingReport`): eve holds each report until the
    /// last sibling settles, and a later batch's work can hold the parent up
    /// too. It becomes `notDelivered` only when no run in any batch is still
    /// working, the parent has been idle for the whole window, and 60 s have
    /// passed since the last finish anywhere in the chat. `parentIdleSince` is
    /// when the parent last went idle; nil is idle for long enough.
    public static func resolveChat(
        batches: [[SubagentRun]],
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        parked: Bool = false,
        parentIdleSince: Date? = nil,
        now: Date
    ) -> [[SubagentRowStatus]] {
        var all: [[SubagentRowStatus]] = []
        var last: Date?
        for runs in batches {
            let done = pass(runs: runs, progress: progress, now: now)
            all.append(done.statuses)
            if let latest = done.finishes.compactMap({ $0 }).max(), latest > (last ?? .distantPast) { last = latest }
        }
        let settled = !all.joined().contains { $0.isWorking }
        // A request parked in the session holds the finished reports too: eve
        // replays them after it is answered, so they are not lost yet.
        guard settled, !parentBusy, !parked, let last, now.timeIntervalSince(last) >= undeliveredAfter,
              parentIdleSince.map({ now.timeIntervalSince($0) >= undeliveredAfter }) ?? true else { return all }
        return all.map { statuses in
            statuses.map { if case .awaitingReport = $0 { return .notDelivered } else { return $0 } }
        }
    }

    /// One batch on its own, as a chat of one.
    public static func resolveAll(
        runs: [SubagentRun],
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        parked: Bool = false,
        parentIdleSince: Date? = nil,
        now: Date
    ) -> [SubagentRowStatus] {
        resolveChat(batches: [runs], progress: progress, parentBusy: parentBusy, parked: parked, parentIdleSince: parentIdleSince, now: now)[0]
    }

    /// Whether any run is still out, by what its card would show: working or
    /// quiet. A finished child awaiting its report is not.
    public static func hasActiveWork(
        runs: [SubagentRun],
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        now: Date
    ) -> Bool {
        pass(runs: runs, progress: progress, now: now).statuses.contains { $0.isWorking }
    }

    /// Whether the chat's cards still need a clock: something is working, or
    /// a finished child may yet turn into "not delivered".
    public static func needsClock(
        batches: [[SubagentRun]],
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        parked: Bool = false,
        parentIdleSince: Date? = nil,
        now: Date
    ) -> Bool {
        resolveChat(batches: batches, progress: progress, parentBusy: parentBusy, parked: parked, parentIdleSince: parentIdleSince, now: now)
            .joined().contains {
                if case .awaitingReport = $0 { return true }
                return $0.isWorking
            }
    }

    /// The same for one card of the chat: its own working runs, and its own
    /// finished ones only while the chat-wide rule could still flip them
    /// (nothing is working anywhere, and no request is parked).
    public static func needsClock(
        batches: [[SubagentRun]],
        of index: Int,
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        parked: Bool = false,
        parentIdleSince: Date? = nil,
        now: Date
    ) -> Bool {
        let all = resolveChat(batches: batches, progress: progress, parentBusy: parentBusy, parked: parked, parentIdleSince: parentIdleSince, now: now)
        guard all.indices.contains(index) else { return false }
        if all[index].contains(where: \.isWorking) { return true }
        let chatWorking = all.joined().contains { $0.isWorking }
        guard !chatWorking, !parked else { return false }
        return all[index].contains { if case .awaitingReport = $0 { return true } else { return false } }
    }

    public static func needsClock(
        runs: [SubagentRun],
        progress: (SubagentRun) -> ChildProgress?,
        parentBusy: Bool,
        now: Date
    ) -> Bool {
        needsClock(batches: [runs], progress: progress, parentBusy: parentBusy, now: now)
    }

    /// The task's own start to its end: the child's own end when its stream
    /// says one (finish, failure or cancel), else the parent's report or
    /// failure time.
    public static func duration(of run: SubagentRun, progress: ChildProgress? = nil) -> TimeInterval? {
        guard let start = run.taskStartedAt ?? run.startedAt else { return nil }
        var end: Date?
        switch run.state {
        case .working: end = nil
        case .reported(let at): end = at
        case .failed(let at, _): end = at
        case .cancelled(let at): end = at
        }
        if let progress, progress.taskId == run.taskId, let own = progress.finishedAt ?? progress.endedAt {
            end = own
        }
        guard let end else { return nil }
        return max(0, end.timeIntervalSince(start))
    }

    /// eve's `message` field, put in words the owner can act on. Never raw JSON.
    public static func plainFailure(_ message: String) -> String {
        // Whole tokens: "1429 ms" is not a 429 and "tolerate" is not "rate".
        let tokens = message.lowercased().split { !($0.isLetter || $0.isNumber) }.map(String.init)
        func has(_ words: String...) -> Bool { words.contains { tokens.contains($0) } }
        func adjacent(_ first: String, _ second: String) -> Bool {
            zip(tokens, tokens.dropFirst()).contains { $0 == first && $1 == second }
        }
        if has("timeout", "timedout") || adjacent("timed", "out") {
            return "Stopped: the model took too long"
        }
        if has("ratelimit", "ratelimited", "429") || adjacent("rate", "limit") || adjacent("rate", "limited") {
            return "Stopped: the model was rate limited"
        }
        if has("empty") && has("model") && has("response") || (has("upstream") && has("protocol") && has("error")) {
            return "Stopped: the model failed to answer"
        }
        if has("credit", "credits", "quota", "402") {
            return "Stopped: the model plan ran out"
        }
        return "Stopped: it hit an error"
    }
}

public struct SubagentHeader: Equatable, Sendable {
    public var title: String
    public var detail: String?
}

public enum SubagentCardCopy {
    public static func header(statuses: [SubagentRowStatus], botName: String) -> SubagentHeader {
        let total = statuses.count
        let working = statuses.filter(\.isWorking).count
        let reported = statuses.filter { $0 == .reported }.count
        let onItsWay = statuses.filter { if case .awaitingReport = $0 { return true } else { return false } }.count
        let undelivered = statuses.filter { $0 == .notDelivered }.count
        let stopped = statuses.filter { $0 == .stopped }.count
        let silent = statuses.filter { $0 == .noWord }.count
        let failed = total - working - reported - onItsWay - undelivered - stopped - silent
        let agents = total == 1 ? "1 sub-agent" : "\(total) sub-agents"
        if working == total { return SubagentHeader(title: "\(agents) working", detail: nil) }
        if working > 0 {
            var parts: [String] = []
            if reported + onItsWay > 0 { parts.append("\(reported + onItsWay) done") }
            if failed > 0 { parts.append("\(failed) failed") }
            if stopped > 0 { parts.append("\(stopped) stopped") }
            if undelivered > 0 { parts.append("\(undelivered) not delivered") }
            if silent > 0 { parts.append("\(silent) no word") }
            parts.append("\(working) working")
            return SubagentHeader(title: agents, detail: parts.joined(separator: " · "))
        }
        if undelivered == total {
            return SubagentHeader(title: "\(total == 1 ? "1 report" : "\(total) reports") not delivered", detail: nil)
        }
        if failed + stopped + undelivered + silent == 0 {
            if onItsWay > 0 { return SubagentHeader(title: "\(agents) done, handing reports to \(botName)", detail: nil) }
            return SubagentHeader(title: "\(total == 1 ? "1 report" : "\(total) reports") handed to \(botName)", detail: nil)
        }
        var parts = ["\(reported) of \(total) \(total == 1 ? "report" : "reports") in"]
        if failed > 0 { parts.append("\(failed) failed") }
        if stopped > 0 { parts.append("\(stopped) stopped") }
        if undelivered > 0 { parts.append("\(undelivered) not delivered") }
        if silent > 0 { parts.append("\(silent) no word") }
        if onItsWay > 0 { parts.append("\(onItsWay) on its way") }
        return SubagentHeader(title: parts.joined(separator: " · "), detail: nil)
    }

    /// The header button's spoken form: the same words, in one sentence.
    public static func accessibility(_ header: SubagentHeader) -> String {
        header.detail.map { "\(header.title), \($0)" } ?? header.title
    }
}

/// Which children to follow, with a cap on how many streams are open.
public struct ChildFollowTarget: Hashable, Sendable {
    public var childSessionId: String
    public var taskId: String
    /// The session whose stream carried the child's `subagent.called`, and its index there.
    public var parentSessionId: String? = nil
    public var calledAt: Int? = nil
}

public enum ChildFollowPlanner {
    public static let cap = 8

    /// Working runs whose child session is known, newest first, up to the
    /// cap. A run that is past patience, or that `skip` rules out (finished,
    /// refused, waiting to retry), is left out before the cap is counted, so
    /// a stale one never holds a slot a new sub-agent needs.
    public static func targets(
        runs: [SubagentRun],
        cap: Int = ChildFollowPlanner.cap,
        now: Date = Date(),
        lastHeard: (SubagentRun) -> Date? = { _ in nil },
        skip: (ChildFollowTarget) -> Bool = { _ in false }
    ) -> [ChildFollowTarget] {
        var found: [ChildFollowTarget] = []
        for run in runs.reversed() where run.state == .working {
            guard let child = run.childSessionId, !child.isEmpty else { continue }
            // Patience from the child's last word, else from the task's start:
            // the same rule the card uses.
            if let base = lastHeard(run) ?? run.taskStartedAt ?? run.startedAt,
               now.timeIntervalSince(base) >= SubagentStatus.patience { continue }
            let target = ChildFollowTarget(
                childSessionId: child,
                taskId: run.taskId,
                parentSessionId: run.childCall?.sessionId,
                calledAt: run.childCall?.index
            )
            if skip(target) { continue }
            found.append(target)
            if found.count == cap { break }
        }
        return found
    }
}

/// The colours the stacked faces take, one per run, in order.
public enum SubagentFaces {
    public static let palette = [
        "blue-mid", "orange-mid", "green-mid", "lilac-mid", "teal-mid",
        "red-mid", "amber-mid", "sky-mid", "yellow-mid", "neutral-mid",
    ]

    public static func color(at index: Int) -> String { palette[index % palette.count] }
}

public enum PendingRequestCopy {
    public static let sessionLimitKind = "session-limit"

    /// Plain words for what eve is waiting on. A kind this build does not
    /// know shows eve's own prompt.
    public static func body(for request: PendingRequest) -> String {
        request.kind == sessionLimitKind
            ? "This chat used its token budget. Continue to keep working, or stop here."
            : request.prompt
    }

    public static func label(of option: PendingRequest.Option, in request: PendingRequest) -> String {
        guard request.kind == sessionLimitKind else { return option.label }
        switch option.id {
        case "continue": return "Continue"
        case "stop": return "Stop"
        default: return option.label
        }
    }

    public static func isPrimary(_ option: PendingRequest.Option, in request: PendingRequest) -> Bool {
        request.kind == sessionLimitKind ? option.id == "continue" : option.style == "primary"
    }
}

extension Transcript {
    /// The row that shows a projection message. A live row's id is replaced by
    /// its durable twin's once the server records it, so an id that is gone
    /// is found again by its text, newest first.
    public static func rowId(forMessage message: ChatMessage, in rows: [TranscriptRow]) -> String? {
        if rows.contains(where: { $0.id == message.id }) { return message.id }
        let kind: TranscriptRow.Kind = message.role == .user ? .user : .assistant
        let text = EveStream.stripThreadPrefix(message.text)
        return rows.last { row in
            row.kind == kind && EveStream.stripThreadPrefix(row.text) == text
        }?.id
    }
}

extension TranscriptBlock {
    /// Whether this block draws the row: an image run holds every picture in it.
    public func holds(rowId: String) -> Bool {
        switch self {
        case .images(let rows): return rows.contains { $0.id == rowId }
        default: return id == rowId
        }
    }
}

/// What the owner's Stop sends to running sub-agents.
public struct ChildCancelTarget: Equatable, Sendable {
    public var agentId: String
    public var taskId: String
    public var title: String
    public var childSessionId: String
    public var parentSessionId: String
    public var calledAt: Int
}

public enum SubagentCancel {
    private static func childEnded(_ run: SubagentRun, _ progress: ChildProgress?) -> Bool {
        guard let progress, progress.taskId == run.taskId else { return false }
        return progress.finishedAt != nil || progress.failure != nil || progress.cancelled
    }

    /// Working runs Stop cannot name yet (no child session, or no call site):
    /// they become targetable once `subagent.called` arrives.
    public static func untargetable(
        runs: [SubagentRun],
        fallbackParent: String? = nil,
        progress: (SubagentRun) -> ChildProgress? = { _ in nil }
    ) -> Int {
        let named = Set(targets(runs: runs, fallbackParent: fallbackParent, progress: progress).map(\.taskId))
        return runs.filter { $0.state == .working && !childEnded($0, progress($0)) && !named.contains($0.taskId) }.count
    }

    /// Every working run that can be named to the proxy: it has a child
    /// session and the call site on its parent's stream.
    /// A call site that names no session was read off the open chat's own.
    /// A run whose child has already finished, failed or been cancelled (by
    /// its own stream) is not stopped again.
    public static func targets(
        runs: [SubagentRun],
        fallbackParent: String? = nil,
        progress: (SubagentRun) -> ChildProgress? = { _ in nil }
    ) -> [ChildCancelTarget] {
        runs.compactMap { run in
            guard run.state == .working, !childEnded(run, progress(run)),
                  let child = run.childSessionId, !child.isEmpty,
                  let site = run.childCall, let parent = site.sessionId ?? fallbackParent, !parent.isEmpty else { return nil }
            return ChildCancelTarget(agentId: run.agentId, taskId: run.taskId, title: run.title, childSessionId: child, parentSessionId: parent, calledAt: site.index)
        }
    }
}

/// eve's built-in agent tool cannot be overridden, so after the owner presses
/// Stop the model may relaunch the agent it was told to leave alone: eve opens
/// a parent turn for each cancelled report, and the model acts on it. This
/// remembers what the owner stopped and recognises that turn, so the app can
/// end it before the model acts.
public struct StoppedRunGuard: Sendable {
    public private(set) var stoppedTasks: Set<String> = []
    private var handledTurns: Set<String> = []

    public init() {}

    public mutating func stop(taskId: String) {
        stoppedTasks.insert(taskId)
    }

    /// Whether a message that opens a parent turn is nothing but cancellations
    /// of tasks the owner stopped, and this turn has not been acted on yet.
    /// Any other report, any owner text after one, or an unknown task is not.
    public mutating func shouldCancel(message text: String, turnId: String?) -> Bool {
        guard !stoppedTasks.isEmpty, let turnId, !handledTurns.contains(turnId) else { return false }
        let details = EveStream.taskReportDetails(text)
        guard !details.isEmpty else { return false }
        for detail in details {
            // A body with a second paragraph is a report with more after it.
            guard detail.outcome == .failed || detail.outcome == .cancelled,
                  stoppedTasks.contains(detail.taskId),
                  EveStream.isCancellation(detail.body),
                  !detail.body.contains("\n\n"), detail.body.count < 200 else { return false }
        }
        handledTurns.insert(turnId)
        return true
    }
}

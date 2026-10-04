import Foundation
import Testing
@testable import UsefulBotCore

/// How this part can fail, written before the code:
/// - the receipt (`action.result` / `subagent.completed`, status working) is not a completion;
/// - `subagent.called` arrives after the receipt, even after the parent's turn ended, or before it;
/// - the call's site (its session and its index on that session's own stream, which the proxy
///   checks) is lost, or taken from the projection's journal count, which runs on across sessions;
/// - a relaunch (same agentId, new taskId) must keep one row, and an old task's late report is stale;
/// - a report for a task nobody launched must neither crash nor invent a row;
/// - two reports in one message settle two rows, each with its own text;
/// - failed, then relaunched, then reported ends reported with the new text;
/// - an update or needs-input wake is not an outcome;
/// - a brief with no role line falls back to "Sub-agent N";
/// - a session-limit request is not closed by later turns or by the owner's send;
/// - an unknown request kind still surfaces; `input.resolved` and a retired session remove it;
/// - a question never becomes a pending request;
/// - a queued owner message is marked only when a request is open and no model step ran;
/// - a snapshot round trip reproduces the same state and keeps projecting the same.
@Suite struct SubagentRunTests {
    private func line(_ json: String) throws -> EveEvent {
        try #require(EveStream.parseLine(json))
    }

    private final class Counter: @unchecked Sendable { var n = 0 }
    private let counter = Counter()
    private func nextId() -> String {
        counter.n += 1
        return "evt_\(counter.n)"
    }

    private func stamp(_ second: Int) -> String {
        String(format: "2026-10-01T20:49:%02d.000Z", second)
    }

    private func json(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text], options: [.fragmentsAllowed])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    private func requested(call: String, brief: String, turn: String, at: Int = 1) throws -> EveEvent {
        try line("""
        {"type":"actions.requested","data":{"actions":[{"callId":"\(call)","input":{"message":\(json(brief))},"kind":"tool-call","toolName":"agent"}],"turnId":"\(turn)"},"meta":{"id":"\(nextId())","at":"\(stamp(at))"}}
        """)
    }

    private func launched(call: String, agent: String, task: String, turn: String, at: Int = 2) throws -> EveEvent {
        try line("""
        {"type":"action.result","data":{"result":{"callId":"\(call)","kind":"tool-result","output":{"agentId":"\(agent)","status":"working","taskId":"\(task)"},"toolName":"agent"},"turnId":"\(turn)","status":"completed"},"meta":{"id":"\(nextId())","at":"\(stamp(at))"}}
        """)
    }

    private func receipt(call: String, agent: String, task: String, at: Int = 2) throws -> EveEvent {
        try line("""
        {"type":"subagent.completed","data":{"backgroundTask":{"status":"working","taskId":"\(task)"},"callId":"\(call)","output":"{\\"agentId\\":\\"\(agent)\\",\\"status\\":\\"working\\",\\"taskId\\":\\"\(task)\\"}","subagentName":"agent"},"meta":{"id":"\(nextId())","at":"\(stamp(at))"}}
        """)
    }

    private func called(agent: String, child: String, turn: String, at: Int = 5) throws -> EveEvent {
        try line("""
        {"type":"subagent.called","data":{"agentId":"\(agent)","callId":"c","childSessionId":"\(child)","childStreamPath":"/eve/v1/session/\(child)/stream","name":"agent","toolName":"agent","turnId":"\(turn)"},"meta":{"id":"\(nextId())","at":"\(stamp(at))"}}
        """)
    }

    private func report(_ text: String, turn: String, at: Int = 30) throws -> EveEvent {
        try line("""
        {"type":"message.received","data":{"message":\(json(text)),"turnId":"\(turn)","kind":"execution.background_task"},"meta":{"id":"\(nextId())","at":"\(stamp(at))"}}
        """)
    }

    private let critic = "You are a senior UX and accessibility critic reviewing one file. Report findings only."

    @Test func aReceiptStartsARunAndIsNotACompletion() throws {
        var p = StreamProjection()
        p.apply(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1", at: 7))
        #expect(p.subagentRuns.count == 1)
        let run = p.subagentRuns[0]
        #expect(run.id == "ag_agent:aaa")
        #expect(run.taskId == "task_aaa")
        #expect(run.title == "UX and accessibility critic")
        #expect(run.groupId == "turn_1")
        #expect(run.childSessionId == nil)
        #expect(run.state == .working)
        #expect(run.result == nil)
        #expect(run.startedAt == TranscriptBlocks.date(fromISO8601: stamp(7)))
        // The admission receipt for the same task is the same run, not a second one.
        p.apply(try receipt(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", at: 7))
        #expect(p.subagentRuns.count == 1)
    }

    @Test func theReceiptAloneStartsARunToo() throws {
        var p = StreamProjection()
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_4"}}"#))
        p.apply(try receipt(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa"))
        #expect(p.subagentRuns.count == 1)
        #expect(p.subagentRuns[0].groupId == "turn_4")
        #expect(p.subagentRuns[0].title == "Sub-agent 1")
    }

    @Test func calledAfterTheParentsTurnEndedFillsTheChildSession() throws {
        var p = StreamProjection()
        p.apply(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_1"}}"#))
        #expect(p.subagentRuns[0].childSessionId == nil)
        // eve files the call under the NEXT turn, which has begun by then.
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_2"}}"#))
        p.apply(try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_2"))
        #expect(p.subagentRuns[0].childSessionId == "wrun_child_a")
        // The run stays in the turn that launched it.
        #expect(p.subagentRuns[0].groupId == "turn_1")
    }

    @Test func calledBeforeTheReceiptIsKept() throws {
        var p = StreamProjection()
        p.apply(try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_2"))
        #expect(p.subagentRuns.isEmpty)
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        #expect(p.subagentRuns[0].childSessionId == "wrun_child_a")
    }

    /// The proxy reads the parent's event at `at` from eve, so the site is the
    /// raw index on the stream that carried it, never the journal position.
    @Test func theCallKeepsItsSessionAndRawStreamIndex() throws {
        func at(_ event: EveEvent, _ index: Int, _ session: String) -> EveEvent {
            var event = event
            event.index = index
            event.sessionId = session
            return event
        }
        var p = StreamProjection()
        // An earlier session moves the journal on.
        for i in 0..<6 {
            p.apply(at(try line(#"{"type":"message.appended","data":{"messageDelta":"x","turnId":"turn_0"}}"#), i, "wrun_old"))
        }
        p.apply(at(try requested(call: "call_a", brief: critic, turn: "turn_1"), 0, "wrun_parent"))
        p.apply(at(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"), 1, "wrun_parent"))
        p.apply(at(try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_1"), 2, "wrun_parent"))
        #expect(p.subagentRuns[0].childSessionId == "wrun_child_a")
        #expect(p.subagentRuns[0].childCall == SubagentCallSite(sessionId: "wrun_parent", index: 2))
        // Called before the receipt: the run is born with the site.
        p.apply(at(try called(agent: "ag_agent:bbb", child: "wrun_child_b", turn: "turn_1"), 3, "wrun_parent"))
        p.apply(at(try launched(call: "call_b", agent: "ag_agent:bbb", task: "task_bbb", turn: "turn_1"), 4, "wrun_parent"))
        #expect(p.subagentRuns[1].childCall == SubagentCallSite(sessionId: "wrun_parent", index: 3))
        let target = ChildFollowPlanner.targets(runs: p.subagentRuns, now: p.subagentRuns[0].startedAt ?? Date()).first { $0.childSessionId == "wrun_child_a" }
        #expect(target == ChildFollowTarget(childSessionId: "wrun_child_a", taskId: "task_aaa", parentSessionId: "wrun_parent", calledAt: 2))
        // A call with no stream position (no reader set one) has no site.
        var q = StreamProjection()
        q.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        q.apply(try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_1"))
        #expect(q.subagentRuns[0].childCall == nil)
    }

    @Test func aReportSettlesTheRunWithItsText() throws {
        var p = StreamProjection()
        p.apply(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try report("Background task task_aaa (agent) is completed.\n\nResult:\nThe file is solid.\n\nOne gap: contrast.", turn: "turn_2", at: 40))
        #expect(p.subagentRuns[0].state == .reported(at: TranscriptBlocks.date(fromISO8601: stamp(40))))
        #expect(p.subagentRuns[0].result == "The file is solid.\n\nOne gap: contrast.")
    }

    @Test func twoReportsInOneMessageSettleTwoRows() throws {
        var p = StreamProjection()
        for (i, id) in ["aaa", "bbb"].enumerated() {
            p.apply(try requested(call: "call_\(id)", brief: critic, turn: "turn_1"))
            p.apply(try launched(call: "call_\(id)", agent: "ag_agent:\(id)", task: "task_\(id)", turn: "turn_1", at: 2 + i))
        }
        p.apply(try report("""
        Background task task_aaa (agent) is completed.

        Result:
        First answer.

        Background task task_bbb (agent) failed.

        Error:
        {"code":"SUBAGENT_EXECUTION_FAILED","message":"upstream_timeout"}
        """, turn: "turn_2"))
        #expect(p.subagentRuns.map(\.id) == ["ag_agent:aaa", "ag_agent:bbb"])
        #expect(p.subagentRuns[0].result == "First answer.")
        guard case .reported = p.subagentRuns[0].state else { Issue.record("first should be reported"); return }
        guard case .failed(_, let message) = p.subagentRuns[1].state else { Issue.record("second should be failed"); return }
        #expect(message == "upstream_timeout")
    }

    @Test func aReportForAnUnknownTaskChangesNothing() throws {
        var p = StreamProjection()
        p.apply(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try report("Background task task_zzz (agent) is completed.\n\nResult:\nStray.", turn: "turn_2"))
        #expect(p.subagentRuns.count == 1)
        #expect(p.subagentRuns[0].state == .working)
    }

    @Test func failureThenRelaunchThenSuccessKeepsOneRow() throws {
        var p = StreamProjection()
        p.apply(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_old", turn: "turn_1"))
        p.apply(try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_2"))
        p.apply(try report("Background task task_old (agent) failed.\n\nError:\n{\"code\":\"X\",\"message\":\"upstream_timeout\"}", turn: "turn_2", at: 20))
        guard case .failed = p.subagentRuns[0].state else { Issue.record("should be failed"); return }
        // Steering relaunches the same agent with a new task and the same child session.
        p.apply(try launched(call: "call_b", agent: "ag_agent:aaa", task: "task_new", turn: "turn_3", at: 25))
        #expect(p.subagentRuns.count == 1)
        #expect(p.subagentRuns[0].taskId == "task_new")
        #expect(p.subagentRuns[0].state == .working)
        #expect(p.subagentRuns[0].childSessionId == "wrun_child_a")
        #expect(p.subagentRuns[0].groupId == "turn_1")
        #expect(p.subagentRuns[0].startedAt == TranscriptBlocks.date(fromISO8601: stamp(2)))
        // The old task's failure delivered again is stale.
        p.apply(try report("Background task task_old (agent) failed.\n\nError:\n{\"message\":\"again\"}", turn: "turn_3", at: 26))
        #expect(p.subagentRuns[0].state == .working)
        p.apply(try report("Background task task_new (agent) is completed.\n\nResult:\nDone this time.", turn: "turn_4", at: 50))
        #expect(p.subagentRuns[0].state == .reported(at: TranscriptBlocks.date(fromISO8601: stamp(50))))
        #expect(p.subagentRuns[0].result == "Done this time.")
    }

    @Test func aCancelledTaskIsCancelledAndAnUpdateIsNot() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try launched(call: "call_b", agent: "ag_agent:bbb", task: "task_bbb", turn: "turn_1"))
        p.apply(try report("Background task task_aaa (agent) update: halfway there.", turn: "turn_2"))
        #expect(p.subagentRuns[0].state == .working)
        p.apply(try report("Background task task_bbb (agent) is cancelled.", turn: "turn_3"))
        guard case .cancelled = p.subagentRuns[1].state else { Issue.record("should be cancelled"); return }
    }

    @Test func runsGroupByTheTurnThatLaunchedThem() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try launched(call: "b", agent: "ag_agent:bbb", task: "task_bbb", turn: "turn_1"))
        p.apply(try launched(call: "c", agent: "ag_agent:ccc", task: "task_ccc", turn: "turn_5"))
        #expect(p.subagentBatches.map(\.id) == ["turn_1", "turn_5"])
        #expect(p.subagentBatches[0].runs.map(\.id) == ["ag_agent:aaa", "ag_agent:bbb"])
        #expect(p.subagentBatches[1].runs.map(\.id) == ["ag_agent:ccc"])
    }

    @Test func titlesComeFromTheBriefsFirstLine() throws {
        #expect(SubagentRun.title(fromBrief: "You are a product strategist critiquing whether a tool serves its users.", fallbackIndex: 1) == "Product strategist")
        #expect(SubagentRun.title(fromBrief: "You are an expert code reviewer. Review the diff.", fallbackIndex: 2) == "Code reviewer")
        #expect(SubagentRun.title(fromBrief: "Read-only research of a public repo.", fallbackIndex: 3) == "Sub-agent 3")
        #expect(SubagentRun.title(fromBrief: nil, fallbackIndex: 4) == "Sub-agent 4")
        #expect(SubagentRun.title(fromBrief: "\n\nYou are a very long winded role name that just keeps going and going on and on forever.", fallbackIndex: 1).count <= 40)
    }

    // MARK: pending requests

    private let limit = """
    {"type":"input.requested","data":{"requests":[{"action":{"callId":"s:limit:input:41","kind":"tool-call","toolName":"session_limit_continuation"},"allowFreeform":false,"display":"confirmation","kind":"session-limit","options":[{"description":"Grant a fresh token budget","id":"continue","label":"Approve","style":"primary"},{"description":"Stop now","id":"stop","label":"Stop","style":"danger"}],"prompt":"This session has hit the input-token limit.","requestId":"s:limit:input:41"}],"turnId":"turn_47"},"meta":{"id":"evt_limit","at":"2026-10-01T21:02:58.244Z"}}
    """

    private func queuedTurn(_ turn: String, text: String = "Any update?") throws -> [EveEvent] {
        [
            try line(#"{"type":"turn.started","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"message.received","data":{"message":\#(json(text)),"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"turn.completed","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"session.waiting","data":{"wait":"next-user-message"},"meta":{"id":"\#(nextId())"}}"#),
        ]
    }

    @Test func aSessionLimitSurfacesAndSurvivesLaterTurns() throws {
        var p = StreamProjection()
        p.apply(try line(limit))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_47"}}"#))
        #expect(p.pendingRequests.count == 1)
        let request = p.pendingRequests[0]
        #expect(request.id == "s:limit:input:41")
        #expect(request.kind == "session-limit")
        #expect(request.prompt.hasPrefix("This session has hit"))
        #expect(request.options.map(\.id) == ["continue", "stop"])
        #expect(request.options.map(\.label) == ["Approve", "Stop"])
        #expect(request.options.map(\.style) == ["primary", "danger"])
        // The owner's send and eve's queued turns do not answer it.
        p.beginTurn()
        for event in try queuedTurn("turn_48") { p.apply(event) }
        for event in try queuedTurn("turn_49") { p.apply(event) }
        #expect(p.pendingRequests.map(\.id) == ["s:limit:input:41"])
        // A replay of the same request is one request.
        p.apply(try line(limit.replacingOccurrences(of: "evt_limit", with: "evt_limit_again")))
        #expect(p.pendingRequests.count == 1)
        p.apply(try line(#"{"type":"input.resolved","data":{"resolutions":[{"kind":"session-limit","outcome":"answered","requestId":"s:limit:input:41"}]}}"#))
        #expect(p.pendingRequests.isEmpty)
    }

    @Test func anUnknownKindStillSurfaces() throws {
        var p = StreamProjection()
        p.apply(try line(#"{"type":"input.requested","data":{"requests":[{"kind":"brand-new-kind","requestId":"r1","prompt":"Allow this?","display":"confirmation"},{"kind":"tool-approval","requestId":"r2"}],"turnId":"turn_1"}}"#))
        #expect(p.pendingRequests.map(\.id) == ["r1", "r2"])
        #expect(p.pendingRequests[0].kind == "brand-new-kind")
        #expect(p.pendingRequests[0].options.isEmpty)
        #expect(!p.pendingRequests[1].prompt.isEmpty)
    }

    @Test func aQuestionIsNotAPendingRequest() throws {
        var p = StreamProjection()
        p.apply(try line(#"{"type":"input.requested","data":{"requests":[{"kind":"question","requestId":"q1","prompt":"Which folder?","options":[]}],"turnId":"turn_1"}}"#))
        #expect(p.questions.count == 1)
        #expect(p.pendingRequests.isEmpty)
    }

    @Test func aRetiredSessionTakesThePendingRequestAndWorkingRunsWithIt() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try line(limit))
        p.apply(try line(#"{"type":"session.failed","data":{"code":"boom"}}"#))
        #expect(p.pendingRequests.isEmpty)
        guard case .cancelled = p.subagentRuns[0].state else { Issue.record("a retired session wakes for nothing"); return }
    }

    // MARK: queued owner messages

    @Test func aTurnWithNoModelStepWhileARequestIsOpenIsQueued() throws {
        var p = StreamProjection()
        p.apply(try line(limit))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_47"}}"#))
        for event in try queuedTurn("turn_48", text: "First nudge") { p.apply(event) }
        for event in try queuedTurn("turn_49", text: "Second nudge") { p.apply(event) }
        let users = p.messages.filter { $0.role == .user }
        #expect(users.count == 2)
        #expect(p.queuedMessageIds == Set(users.map(\.id)))
        // Resolving it leaves those rows as they were.
        p.apply(try line(#"{"type":"input.resolved","data":{"resolutions":[{"requestId":"s:limit:input:41"}]}}"#))
        #expect(p.queuedMessageIds.count == 2)
    }

    @Test func aNormalMessageThatGetsAReplyIsNeverQueued() throws {
        var p = StreamProjection()
        // A request is open, but this turn ran a model step and answered.
        p.apply(try line(limit))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_47"}}"#))
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_48"},"meta":{"id":"e1"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":"Hello","turnId":"turn_48"},"meta":{"id":"e2"}}"#))
        p.apply(try line(#"{"type":"step.started","data":{"turnId":"turn_48","stepIndex":0},"meta":{"id":"e3"}}"#))
        p.apply(try line(#"{"type":"message.completed","data":{"message":"Hi there","turnId":"turn_48"},"meta":{"id":"e4"}}"#))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_48"},"meta":{"id":"e5"}}"#))
        #expect(p.queuedMessageIds.isEmpty)
        // And with no request open, an empty turn is not queued either.
        var q = StreamProjection()
        for event in try queuedTurn("turn_1") { q.apply(event) }
        #expect(q.queuedMessageIds.isEmpty)
    }

    // MARK: held rows and eve's replay

    /// The turn whose own message raised the request: a message, the request, an end, no step.
    private func originTurn(_ turn: String, text: String) throws -> [EveEvent] {
        [
            try line(#"{"type":"turn.started","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"message.received","data":{"message":\#(json(text)),"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(limit.replacingOccurrences(of: "turn_47", with: turn).replacingOccurrences(of: "evt_limit", with: nextId())),
            try line(#"{"type":"turn.completed","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
        ]
    }

    private let resolved = #"{"type":"input.resolved","data":{"resolutions":[{"kind":"session-limit","outcome":"answered","requestId":"s:limit:input:41"}]}}"#

    /// eve replays the queued text as a new message in a turn that runs.
    private func replayTurn(_ turn: String, text: String) throws -> [EveEvent] {
        [
            try line(#"{"type":"turn.started","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"message.received","data":{"message":\#(json(text)),"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"step.started","data":{"turnId":"\#(turn)","stepIndex":0},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"message.completed","data":{"message":"ok","turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
            try line(#"{"type":"turn.completed","data":{"turnId":"\#(turn)"},"meta":{"id":"\#(nextId())"}}"#),
        ]
    }

    private func users(_ p: StreamProjection) -> [ChatMessage] { p.messages.filter { $0.role == .user } }

    @Test func theMessageThatRaisedTheRequestIsHeldToo() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        #expect(p.pendingRequests.count == 1)
        #expect(p.queuedMessageIds == Set(users(p).map(\.id)))
        #expect(p.droppedMessageIds.isEmpty)
    }

    /// Seen live: eve can open the step before it pauses for the limit.
    @Test func anOriginTurnWithAStepStartedIsStillHeldAndDropped() throws {
        var p = StreamProjection()
        var origin = try originTurn("turn_25", text: "Probe 21")
        origin.insert(try line(#"{"type":"step.started","data":{"turnId":"turn_25","stepIndex":0},"meta":{"id":"\#(nextId())"}}"#), at: 2)
        for event in origin { p.apply(event) }
        for event in try queuedTurn("turn_26", text: "Held") { p.apply(event) }
        #expect(p.queuedMessageIds.count == 2)
        p.apply(try line(resolved))
        for event in try replayTurn("turn_27", text: "Held") { p.apply(event) }
        #expect(users(p).map(\.text) == ["Probe 21", "Held"])
        #expect(p.droppedMessageIds == [users(p)[0].id])
    }

    /// A request raised after the turn already answered resumes that turn, so
    /// its message is neither held nor dropped.
    @Test func aRequestRaisedMidTurnDoesNotHoldItsMessage() throws {
        var p = StreamProjection()
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_30"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":"Do it","turnId":"turn_30"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"step.started","data":{"turnId":"turn_30","stepIndex":0},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.completed","data":{"message":"Working on it","turnId":"turn_30"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(limit.replacingOccurrences(of: "turn_47", with: "turn_30").replacingOccurrences(of: "evt_limit", with: nextId())))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_30"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(p.pendingRequests.count == 1)
        #expect(p.queuedMessageIds.isEmpty)
    }

    @Test func aReplayOfQueuedTextAttachesToTheExistingRow() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        #expect(users(p).count == 2)
        p.apply(try line(resolved))
        for event in try replayTurn("turn_18", text: "Probe 19") { p.apply(event) }
        // Probe 19 once, then its reply; probe 18 is never replayed.
        #expect(users(p).map(\.text) == ["Probe 18", "Probe 19"])
        #expect(p.messages.map(\.text) == ["Probe 18", "Probe 19", "ok"])
        #expect(p.queuedMessageIds.isEmpty)
        #expect(p.droppedMessageIds == [users(p)[0].id])
        #expect(!p.pending)
    }

    @Test func severalQueuedRowsJoinedByBlankLinesAttachInOrder() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        for event in try queuedTurn("turn_18", text: "Probe 20") { p.apply(event) }
        p.apply(try line(resolved))
        for event in try replayTurn("turn_19", text: "Probe 19\n\nProbe 20") { p.apply(event) }
        #expect(users(p).map(\.text) == ["Probe 18", "Probe 19", "Probe 20"])
        #expect(p.messages.last?.text == "ok")
        #expect(p.queuedMessageIds.isEmpty)
        #expect(p.droppedMessageIds == [users(p)[0].id])
    }

    /// eve never replays the message whose turn raised the request, so it is
    /// dropped the moment the request is answered.
    @Test func theOriginIsDroppedAsSoonAsTheRequestIsAnswered() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        p.apply(try line(resolved))
        #expect(p.droppedMessageIds == [users(p)[0].id])
        // The queued one still waits for its replay.
        #expect(p.queuedMessageIds == [users(p)[1].id])
    }

    @Test func aReportOnlyTurnBeforeTheReplayDoesNotCloseTheWindow() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        p.apply(try line(resolved))
        let report = "Background task task_aaa (agent) is completed.\n\nResult:\nFine."
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(report)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(p.queuedMessageIds == [users(p)[1].id])
        for event in try replayTurn("turn_19", text: "Probe 19") { p.apply(event) }
        #expect(users(p).map(\.text) == ["Probe 18", "Probe 19"])
        #expect(p.queuedMessageIds.isEmpty)
        #expect(p.droppedMessageIds == [users(p)[0].id])
    }

    @Test func aShortHeldTextIsOnlyFoundAsItsOwnSegment() throws {
        func run(_ merged: String) throws -> StreamProjection {
            var p = StreamProjection()
            p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
            for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
            for event in try queuedTurn("turn_17", text: "yes") { p.apply(event) }
            p.apply(try line(resolved))
            p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
            p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(merged)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
            return p
        }
        let inside = try run("Background task task_aaa (agent) is completed.\n\nResult:\nYesterday it said yes sir.")
        #expect(inside.queuedMessageIds.count == 1)
        let own = try run("Background task task_aaa (agent) is completed.\n\nResult:\nFine.\n\nyes")
        #expect(own.queuedMessageIds.isEmpty)
    }

    @Test func aSessionChangeClearsRequestsAndHeldRows() throws {
        var p = StreamProjection()
        func feed(_ events: [EveEvent], session: String) { for var e in events { e.sessionId = session; p.apply(e) } }
        feed(try originTurn("turn_16", text: "Probe 18"), session: "ses_a")
        feed(try queuedTurn("turn_17", text: "Probe 19"), session: "ses_a")
        #expect(p.pendingRequests.count == 1)
        feed(try queuedTurn("turn_1", text: "Fresh"), session: "ses_b")
        #expect(p.pendingRequests.isEmpty)
        #expect(p.queuedMessageIds.isEmpty)
        #expect(p.droppedMessageIds.count == 2)
    }

    @Test func aDifferentMessageAfterTheAnswerDropsTheHeldRows() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        p.apply(try line(resolved))
        for event in try replayTurn("turn_17", text: "Something else") { p.apply(event) }
        #expect(users(p).map(\.text) == ["Probe 18", "Something else"])
        #expect(p.droppedMessageIds == [users(p)[0].id])
        #expect(p.queuedMessageIds.isEmpty)
    }

    @Test func stopEndsTheSessionAndEveryHeldRowIsDropped() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        p.apply(try line(resolved))
        p.apply(try line(#"{"type":"session.completed","data":{}}"#))
        #expect(p.droppedMessageIds == Set(users(p).map(\.id)))
        #expect(p.queuedMessageIds.isEmpty)
    }

    @Test func theOwnersStopChoiceDropsHeldRowsDirectly() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        p.dropHeldMessages()
        #expect(p.droppedMessageIds == Set(users(p).map(\.id)))
        #expect(p.queuedMessageIds.isEmpty)
    }

    @Test func aReplayInsideABatchedReportTurnJoinsTheHeldRow() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        p.apply(try line(resolved))
        // eve merged the owner's replayed text with the sub-agent's report.
        let merged = "Background task task_aaa (agent) is completed.\n\nResult:\nFine.\n\nProbe 19"
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(merged)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(users(p).map(\.text) == ["Probe 18", "Probe 19"])
        #expect(p.queuedMessageIds.isEmpty)
        #expect(p.droppedMessageIds == [users(p)[0].id])
        // The next owner message does not drop the delivered row.
        for event in try replayTurn("turn_19", text: "Thanks") { p.apply(event) }
        #expect(p.droppedMessageIds == [users(p)[0].id])
    }

    @Test func spacingDifferencesStillMatchTheHeldRow() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19 now") { p.apply(event) }
        p.apply(try line(resolved))
        for event in try replayTurn("turn_18", text: "  Probe  19\nnow \n") { p.apply(event) }
        #expect(users(p).count == 2)
        #expect(p.queuedMessageIds.isEmpty)
    }

    @Test func theVerdictWaitsForTheReplayTurnToEnd() throws {
        var p = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        for event in try queuedTurn("turn_18", text: "Probe 20") { p.apply(event) }
        p.apply(try line(resolved))
        let replay = try replayTurn("turn_19", text: "Probe 19")
        for event in replay.dropLast() { p.apply(event) }
        // Mid-turn: the unreplayed 20 is not judged yet (the origin went at the answer).
        #expect(p.droppedMessageIds == [users(p)[0].id])
        #expect(p.queuedMessageIds == [users(p)[2].id])
        p.apply(replay.last!)
        #expect(p.droppedMessageIds == [users(p)[0].id, users(p)[2].id])
    }

    @Test func stopInTheResolutionDropsEveryHeldRowOnReplayToo() throws {
        let stopped = #"{"type":"input.resolved","data":{"resolutions":[{"kind":"session-limit","outcome":"answered","requestId":"s:limit:input:41","response":{"optionId":"stop"}}]}}"#
        var events: [EveEvent] = []
        events += try originTurn("turn_16", text: "Probe 18")
        events += try queuedTurn("turn_17", text: "Probe 19")
        events.append(try line(stopped))
        var live = StreamProjection()
        for event in events { live.apply(event) }
        #expect(live.droppedMessageIds == Set(users(live).map(\.id)))
        #expect(live.queuedMessageIds.isEmpty)
        // A replay from zero gives the same.
        var replayed = StreamProjection()
        for event in events { replayed.apply(event) }
        #expect(replayed.droppedMessageIds == live.droppedMessageIds)
        #expect(replayed.queuedMessageIds == live.queuedMessageIds)
        // Continue is not Stop.
        var other = StreamProjection()
        for event in events.dropLast() { other.apply(event) }
        other.apply(try line(resolved))
        // Only the message whose turn raised the request is gone.
        #expect(other.droppedMessageIds.count == 1)
    }

    @Test func aMultiParagraphHeldTextIsFoundInAMergedReportTurn() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "First part\n\nSecond part") { p.apply(event) }
        p.apply(try line(resolved))
        let merged = "Background task task_aaa (agent) is completed.\n\nResult:\nFine.\n\nFirst part\n\nSecond part"
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(merged)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(p.queuedMessageIds.isEmpty)
    }

    /// The launching turn's row is remembered when the turn table forgets the turn.
    @Test func aCardKeepsItsAnchorAfterItsTurnIsForgotten() throws {
        var p = StreamProjection()
        p.apply(try line(#"{"type":"message.received","data":{"message":"Run critics","turnId":"turn_1"},"meta":{"id":"first_row"}}"#))
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_1"},"meta":{"id":"end_1"}}"#))
        for n in 2...300 {
            p.apply(try line(#"{"type":"message.received","data":{"message":"Hello \#(n)","turnId":"turn_\#(n)"},"meta":{"id":"row_\#(n)"}}"#))
            p.apply(try line(#"{"type":"turn.completed","data":{"turnId":"turn_\#(n)"},"meta":{"id":"end_\#(n)"}}"#))
        }
        let group = try #require(p.subagentRuns.first?.groupId)
        #expect(p.subagentAnchor(forGroup: group) == "first_row")
        let restored = try JSONDecoder().decode(StreamProjection.self, from: JSONEncoder().encode(p))
        #expect(restored.subagentAnchor(forGroup: group) == "first_row")
    }

    @Test func aMergedReportsBodyStopsWhereTheReplayedOwnerTextBegins() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        p.apply(try line(resolved))
        let merged = "Background task task_aaa (agent) is completed.\n\nResult:\nFine.\n\nSecond paragraph of the report.\n\nProbe 19"
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(merged)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(p.subagentRuns[0].result == "Fine.\n\nSecond paragraph of the report.")
    }

    @Test func aReportBodyIsNotCutWhenNoReplayIsOpen() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        for event in try originTurn("turn_16", text: "Probe 18") { p.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { p.apply(event) }
        // The request is still open: the report lands as it came.
        let report = "Background task task_aaa (agent) is completed.\n\nResult:\nFine.\n\nProbe 19"
        p.apply(try line(#"{"type":"turn.started","data":{"turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        p.apply(try line(#"{"type":"message.received","data":{"message":\#(json(report)),"kind":"\#(EveStream.backgroundTaskKind)","turnId":"turn_18"},"meta":{"id":"\#(nextId())"}}"#))
        #expect(p.subagentRuns[0].result == "Fine.\n\nProbe 19")
    }

    @Test func anOwnerCancelledChildReportedAsFailedIsStopped() throws {
        var p = StreamProjection()
        p.apply(try launched(call: "a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        p.apply(try launched(call: "b", agent: "ag_agent:bbb", task: "task_bbb", turn: "turn_1"))
        let text = "Background task task_aaa (agent) failed.\n\nError:\n{\"code\":\"SUBAGENT_EXECUTION_FAILED\",\"message\":\"The agent invocation was cancelled.\"}"
        p.apply(try report(text, turn: "turn_2"))
        guard case .cancelled = p.subagentRuns[0].state else { Issue.record("a cancel is not a failure"); return }
        // A real failure still fails.
        let boom = "Background task task_bbb (agent) failed.\n\nError:\n{\"code\":\"SUBAGENT_EXECUTION_FAILED\",\"message\":\"upstream_timeout\"}"
        p.apply(try report(boom, turn: "turn_3"))
        guard case .failed(_, let message) = p.subagentRuns[1].state else { Issue.record("should fail"); return }
        #expect(message == "upstream_timeout")
        #expect(EveStream.isCancellation("The agent invocation was cancelled."))
        // Only eve's own sentence counts.
        #expect(!EveStream.isCancellation("Run was canceled by user"))
        #expect(!EveStream.isCancellation("The request was cancelled by the network"))
        #expect(!EveStream.isCancellation("upstream_timeout"))
    }

    @Test func heldRowsSurviveASnapshotBetweenTheAnswerAndTheReplay() throws {
        var head = StreamProjection()
        for event in try originTurn("turn_16", text: "Probe 18") { head.apply(event) }
        for event in try queuedTurn("turn_17", text: "Probe 19") { head.apply(event) }
        head.apply(try line(resolved))
        var restored = try JSONDecoder().decode(StreamProjection.self, from: JSONEncoder().encode(head))
        #expect(restored == head)
        for event in try replayTurn("turn_18", text: "Probe 19") { restored.apply(event) }
        #expect(users(restored).map(\.text) == ["Probe 18", "Probe 19"])
        #expect(restored.droppedMessageIds.count == 1)
        #expect(restored.queuedMessageIds.isEmpty)
    }

    // MARK: snapshots

    @Test func aSnapshotRoundTripKeepsProjectingTheSame() throws {
        var events: [EveEvent] = []
        events.append(try requested(call: "call_a", brief: critic, turn: "turn_1"))
        events.append(try launched(call: "call_a", agent: "ag_agent:aaa", task: "task_aaa", turn: "turn_1"))
        events.append(try line(limit))
        for event in try queuedTurn("turn_48") { events.append(event) }
        let tail = [
            try called(agent: "ag_agent:aaa", child: "wrun_child_a", turn: "turn_49"),
            try report("Background task task_aaa (agent) is completed.\n\nResult:\nFine.", turn: "turn_49", at: 44),
            try line(#"{"type":"input.resolved","data":{"resolutions":[{"requestId":"s:limit:input:41"}]}}"#),
        ]
        var whole = StreamProjection()
        for event in events + tail { whole.apply(event) }

        var head = StreamProjection()
        for event in events { head.apply(event) }
        let data = try JSONEncoder().encode(head)
        var restored = try JSONDecoder().decode(StreamProjection.self, from: data)
        #expect(restored == head)
        #expect(restored.isConsistent)
        for event in tail { restored.apply(event) }
        #expect(restored == whole)
        #expect(restored.subagentRuns[0].result == "Fine.")
        #expect(restored.pendingRequests.isEmpty)
        #expect(restored.queuedMessageIds.count == 1)
    }
}

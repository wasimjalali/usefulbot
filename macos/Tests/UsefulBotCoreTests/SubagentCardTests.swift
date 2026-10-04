import Foundation
import Testing
@testable import UsefulBotCore

/// How the card's logic can fail:
/// - a child stream that never spoke must read as plain working, never as quiet;
/// - progress of an earlier task of the same agent must not colour a relaunched run;
/// - quiet starts at five minutes of silence and not before; a finished child is never quiet;
/// - "report not delivered" needs a finished answer, 60 s of waiting and an idle parent;
///   a busy parent, an empty answer or a settled run is never undelivered;
/// - a child that went on to another turn forgets its earlier answer;
/// - a tool-call message is not a final answer;
/// - raw error text never reaches the owner;
/// - header copy for one, many, mixed, all settled and failed sets;
/// - ten runs follow at most eight children, only working ones with a known session;
/// - a relaunch swaps the follow target;
/// - waiting-card copy: a session limit reads plainly, an unknown kind keeps eve's words;
/// - a live row replaced by its durable twin is still found, and a missing one is nil.
private extension ChildProgress {
    func with(task: String) -> ChildProgress {
        var copy = self
        copy.taskId = task
        return copy
    }
}

@Suite struct SubagentCardTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func event(_ type: String, data: String = "{}", message: String? = nil, turn: String = "turn_c1") throws -> EveEvent {
        let text = message.map { "\"message\":\(jsonString($0))," } ?? ""
        let raw = "{\"type\":\"\(type)\",\"data\":{\(text)\"turnId\":\"\(turn)\"\(data == "{}" ? "" : "," + data)},\"meta\":{\"id\":\"e_\(UUID().uuidString)\",\"at\":\"2026-10-01T20:49:01.000Z\"}}"
        return try #require(EveStream.parseLine(raw))
    }

    private func jsonString(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text])
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    private func run(_ state: SubagentRun.State = .working, task: String = "task_1", child: String? = "ses_c", start: Date? = nil) -> SubagentRun {
        SubagentRun(agentId: "agent_1", childSessionId: child, taskId: task, title: "Critic", startedAt: start ?? t0, state: state, groupId: "turn_1")
    }

    private func spoke(_ task: String = "task_1", at: Date) -> ChildProgress {
        var p = ChildProgress(taskId: task)
        p.lastEventAt = at
        return p
    }

    // MARK: Tracker

    private func stamped(_ type: String, at stamp: String, data: String = "{}", message: String? = nil, turn: String = "turn_c1") throws -> EveEvent {
        let text = message.map { "\"message\":\(jsonString($0))," } ?? ""
        let raw = "{\"type\":\"\(type)\",\"data\":{\(text)\"turnId\":\"\(turn)\"\(data == "{}" ? "" : "," + data)},\"meta\":{\"id\":\"e_\(UUID().uuidString)\",\"at\":\"\(stamp)\"}}"
        return try #require(EveStream.parseLine(raw))
    }

    @Test func silentChildHasNoLabel() {
        let tracker = ChildTracker(taskId: "task_1")
        #expect(tracker.progress.label == nil)
        #expect(tracker.progress.lastEventAt == nil)
    }

    @Test func trackerReadsLabelAndFinalAnswer() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("turn.started"), at: t0)
        #expect(tracker.progress.label == "Thinking")
        try tracker.apply(event("message.completed", data: "\"finishReason\":\"stop\"", message: "All good."), at: t0 + 5)
        try tracker.apply(event("turn.completed"), at: t0 + 6)
        #expect(tracker.progress.finalAnswer == "All good.")
        #expect(tracker.progress.lastEventAt == t0 + 6)
        #expect(tracker.progress.finishedAt != nil)
    }

    /// The child's own clock, not the arrival time: a replay delivers old events late.
    @Test func finishTimeIsTheChildsOwnStamp() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(stamped("message.completed", at: "2026-10-01T20:49:16.500Z", data: "\"finishReason\":\"stop\"", message: "Done."), at: t0)
        try tracker.apply(stamped("turn.completed", at: "2026-10-01T20:49:17.000Z"), at: t0 + 1)
        let expected = ISO8601DateFormatter().date(from: "2026-10-01T20:49:17Z")
        #expect(tracker.progress.finishedAt == expected)
    }

    @Test func toolCallMessageIsNotAFinalAnswer() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("message.completed", data: "\"finishReason\":\"tool-calls\"", message: "Let me look."), at: t0)
        try tracker.apply(event("turn.completed"), at: t0 + 1)
        #expect(tracker.progress.finalAnswer == nil)
        #expect(tracker.progress.finishedAt == nil)
    }

    @Test func anotherTurnForgetsTheEarlierAnswer() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("message.completed", data: "\"finishReason\":\"stop\"", message: "Done."), at: t0)
        try tracker.apply(event("turn.completed"), at: t0 + 1)
        try tracker.apply(event("turn.started", turn: "turn_c2"), at: t0 + 90)
        #expect(tracker.progress.finishedAt == nil)
        #expect(tracker.progress.finalAnswer == nil)
    }

    // MARK: Status

    private func resolve(_ runs: [SubagentRun], _ progress: [String: ChildProgress], busy: Bool = false, now: Date) -> [SubagentRowStatus] {
        SubagentStatus.resolveAll(runs: runs, progress: { progress[$0.agentId] }, parentBusy: busy, now: now)
    }

    private func sibling(_ id: String, _ state: SubagentRun.State = .working) -> SubagentRun {
        SubagentRun(agentId: id, childSessionId: "ses_\(id)", taskId: "task_\(id)", title: id, startedAt: t0, state: state, groupId: "turn_1")
    }

    private func finished(_ id: String, at: Date, speaking: Date? = nil) -> ChildProgress {
        var p = ChildProgress(taskId: "task_\(id)")
        p.lastEventAt = speaking ?? at
        p.finalAnswer = "Report \(id)."
        p.finishedAt = at
        return p
    }

    private func busyChild(_ id: String, at: Date) -> ChildProgress {
        var p = ChildProgress(taskId: "task_\(id)")
        p.lastEventAt = at
        return p
    }

    @Test func workingWithoutProgressIsPlain() {
        #expect(resolve([run()], [:], now: t0 + 3600) == [.working(label: nil)])
        #expect(resolve([run()], ["agent_1": ChildProgress(taskId: "task_1")], now: t0 + 3600) == [.working(label: nil)])
    }

    @Test func earlierTaskProgressIsIgnored() {
        #expect(resolve([run(task: "task_1")], ["agent_1": spoke("task_0", at: t0)], now: t0 + 3600) == [.working(label: nil)])
    }

    @Test func quietStartsAtFiveMinutes() {
        let p = ["agent_1": spoke(at: t0)]
        #expect(resolve([run()], p, now: t0 + 299) == [.working(label: "Thinking")])
        #expect(resolve([run()], p, now: t0 + 300) == [.quiet(minutes: 5, lastStep: "Thinking")])
        #expect(resolve([run()], p, busy: true, now: t0 + 7 * 60) == [.quiet(minutes: 7, lastStep: "Thinking")])
    }

    /// eve holds each report until the last sibling settles.
    @Test func finishedChildAwaitsItsReport() {
        let a = sibling("a"), b = sibling("b")
        let p = ["a": finished("a", at: t0 + 16), "b": busyChild("b", at: t0 + 30)]
        let out = resolve([a, b], p, now: t0 + 40)
        #expect(out == [.awaitingReport(answer: "Report a."), .working(label: "Thinking")])
    }

    @Test func notDeliveredNeverFiresWhileASiblingWorks() {
        let a = sibling("a"), b = sibling("b")
        // b says something every few minutes, so it is working and never quiet for long.
        let p = ["a": finished("a", at: t0 + 16), "b": busyChild("b", at: t0 + 3000)]
        let out = resolve([a, b], p, now: t0 + 3010)
        #expect(out[0] == .awaitingReport(answer: "Report a."))
        // Even a sibling quiet for five minutes is still a working run.
        let quiet = resolve([a, b], ["a": finished("a", at: t0 + 16), "b": busyChild("b", at: t0)], now: t0 + 600)
        #expect(quiet[0] == .awaitingReport(answer: "Report a."))
        #expect(quiet[1] == .quiet(minutes: 10, lastStep: "Thinking"))
    }

    @Test func notDeliveredFiresWhenAllFinishedAndParentIdle() {
        let a = sibling("a"), b = sibling("b")
        let p = ["a": finished("a", at: t0 + 16), "b": finished("b", at: t0 + 40)]
        #expect(resolve([a, b], p, now: t0 + 99) == [.awaitingReport(answer: "Report a."), .awaitingReport(answer: "Report b.")])
        // 60 s after the LAST one finished, not the first.
        #expect(resolve([a, b], p, now: t0 + 100) == [.notDelivered, .notDelivered])
        #expect(resolve([a, b], p, now: t0 + 40 + 61) == [.notDelivered, .notDelivered])
    }

    @Test func notDeliveredNeverFiresWhileTheParentIsBusy() {
        let a = sibling("a")
        let p = ["a": finished("a", at: t0)]
        #expect(resolve([a], p, busy: true, now: t0 + 3600) == [.awaitingReport(answer: "Report a.")])
        #expect(resolve([a], p, busy: false, now: t0 + 3600) == [.notDelivered])
    }

    @Test func reportedAndFailedSiblingsCountAsSettled() {
        let a = sibling("a"), b = sibling("b", .reported(at: t0 + 50)), c = sibling("c", .failed(at: t0 + 20, message: "upstream_timeout"))
        let p = ["a": finished("a", at: t0 + 16)]
        let out = resolve([a, b, c], p, now: t0 + 120)
        #expect(out == [.notDelivered, .reported, .failed(reason: "Stopped: the model took too long")])
        // Not 60 s after the last settle (50) yet.
        #expect(resolve([a, b, c], p, now: t0 + 109)[0] == .awaitingReport(answer: "Report a."))
    }

    @Test func settledStatesAndPlainFailures() {
        #expect(resolve([run(.failed(at: nil, message: "upstream_timeout"))], [:], now: t0) == [.failed(reason: "Stopped: the model took too long")])
        #expect(resolve([run(.cancelled(at: nil))], [:], now: t0) == [.stopped])
        #expect(resolve([run(.reported(at: t0 + 20))], [:], now: t0 + 600) == [.reported])
        for raw in ["{\"message\":\"x\"}", "boom", "", "Error: something odd"] {
            let text = SubagentStatus.plainFailure(raw)
            #expect(text.hasPrefix("Stopped: "))
            #expect(!text.contains("{") && !text.contains("Error:"))
        }
        #expect(SubagentStatus.plainFailure("HTTP 429 too many requests") == "Stopped: the model was rate limited")
    }

    @Test func codesMatchWholeTokensOnly() {
        #expect(SubagentStatus.plainFailure("rate_limit_exceeded") == "Stopped: the model was rate limited")
        #expect(SubagentStatus.plainFailure("HTTP 429") == "Stopped: the model was rate limited")
        #expect(SubagentStatus.plainFailure("upstream_timeout") == "Stopped: the model took too long")
        #expect(SubagentStatus.plainFailure("HTTP 402 payment required") == "Stopped: the model plan ran out")
        // Substrings of other words and numbers are not codes.
        #expect(SubagentStatus.plainFailure("Failed after 1429 ms") == "Stopped: it hit an error")
        #expect(SubagentStatus.plainFailure("could not tolerate the limit") == "Stopped: it hit an error")
        #expect(SubagentStatus.plainFailure("accurate and limited") == "Stopped: it hit an error")
        #expect(SubagentStatus.plainFailure("job 14020 broke") == "Stopped: it hit an error")
    }

    // MARK: Child failure and cancel

    @Test func aFailedChildStreamShowsFailedWithoutTheParentsReport() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("turn.started"), at: t0)
        try tracker.apply(event("turn.failed", data: "\"code\":\"upstream_timeout\""), at: t0 + 9)
        #expect(resolve([run()], ["agent_1": tracker.progress], now: t0 + 10) == [.failed(reason: "Stopped: the model took too long")])
        // The child went on to another turn: it is working again.
        try tracker.apply(event("turn.started", turn: "turn_c2"), at: t0 + 20)
        #expect(resolve([run()], ["agent_1": tracker.progress], now: t0 + 21) == [.working(label: "Thinking")])
    }

    @Test func aCancelledChildStreamShowsStopped() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("turn.started"), at: t0)
        try tracker.apply(event("turn.cancelled"), at: t0 + 3)
        #expect(resolve([run()], ["agent_1": tracker.progress], now: t0 + 4) == [.stopped])
    }

    @Test func aFailedChildCountsAsSettledForTheBatch() {
        var failedChild = busyChild("b", at: t0 + 5)
        failedChild.failure = "boom"
        failedChild.endedAt = t0 + 5
        let a = sibling("a"), b = sibling("b")
        let out = resolve([a, b], ["a": finished("a", at: t0 + 16), "b": failedChild], now: t0 + 100)
        #expect(out == [.notDelivered, .failed(reason: "Stopped: it hit an error")])
    }

    @Test func aFinishBeforeTheCurrentTaskStartedIsNotThisTasks() {
        var r = run(task: "task_2")
        r.taskStartedAt = t0 + 100
        var old = finished("1", at: t0 + 50).with(task: "task_2")
        old.lastEventAt = t0 + 120
        #expect(resolve([r], ["agent_1": old], now: t0 + 130) == [.working(label: "Thinking")])
        var failedOld = busyChild("1", at: t0 + 120).with(task: "task_2")
        failedOld.failure = "boom"
        failedOld.endedAt = t0 + 50
        #expect(resolve([r], ["agent_1": failedOld], now: t0 + 130) == [.working(label: "Thinking")])
        // After the start it counts.
        var fresh = finished("1", at: t0 + 110).with(task: "task_2")
        fresh.lastEventAt = t0 + 110
        #expect(resolve([r], ["agent_1": fresh], now: t0 + 130) == [.awaitingReport(answer: "Report 1.")])
    }

    @Test func activeWorkReadsTheResolvedStatuses() {
        let a = sibling("a"), b = sibling("b"), c = sibling("c")
        // a finished (awaiting), b quiet, c lost with no stream at all.
        let p = ["a": finished("a", at: t0 + 10), "b": busyChild("b", at: t0)]
        #expect(SubagentStatus.hasActiveWork(runs: [a], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 20) == false)
        #expect(SubagentStatus.hasActiveWork(runs: [a, b], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 400) == true)
        #expect(SubagentStatus.hasActiveWork(runs: [a, c], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 20) == true)
        // Everything settled or delivered: nothing ticks.
        #expect(SubagentStatus.needsClock(runs: [a], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 20) == true)
        #expect(SubagentStatus.needsClock(runs: [a], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 200) == false)
        #expect(SubagentStatus.needsClock(runs: [sibling("r", .reported(at: t0 + 5))], progress: { _ in nil }, parentBusy: false, now: t0 + 200) == false)
    }

    @Test func lastEventTimeIsTheEventsOwnStampWhenOlder() throws {
        var tracker = ChildTracker(taskId: "task_1")
        let stamp = ISO8601DateFormatter().date(from: "2026-10-01T20:49:01Z")!
        // Read long after it happened (a tail read after a relaunch).
        try tracker.apply(event("turn.started"), at: stamp + 3600)
        #expect(tracker.progress.lastEventAt == stamp)
        // A stamp ahead of the clock is clock skew: arrival time wins.
        try tracker.apply(event("turn.started"), at: stamp - 5)
        #expect(tracker.progress.lastEventAt == stamp - 5)
    }

    // MARK: Light tracker

    @Test func theTrackerKeepsOnlyTheStepFromTheEvents() throws {
        var tracker = ChildTracker(taskId: "task_1")
        try tracker.apply(event("actions.requested", data: "\"actions\":[{\"callId\":\"c\",\"toolName\":\"read_file\",\"input\":{\"path\":\"a.txt\"}}]"), at: t0)
        #expect(tracker.progress.label == TurnActivity.tool("read_file", detail: "a.txt").label)
        try tracker.apply(event("message.appended", data: "\"messageDelta\":\"hi\""), at: t0 + 1)
        #expect(tracker.progress.label == "Writing")
        try tracker.apply(event("compaction.requested"), at: t0 + 2)
        #expect(tracker.progress.label == "Compacting the conversation")
        try tracker.apply(event("reasoning.appended"), at: t0 + 3)
        #expect(tracker.progress.label == "Thinking")
    }

    // MARK: Block holds

    @Test func aBlockHoldsItsOwnRowsAndAnImageRunsLaterOnes() {
        let a = TranscriptRow(id: "i1", kind: .image, text: "a")
        let b = TranscriptRow(id: "i2", kind: .image, text: "b")
        let images = TranscriptBlock.images(rows: [a, b])
        #expect(images.holds(rowId: "i2"))
        #expect(images.holds(rowId: "i1"))
        #expect(!images.holds(rowId: "x"))
        let message = TranscriptBlock.message(row: TranscriptRow(id: "m", kind: .assistant, text: "t"), recipients: [])
        #expect(message.holds(rowId: "m"))
        #expect(!message.holds(rowId: "i1"))
    }

    @Test func durationIsStartToTheChildsOwnFinish() {
        #expect(SubagentStatus.duration(of: run(.reported(at: t0 + 65))) == 65)
        // Reported at 42 s, but the child was done at 16 s.
        #expect(SubagentStatus.duration(of: run(.reported(at: t0 + 42)), progress: finished("1", at: t0 + 16).with(task: "task_1")) == 16)
        // Another task's finish is not this run's.
        #expect(SubagentStatus.duration(of: run(.reported(at: t0 + 42)), progress: finished("0", at: t0 + 16)) == 42)
        // Still unreported, but done.
        #expect(SubagentStatus.duration(of: run(.working), progress: finished("1", at: t0 + 22).with(task: "task_1")) == 22)
        #expect(SubagentStatus.duration(of: run(.working)) == nil)
        #expect(SubagentStatus.duration(of: run(.reported(at: nil))) == nil)
        #expect(SubagentStatus.duration(of: run(.reported(at: t0 - 5))) == 0)
    }

    // MARK: Header

    private func header(_ s: [SubagentRowStatus]) -> SubagentHeader { SubagentCardCopy.header(statuses: s, botName: "Generalist") }
    private let work = SubagentRowStatus.working(label: nil)


    @Test func headerCopy() {
        #expect(header([work]) == SubagentHeader(title: "1 sub-agent working", detail: nil))
        #expect(header([work, work, .quiet(minutes: 5, lastStep: nil)]) == SubagentHeader(title: "3 sub-agents working", detail: nil))
        #expect(header([.reported, .failed(reason: "x"), work, work, .quiet(minutes: 5, lastStep: nil)])
            == SubagentHeader(title: "5 sub-agents", detail: "1 done · 1 failed · 3 working"))
        #expect(header([.reported, work]) == SubagentHeader(title: "2 sub-agents", detail: "1 done · 1 working"))
        #expect(header([.reported, .reported, .reported]) == SubagentHeader(title: "3 reports handed to Generalist", detail: nil))
        #expect(header([.reported]) == SubagentHeader(title: "1 report handed to Generalist", detail: nil))
        #expect(header([.reported, .reported, .failed(reason: "x")]) == SubagentHeader(title: "2 of 3 reports in · 1 failed", detail: nil))
        #expect(header([.stopped, .failed(reason: "x")]) == SubagentHeader(title: "0 of 2 reports in · 1 failed · 1 stopped", detail: nil))
        #expect(SubagentCardCopy.accessibility(header([.reported, work])) == "2 sub-agents, 1 done · 1 working")
        let wait = SubagentRowStatus.awaitingReport(answer: nil)
        #expect(header([wait, work, work]) == SubagentHeader(title: "3 sub-agents", detail: "1 done · 2 working"))
        #expect(header([wait, wait, wait]) == SubagentHeader(title: "3 sub-agents done, handing reports to Generalist", detail: nil))
        // Not delivered is its own count, never "handing reports".
        #expect(header([.notDelivered]) == SubagentHeader(title: "1 report not delivered", detail: nil))
        #expect(header([.notDelivered, .notDelivered]) == SubagentHeader(title: "2 reports not delivered", detail: nil))
        #expect(header([.reported, .notDelivered]) == SubagentHeader(title: "1 of 2 reports in · 1 not delivered", detail: nil))
        #expect(header([.stopped, work]) == SubagentHeader(title: "2 sub-agents", detail: "1 stopped · 1 working"))
        #expect(header([.reported, wait, .failed(reason: "x")]) == SubagentHeader(title: "1 of 3 reports in · 1 failed · 1 on its way", detail: nil))
    }

    @Test func tenRunsHeader() {
        let ten = Array(repeating: work, count: 10)
        #expect(header(ten).title == "10 sub-agents working")
    }

    // MARK: Following

    private func manyRuns(_ n: Int, startedAgo: (Int) -> TimeInterval = { _ in 10 }) -> [SubagentRun] {
        (0..<n).map { i in
            SubagentRun(agentId: "a\(i)", childSessionId: "ses_\(i)", taskId: "task_\(i)", title: "R\(i)",
                        startedAt: t0 - startedAgo(i), groupId: "g")
        }
    }

    @Test func followCapAndFilters() {
        var runs = manyRuns(10)
        runs[1].state = .reported(at: nil)
        runs[2].childSessionId = nil
        let targets = ChildFollowPlanner.targets(runs: runs, now: t0)
        #expect(targets.count == 8)
        #expect(!targets.contains { $0.childSessionId == "ses_1" || $0.childSessionId == "ses_2" })
        // Newest first.
        #expect(targets.first?.childSessionId == "ses_9")
        // Once one settles, the next waiting run takes its place.
        runs[9].state = .failed(at: nil, message: "x")
        #expect(ChildFollowPlanner.targets(runs: runs, now: t0).first?.childSessionId == "ses_8")
    }

    @Test func staleRunsNeverStarveNewOnes() {
        // Eight lost runs from hours ago, then two new ones.
        var runs = manyRuns(10) { $0 < 8 ? SubagentStatus.patience + 60 : 10 }
        let targets = ChildFollowPlanner.targets(runs: runs, now: t0)
        #expect(targets.map(\.childSessionId) == ["ses_9", "ses_8"])
        // Runs ruled out by the caller (finished, refused) are skipped before the cap.
        runs = manyRuns(12)
        let skipped = ChildFollowPlanner.targets(runs: runs, now: t0) { $0.childSessionId == "ses_11" || $0.childSessionId == "ses_10" }
        #expect(skipped.count == 8)
        #expect(skipped.first?.childSessionId == "ses_9")
        #expect(!skipped.contains { $0.childSessionId == "ses_11" })
    }

    // MARK: Chat-wide delivery

    @Test func notDeliveredIsJudgedAcrossEveryBatch() {
        let a = sibling("a"), b = sibling("b")
        let p = ["a": finished("a", at: t0 + 16), "b": busyChild("b", at: t0 + 3000)]
        // Batch two is still working: batch one is not undelivered however long ago it finished.
        let out = SubagentStatus.resolveChat(batches: [[a], [b]], progress: { p[$0.agentId] }, parentBusy: false, now: t0 + 3010)
        #expect(out[0] == [.awaitingReport(answer: "Report a.")])
        #expect(out[1] == [.working(label: "Thinking")])
        // Everything finished anywhere in the chat: all undelivered together.
        let both = ["a": finished("a", at: t0 + 16), "b": finished("b", at: t0 + 100)]
        let early = SubagentStatus.resolveChat(batches: [[a], [b]], progress: { both[$0.agentId] }, parentBusy: false, now: t0 + 159)
        #expect(early == [[.awaitingReport(answer: "Report a.")], [.awaitingReport(answer: "Report b.")]])
        let late = SubagentStatus.resolveChat(batches: [[a], [b]], progress: { both[$0.agentId] }, parentBusy: false, now: t0 + 160)
        #expect(late == [[.notDelivered], [.notDelivered]])
    }

    @Test func theParentMustHaveBeenIdleForTheWholeWindow() {
        let a = sibling("a")
        let p = ["a": finished("a", at: t0)]
        // Idle only 10 s, though the child finished long ago: a long turn just ended.
        let fresh = SubagentStatus.resolveAll(runs: [a], progress: { p[$0.agentId] }, parentBusy: false, parentIdleSince: t0 + 590, now: t0 + 600)
        #expect(fresh == [.awaitingReport(answer: "Report a.")])
        let settled = SubagentStatus.resolveAll(runs: [a], progress: { p[$0.agentId] }, parentBusy: false, parentIdleSince: t0 + 540, now: t0 + 600)
        #expect(settled == [.notDelivered])
    }

    @Test func aRunNobodyHeardFromForHoursIsGivenUp() {
        var r = run()
        r.startedAt = t0
        r.taskStartedAt = t0
        let late = t0 + SubagentStatus.patience + 1
        #expect(resolve([r], [:], now: late) == [.noWord])
        // A child still talking is working, however old the run.
        #expect(resolve([r], ["agent_1": spoke(at: late - 10)], now: late) == [.working(label: "Thinking")])
        #expect(resolve([r], ["agent_1": spoke(at: t0)], now: late) == [.noWord])
        #expect(!SubagentRowStatus.noWord.isWorking)
        #expect(SubagentStatus.needsClock(runs: [r], progress: { _ in nil }, parentBusy: false, now: late) == false)
        #expect(header([.noWord, .reported]) == SubagentHeader(title: "1 of 2 reports in · 1 no word", detail: nil))
        #expect(header([.noWord, work]) == SubagentHeader(title: "2 sub-agents", detail: "1 no word · 1 working"))
    }

    @Test func aParkedRequestHoldsDeliveryJudgement() {
        let a = sibling("a")
        let p = ["a": finished("a", at: t0)]
        let parked = SubagentStatus.resolveChat(batches: [[a]], progress: { p[$0.agentId] }, parentBusy: false, parked: true, now: t0 + 600)
        #expect(parked == [[.awaitingReport(answer: "Report a.")]])
        let open = SubagentStatus.resolveChat(batches: [[a]], progress: { p[$0.agentId] }, parentBusy: false, parked: false, now: t0 + 600)
        #expect(open == [[.notDelivered]])
        #expect(SubagentStatus.needsClock(batches: [[a]], progress: { p[$0.agentId] }, parentBusy: false, parked: true, now: t0 + 600))
    }

    @Test func patienceIsFromTheChildsLastWordForThePlannerToo() {
        var r = run()
        r.startedAt = t0
        r.taskStartedAt = t0
        let late = t0 + SubagentStatus.patience + 100
        #expect(ChildFollowPlanner.targets(runs: [r], now: late).isEmpty)
        // The child spoke a minute ago: still followed, as the card still shows it working.
        #expect(ChildFollowPlanner.targets(runs: [r], now: late, lastHeard: { _ in late - 60 }).count == 1)
        #expect(resolve([r], ["agent_1": spoke(at: late - 60)], now: late) == [.working(label: "Thinking")])
    }

    @Test func eachCardNeedsAClockOnlyForItsOwnWork() {
        let a = sibling("a"), b = sibling("b"), c = sibling("c", .reported(at: t0 + 5))
        let p = ["a": finished("a", at: t0 + 16), "b": busyChild("b", at: t0 + 30)]
        func need(_ index: Int, batches: [[SubagentRun]], now: Date = t0 + 40) -> Bool {
            SubagentStatus.needsClock(batches: batches, of: index, progress: { p[$0.agentId] }, parentBusy: false, now: now)
        }
        // Card 0 holds a finished child, card 1 a working one: only card 1 ticks.
        #expect(need(0, batches: [[a], [b]]) == false)
        #expect(need(1, batches: [[a], [b]]) == true)
        // A fully settled card never ticks.
        #expect(need(0, batches: [[c], [b]]) == false)
        // Nothing working anywhere: the awaiting card ticks toward "not delivered".
        #expect(need(0, batches: [[a], [c]]) == true)
        #expect(need(1, batches: [[a], [c]]) == false)
    }

    @Test func failedAndStoppedDurationsUseTheChildsOwnEnd() {
        var failedChild = busyChild("1", at: t0 + 9)
        failedChild.failure = "boom"
        failedChild.endedAt = t0 + 9
        #expect(SubagentStatus.duration(of: run(.failed(at: t0 + 300, message: "boom")), progress: failedChild) == 9)
        #expect(SubagentStatus.duration(of: run(.failed(at: t0 + 300, message: "boom"))) == 300)
        var stopped = busyChild("1", at: t0 + 4)
        stopped.cancelled = true
        stopped.endedAt = t0 + 4
        #expect(SubagentStatus.duration(of: run(.cancelled(at: t0 + 90)), progress: stopped) == 4)
    }

    @Test func aCancelledMessageReadsStoppedWhereverItCameFrom() {
        // An older snapshot holds the cancel as a failure.
        #expect(resolve([run(.failed(at: nil, message: "The agent invocation was cancelled."))], [:], now: t0) == [.stopped])
        var child = busyChild("1", at: t0 + 3)
        child.failure = "The agent invocation was cancelled."
        child.endedAt = t0 + 3
        #expect(resolve([run()], ["agent_1": child], now: t0 + 4) == [.stopped])
        // Counted as stopped in the header, not failed.
        #expect(header([.stopped, .stopped, work]) == SubagentHeader(title: "3 sub-agents", detail: "2 stopped · 1 working"))
    }

    @Test func aRelaunchedRunCountsFromItsOwnStart() {
        var r = run(.reported(at: t0 + 130))
        r.taskStartedAt = t0 + 100
        #expect(SubagentStatus.duration(of: r) == 30)
    }

    @Test func relaunchChangesTheTarget() {
        var r = run(task: "task_1")
        let before = ChildFollowPlanner.targets(runs: [r], now: t0)
        r.taskId = "task_2"
        #expect(!before.isEmpty)
        #expect(ChildFollowPlanner.targets(runs: [r], now: t0) != before)
    }

    @Test func facesAreValidAndDistinct() {
        #expect(Set(SubagentFaces.palette).count == SubagentFaces.palette.count)
        for color in SubagentFaces.palette { #expect(FacePalette.isColor(color)) }
        #expect(SubagentFaces.color(at: 10) == SubagentFaces.color(at: 0))
    }

    // MARK: Waiting card

    @Test func requestCopy() {
        let limit = PendingRequest(id: "s:limit:input:1", kind: "session-limit", prompt: "Session reached the limit",
                                   options: [.init(id: "continue", label: "Continue anyway"), .init(id: "stop", label: "Stop session")])
        #expect(PendingRequestCopy.body(for: limit) == "This chat used its token budget. Continue to keep working, or stop here.")
        #expect(PendingRequestCopy.label(of: limit.options[0], in: limit) == "Continue")
        #expect(PendingRequestCopy.label(of: limit.options[1], in: limit) == "Stop")
        #expect(PendingRequestCopy.isPrimary(limit.options[0], in: limit))
        #expect(!PendingRequestCopy.isPrimary(limit.options[1], in: limit))
        let other = PendingRequest(id: "r", kind: "tool-approval", prompt: "Run rm -rf?",
                                   options: [.init(id: "yes", label: "Allow", style: "primary"), .init(id: "no", label: "Deny", style: "danger")])
        #expect(PendingRequestCopy.body(for: other) == "Run rm -rf?")
        #expect(PendingRequestCopy.label(of: other.options[0], in: other) == "Allow")
        #expect(PendingRequestCopy.isPrimary(other.options[0], in: other))
        #expect(!PendingRequestCopy.isPrimary(other.options[1], in: other))
    }

    // MARK: Row lookup

    @Test func rowFoundByIdThenByText() {
        let message = ChatMessage(id: "live-1", role: .assistant, text: "Here you go.")
        let rows = [
            TranscriptRow(id: "u", kind: .user, text: "Here you go."),
            TranscriptRow(id: "durable-9", kind: .assistant, text: "Here you go."),
        ]
        #expect(Transcript.rowId(forMessage: message, in: rows) == "durable-9")
        #expect(Transcript.rowId(forMessage: message, in: rows + [TranscriptRow(id: "live-1", kind: .assistant, text: "x")]) == "live-1")
        #expect(Transcript.rowId(forMessage: ChatMessage(id: "m", role: .assistant, text: "gone"), in: rows) == nil)
        #expect(Transcript.rowId(forMessage: ChatMessage(id: "m", role: .user, text: "Here you go."), in: rows) == "u")
    }

    // MARK: Anchor

    @Test func anchorFollowsTheLaunchingTurnsLastRow() throws {
        var projection = StreamProjection()
        func feed(_ json: String) throws { projection.apply(try #require(EveStream.parseLine(json)), live: true) }
        try feed("""
        {"type":"message.received","data":{"message":"Run the critics","turnId":"turn_1"},"meta":{"id":"m1","at":"2026-10-01T20:49:01.000Z"}}
        """)
        try feed("""
        {"type":"action.result","data":{"result":{"callId":"c1","kind":"tool-result","output":{"agentId":"agent_1","status":"working","taskId":"task_1"},"toolName":"agent"},"turnId":"turn_1","status":"completed"},"meta":{"id":"r1","at":"2026-10-01T20:49:02.000Z"}}
        """)
        let group = try #require(projection.subagentRuns.first?.groupId)
        #expect(projection.subagentAnchor(forGroup: group) == "m1")
        #expect(projection.subagentAnchor(forGroup: "turn_unknown") == nil)
    }
}

/// What Stop and approval cards need from the core.
@Suite struct SubagentStopAndApprovalTests {
    private func run(_ id: String, state: SubagentRun.State = .working, child: String? = "ses_c", call: SubagentCallSite? = SubagentCallSite(sessionId: "ses_p", index: 7)) -> SubagentRun {
        SubagentRun(agentId: id, childSessionId: child, childCall: call, taskId: "task_\(id)", title: "Critic \(id)", state: state, groupId: "g")
    }

    @Test func stopNamesEveryWorkingRunThatCanBeNamed() {
        let runs = [
            run("a"),
            run("b", state: .reported(at: nil)),
            run("c", child: nil),
            run("d", call: nil),
            run("e", call: SubagentCallSite(sessionId: nil, index: 3)),
        ]
        #expect(SubagentCancel.targets(runs: runs) == [
            ChildCancelTarget(agentId: "a", taskId: "task_a", title: "Critic a", childSessionId: "ses_c", parentSessionId: "ses_p", calledAt: 7),
        ])
        // A call site with no session falls back to the open chat's.
        #expect(SubagentCancel.targets(runs: runs, fallbackParent: "ses_open").map(\.calledAt) == [7, 3])
        #expect(SubagentCancel.targets(runs: []).isEmpty)
    }

    private func decode(_ json: String) throws -> ApprovalItem {
        try JSONDecoder().decode(ApprovalItem.self, from: Data(json.utf8))
    }

    @Test func anOldServersCardStillDecodesAndSaysNothingOfItsOrigin() throws {
        let item = try decode(#"{"id":"a1","actionSha256":"x","preview":"rm","tool":"bash"}"#)
        #expect(!item.subagent)
        #expect(item.botName == nil)
        #expect(item.originLabel(openBotId: "bot_1") == nil)
    }

    @Test func aSubagentsCardSaysSo() throws {
        let named = try decode(#"{"id":"a1","tool":"bash","botId":"bot_1","botName":"Generalist","sessionId":"ses_c","subagent":true}"#)
        #expect(named.originLabel(openBotId: "bot_1") == "Sub-agent of Generalist")
        let anonymous = try decode(#"{"id":"a1","tool":"bash","subagent":true}"#)
        #expect(anonymous.originLabel(openBotId: "bot_1") == "Sub-agent")
        let blank = try decode(#"{"id":"a1","tool":"bash","botName":"  ","subagent":true}"#)
        #expect(blank.originLabel(openBotId: nil) == "Sub-agent")
    }

    @Test func anotherBotsOwnCardNamesTheBot() throws {
        let other = try decode(#"{"id":"a1","tool":"bash","botId":"bot_2","botName":"Growth"}"#)
        #expect(other.originLabel(openBotId: "bot_1") == "Growth")
        #expect(other.originLabel(openBotId: "bot_2") == nil)
    }
}

@Suite struct StoppedRunGuardTests {
    private func cancelled(_ task: String) -> String {
        "Background task \(task) (agent) failed.\n\nError:\n{\"code\":\"SUBAGENT_EXECUTION_FAILED\",\"message\":\"The agent invocation was cancelled.\"}"
    }

    private func ask(_ g: inout StoppedRunGuard, _ text: String, _ turn: String?) -> Bool {
        g.shouldCancel(message: text, turnId: turn)
    }

    private func guardWith(_ tasks: String...) -> StoppedRunGuard {
        var g = StoppedRunGuard()
        for task in tasks { g.stop(taskId: task) }
        return g
    }

    @Test func onlyCancellationsOfStoppedTasksEndTheTurn() {
        var g = guardWith("task_a", "task_b")
        #expect(ask(&g, cancelled("task_a"), "turn_1"))
        // Several reports in one message, all stopped ones.
        #expect(ask(&g, cancelled("task_a") + "\n\n" + cancelled("task_b"), "turn_2"))
    }

    @Test func aMixedMessageDoesNothing() {
        var g = guardWith("task_a")
        // Another task's cancellation.
        #expect(!ask(&g, cancelled("task_a") + "\n\n" + cancelled("task_z"), "turn_1"))
        // A real report beside it.
        let done = "Background task task_a (agent) is completed.\n\nResult:\nFine."
        #expect(!ask(&g, cancelled("task_a") + "\n\n" + done, "turn_2"))
        // Owner text after it.
        #expect(!ask(&g, cancelled("task_a") + "\n\nPlease carry on", "turn_3"))
        // A real failure of a stopped task.
        let boom = "Background task task_a (agent) failed.\n\nError:\n{\"message\":\"upstream_timeout\"}"
        #expect(!ask(&g, boom, "turn_4"))
    }

    @Test func anUnknownTaskOrPlainOwnerTextDoesNothing() {
        var g = guardWith("task_a")
        #expect(!ask(&g, cancelled("task_zzz"), "turn_1"))
        #expect(!ask(&g, "Stop please", "turn_2"))
        var none = StoppedRunGuard()
        #expect(!ask(&none, cancelled("task_a"), "turn_1"))
        // No turn id to count it by.
        #expect(!ask(&g, cancelled("task_a"), nil))
    }

    @Test func aTurnIsEndedOnlyOnce() {
        var g = guardWith("task_a")
        #expect(ask(&g, cancelled("task_a"), "turn_1"))
        #expect(!ask(&g, cancelled("task_a"), "turn_1"))
        #expect(ask(&g, cancelled("task_a"), "turn_2"))
    }

    @Test func theStopRecordsTheTask() {
        let g = guardWith("task_a")
        #expect(g.stoppedTasks == ["task_a"])
    }
}

@Suite struct StopTargetingTests {
    private func run(_ id: String, state: SubagentRun.State = .working, child: String? = "ses_\(1)", call: SubagentCallSite? = SubagentCallSite(sessionId: "ses_p", index: 7)) -> SubagentRun {
        SubagentRun(agentId: id, childSessionId: child, childCall: call, taskId: "task_\(id)", title: "R \(id)", state: state, groupId: "g")
    }

    private func ended(_ id: String) -> ChildProgress {
        var p = ChildProgress(taskId: "task_\(id)")
        p.lastEventAt = Date()
        p.finishedAt = Date()
        p.finalAnswer = "done"
        return p
    }

    @Test func aChildThatAlreadyFinishedIsNotStoppedAgain() {
        let runs = [run("a"), run("b")]
        let progress: (SubagentRun) -> ChildProgress? = { $0.agentId == "a" ? self.ended("a") : nil }
        #expect(SubagentCancel.targets(runs: runs, progress: progress).map(\.taskId) == ["task_b"])
        // Another task's finish says nothing about this one.
        let stale: (SubagentRun) -> ChildProgress? = { _ in self.ended("zzz") }
        #expect(SubagentCancel.targets(runs: runs, progress: stale).count == 2)
    }

    @Test func runsStopCannotNameYetAreCounted() {
        let runs = [run("a"), run("b", child: nil), run("c", call: nil), run("d", state: .reported(at: nil)), run("e")]
        #expect(SubagentCancel.untargetable(runs: runs) == 2)
        #expect(SubagentCancel.untargetable(runs: [run("a")]) == 0)
        // A finished one that cannot be named is not waiting on anything.
        let progress: (SubagentRun) -> ChildProgress? = { $0.agentId == "b" ? self.ended("b") : nil }
        #expect(SubagentCancel.untargetable(runs: [run("b", child: nil)], progress: progress) == 0)
    }

    private func decode(_ json: String) throws -> ApprovalItem {
        try JSONDecoder().decode(ApprovalItem.self, from: Data(json.utf8))
    }

    @Test func aSubagentCardFromAnotherChatSaysSo() throws {
        let item = try decode(#"{"id":"a","tool":"bash","botName":"Generalist","subagent":true,"rootSessionId":"ses_root"}"#)
        #expect(item.originLabel(openBotId: "b", openSessionId: "ses_root") == "Sub-agent of Generalist")
        #expect(item.originLabel(openBotId: "b", openSessionId: "ses_other") == "Sub-agent of Generalist, from another chat")
        // Unknown on either side: no claim.
        #expect(item.originLabel(openBotId: "b", openSessionId: nil) == "Sub-agent of Generalist")
        let old = try decode(#"{"id":"a","tool":"bash","botName":"G","subagent":true}"#)
        #expect(old.originLabel(openBotId: "b", openSessionId: "ses_other") == "Sub-agent of G")
    }
}

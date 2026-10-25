import Foundation
import Testing
@testable import UsefulBotCore

private let epoch = "e7a1c0de-0000-4000-8000-000000000001"

private func empty(tailSeq: Int = 0) -> ChatProjection {
    var projection = ChatProjection()
    projection.load(RowsPage(rows: [], tailSeq: tailSeq, epoch: epoch))
    return projection
}

private func event(_ json: String) -> ChatEvent {
    ChatEvent.parse(line: json)!
}

@Suite struct ChatProjectionTests {
    // MARK: Events against fixtures

    @Test(.enabled(if: ChatFixtures.available)) func anOwnerTurnBuildsItsRowsFromTheEvents() throws {
        var projection = empty()
        var activities: [TurnActivity] = []
        for line in try ChatFixtures.events("events-turn.ndjson") {
            projection.apply(line)
            if projection.pending, activities.last != projection.activity { activities.append(projection.activity) }
        }
        let ids = projection.rows.map(\.rowId)
        #expect(ids == [
            "7a1e0001-0000-4000-8000-00000000a001:u",
            "7a1e0001-0000-4000-8000-00000000a001:a0",
            "widget:call-excal-1",
            "image:img-0001",
            "7a1e0001-0000-4000-8000-00000000a001:a1",
            "7a1e0001-0000-4000-8000-00000000a002:u",
            "7a1e0001-0000-4000-8000-00000000a002:a0",
        ])
        let user = projection.rows[0]
        #expect(user.text == "Find two sources on Pi and draw the flow")
        #expect(user.attachments.map(\.name) == ["notes.txt"])
        #expect(projection.rows[1].text == "Here are two sources.")
        // The streamed bubble ends on the authoritative text.
        #expect(projection.rows.last?.text == "Saved to the Desktop.")
        #expect(!projection.pending)
        #expect(projection.openQuestion == nil)
        #expect(activities.first == .thinking)
    }

    @Test(.enabled(if: ChatFixtures.available)) func theQuestionOpensEndsTheTurnAndClosesWithTheNextOne() throws {
        var projection = empty()
        var openedAt: Int?
        var closedAt: Int?
        var pendingAtOpen: Bool?
        for line in try ChatFixtures.events("events-turn.ndjson") {
            projection.apply(line)
            if projection.openQuestion != nil, openedAt == nil {
                openedAt = line.seq
                pendingAtOpen = projection.pending
            }
            if projection.openQuestion == nil, openedAt != nil, closedAt == nil { closedAt = line.seq }
        }
        #expect(openedAt == 21)
        #expect(closedAt == 24)
        // The turn is still running when the question lands; it ends right after.
        #expect(pendingAtOpen == true)
    }

    @Test(.enabled(if: ChatFixtures.available)) func searchResultsBecomeChipsAndADrawingBecomesALiveWidgetUntilItsRow() throws {
        var projection = empty()
        var sawChips = false
        var sawLiveWidget = false
        for line in try ChatFixtures.events("events-turn.ndjson") {
            projection.apply(line)
            if projection.searchHits.count == 2 { sawChips = true }
            if projection.widgets.map(\.callId) == ["call-excal-1"] {
                sawLiveWidget = true
                #expect(projection.transcript().contains { $0.id == "live-call-excal-1" })
                #expect(projection.widgets[0].qualifiedToolName == "excalidraw__create_view")
            }
        }
        #expect(sawChips)
        #expect(sawLiveWidget)
        // The saved widget row replaced the live one.
        #expect(projection.widgets.isEmpty)
        #expect(projection.transcript().contains { $0.id == "widget:call-excal-1" })
        #expect(!projection.transcript().contains { $0.id.hasPrefix("live-") })
    }

    @Test(.enabled(if: ChatFixtures.available)) func aFailedTurnKeepsItsMessageAndRetryReplacesTheFailure() throws {
        var projection = empty(tailSeq: 30)
        let events = try ChatFixtures.events("events-failure.ndjson")
        var retryTargetAfterFailure: (clientId: String, text: String)?
        var retryableRow: String?
        var retryResync = false
        for line in events {
            if projection.apply(line) == .resync {
                // The retry's turn.started: the rows are read again.
                retryResync = true
                break
            }
            if line.type == "turn.failed" {
                retryTargetAfterFailure = projection.retryTarget
                retryableRow = projection.retryableFailureRowId
                #expect(!projection.pending)
                #expect(projection.activity == .thinking)
            }
        }
        #expect(retryableRow == "7a1e0001-0000-4000-8000-00000000a002:f")
        #expect(retryTargetAfterFailure?.clientId == "c1c1c1c1-0000-4000-8000-0000000000c2")
        #expect(retryTargetAfterFailure?.text == "Desktop")
        #expect(retryResync)
    }

    @Test func aRetryReadsTheRowsAgainAndTheFailedAttemptsRowsAreGone() throws {
        let failedPage = #"{"rows":[{"rowId":"t1:u","kind":"user","turnId":"t1","text":"Draw it","clientId":"c1"},{"rowId":"t1:a0","kind":"assistant","turnId":"t1","text":"Here."},{"rowId":"image:img-1","kind":"image","turnId":"t1"},{"rowId":"t1:f","kind":"failure","turnId":"t1"}],"tailSeq":6,"epoch":"\#(epoch)"}"#
        var projection = ChatProjection()
        projection.load(try JSONDecoder().decode(RowsPage.self, from: Data(failedPage.utf8)))
        #expect(projection.rows.count == 4)
        // The retry is a new turn on the same owner message: the stream asks for a re-read.
        let started = event(#"{"seq":7,"epoch":"\#(epoch)","chatId":"c","turnId":"t2","type":"turn.started","origin":"owner","clientId":"c1","retry":true}"#)
        #expect(projection.apply(started) == .resync)
        // The engine's rows no longer hold the abandoned branch; the bubble is bound by clientId.
        let retryPage = #"{"rows":[{"rowId":"t2:u","kind":"user","turnId":"t2","text":"Draw it","clientId":"c1"}],"tailSeq":7,"epoch":"\#(epoch)","running":{"turnId":"t2","partialText":""}}"#
        projection.load(try JSONDecoder().decode(RowsPage.self, from: Data(retryPage.utf8)))
        #expect(projection.rows.map(\.rowId) == ["t2:u"])
        #expect(projection.rows.first?.clientId == "c1")
        #expect(projection.pending)
        #expect(projection.retryableFailureRowId == nil)
    }

    @Test func anAttemptPiRetriedLosesItsBubbleAndTheAnswerStreamsUnderTheNextRow() {
        var projection = empty(tailSeq: 0)
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner","clientId":"c1"}"#))
        projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.delta","rowId":"t1:a0","delta":"Here is the pl"}"#))
        #expect(projection.rows.contains { $0.rowId == "t1:a0" })
        // The stream dropped and Pi retried the attempt: the engine says the cut bubble goes.
        projection.apply(event(#"{"seq":3,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"row.removed","rowId":"t1:a0"}"#))
        #expect(!projection.rows.contains { $0.rowId == "t1:a0" })
        projection.apply(event(#"{"seq":4,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.final","rowId":"t1:a1","text":"Here is the plan."}"#))
        #expect(projection.rows.filter { $0.kind == .assistant }.map(\.text) == ["Here is the plan."])
    }

    @Test(.enabled(if: ChatFixtures.available)) func messagesSentDuringATurnQueueAndACancelHandsThemBackUnsent() throws {
        var projection = empty(tailSeq: 40)
        var queuedMidTurn: [TranscriptRow] = []
        for line in try ChatFixtures.events("events-queue.ndjson") {
            projection.apply(line)
            if line.seq == 45 {
                // Two queued behind the running first turn.
                queuedMidTurn = projection.transcript().filter(\.queued)
                #expect(projection.transcript().map(\.id).suffix(2).allSatisfy { $0.hasPrefix("local-") })
            }
        }
        #expect(queuedMidTurn.map(\.text) == ["Make it shorter", "and email it to me"])
        // The second ran as its own turn; the third came back as an unsent bubble with its line.
        let ids = projection.transcript().map(\.id)
        #expect(ids.contains("unsent-c1c1c1c1-0000-4000-8000-0000000000c3"))
        #expect(ids.contains("unsent-line-c1c1c1c1-0000-4000-8000-0000000000c3"))
        #expect(projection.pendingSends.isEmpty)
        #expect(!projection.pending)
        #expect(projection.rows.filter { $0.kind == .user }.map(\.text) == ["Write a long plan", "Make it shorter"])
        let line = try #require(projection.transcript().first { $0.kind == .unsent })
        #expect(line.text == "Not sent. The turn before it was stopped.")
    }

    @Test(.enabled(if: ChatFixtures.available)) func compactionShowsAsAQuietNoteAndTheLabelComesBack() throws {
        var projection = empty(tailSeq: 60)
        var labels: [TurnActivity] = []
        for line in try ChatFixtures.events("events-compaction.ndjson") {
            projection.apply(line)
            if projection.pending, labels.last != projection.activity { labels.append(projection.activity) }
        }
        #expect(labels.contains(.compacting))
        let note = try #require(projection.transcript().first { $0.kind == .note })
        #expect(note.text == "Conversation compacted to fit the model's window")
        #expect(projection.rows.last?.text == "Continuing.")
    }

    @Test(.enabled(if: ChatFixtures.available)) func aRoutineTurnHasNoOwnerBubble() throws {
        var projection = empty()
        for line in try ChatFixtures.events("events-routine.ndjson") { projection.apply(line) }
        #expect(projection.rows.map(\.kind) == [.note, .assistant])
        #expect(projection.rows[0].text == "Routine Morning summary ran.")
        #expect(!projection.pending)
    }

    @Test(.enabled(if: ChatFixtures.available)) func aReconnectBehindTheBufferAsksForTheRowsAgain() throws {
        var projection = ChatProjection()
        projection.load(try ChatFixtures.decode(RowsPage.self, "rows-page.json"))
        #expect(projection.tailSeq == 57)
        let events = try ChatFixtures.events("events-resync.ndjson")
        // stream.ready says resync: read the rows again.
        #expect(projection.apply(events[0]) == .resync)
        // An event far past the tail is a gap, never applied.
        #expect(projection.apply(events[1]) == .gap)
        #expect(projection.tailSeq == 57)
    }

    @Test(.enabled(if: ChatFixtures.available)) func theNewestPageRestoresTheRunningTurnAndItsQueue() throws {
        var projection = ChatProjection()
        projection.load(try ChatFixtures.decode(RowsPage.self, "rows-page.json"))
        #expect(projection.pending)
        #expect(projection.turnId == "7a1e0001-0000-4000-8000-00000000a003")
        #expect(projection.activity == .tool("web_search", detail: "Searching the web"))
        // The partial reply is already a row; it keeps growing from its id.
        #expect(projection.rows.contains { $0.rowId == "7a1e0001-0000-4000-8000-00000000a003:a0" })
        // The queued message is one bubble, with its tag, not two.
        let queued = projection.transcript().filter(\.queued)
        #expect(queued.map(\.text) == ["Then list three next steps"])
        #expect(projection.pendingSends.isEmpty)
        // The newest turn's web results are the chips; the question is closed.
        #expect(projection.openQuestion == nil)
        #expect(projection.nextBefore == "compaction:e-0042")
    }

    @Test func aLaterStreamingMessageKeepsItsPartialTextOnAReload() throws {
        let json = #"{"rows":[{"rowId":"t1:u","kind":"user","turnId":"t1","text":"Hi"},{"rowId":"t1:a0","kind":"assistant","turnId":"t1","text":"First."}],"tailSeq":9,"epoch":"\#(epoch)","running":{"turnId":"t1","partialText":"Second so far","rowId":"t1:a1"}}"#
        var projection = ChatProjection()
        projection.load(try JSONDecoder().decode(RowsPage.self, from: Data(json.utf8)))
        #expect(projection.rows.map(\.rowId) == ["t1:u", "t1:a0", "t1:a1"])
        #expect(projection.rows.last?.text == "Second so far")
    }

    @Test func aSettleTheStreamNeverDeliveredShowsAsAGap() {
        var projection = empty(tailSeq: 5)
        #expect(projection.apply(event(#"{"seq":9,"epoch":"\#(epoch)","chatId":"c","type":"ping"}"#)) == .gap)
        #expect(projection.apply(event(#"{"seq":5,"epoch":"\#(epoch)","chatId":"c","type":"ping"}"#)) == .ignored)
        #expect(projection.apply(event(#"{"epoch":"\#(epoch)","chatId":"c","type":"stream.ready","tailSeq":8,"resync":false}"#)) == .gap)
        #expect(projection.apply(event(#"{"epoch":"\#(epoch)","chatId":"c","type":"stream.ready","tailSeq":5,"resync":false}"#)) == .applied)
    }

    @Test func aDequeuedMessageMovesBelowTheRowsTheTurnAdded() throws {
        let json = #"{"rows":[{"rowId":"t1:u","kind":"user","turnId":"t1","text":"One","clientId":"c1"},{"rowId":"t1:a0","kind":"assistant","turnId":"t1","text":"Partial"},{"rowId":"q:c2","kind":"user","text":"Two","clientId":"c2","queued":true}],"tailSeq":9,"epoch":"\#(epoch)","running":{"turnId":"t1","partialText":""}}"#
        var projection = ChatProjection()
        projection.load(try JSONDecoder().decode(RowsPage.self, from: Data(json.utf8)))
        projection.apply(event(#"{"seq":10,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.final","rowId":"t1:a1","text":"Later"}"#))
        projection.apply(event(#"{"seq":11,"epoch":"\#(epoch)","chatId":"c","turnId":"t2","type":"message.user","rowId":"t2:u","clientId":"c2","text":"Two","attachments":[]}"#))
        #expect(projection.rows.last?.rowId == "t2:u")
        #expect(projection.rows.last?.queued == false)
    }

    @Test func aSettledTurnForgetsItsStart() {
        var projection = empty()
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner","at":"2026-10-25T10:00:00Z"}"#))
        #expect(projection.turnStartedAt != nil)
        projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.completed"}"#))
        #expect(projection.turnStartedAt == nil)
    }

    @Test func aResumedStreamReadyIsNotAGap() {
        var projection = empty(tailSeq: 5)
        let ready = event(#"{"epoch":"\#(epoch)","chatId":"c","type":"stream.ready","tailSeq":8,"resync":false}"#)
        #expect(projection.apply(ready, resumed: true) == .applied)
        #expect(projection.apply(ready) == .gap)
    }

    // MARK: Sending

    @Test func aSentMessageShowsAtOnceAndTheEnginesRowTakesItOver() {
        var projection = empty()
        projection.addPending(.init(clientId: "c1", text: "Hello"))
        #expect(projection.transcript().map(\.id) == ["local-c1"])
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner","clientId":"c1"}"#))
        projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.user","rowId":"t1:u","clientId":"c1","text":"Hello","attachments":[]}"#))
        #expect(projection.transcript().map(\.id) == ["t1:u"])
        #expect(projection.pending)
        // A repeated event is passed over.
        #expect(projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.user","rowId":"t1:u","clientId":"c1","text":"Hello","attachments":[]}"#)) == .ignored)
        #expect(projection.transcript().count == 1)
    }

    @Test func aQueuedBubbleSitsAfterTheRunningTurnsRows() {
        var projection = empty()
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner","clientId":"c1"}"#))
        projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.user","rowId":"t1:u","clientId":"c1","text":"Plan","attachments":[]}"#))
        projection.addPending(.init(clientId: "c2", text: "Shorter"))
        projection.markQueued(clientId: "c2")
        // The reply starts after the second message was queued.
        projection.apply(event(#"{"seq":3,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.delta","rowId":"t1:a0","delta":"Step one"}"#))
        let rows = projection.transcript()
        #expect(rows.map(\.text) == ["Plan", "Step one", "Shorter"])
        #expect(rows.map(\.queued) == [false, false, true])
    }

    @Test func aRefusedSendLeavesNoBubbleBehind() {
        var projection = empty()
        projection.addPending(.init(clientId: "c1", text: "Hello"))
        projection.removePending(clientId: "c1")
        #expect(projection.transcript().isEmpty)
    }

    @Test func eventsOfAnotherEpochOrBeforeTheRowsAreNotApplied() {
        var projection = ChatProjection()
        // Nothing loaded yet: events wait for the rows page.
        #expect(projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","type":"turn.started","turnId":"t","origin":"owner"}"#)) == .ignored)
        projection.load(RowsPage(rows: [], tailSeq: 5, epoch: epoch))
        // At or behind the page's tail: already in the rows.
        #expect(projection.apply(event(#"{"seq":5,"epoch":"\#(epoch)","chatId":"c","type":"turn.started","turnId":"t","origin":"owner"}"#)) == .ignored)
        #expect(!projection.pending)
        // The engine restarted: its sequence means nothing here.
        #expect(projection.apply(event(#"{"seq":1,"epoch":"other","chatId":"c","type":"turn.started","turnId":"t","origin":"owner"}"#)) == .resync)
        #expect(projection.apply(event(#"{"seq":6,"epoch":"\#(epoch)","chatId":"c","type":"turn.started","turnId":"t","origin":"owner"}"#)) == .applied)
        #expect(projection.pending)
    }

    @Test func aTurnThatFailsLeavesAFailureRowEvenWithoutARowEvent() {
        var projection = empty()
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.started","origin":"owner"}"#))
        projection.apply(event(#"{"seq":2,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"turn.failed","code":"circuit_open","detail":"","retryAfterMs":21500,"messageKept":true,"rowId":"t1:f"}"#))
        let failure = projection.rows.first
        #expect(failure?.kind == .failure && failure?.rowId == "t1:f")
        #expect(failure?.failure.coolDownSeconds == 22)
        #expect(!projection.pending)
    }

    @Test func olderRowsGoInFrontWithoutRepeating() {
        var projection = ChatProjection()
        var newest = ChatRow(rowId: "b", kind: .assistant, text: "b")
        newest.at = "2026-10-25T12:00:02.000Z"
        projection.load(RowsPage(rows: [newest], tailSeq: 1, epoch: epoch, nextBefore: "a"))
        #expect(projection.nextBefore == "a")
        projection.prepend(RowsPage(rows: [ChatRow(rowId: "a", kind: .assistant, text: "a"), newest], nextBefore: nil))
        #expect(projection.rows.map(\.rowId) == ["a", "b"])
        #expect(projection.nextBefore == nil)
        #expect(projection.contains(rowId: "a"))
    }

    @Test func blankAssistantTextDrawsNothing() {
        var projection = empty()
        projection.apply(event(#"{"seq":1,"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"message.final","rowId":"t1:a0","text":" \n​"}"#))
        #expect(projection.transcript().isEmpty)
    }
}

@Suite struct WorkingMarkPhaseTests {
    /// The working row's mark: three dots while the bot works, the four-dot
    /// figure for a shell command, nothing once the turn is over.
    private func phase(_ projection: ChatProjection) -> AgentMarkPhase {
        guard projection.pending else { return .done }
        return projection.activity.runsCommand ? .command : .thinking
    }

    @Test(.enabled(if: ChatFixtures.available)) func theTurnFixtureDrivesThinkingThenDone() throws {
        var projection = empty()
        var phases: [AgentMarkPhase] = []
        var started = false
        for line in try ChatFixtures.events("events-turn.ndjson") {
            projection.apply(line)
            if projection.pending { started = true }
            guard started else { continue }
            let next = phase(projection)
            if phases.last != next { phases.append(next) }
            // The first turn ends on its question; stop before the second begins.
            if line.type == "turn.completed" { break }
        }
        // No shell command ran, so the mark never leaves the three-dot loop.
        #expect(phases == [.thinking, .done])
    }

    @Test func eachShellCommandIsItsOwnBurstAndOneCommandIsOne() {
        var projection = empty()
        var steps: [(command: Bool, call: String?)] = []
        func feed(_ seq: Int, _ body: String) {
            projection.apply(event(#"{"seq":\#(seq),"epoch":"\#(epoch)","chatId":"c","turnId":"t1",\#(body)}"#))
            steps.append((projection.activity.runsCommand, projection.activityCall))
        }
        feed(1, #""type":"turn.started","origin":"owner""#)
        feed(2, #""type":"activity","kind":"tool","tool":"web_search","detail":"Searching the web""#)
        feed(3, #""type":"tool.call","callId":"c1","name":"web_search""#)
        feed(4, #""type":"tool.result","callId":"c1","name":"web_search","isError":false"#)
        // The first command: the activity arrives, then its call.
        feed(5, #""type":"activity","kind":"tool","tool":"bash","detail":"Running a command""#)
        feed(6, #""type":"tool.call","callId":"c2","name":"bash""#)
        feed(7, #""type":"tool.result","callId":"c2","name":"bash","isError":false"#)
        // The second command, with the same label.
        feed(8, #""type":"activity","kind":"tool","tool":"bash","detail":"Running a command""#)
        feed(9, #""type":"tool.call","callId":"c3","name":"bash""#)

        // What the working row does with them (WorkingRow and AgentMark).
        var sequencer = AgentMarkSequencer(start: 0)
        var bursts = 0
        var now = 10.0
        for (index, step) in steps.enumerated() {
            if step.command, sequencer.phase != .command {
                sequencer.set(.command, at: now)
                bursts += 1
            } else if !step.command, sequencer.phase == .command {
                sequencer.set(.thinking, at: now)
            } else if step.command, index > 0,
                      AgentMarkSequencer.isNewCommandStep(from: steps[index - 1].call, to: step.call) {
                sequencer.set(.command, at: now, restart: true)
                bursts += 1
            }
            // Far enough apart that the command figure's dwell has run out.
            now += 2
        }
        #expect(steps.compactMap { $0.command ? $0.call : nil } == ["c2", "c3"])
        // One burst for each command; a call id arriving for a step already
        // showing is the same step, not a second burst.
        #expect(bursts == 2)
    }

    @Test func aSecondCommandRightAfterTheFirstIsANewStep() {
        var projection = empty()
        func feed(_ seq: Int, _ body: String) {
            projection.apply(event(#"{"seq":\#(seq),"epoch":"\#(epoch)","chatId":"c","turnId":"t1",\#(body)}"#))
        }
        feed(1, #""type":"turn.started","origin":"owner""#)
        feed(2, #""type":"activity","kind":"tool","tool":"bash","detail":"Running a command""#)
        feed(3, #""type":"tool.call","callId":"c2","name":"bash""#)
        let first = projection.activityCall
        // No result between: the next command's call replaces the id.
        feed(4, #""type":"activity","kind":"tool","tool":"bash","detail":"Running a command""#)
        feed(5, #""type":"tool.call","callId":"c3","name":"bash""#)
        #expect(AgentMarkSequencer.isNewCommandStep(from: first, to: projection.activityCall))
        // Text arriving ends the step.
        feed(6, #""type":"message.delta","rowId":"t1:a0","delta":"Done""#)
        #expect(projection.activity == .working)
        #expect(projection.activityCall == nil)
    }
}

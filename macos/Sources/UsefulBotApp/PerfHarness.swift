import AppKit
import Foundation
import UsefulBotCore

/// The performance regression guard's hooks (see `perf/README.md`).
///
/// Off unless the app is launched with `-UsefulBotPerfRun <scenario.json>`.
/// Then it writes timed marks to the scenario's result file and runs its
/// steps itself: open a fixture chat, wait for it to land, pause, send a
/// fixture turn, quit. Driving the app from inside keeps accessibility off
/// (an AX click switches on SwiftUI's accessibility tree, which inflates the
/// very row builds being timed) and has no input-queue delay to subtract.
///
/// Times are `CLOCK_UPTIME_RAW` nanoseconds: the clock the runner and the
/// frame recorder read too, so all three line up without conversion.
///
/// It only ever opens or sends to chats whose title starts with "Perf ": the
/// owner's chats hold real conversations. The one exception is `restore`,
/// which puts back the chat the owner had open before the run. The fixture
/// chats are listed by the engine only for the dev stack (`includeFixtures`).
@MainActor
final class PerfHarness {
    static let shared: PerfHarness? = PerfHarness.fromArguments()
    static let fixturePrefix = "Perf "

    struct Scenario: Decodable {
        let runId: String
        let resultFile: String
        /// The chat the owner had open before the run, for `restore`.
        let restoreChatId: String?
        let steps: [Step]
    }

    struct Step: Decodable {
        /// select | pause | send | post | stop | deny | restore | quit
        let op: String
        /// The fixture chat's title ("Perf Long Replies").
        let bot: String?
        let label: String?
        let ms: Int?
        let text: String?
    }

    private struct Landing {
        let chatKey: String
        let t: UInt64
    }

    private let scenario: Scenario
    private let output: FileHandle
    private var landings: [Landing] = []
    private var landingWaiters: [(chatKey: String, after: UInt64, resume: CheckedContinuation<Bool, Never>)] = []
    private var started = false
    private var aborted = false
    /// The responsiveness probe of the latest landing. A select waits it out,
    /// so the next step's work is never counted as this landing's stall.
    private var lastProbe: Task<Void, Never>?
    /// App Nap throttles a background app's timers, and the runner launches
    /// the app with `open -g` so the owner's focus is never taken. An app in
    /// front is never napped, so this keeps the numbers to what the owner sees.
    private let activity: NSObjectProtocol

    nonisolated static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

    /// A step's milliseconds as nanoseconds, clamped to 0...1 h so a malformed
    /// scenario cannot trap on a negative or overflowing value.
    static func nanos(_ ms: Int) -> UInt64 { UInt64(min(max(ms, 0), 3_600_000)) * 1_000_000 }

    private static func fromArguments() -> PerfHarness? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "-UsefulBotPerfRun"), flag + 1 < args.count else { return nil }
        let path = args[flag + 1]
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let scenario = try JSONDecoder().decode(Scenario.self, from: data)
            let url = URL(fileURLWithPath: scenario.resultFile)
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: url)
            handle.seekToEndOfFile()
            return PerfHarness(scenario: scenario, output: handle)
        } catch {
            // Fail loud: a perf run that cannot record must not look like a
            // clean launch to the runner, which waits for marks that never come.
            NSLog("[perf] scenario \(path) could not be loaded: \(error)")
            return nil
        }
    }

    private init(scenario: Scenario, output: FileHandle) {
        self.scenario = scenario
        self.output = output
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical],
            reason: "Performance regression run"
        )
        mark("app_init", ["pid": Int(ProcessInfo.processInfo.processIdentifier)])
    }

    func mark(_ event: String, _ fields: [String: Any] = [:], at t: UInt64 = PerfHarness.now()) {
        var line = fields
        line["t"] = t
        line["ev"] = event
        line["run"] = scenario.runId
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else {
            NSLog("[perf] mark \(event) could not be encoded")
            return
        }
        output.write(data)
        output.write(Data([0x0A]))
    }

    /// Called by ChatView when a chat has landed (its rows are shown).
    func landed(chatKey: String, reason: String, stats: [String: Any]) {
        let t = Self.now()
        var fields = stats
        fields["chat"] = chatKey
        fields["reason"] = reason
        mark("landed", fields, at: t)
        landings.append(Landing(chatKey: chatKey, t: t))
        let ready = landingWaiters.filter { $0.chatKey == chatKey && $0.after <= t }
        landingWaiters.removeAll { $0.chatKey == chatKey && $0.after <= t }
        for waiter in ready { waiter.resume.resume(returning: true) }
        probeResponsiveness(chatKey: chatKey, landedAt: t)
    }

    /// Deferred row building can freeze a picture that no longer changes, so
    /// the main thread is sampled for a second after each landing.
    private func probeResponsiveness(chatKey: String, landedAt: UInt64) {
        lastProbe = Task { @MainActor [weak self] in
            var worst: UInt64 = 0
            for _ in 0..<60 {
                let before = Self.now()
                try? await Task.sleep(nanoseconds: 16_000_000)
                let took = Self.now() - before
                if took > 16_000_000 { worst = max(worst, took - 16_000_000) }
            }
            self?.mark("responsive", ["chat": chatKey, "landedAt": landedAt, "stallMaxMs": Double(worst) / 1_000_000])
        }
    }

    private func waitLanded(chatKey: String, after: UInt64, timeoutMs: Int) async -> Bool {
        if landings.contains(where: { $0.chatKey == chatKey && $0.t >= after }) { return true }
        return await withCheckedContinuation { resume in
            landingWaiters.append((chatKey, after, resume))
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: Self.nanos(timeoutMs))
                guard let self, let index = self.landingWaiters.firstIndex(where: {
                    $0.chatKey == chatKey && $0.after == after
                }) else { return }
                self.landingWaiters.remove(at: index).resume.resume(returning: false)
            }
        }
    }

    /// Runs the scenario once the app is ready. Every failure is written as a
    /// mark and ends the run, so the runner fails the case instead of timing
    /// something the scenario did not ask for.
    func run(model: AppModel) {
        guard !started else { return }
        started = true
        Task { @MainActor in
            await self.execute(model: model)
            // A run that stopped early still gives the owner their chat back.
            if self.aborted, let id = self.scenario.restoreChatId, model.currentChatId != id {
                model.openChat(id)
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                self.mark("restored", ["chat": id])
            }
        }
    }

    private func execute(model: AppModel) async {
        mark("ready", ["chat": model.currentChatId ?? ""])
        if let first = model.currentChatId,
           !(await waitLanded(chatKey: first, after: 0, timeoutMs: 30_000)) {
            return abort("the first chat never landed")
        }
        // The first landing's stall probe is waited out like any select's, so
        // step 1's work is never counted as the launch's stall.
        await lastProbe?.value
        // The fixture chat the steps work in, by id.
        var openChatId: String? = model.currentChatId
        for (index, step) in scenario.steps.enumerated() {
            let label = step.label ?? step.op
            switch step.op {
            case "deny":
                // Approvals are not tied to a chat here, so only cards whose
                // preview starts with one of the fixture's own commands (one
                // per line of `text`) are touched. Ends once none has shown
                // for 20 s.
                guard let text = step.text, !text.isEmpty else { return abort("step \(index): deny has no text") }
                let commands = text.split(separator: "\n").map(String.init)
                var quietSince = Date()
                var requested: Set<String> = []
                let deadline = Date().addingTimeInterval(300)
                while Date().timeIntervalSince(quietSince) < 20, Date() < deadline {
                    if let item = model.approvals.first(where: { card in
                        !requested.contains(card.id) && commands.contains { card.preview.hasPrefix($0) }
                    }), !model.busyApprovals.contains(item.id) {
                        requested.insert(item.id)
                        model.decideApproval(item, decision: .deny)
                        mark("deny_requested", ["preview": item.preview])
                        quietSince = Date()
                    }
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            case "pause":
                try? await Task.sleep(nanoseconds: Self.nanos(step.ms ?? 1000))
            case "select", "send", "post", "stop":
                guard let name = step.bot, name.hasPrefix(Self.fixturePrefix) else {
                    return abort("step \(index): \(step.bot ?? "no chat") is not a Perf chat")
                }
                let alreadyOpen = model.currentChatId != nil && model.chatTitle(model.currentChatId) == name
                if step.op == "select" || !alreadyOpen {
                    guard !alreadyOpen else {
                        return abort("step \(index): \(name) is already open, a select would be a no-op")
                    }
                    let t = Self.now()
                    mark("step", ["label": label, "name": name, "index": index], at: t)
                    guard let id = await model.openFixtureChat(title: name) else {
                        return abort("step \(index): \(name) is not a chat of this stack")
                    }
                    openChatId = id
                    guard await waitLanded(chatKey: id, after: t, timeoutMs: step.ms ?? 30_000) else {
                        return abort("step \(index): \(name) never landed")
                    }
                    await lastProbe?.value
                }
                if step.op == "post" {
                    // A send that is not waited out, for checking a turn while
                    // it runs (an approval card, a step row).
                    guard let text = step.text, !text.isEmpty, model.currentChatId == openChatId, !model.pending else {
                        return abort("step \(index): post needs text, the open Perf chat and no turn running")
                    }
                    model.send(text)
                    guard model.pending else { return abort("step \(index): the post was refused") }
                    mark("post", ["index": index])
                }
                if step.op == "stop" {
                    guard model.currentChatId == openChatId else { return abort("step \(index): stop needs the open Perf chat") }
                    let running = model.pending
                    model.cancel()
                    mark("stop", ["index": index, "turnWasRunning": running, "cardsBefore": model.approvals.count])
                }
                if step.op == "send" {
                    guard let text = step.text, !text.isEmpty else { return abort("step \(index): send has no text") }
                    guard await sendAndWait(model: model, chatId: openChatId, text: text, index: index) else { return }
                }
            case "restore":
                guard let id = scenario.restoreChatId else {
                    mark("restore_skipped")
                    continue
                }
                if model.currentChatId != id { model.openChat(id) }
                mark("restored", ["chat": id])
            case "quit":
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                mark("quit")
                try? output.synchronize()
                NSApplication.shared.terminate(nil)
                return
            default:
                return abort("step \(index): unknown op \(step.op)")
            }
        }
        mark("done")
    }

    /// A fixture turn: sent, then waited out until the bot is idle again.
    private func sendAndWait(model: AppModel, chatId: String?, text: String, index: Int) async -> Bool {
        // `send` goes to whatever chat is open when it runs. A chat opened from
        // elsewhere since the step began would post fixture text into a real
        // conversation, and a turn already running would be measured as this
        // one.
        guard let chatId, model.currentChatId == chatId,
              model.chatTitle(chatId)?.hasPrefix(Self.fixturePrefix) == true else {
            abort("step \(index): the open chat is no longer the Perf chat")
            return false
        }
        guard !model.pending else {
            abort("step \(index): a turn is already running in this chat")
            return false
        }
        let t = Self.now()
        mark("send", ["index": index, "chars": text.count,
                      "modelId": model.composer?.modelId ?? "", "modelLabel": model.composer?.modelLabel ?? ""], at: t)
        model.send(text)
        // Long answers at high effort run several minutes; a turn stuck on an
        // approval card would wait forever, and fixtures never need one.
        let deadline = Date().addingTimeInterval(720)
        // The send is committed synchronously when it is accepted.
        guard model.pending else {
            abort("step \(index): the send was refused")
            return false
        }
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if !model.pending {
                if let error = model.threadError {
                    abort("step \(index): the turn failed: \(error)")
                    return false
                }
                let done = Self.now()
                mark("send_done", ["index": index, "stats": model.perfStats,
                                   "seconds": Double(done - t) / 1_000_000_000], at: done)
                return true
            }
        }
        abort("step \(index): the turn did not finish in 12 minutes (an approval card?)")
        return false
    }

    private func abort(_ why: String) {
        aborted = true
        NSLog("[perf] aborted: \(why)")
        mark("abort", ["why": why])
        try? output.synchronize()
    }
}

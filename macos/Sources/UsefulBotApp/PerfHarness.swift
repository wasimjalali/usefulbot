import AppKit
import Foundation
import UsefulBotCore

/// The performance regression guard's hooks (see `perf/README.md`).
///
/// Off unless the app is launched with `-UsefulBotPerfRun <scenario.json>`.
/// Then it writes timed marks to the scenario's result file and runs its
/// steps itself: select a bot, wait for its chat to land, pause, send a
/// fixture turn, quit. Driving the app from inside keeps accessibility off
/// (an AX click switches on SwiftUI's accessibility tree, which inflates the
/// very row builds being timed) and has no input-queue delay to subtract.
///
/// Times are `CLOCK_UPTIME_RAW` nanoseconds: the clock the runner and the
/// frame recorder read too, so all three line up without conversion.
///
/// It only ever selects or sends to bots whose name starts with "Perf ": the
/// owner's bots hold real conversations. The one exception is `restore`,
/// which puts back the bot the owner had open before the run.
@MainActor
final class PerfHarness {
    static let shared: PerfHarness? = PerfHarness.fromArguments()
    static let fixturePrefix = "Perf "

    struct Scenario: Decodable {
        let runId: String
        let resultFile: String
        /// Bot ids whose disk snapshot is removed at launch, for the case
        /// that measures a first open with no snapshot to start from.
        let dropSnapshots: [String]?
        /// The owner's selection before the run, for `restore`.
        let restoreBotId: String?
        let steps: [Step]
    }

    struct Step: Decodable {
        /// create | select | pause | send | post | stop | deny | wait_prewarm | restore | quit
        let op: String
        let bot: String?
        let label: String?
        let ms: Int?
        let text: String?
    }

    private struct Landing {
        let botId: String
        let t: UInt64
    }

    private let scenario: Scenario
    private let output: FileHandle
    private var landings: [Landing] = []
    private var landingWaiters: [(botId: String, after: UInt64, resume: CheckedContinuation<Bool, Never>)] = []
    private var started = false
    private var prewarmEnded = false
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
        if event == "prewarm_end" { prewarmEnded = true }
    }

    /// Snapshot files to remove before the first restore reads them. The store
    /// is not loaded yet, so these ids cannot be checked against "Perf " names
    /// here: the runner only ever passes fixture ids. The files are a cache.
    var snapshotsToDrop: [String] { scenario.dropSnapshots ?? [] }

    /// Called by ChatView when a chat has landed (its rows are shown).
    func landed(botId: String, reason: String, stats: [String: Any]) {
        let t = Self.now()
        var fields = stats
        fields["bot"] = botId
        fields["reason"] = reason
        mark("landed", fields, at: t)
        landings.append(Landing(botId: botId, t: t))
        let ready = landingWaiters.filter { $0.botId == botId && $0.after <= t }
        landingWaiters.removeAll { $0.botId == botId && $0.after <= t }
        for waiter in ready { waiter.resume.resume(returning: true) }
        probeResponsiveness(botId: botId, landedAt: t)
    }

    /// Deferred row building can freeze a picture that no longer changes, so
    /// the main thread is sampled for a second after each landing.
    private func probeResponsiveness(botId: String, landedAt: UInt64) {
        lastProbe = Task { @MainActor [weak self] in
            var worst: UInt64 = 0
            for _ in 0..<60 {
                let before = Self.now()
                try? await Task.sleep(nanoseconds: 16_000_000)
                let took = Self.now() - before
                if took > 16_000_000 { worst = max(worst, took - 16_000_000) }
            }
            self?.mark("responsive", ["bot": botId, "landedAt": landedAt, "stallMaxMs": Double(worst) / 1_000_000])
        }
    }

    private func waitLanded(botId: String, after: UInt64, timeoutMs: Int) async -> Bool {
        if landings.contains(where: { $0.botId == botId && $0.t >= after }) { return true }
        return await withCheckedContinuation { resume in
            landingWaiters.append((botId, after, resume))
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: Self.nanos(timeoutMs))
                guard let self, let index = self.landingWaiters.firstIndex(where: {
                    $0.botId == botId && $0.after == after
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
            if self.aborted, let id = self.scenario.restoreBotId, model.selectedBotId != id,
               model.store?.bots.contains(where: { $0.id == id }) == true {
                model.select(id)
                // The selection is saved through a queued write; the runner
                // quits the app once it reads the abort.
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                self.mark("restored", ["bot": id])
            }
        }
    }

    private func execute(model: AppModel) async {
        mark("ready", ["bot": model.selectedBotId ?? ""])
        if let first = model.selectedBotId,
           !(await waitLanded(botId: first, after: 0, timeoutMs: 30_000)) {
            return abort("the first chat never landed")
        }
        // The first landing's stall probe is waited out like any select's, so
        // step 1's work is never counted as the launch's stall.
        await lastProbe?.value
        for (index, step) in scenario.steps.enumerated() {
            let label = step.label ?? step.op
            switch step.op {
            case "create":
                guard let name = step.bot, name.hasPrefix(Self.fixturePrefix) else {
                    return abort("step \(index): only Perf bots may be created")
                }
                if model.store?.bots.contains(where: { $0.name == name }) == true {
                    mark("create_skipped", ["name": name])
                    continue
                }
                model.createBot(name: name, petname: name, label: "",
                                description: "Performance fixture. Keep it frozen.", sectionId: nil)
                var made = false
                for _ in 0..<100 where !made {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    made = model.store?.bots.contains(where: { $0.name == name }) == true
                }
                guard made else { return abort("step \(index): \(name) was not created") }
                mark("created", ["name": name])
            case "deny":
                // Approvals are not tied to a bot here, so only cards whose
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
            case "wait_prewarm":
                // The prewarm snapshots every chat after a new build; a
                // measured launch must not share the machine with it.
                let deadline = Date().addingTimeInterval(Double(Self.nanos(step.ms ?? 180_000)) / 1_000_000_000)
                while !prewarmEnded, Date() < deadline {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
                guard prewarmEnded else { return abort("step \(index): the prewarm did not finish") }
            case "pause":
                try? await Task.sleep(nanoseconds: Self.nanos(step.ms ?? 1000))
            case "select", "send", "post", "stop":
                guard let name = step.bot, name.hasPrefix(Self.fixturePrefix),
                      let bot = model.store?.bots.first(where: { $0.name == name }) else {
                    return abort("step \(index): \(step.bot ?? "no bot") is not a Perf bot here")
                }
                if step.op == "select" || model.selectedBotId != bot.id {
                    guard model.selectedBotId != bot.id else {
                        return abort("step \(index): \(name) is already open, a select would be a no-op")
                    }
                    let t = Self.now()
                    mark("step", ["label": label, "bot": bot.id, "name": name, "index": index], at: t)
                    model.select(bot.id)
                    guard await waitLanded(botId: bot.id, after: t, timeoutMs: step.ms ?? 30_000) else {
                        return abort("step \(index): \(name) never landed")
                    }
                    await lastProbe?.value
                }
                if step.op == "post" {
                    // A send that is not waited out, for checking a turn while
                    // it runs (an approval card, a step row).
                    guard let text = step.text, !text.isEmpty, model.selectedBotId == bot.id,
                          model.store?.bots.first(where: { $0.id == bot.id })?.name.hasPrefix(Self.fixturePrefix) == true,
                          !model.pending, !model.backgroundWorking else {
                        return abort("step \(index): post needs text, the open Perf bot and no turn running")
                    }
                    model.send(text)
                    guard model.pending else { return abort("step \(index): the post was refused") }
                    mark("post", ["index": index])
                }
                if step.op == "stop" {
                    guard model.selectedBotId == bot.id else { return abort("step \(index): stop needs the open Perf bot") }
                    let running = model.pending || model.backgroundWorking
                    model.cancel()
                    mark("stop", ["index": index, "turnWasRunning": running, "cardsBefore": model.approvals.count])
                }
                if step.op == "send" {
                    guard let text = step.text, !text.isEmpty else { return abort("step \(index): send has no text") }
                    guard await sendAndWait(model: model, botId: bot.id, text: text, index: index) else { return }
                }
            case "restore":
                guard let id = scenario.restoreBotId, model.store?.bots.contains(where: { $0.id == id }) == true else {
                    mark("restore_skipped")
                    continue
                }
                if model.selectedBotId != id { model.select(id) }
                mark("restored", ["bot": id])
            case "quit":
                // `select` saves the selection through a queued write; an exit
                // straight after `restore` could drop it.
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
    private func sendAndWait(model: AppModel, botId: String, text: String, index: Int) async -> Bool {
        // `send` goes to whatever chat is open when it runs. A selection echoed
        // from elsewhere since the step began would post fixture text into a
        // real conversation, and a turn already running would be measured as
        // this one.
        guard model.selectedBotId == botId,
              model.store?.bots.first(where: { $0.id == botId })?.name.hasPrefix(Self.fixturePrefix) == true else {
            abort("step \(index): the open chat is no longer the Perf bot")
            return false
        }
        guard !model.pending, !model.backgroundWorking else {
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
            if !model.pending && !model.backgroundWorking {
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

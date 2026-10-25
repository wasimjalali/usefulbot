import Foundation

// The keyframes behind the agent-working mark (the dots that juggle while the
// agent works). Pure numbers, no SwiftUI, so the loop periods and the
// positions can be unit-tested. The shapes and times come from
// ~/.agents/skills/useful-brand/references/agent-working-motion.md (section 4);
// the view that draws them is `AgentMark` in UsefulBotApp.
//
// A dot is `(x, y, d)` in points from the centre of a 24 x 24 box, y down, d
// the diameter. Where two dots share a coordinate they are fused.

public struct MarkDot: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var d: Double

    public init(_ x: Double, _ y: Double, _ d: Double) {
        self.x = x
        self.y = y
        self.d = d
    }
}

/// What the agent is doing, as far as the mark cares.
public enum AgentMarkPhase: Equatable, Sendable {
    /// Thinking, searching, reading, waiting: the three-dot juggle.
    case thinking
    /// A command is running: the four-dot shear.
    case command
    /// The turn ended: the dots shrink away.
    case done
}

public enum AgentMarkFrames {
    // MARK: Periods (seconds)

    public static let arrivalDuration = 0.66
    public static let thinkingPeriod = 4.62
    public static let commandPeriod = 1.26
    /// The burst that opens the four-dot figure, then its loop starts.
    public static let burstDuration = 0.20
    /// A figure folding into one dot before the next one starts.
    public static let collapseDuration = 0.20
    /// What a collapse shrinks to, so there is never an empty frame between
    /// figures: the burst's first dot going to the command figure, the 3.5 pt
    /// dot the fan starts from going back to thinking.
    public static let collapseEndCommand = 7.0
    public static let collapseEndThinking = 3.5
    /// Once the command figure has started, it stays through its burst and one
    /// full shear before it gives way, so fast steps do not flicker.
    public static let commandDwell = burstDuration + commandPeriod
    /// Where the arrival picks up when the three-dot figure comes back after
    /// a command: the one 3.5 pt dot, then the fan.
    public static let fanEntry = 0.48
    public static let completionDuration = 0.05
    /// The loop opens with the fan from one dot and reaches its row here. An
    /// arrival or a return from a command has already fanned, so it joins the
    /// loop at this point.
    public static let thinkingFanEnd = 0.30

    /// Three still dots, for Reduce Motion.
    public static let reducedMotion = [MarkDot(-8, 0, 4.5), MarkDot(0, 0, 3), MarkDot(8, 0, 5.5)]

    // MARK: Figures

    /// The loop for a phase at `t` seconds (any t, it wraps). `done` has no loop.
    public static func dots(at t: Double, phase: AgentMarkPhase) -> [MarkDot] {
        switch phase {
        case .thinking: return thinkingLoop(at: t)
        case .command: return commandLoop(at: t)
        case .done: return []
        }
    }

    /// Every turn's first 0.66 s. After it, the three-dot loop.
    public static func arrival(at t: Double) -> [MarkDot] { arrivalTrack.dots(at: t) }

    public static func thinkingLoop(at t: Double) -> [MarkDot] {
        threeTrack.dots(at: wrap(t, thinkingPeriod))
    }

    public static func commandLoop(at t: Double) -> [MarkDot] {
        fourTrack.dots(at: wrap(t, commandPeriod))
    }

    /// The four-dot figure opening: one dot, a tight cluster, the square.
    public static func burst(at t: Double) -> [MarkDot] { burstTrack.dots(at: t) }

    /// A figure folding away: every dot slides to the centre and fuses at
    /// 8 pt, then shrinks (ease-in) to `endSize`, which is the first dot of
    /// whatever comes next (nothing, by default). Empty once it is done.
    public static func collapse(from snapshot: [MarkDot], at t: Double, endSize: Double = 0) -> [MarkDot] {
        guard !snapshot.isEmpty, t.isFinite, t >= 0, t < collapseDuration else { return [] }
        let converge = collapseDuration * 0.6
        if t < converge {
            let p = Ease.inOut(t / converge)
            return snapshot.map { MarkDot($0.x * (1 - p), $0.y * (1 - p), $0.d + (fuseSize($0.d) - $0.d) * p) }
        }
        let p = Ease.shrink((t - converge) / (collapseDuration - converge))
        return snapshot.map { MarkDot(0, 0, fuseSize($0.d) + (endSize - fuseSize($0.d)) * p) }
    }

    /// What a dot swells to as the figure fuses: up to the spec's 8 pt, but a
    /// dot that is already small (one on its way out) does not balloon.
    static func fuseSize(_ d: Double) -> Double { min(8, d * 1.7) }

    /// The turn ended: shrink to 2 pt and vanish within 50 ms. Nothing is left.
    public static func completion(from snapshot: [MarkDot], at t: Double) -> [MarkDot] {
        guard t.isFinite, t >= 0, t < completionDuration else { return [] }
        let p = Ease.shrink(min(1, t / (completionDuration * 0.8)))
        // Toward 2 pt, never growing a dot that is already smaller.
        return snapshot.map { MarkDot($0.x, $0.y, $0.d + (min($0.d, 2) - $0.d) * p) }
    }

    // MARK: Keyframe tables (spec section 4)

    private static let row = [MarkDot(-8, 0, 4.5), MarkDot(0, 0, 3), MarkDot(8, 0, 5)]
    /// The four-dot square, top-left, top-right, bottom-left, bottom-right.
    private static let square = [MarkDot(-6, -6, 5), MarkDot(6, -6, 5), MarkDot(-6, 6, 5), MarkDot(6, 6, 5)]

    /// 4.1: one dot at full size (no fade, no scale-in), shrinks, blinks out
    /// for a frame, then fans into the row.
    private static let arrivalTrack = MarkTrack([
        MarkKey(0.00, .linear, [MarkDot(0, 0, 9)]),
        MarkKey(0.07, .linear, [MarkDot(0, 0, 9)]),
        MarkKey(0.31, .inOut, [MarkDot(0, 0, 3.5)]),
        MarkKey(0.43, .linear, [MarkDot(0, 0, 3.5)]),
        // Gone for one frame.
        MarkKey(0.44, .easeIn, []),
        MarkKey(0.48, .linear, [MarkDot(0, 0, 3.5)]),
        MarkKey(0.53, .linear, [MarkDot(-2, 0, 3.5), MarkDot(0, 0, 3), MarkDot(2, 0, 4)]),
        // The loop's own row, so the arrival hands over without a size pop.
        MarkKey(0.66, .out, [MarkDot(-8, 0, 4.5), MarkDot(0, 0, 3), MarkDot(8, 0, 5)]),
    ])

    /// 4.2, re-measured from the capture (rec-02, 3.87 s is t = 0). The spec's
    /// table was read off every third frame and disagrees with the frames in
    /// three places, so these keys follow the frames: the loop opens with the
    /// fan from one dot, the fused pair slides before it splits, and the
    /// triangle is three dots circling counter-clockwise on a flat ellipse
    /// (x +-8.4, y -3.7 to +5.8), small at the top and large at the bottom,
    /// that lands with the first dot on the right. Dots 1, 2, 3 keep their
    /// identity throughout, so no dot crosses another except inside a fuse.
    private static let threeTrack = MarkTrack([
        // The loop starts where the arrival and the restart both leave off: a
        // 4.8 pt dot that fans into the row (the capture's 4.65 to 4.92 s).
        MarkKey(0.00, .linear, [MarkDot(0, 0, 4.8)]),
        MarkKey(0.03, .linear, [MarkDot(0, 0, 4.8)]),
        MarkKey(0.30, .out, row),
        MarkKey(0.42, .linear, row),
        // Phrase 1, juggle. Dot 2 runs left into dot 1, and the blob slides right.
        MarkKey(0.63, .inOut, [MarkDot(-5.8, 0, 4.5), MarkDot(-4.8, 0, 4.5), MarkDot(8.3, 0, 4.3)]),
        MarkKey(0.78, .smooth, [MarkDot(-3.4, 0.5, 4.6), MarkDot(-2.4, 0.6, 4.6), MarkDot(7.4, -0.2, 3.5)]),
        // Split: small, big, small.
        MarkKey(0.81, .inOut, [MarkDot(-5.6, -0.2, 3.3), MarkDot(-1.1, 1.0, 5.2), MarkDot(6.8, -0.4, 3.4)]),
        MarkKey(0.88, .smooth, [MarkDot(-6.2, -0.4, 3.2), MarkDot(0.1, 1.3, 5.2), MarkDot(6.4, -0.4, 3.3)]),
        // The big dot runs into the right one and they separate sideways.
        MarkKey(0.95, .smooth, [MarkDot(-7.2, -0.3, 3.4), MarkDot(3.2, 1.2, 5.2), MarkDot(5.2, 0.6, 3.4)]),
        MarkKey(1.00, .smooth, [MarkDot(-7.9, 0.1, 3.7), MarkDot(4.5, 1.3, 5.2), MarkDot(5.0, 1.0, 3.4)]),
        // The rotating triangle.
        MarkKey(1.07, .smooth, [MarkDot(-8.2, 1.2, 4.3), MarkDot(7.6, 2.4, 4.7), MarkDot(1.3, -2.5, 3.1)]),
        MarkKey(1.14, .smooth, [MarkDot(-7.6, 2.8, 4.5), MarkDot(8.3, 1.8, 4.3), MarkDot(-0.5, -3.1, 2.8)]),
        MarkKey(1.21, .smooth, [MarkDot(-6.0, 4.4, 4.7), MarkDot(8.4, 0.8, 3.9), MarkDot(-2.3, -3.7, 3.1)]),
        MarkKey(1.28, .smooth, [MarkDot(-4.4, 5.4, 4.8), MarkDot(8.4, 0.1, 3.8), MarkDot(-3.2, -3.7, 3.2)]),
        MarkKey(1.35, .smooth, [MarkDot(-1.1, 5.6, 5.0), MarkDot(7.2, -1.6, 3.4), MarkDot(-5.5, -2.4, 3.3)]),
        MarkKey(1.42, .smooth, [MarkDot(0.2, 5.1, 5.0), MarkDot(6.6, -1.8, 3.4), MarkDot(-6.3, -1.7, 3.4)]),
        MarkKey(1.49, .smooth, [MarkDot(4.5, 3.3, 5.2), MarkDot(4.1, -1.9, 2.9), MarkDot(-7.8, -0.2, 3.6)]),
        MarkKey(1.55, .smooth, [MarkDot(6.8, 2.0, 4.9), MarkDot(2.3, -1.6, 2.9), MarkDot(-8.3, 0.4, 4.0)]),
        MarkKey(1.62, .smooth, [MarkDot(8.0, 1.1, 4.6), MarkDot(0.4, -1.1, 2.9), MarkDot(-8.1, 0.8, 4.4)]),
        MarkKey(1.69, .smooth, [MarkDot(8.4, 0.4, 4.0), MarkDot(-1.3, -0.8, 2.9), MarkDot(-7.1, 0.8, 4.7)]),
        // Landed: dot 1 right, dot 2 middle, dot 3 left. Dots 2 and 3 meet at once.
        MarkKey(1.73, .smooth, [MarkDot(8.4, 0.2, 3.9), MarkDot(-2.2, -0.6, 2.9), MarkDot(-6.3, 0.8, 5.0)]),
        MarkKey(1.76, .smooth, [MarkDot(8.2, 0.1, 3.8), MarkDot(-4.4, 0.4, 4.6), MarkDot(-5.1, 0.4, 4.6)]),
        MarkKey(1.87, .smooth, [MarkDot(7.1, 0.1, 3.3), MarkDot(-2.4, 0.2, 5.0), MarkDot(-3.0, 0.2, 5.0)]),
        // Swap: dots 2 and 3 trade places through the fuse, then dot 3 runs
        // into dot 1 and they trade the same way.
        MarkKey(1.91, .inOut, [MarkDot(6.6, 0.1, 3.3), MarkDot(-5.9, -0.1, 3.2), MarkDot(-0.4, 0.2, 5.4)]),
        MarkKey(1.97, .smooth, [MarkDot(5.0, 0.1, 3.4), MarkDot(-7.4, 0.1, 3.5), MarkDot(3.0, 0.1, 5.4)]),
        MarkKey(2.08, .smooth, [MarkDot(6.2, 0.1, 3.5), MarkDot(-8.2, 0, 3.9), MarkDot(4.6, 0.1, 5.2)]),
        MarkKey(2.13, .smooth, [MarkDot(6.0, 0, 3.5), MarkDot(-8.3, 0, 4.0), MarkDot(4.8, 0, 5.3)]),
        MarkKey(2.17, .inOut, [MarkDot(1.9, 0.1, 2.8), MarkDot(-8.3, 0, 4.1), MarkDot(7.1, 0, 4.8)]),
        MarkKey(2.24, .inOut, [MarkDot(0.7, 0.1, 2.9), MarkDot(-8.2, 0, 4.4), MarkDot(8.0, 0, 4.6)]),
        MarkKey(2.30, .linear, [MarkDot(0.7, 0.1, 2.9), MarkDot(-8.2, 0, 4.4), MarkDot(8.0, 0, 4.6)]),
        // The gather: all three slide in, fuse at 6.7 pt and shrink away.
        MarkKey(2.41, .inOut, [MarkDot(-1.5, 0.8, 2.8), MarkDot(-5.8, -0.8, 4.3), MarkDot(7.4, -0.2, 3.8)]),
        MarkKey(2.45, .smooth, [MarkDot(-3.4, -0.6, 4.4), MarkDot(-4.4, -0.6, 4.4), MarkDot(6.8, -0.2, 3.5)]),
        MarkKey(2.59, .smooth, [MarkDot(-0.9, -0.6, 4.4), MarkDot(-1.3, -0.6, 4.4), MarkDot(3.1, 0.4, 3.5)]),
        MarkKey(2.62, .inOut, [MarkDot(0.2, -0.1, 6.7)]),
        MarkKey(2.78, .linear, []),
        MarkKey(2.83, .linear, [MarkDot(0, 0, 2.6)]),
        MarkKey(2.90, .linear, [MarkDot(0, 0, 2.6)]),
        // Phrase 2, breathe: the dot grows, then fans into the row.
        MarkKey(3.06, .inOut, [MarkDot(0, 0, 5.3)]),
        MarkKey(3.32, .out, row),
        MarkKey(3.39, .linear, row),
        // Dots 1 and 2 meet, dot 3 comes in, all three fuse (6.4 pt) and split.
        MarkKey(3.60, .inOut, [MarkDot(-3.9, 0, 4.6), MarkDot(-3.2, 0, 4.6), MarkDot(6.1, 0, 4.1)]),
        MarkKey(3.67, .smooth, [MarkDot(-2.0, 0, 4.8), MarkDot(-1.2, 0, 4.8), MarkDot(4.7, 0, 3.6)]),
        MarkKey(3.70, .inOut, [MarkDot(0.1, 0, 6.4)]),
        MarkKey(3.74, .inOut, [MarkDot(-5.4, 0.1, 3.7), MarkDot(2.7, 0, 4.6), MarkDot(3.5, 0, 4.6)]),
        MarkKey(3.77, .smooth, [MarkDot(-6.0, 0, 4.1), MarkDot(3.4, 0, 4.6), MarkDot(4.4, 0, 4.6)]),
        MarkKey(3.84, .inOut, [MarkDot(-6.9, 0, 4.3), MarkDot(1.0, -0.1, 2.8), MarkDot(6.2, 0, 4.6)]),
        MarkKey(3.94, .out, row),
        MarkKey(4.05, .linear, row),
        // All three slide to the centre, fuse and shrink; the dot that is left
        // grows and fans out again, which is the next loop's first 0.30 s.
        MarkKey(4.29, .inOut, [MarkDot(-4.4, 0, 4.0), MarkDot(0.1, 0, 3), MarkDot(4.6, 0, 4.2)]),
        MarkKey(4.37, .inOut, [MarkDot(0.1, 0, 4.7)]),
        MarkKey(4.54, .linear, [MarkDot(0, 0, 1.2)]),
        MarkKey(4.58, .linear, [MarkDot(0, 0, 3.2)]),
        MarkKey(4.62, .linear, [MarkDot(0, 0, 4.8)]),
    ])

    /// 4.3 burst in: one dot, a tight 2 x 2 cluster, then the square.
    private static let burstTrack = MarkTrack([
        MarkKey(0.00, .linear, [MarkDot(0, 0, 7)]),
        MarkKey(0.07, .out, [MarkDot(-1.5, -1.5, 5), MarkDot(1.5, -1.5, 5), MarkDot(-1.5, 1.5, 5), MarkDot(1.5, 1.5, 5)]),
        MarkKey(0.20, .out, square),
    ])

    /// 4.3 loop: two shears, "/" then "\", each 0.33 s of motion and a 0.30 s
    /// hold on the square. The mirror shear is the first shifted by half a
    /// period (0.63 s), the spacing the capture measured between diagonals;
    /// the spec's table lists its diagonal and fused pair at 0.63 and 0.72,
    /// which would make the two shears uneven.
    private static let fourTrack = MarkTrack([
        MarkKey(0.00, .linear, square),
        MarkKey(0.09, .smooth, [MarkDot(2.5, -2.5, 5), MarkDot(7, -7, 5), MarkDot(-7, 7, 5), MarkDot(-2.5, 2.5, 5)]),
        MarkKey(0.17, .smooth, [MarkDot(3, -6, 5), MarkDot(8, -6, 5), MarkDot(-8, 6, 5), MarkDot(-3, 6, 5)]),
        MarkKey(0.33, .smooth, square),
        MarkKey(0.63, .linear, square),
        MarkKey(0.72, .smooth, [MarkDot(-7, -7, 5), MarkDot(-2.5, -2.5, 5), MarkDot(2.5, 2.5, 5), MarkDot(7, 7, 5)]),
        MarkKey(0.80, .smooth, [MarkDot(-8, -6, 5), MarkDot(-3, -6, 5), MarkDot(3, 6, 5), MarkDot(8, 6, 5)]),
        MarkKey(0.96, .smooth, square),
        MarkKey(1.26, .linear, square),
    ])

    private static func wrap(_ t: Double, _ period: Double) -> Double {
        guard t.isFinite, t > 0 else { return 0 }
        return t.truncatingRemainder(dividingBy: period)
    }
}

// MARK: - Sequencer

/// Which figure the mark is in, and how it got there. One per mark. The
/// arrival, the collapse between figures and the completion all start from
/// "now", so the sequencer holds the moment each began; `dots(at:)` then
/// needs nothing but the clock. The label swaps on its own clock and never
/// reaches this: the dots do not reset when the label changes.
public struct AgentMarkSequencer: Equatable, Sendable {
    enum Stage: Equatable, Sendable {
        /// The turn's arrival, then the three-dot loop.
        case arrival
        /// The three-dot figure coming back after a command (4.4).
        case fan
        /// The four-dot burst, then its loop.
        case burst
        /// A loop from the shared clock, no entry (a sidebar row).
        case loop(AgentMarkPhase)
        /// Fold the figure that was showing, then enter `to`.
        case collapse(from: [MarkDot], to: AgentMarkPhase)
        case done(from: [MarkDot])
    }

    private(set) var stage: Stage
    private var stageStart: Double
    public private(set) var phase: AgentMarkPhase
    /// When the command figure started (its burst), while it is the figure.
    private var commandStart: Double?
    /// What came while the command figure was still in its dwell, applied the
    /// moment the dwell ends. `returnOwed`: the steps ended and thinking is
    /// back; a command after it cancels it. `restartOwed`: another command
    /// step began, so the figure folds and bursts again. They are separate so
    /// that a return that comes after a restart does not lose it: command A,
    /// command B, thinking, command C is still owed one burst. When both are
    /// owed at the end, the return wins (the later command step has ended).
    private var returnOwed = false
    private var restartOwed = false
    private var owes: Bool { returnOwed || restartOwed }

    /// `arrives`: the turn's arrival first (a chat's working row). Without it
    /// the mark loops from the clock, so every sidebar mark stays in step.
    public init(start: Double, phase: AgentMarkPhase = .thinking, arrives: Bool = true) {
        self.phase = phase
        stageStart = start
        switch (arrives, phase) {
        case (_, .done): stage = .done(from: [])
        case (true, .thinking): stage = .arrival
        case (true, .command):
            stage = .burst
            commandStart = start
        case (false, _): stage = .loop(phase)
        }
    }

    /// When the command figure may give way, or nil when it is not showing.
    private var dwellEnd: Double? { commandStart.map { $0 + AgentMarkFrames.commandDwell } }

    /// Whether the command step key changing from `old` to `new` is one command
    /// step following another. A step that is only now getting its id or
    /// detail (nil before) is the same step.
    public static func isNewCommandStep(from old: String?, to new: String?) -> Bool {
        guard let old, let new else { return false }
        return old != new
    }

    /// The phase changed at `now`.
    ///
    /// The command figure keeps the mark until its burst and one full shear
    /// have run. A return to thinking inside that dwell waits for it (the
    /// latest request wins), and a command inside it continues the same
    /// figure. A `restart` (one command step following another, spec 4.3)
    /// inside the dwell waits for the dwell's end too, so a long command that
    /// follows a short one still bursts, and so does a command that follows a
    /// return to thinking there (a new step either way). A finished turn ends
    /// at once.
    public mutating func set(_ next: AgentMarkPhase, at now: Double, restart: Bool = false) {
        settle(at: now)
        if next == .done {
            returnOwed = false
            restartOwed = false
        } else if phase == .command, let end = dwellEnd, now < end {
            if next == .thinking {
                returnOwed = true
            } else {
                // A command after a waiting return, or flagged as the next
                // step, is a new step: owed a burst at the end of the dwell.
                if restart || returnOwed { restartOwed = true }
                returnOwed = false
            }
            return
        }
        guard next != phase || (restart && next == .command) else { return }
        apply(next, at: now)
    }

    /// Switches figure at `now`, which is already past any dwell.
    private mutating func apply(_ next: AgentMarkPhase, at now: Double) {
        let showing = rawDots(at: now)
        let previous = phase
        phase = next
        stageStart = now
        commandStart = nil
        returnOwed = false
        restartOwed = false
        switch next {
        case .done:
            stage = .done(from: showing)
        case .thinking, .command:
            if previous == .done {
                // A new turn on the same mark: arrive afresh.
                stage = next == .thinking ? .arrival : .burst
                if next == .command { commandStart = now }
            } else if showing.isEmpty {
                // Nothing on screen (the arrival's one-frame blink): there is
                // nothing to fold, so go straight into the entry.
                stage = next == .command ? .burst : .fan
                if next == .command { commandStart = now }
            } else {
                stage = .collapse(from: showing, to: next)
                if next == .command { commandStart = now + AgentMarkFrames.collapseDuration }
            }
        }
    }

    /// Applies what waited for the dwell, if the dwell is over by `now`: the
    /// return to thinking, or else the deferred restart (fold and burst
    /// again). It starts when the dwell ended, not when it was noticed.
    private mutating func settle(at now: Double) {
        guard owes, let end = dwellEnd, now >= end else { return }
        let next: AgentMarkPhase = returnOwed ? .thinking : .command
        apply(next, at: end)
    }

    /// Moves on past a dwell that has ended, so the work is done once and not
    /// again on every frame. `dots(at:)` gives the same answer either way.
    public mutating func advance(to now: Double) { settle(at: now) }

    public func dots(at now: Double) -> [MarkDot] {
        if owes, let end = dwellEnd, now >= end {
            var settled = self
            settled.settle(at: now)
            return settled.rawDots(at: now)
        }
        return rawDots(at: now)
    }

    private func rawDots(at now: Double) -> [MarkDot] {
        let t = max(0, now - stageStart)
        guard t.isFinite else { return [] }
        switch stage {
        case .arrival:
            if t < AgentMarkFrames.arrivalDuration { return AgentMarkFrames.arrival(at: t) }
            return Self.loop(after: t - AgentMarkFrames.arrivalDuration)
        case .fan:
            return Self.fan(t)
        case .burst:
            return Self.burst(t)
        case .loop(let phase):
            return AgentMarkFrames.dots(at: now, phase: phase)
        case .collapse(let snapshot, let to):
            let end = to == .command ? AgentMarkFrames.collapseEndCommand : AgentMarkFrames.collapseEndThinking
            if t < AgentMarkFrames.collapseDuration {
                return AgentMarkFrames.collapse(from: snapshot, at: t, endSize: end)
            }
            // The next figure starts on the dot the fold ended on.
            let s = t - AgentMarkFrames.collapseDuration
            return to == .command ? Self.burst(s) : Self.fan(s)
        case .done(let snapshot):
            return AgentMarkFrames.completion(from: snapshot, at: t)
        }
    }

    private static func burst(_ s: Double) -> [MarkDot] {
        if s < AgentMarkFrames.burstDuration { return AgentMarkFrames.burst(at: s) }
        return AgentMarkFrames.commandLoop(at: s - AgentMarkFrames.burstDuration)
    }

    private static func fan(_ s: Double) -> [MarkDot] {
        let at = AgentMarkFrames.fanEntry + s
        if at < AgentMarkFrames.arrivalDuration { return AgentMarkFrames.arrival(at: at) }
        return loop(after: at - AgentMarkFrames.arrivalDuration)
    }

    /// The three-dot loop, joined after the arrival's own fan: it starts at its row.
    private static func loop(after s: Double) -> [MarkDot] {
        AgentMarkFrames.thinkingLoop(at: AgentMarkFrames.thinkingFanEnd + s)
    }
}

// MARK: - Label hold

/// What the working row's label shows. A label stays up for at least `hold`
/// before the next one replaces it, so a run of fast steps ("Thinking",
/// "Running a command", "Thinking") can be read, and the 120 ms swaps never
/// overlap. A label offered during the hold waits as the pending one, and a
/// newer offer replaces it: only the latest shows when the hold ends.
public struct LabelHold: Equatable, Sendable {
    public static let hold = 0.8

    public private(set) var shown: String
    private var shownSince: Double
    private var pending: String?

    public init(_ label: String, at now: Double) {
        shown = label
        shownSince = now
    }

    /// The label was offered at `now`.
    public mutating func offer(_ label: String, at now: Double) {
        settle(at: now)
        pending = label == shown ? nil : label
    }

    /// Restarts the hold, for a label that only became visible at `now`.
    public mutating func restart(at now: Double) { shownSince = now }

    /// When the pending label replaces the shown one, or nil with none pending.
    public var due: Double? { pending == nil ? nil : shownSince + Self.hold }

    /// Shows the pending label if its hold is over by `now`.
    public mutating func settle(at now: Double) {
        guard let next = pending, let due, now >= due else { return }
        shown = next
        shownSince = due
        pending = nil
    }

    /// The label on screen at `now`, without changing anything.
    public func shown(at now: Double) -> String {
        var copy = self
        copy.settle(at: now)
        return copy.shown
    }
}

// MARK: - Shimmer

/// The light sweep across an in-progress label (spec section 5). The numbers
/// live here so the view and the tests read the same ones.
public enum AgentShimmer {
    public static let bandWidth = 130.0
    /// Points per second.
    public static let speed = 485.0
    /// Seconds between sweeps while a label stays up.
    public static let period = 3.0
    /// The first sweep starts this long after a label appears.
    public static let firstDelay = 0.7
    /// The timer shows once the row has been live this long.
    public static let timerAfter = 5

    /// How long one sweep takes across a label of `width`.
    public static func sweepDuration(width: Double) -> Double { (max(0, width) + bandWidth) / speed }

    /// Where the band's centre is `elapsed` seconds after the label appeared,
    /// measured from the label's left edge, or nil between sweeps.
    public static func bandCentre(elapsed: Double, width: Double) -> Double? {
        let e = elapsed - firstDelay
        guard e.isFinite, e >= 0 else { return nil }
        let cycle = e.truncatingRemainder(dividingBy: period)
        guard cycle < sweepDuration(width: width) else { return nil }
        return -bandWidth / 2 + cycle * speed
    }

    /// The first label shows a beat after the mark arrives, so the row is
    /// never a bare dot for long.
    public static let firstLabelDelay = 0.6
}

// MARK: - Keyframes and easing

enum MarkEase: Sendable {
    case linear
    /// Symmetric ease-in-out, for loop moves.
    case inOut
    /// The brand curve, for arrivals.
    case out
    /// For shrinks that end in a vanish.
    case easeIn
    /// A cubic Hermite through neighbouring keys, so a run of keys moves as one gesture
    /// instead of stopping at each. Zero speed at a rest (a key equal to its neighbour).
    case smooth
}

enum Ease {
    static func inOut(_ p: Double) -> Double { bezier(0.45, 0, 0.55, 1, clamp(p)) }
    static func out(_ p: Double) -> Double { bezier(0.22, 1, 0.36, 1, clamp(p)) }
    static func shrink(_ p: Double) -> Double { bezier(0.32, 0, 0.67, 0, clamp(p)) }

    static func apply(_ ease: MarkEase, _ p: Double) -> Double {
        switch ease {
        case .linear, .smooth: return clamp(p)
        case .inOut: return inOut(p)
        case .out: return out(p)
        case .easeIn: return shrink(p)
        }
    }

    private static func clamp(_ p: Double) -> Double { min(1, max(0, p)) }

    /// CSS `cubic-bezier(x1, y1, x2, y2)` at time fraction `p`.
    static func bezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ p: Double) -> Double {
        if p <= 0 { return 0 }
        if p >= 1 { return 1 }
        var low = 0.0, high = 1.0
        for _ in 0..<24 {
            let t = (low + high) / 2
            let i = 1 - t
            let x = 3 * i * i * t * x1 + 3 * i * t * t * x2 + t * t * t
            if x < p { low = t } else { high = t }
        }
        let t = (low + high) / 2
        let i = 1 - t
        return 3 * i * i * t * y1 + 3 * i * t * t * y2 + t * t * t
    }
}

/// A keyframe: the dots at `t`, reached from the previous key with `ease`.
/// No dots at all means "gone": a figure shrinking into it vanishes, and one
/// leaving it pops in at the next key.
struct MarkKey: Sendable {
    let t: Double
    var dots: [MarkDot]
    let ease: MarkEase

    init(_ t: Double, _ ease: MarkEase, _ dots: [MarkDot]) {
        self.t = t
        self.ease = ease
        self.dots = dots
    }
}

struct MarkTrack: Sendable {
    let keys: [MarkKey]

    /// Every key gets the same number of dots, the extras sitting on the
    /// first one, so a fused blob can split into three and three can gather
    /// into one without a dot appearing from nowhere.
    init(_ keys: [MarkKey]) {
        let count = keys.map(\.dots.count).max() ?? 0
        self.keys = keys.map { key in
            guard let first = key.dots.first, key.dots.count < count else { return key }
            var padded = key
            padded.dots += Array(repeating: first, count: count - key.dots.count)
            return padded
        }
    }

    func dots(at t: Double) -> [MarkDot] {
        guard let first = keys.first, let last = keys.last else { return [] }
        if !(t > first.t) { return first.dots }
        if t >= last.t { return last.dots }
        var i = 0
        while i + 2 < keys.count, keys[i + 1].t <= t { i += 1 }
        let a = keys[i], b = keys[i + 1]
        let p = (t - a.t) / (b.t - a.t)
        if a.dots.isEmpty { return [] }
        if b.dots.isEmpty {
            let w = Ease.apply(b.ease == .smooth ? .easeIn : b.ease, p)
            return a.dots.map { MarkDot($0.x, $0.y, $0.d * (1 - w)) }
        }
        if b.ease == .smooth { return hermite(i, p) }
        let w = Ease.apply(b.ease, p)
        return zip(a.dots, b.dots).map { x, y in
            MarkDot(x.x + (y.x - x.x) * w, x.y + (y.y - x.y) * w, max(0, x.d + (y.d - x.d) * w))
        }
    }

    private func hermite(_ i: Int, _ u: Double) -> [MarkDot] {
        let a = keys[i], b = keys[i + 1]
        let h = b.t - a.t
        let u2 = u * u, u3 = u2 * u
        let h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u
        let h01 = -2 * u3 + 3 * u2, h11 = u3 - u2
        let m0 = tangents(at: i), m1 = tangents(at: i + 1)
        func value(_ p0: Double, _ p1: Double, _ s0: Double, _ s1: Double) -> Double {
            h00 * p0 + h10 * h * s0 + h01 * p1 + h11 * h * s1
        }
        return a.dots.indices.map { n in
            MarkDot(
                value(a.dots[n].x, b.dots[n].x, m0[n].x, m1[n].x),
                value(a.dots[n].y, b.dots[n].y, m0[n].y, m1[n].y),
                max(0, value(a.dots[n].d, b.dots[n].d, m0[n].d, m1[n].d))
            )
        }
    }

    /// Speed of each dot through key `i`: the chord between its neighbours,
    /// or zero at a rest, at the ends and next to a gap.
    private func tangents(at i: Int) -> [MarkDot] {
        let here = keys[i]
        let still = here.dots.map { _ in MarkDot(0, 0, 0) }
        guard i > 0, i + 1 < keys.count else { return still }
        let before = keys[i - 1], after = keys[i + 1]
        if before.dots.isEmpty || after.dots.isEmpty { return still }
        if before.dots == here.dots || after.dots == here.dots { return still }
        let span = after.t - before.t
        return here.dots.indices.map { n in
            MarkDot(
                (after.dots[n].x - before.dots[n].x) / span,
                (after.dots[n].y - before.dots[n].y) / span,
                (after.dots[n].d - before.dots[n].d) / span
            )
        }
    }
}

import Foundation
import Testing
@testable import UsefulBotCore

/// The agent-working mark's keyframes. The arrival, the four-dot figure and
/// the timings follow the tables in
/// ~/.agents/skills/useful-brand/references/agent-working-motion.md; the
/// three-dot loop follows the capture frames (rec-02) where the table
/// disagrees with them.
@Suite struct AgentMarkFramesTests {
    private func same(_ a: [MarkDot], _ b: [MarkDot], tolerance: Double = 0.001) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy {
            abs($0.x - $1.x) < tolerance && abs($0.y - $1.y) < tolerance && abs($0.d - $1.d) < tolerance
        }
    }

    private func dots(_ values: [(Double, Double, Double)]) -> [MarkDot] {
        values.map { MarkDot($0.0, $0.1, $0.2) }
    }

    private let eps = 1e-6

    // MARK: Periods

    @Test func loopsRepeatExactlyEveryPeriod() {
        for t in stride(from: 0.0, to: 4.62, by: 0.037) {
            #expect(same(AgentMarkFrames.thinkingLoop(at: t), AgentMarkFrames.thinkingLoop(at: t + 4.62)))
            #expect(same(AgentMarkFrames.thinkingLoop(at: t), AgentMarkFrames.thinkingLoop(at: t + 9.24)))
        }
        for t in stride(from: 0.0, to: 1.26, by: 0.011) {
            #expect(same(AgentMarkFrames.commandLoop(at: t), AgentMarkFrames.commandLoop(at: t + 1.26)))
        }
        #expect(AgentMarkFrames.thinkingPeriod == 4.62)
        #expect(AgentMarkFrames.commandPeriod == 1.26)
        #expect(AgentMarkFrames.arrivalDuration == 0.66)
    }

    @Test func loopsRestartWhereTheyEnd() {
        // 4.62 s lands on the dot 0.00 starts from, 1.26 s on the square.
        #expect(same(AgentMarkFrames.thinkingLoop(at: 4.62), AgentMarkFrames.thinkingLoop(at: 0)))
        #expect(same(AgentMarkFrames.commandLoop(at: 1.26), AgentMarkFrames.commandLoop(at: 0)))
    }

    // MARK: Arrival (4.1)

    @Test func arrivalFollowsTheTable() {
        #expect(same(AgentMarkFrames.arrival(at: 0), dots([(0, 0, 9), (0, 0, 9), (0, 0, 9)])))
        #expect(same(AgentMarkFrames.arrival(at: 0.07), dots([(0, 0, 9), (0, 0, 9), (0, 0, 9)])))
        #expect(same(AgentMarkFrames.arrival(at: 0.31), dots([(0, 0, 3.5), (0, 0, 3.5), (0, 0, 3.5)])))
        #expect(AgentMarkFrames.arrival(at: 0.44).isEmpty)
        #expect(AgentMarkFrames.arrival(at: 0.46).isEmpty)
        #expect(same(AgentMarkFrames.arrival(at: 0.48), dots([(0, 0, 3.5), (0, 0, 3.5), (0, 0, 3.5)])))
        #expect(same(AgentMarkFrames.arrival(at: 0.53), dots([(-2, 0, 3.5), (0, 0, 3), (2, 0, 4)])))
        // The loop's own row, so the hand-over has no size pop.
        #expect(same(AgentMarkFrames.arrival(at: 0.66), dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5)])))
    }

    @Test func arrivalShrinksWithoutFadingIn() {
        // Full size in the first frame, never smaller on the way in.
        #expect(AgentMarkFrames.arrival(at: 0).allSatisfy { $0.d == 9 })
        var last = 9.0
        for t in stride(from: 0.0, through: 0.31, by: 0.01) {
            let d = AgentMarkFrames.arrival(at: t)[0].d
            #expect(d <= last + 0.0001)
            last = d
        }
    }

    // MARK: Three-dot loop (4.2, from the capture)

    @Test func threeDotLoopFollowsTheCapture() {
        let f = AgentMarkFrames.thinkingLoop(at:)
        let blob = dots([(0, 0, 4.8), (0, 0, 4.8), (0, 0, 4.8)])
        let row = dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5)])
        // The loop opens on the dot the arrival and the restart leave, fans
        // into the row by 0.30 s and holds it.
        #expect(same(f(0), blob))
        #expect(same(f(0.30), row))
        #expect(same(f(0.40), row))
        // Dot 2 runs into dot 1 and the blob slides right.
        #expect(same(f(0.63), dots([(-5.8, 0, 4.5), (-4.8, 0, 4.5), (8.3, 0, 4.3)])))
        // Split into small, big, small, then the rotating triangle.
        #expect(same(f(0.81), dots([(-5.6, -0.2, 3.3), (-1.1, 1, 5.2), (6.8, -0.4, 3.4)])))
        #expect(same(f(1.07), dots([(-8.2, 1.2, 4.3), (7.6, 2.4, 4.7), (1.3, -2.5, 3.1)])))
        #expect(same(f(1.35), dots([(-1.1, 5.6, 5), (7.2, -1.6, 3.4), (-5.5, -2.4, 3.3)])))
        #expect(same(f(1.73), dots([(8.4, 0.2, 3.9), (-2.2, -0.6, 2.9), (-6.3, 0.8, 5)])))
        // The gather, the shrink and the dot that comes back.
        #expect(same(f(2.62), dots([(0.2, -0.1, 6.7), (0.2, -0.1, 6.7), (0.2, -0.1, 6.7)])))
        #expect(f(2.78).isEmpty)
        #expect(f(2.80).isEmpty)
        #expect(same(f(2.83), dots([(0, 0, 2.6), (0, 0, 2.6), (0, 0, 2.6)])))
        // Phrase 2: fan into the row, meet, fuse into one blob, split.
        #expect(same(f(3.32), row))
        #expect(same(f(3.39), row))
        #expect(same(f(3.70), dots([(0.1, 0, 6.4), (0.1, 0, 6.4), (0.1, 0, 6.4)])))
        #expect(same(f(3.94), row))
        #expect(same(f(4.37), dots([(0.1, 0, 4.7), (0.1, 0, 4.7), (0.1, 0, 4.7)])))
        // The 4.54 s dot is small but never gone: the capture has no blank frame.
        #expect(!f(4.54).isEmpty)
    }

    @Test func phraseTwoHoldsTheRowThenFusesThenSplits() {
        let f = AgentMarkFrames.thinkingLoop(at:)
        // The row holds, then eases in (the capture's dots barely move until
        // about 3.50), fused by about 3.70 and split from 3.74: the blob shows
        // for about 30 ms.
        #expect(same(f(3.39), f(3.32)))
        #expect(abs(f(3.45)[0].x - f(3.39)[0].x) < 1)
        let meeting = f(3.60)
        #expect(meeting[1].x - meeting[0].x < 1)
        let fused = f(3.70)
        #expect(fused.allSatisfy { $0.x == fused[0].x && $0.d == fused[0].d })
        let split = f(3.74)
        #expect(split[0].x < -5 && split[1].x > 2)
    }

    @Test func theTriangleKeepsEveryDotInItsLane() {
        // From the capture: dot 1 (large at the bottom) lands on the right,
        // dot 3 on the left, dot 2 in the middle, and none of them crosses
        // another between 1.49 and 1.73. The spec's table has them landing
        // the other way round.
        for t in stride(from: 1.49, through: 1.73, by: 0.005) {
            let d = AgentMarkFrames.thinkingLoop(at: t)
            #expect(d[2].x < d[1].x + 0.0001)
            #expect(d[1].x < d[0].x + 0.0001)
        }
        let landed = AgentMarkFrames.thinkingLoop(at: 1.73)
        #expect(landed[0].x > 8 && landed[2].x < -6)
    }

    @Test func theTriangleSpreadsAboutNinePointsTall() {
        // Dot centres run from y -3.7 to +5.8 in the capture (the spec's
        // table says 8 pt, read from every third frame).
        let ys = (0..<462).flatMap { AgentMarkFrames.thinkingLoop(at: Double($0) * 0.01).map(\.y) }
        let spread = (ys.max() ?? 0) - (ys.min() ?? 0)
        #expect(spread > 8)
        #expect(spread < 10.5)
    }

    @Test func theLoopRestartIsAFanFromTheOneDotNotAPop() {
        // 4.58 to 4.62 and on into the next loop: a dot of 3.2 pt grows to 4.8
        // and then fans out over about 0.27 s.
        #expect(!AgentMarkFrames.thinkingLoop(at: 4.58).isEmpty)
        #expect(abs(AgentMarkFrames.thinkingLoop(at: 4.58)[0].d - 3.2) < 0.001)
        var previousSpread = -1.0
        for t in stride(from: 0.03, through: 0.30, by: 0.01) {
            let d = AgentMarkFrames.thinkingLoop(at: t)
            let spread = d[2].x - d[0].x
            #expect(spread >= previousSpread - 0.0001)
            previousSpread = spread
        }
        // Halfway through it is neither the dot nor the row.
        let mid = AgentMarkFrames.thinkingLoop(at: 0.12)
        #expect(mid[2].x - mid[0].x > 2 && mid[2].x - mid[0].x < 16)
        // No jump across the 4.62 seam.
        let before = AgentMarkFrames.thinkingLoop(at: 4.619)
        let after = AgentMarkFrames.thinkingLoop(at: 4.621)
        #expect(zip(before, after).allSatisfy { abs($0.x - $1.x) < 0.2 && abs($0.d - $1.d) < 0.2 })
    }

    @Test func splitsStartSlowSoTheyAreNotTheBrandCurve() {
        // The 0.81 split moves symmetrically: the first quarter of its time
        // covers little ground. The brand curve would be most of the way by 40%.
        let a = AgentMarkFrames.thinkingLoop(at: 0.78)
        let b = AgentMarkFrames.thinkingLoop(at: 0.81)
        let early = AgentMarkFrames.thinkingLoop(at: 0.78 + 0.03 * 0.25)
        let travelled = abs(early[1].x - a[1].x) / abs(b[1].x - a[1].x)
        #expect(travelled < 0.2)
    }

    // MARK: Four-dot figure (4.3)

    @Test func burstFollowsTheTable() {
        let f = AgentMarkFrames.burst(at:)
        #expect(same(f(0), dots([(0, 0, 7), (0, 0, 7), (0, 0, 7), (0, 0, 7)])))
        #expect(same(f(0.07), dots([(-1.5, -1.5, 5), (1.5, -1.5, 5), (-1.5, 1.5, 5), (1.5, 1.5, 5)])))
        #expect(same(f(0.20), dots([(-6, -6, 5), (6, -6, 5), (-6, 6, 5), (6, 6, 5)])))
    }

    @Test func fourDotLoopFollowsTheTable() {
        let f = AgentMarkFrames.commandLoop(at:)
        let square = dots([(-6, -6, 5), (6, -6, 5), (-6, 6, 5), (6, 6, 5)])
        #expect(same(f(0), square))
        #expect(same(f(0.09), dots([(2.5, -2.5, 5), (7, -7, 5), (-7, 7, 5), (-2.5, 2.5, 5)])))
        #expect(same(f(0.17), dots([(3, -6, 5), (8, -6, 5), (-8, 6, 5), (-3, 6, 5)])))
        #expect(same(f(0.33), square))
        // The hold on the square, 0.30 s.
        #expect(same(f(0.5), square))
        #expect(same(f(0.63), square))
        // The mirror shear is the first shifted half a period.
        #expect(same(f(0.72), dots([(-7, -7, 5), (-2.5, -2.5, 5), (2.5, 2.5, 5), (7, 7, 5)])))
        #expect(same(f(0.80), dots([(-8, -6, 5), (-3, -6, 5), (3, 6, 5), (8, 6, 5)])))
        #expect(same(f(0.96), square))
        #expect(same(f(1.1), square))
    }

    // MARK: Fits the box

    @Test func everyFigureStaysInsideTheTwentyFourPointBox() {
        func fits(_ dots: [MarkDot]) -> Bool {
            dots.allSatisfy { abs($0.x) + $0.d / 2 <= 12 && abs($0.y) + $0.d / 2 <= 12 && $0.d >= 0 }
        }
        for t in stride(from: 0.0, to: 4.62, by: 0.01) { #expect(fits(AgentMarkFrames.thinkingLoop(at: t))) }
        for t in stride(from: 0.0, to: 1.26, by: 0.01) { #expect(fits(AgentMarkFrames.commandLoop(at: t))) }
        for t in stride(from: 0.0, to: 0.66, by: 0.01) { #expect(fits(AgentMarkFrames.arrival(at: t))) }
        for t in stride(from: 0.0, to: 0.2, by: 0.01) { #expect(fits(AgentMarkFrames.burst(at: t))) }
    }

    // MARK: Reduced motion and phases

    @Test func reducedMotionIsThreeStillDots() {
        #expect(AgentMarkFrames.reducedMotion == dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5.5)]))
    }

    @Test func phaseSelectsTheFigure() {
        #expect(same(AgentMarkFrames.dots(at: 0.85, phase: .thinking), AgentMarkFrames.thinkingLoop(at: 0.85)))
        #expect(same(AgentMarkFrames.dots(at: 0.09, phase: .command), AgentMarkFrames.commandLoop(at: 0.09)))
        #expect(AgentMarkFrames.dots(at: 0.3, phase: .done).isEmpty)
    }

    // MARK: Collapse and completion

    @Test func collapseFusesTowardEightPointsThenShrinksAway() {
        let snapshot = dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5.5)])
        #expect(same(AgentMarkFrames.collapse(from: snapshot, at: 0), snapshot))
        // Each dot swells to 8 pt at most, and a small one swells less.
        let fused = AgentMarkFrames.collapse(from: snapshot, at: 0.12)
        #expect(same(fused, dots([(0, 0, 7.65), (0, 0, 5.1), (0, 0, 8)])))
        let shrinking = AgentMarkFrames.collapse(from: snapshot, at: 0.16)
        #expect(shrinking.allSatisfy { $0.d > 0 && $0.x == 0 })
        #expect(zip(shrinking, fused).allSatisfy { $0.d < $1.d })
        #expect(AgentMarkFrames.collapse(from: snapshot, at: 0.2).isEmpty)
        #expect(AgentMarkFrames.collapse(from: [], at: 0.05).isEmpty)
    }

    @Test func aCollapseCanShrinkOntoTheNextFiguresFirstDot() {
        let snapshot = dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5.5)])
        let almost = AgentMarkFrames.collapse(from: snapshot, at: 0.1999, endSize: 7)
        #expect(almost.allSatisfy { abs($0.d - 7) < 0.05 && $0.x == 0 })
        // Never a blank frame on the way.
        for t in stride(from: 0.0, to: 0.2, by: 0.002) {
            #expect(!AgentMarkFrames.collapse(from: snapshot, at: t, endSize: 3.5).isEmpty)
        }
    }

    @Test func aDotOnItsWayOutDoesNotBalloonInACollapse() {
        let snapshot = dots([(0, 0, 0.8)])
        for t in stride(from: 0.0, to: 0.2, by: 0.01) {
            #expect(AgentMarkFrames.collapse(from: snapshot, at: t).allSatisfy { $0.d <= 0.8 * 1.7 + 0.0001 })
        }
    }

    @Test func completionShrinksTowardTwoPointsAndVanishesWithinFiftyMilliseconds() {
        let snapshot = dots([(-8, 0, 4.5), (0, 0, 3), (8, 0, 5.5)])
        #expect(same(AgentMarkFrames.completion(from: snapshot, at: 0), snapshot))
        let late = AgentMarkFrames.completion(from: snapshot, at: 0.04)
        #expect(late.allSatisfy { abs($0.d - 2) < 0.1 })
        #expect(AgentMarkFrames.completion(from: snapshot, at: 0.05).isEmpty)
        // A dot already under 2 pt is not made bigger on its way out.
        let small = dots([(0, 0, 1.2)])
        for t in stride(from: 0.0, to: 0.05, by: 0.005) {
            #expect(AgentMarkFrames.completion(from: small, at: t).allSatisfy { $0.d <= 1.2 + 0.0001 })
        }
    }

    // MARK: Sequencer

    @Test func sequencerArrivesThenJoinsTheLoopAtItsRow() {
        let s = AgentMarkSequencer(start: 100)
        #expect(same(s.dots(at: 100), AgentMarkFrames.arrival(at: 0)))
        // The arrival has already fanned, so the loop is joined at its row.
        #expect(same(s.dots(at: 100.66 + eps), AgentMarkFrames.thinkingLoop(at: 0.30)))
        #expect(same(s.dots(at: 100.66 + 0.55), AgentMarkFrames.thinkingLoop(at: 0.85)))
        // A sidebar mark skips the arrival and follows the shared clock.
        let side = AgentMarkSequencer(start: 100, phase: .thinking, arrives: false)
        #expect(same(side.dots(at: 107.3), AgentMarkFrames.thinkingLoop(at: 107.3)))
    }

    @Test func commandCollapsesBurstsAndLoopsThenReturnsToThree() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        // Folding, then the burst starts on the dot the fold ended on: no gap.
        #expect(!s.dots(at: 10.205).isEmpty)
        #expect(same(s.dots(at: 10 + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
        #expect(same(s.dots(at: 10 + 0.2 + 0.2 + eps), AgentMarkFrames.commandLoop(at: 0)))
        #expect(same(s.dots(at: 10 + 0.2 + 0.2 + 0.09 + eps), AgentMarkFrames.commandLoop(at: 0.09)))
        // Thinking again once the dwell is over: the square contracts onto the
        // 3.5 pt dot the fan starts from, and the three-dot loop resumes at its row.
        s.set(.thinking, at: 20)
        #expect(!s.dots(at: 20.3).isEmpty)
        #expect(same(s.dots(at: 20 + 0.2 + eps), AgentMarkFrames.arrival(at: 0.48)))
        #expect(same(s.dots(at: 20 + 0.2 + 0.18 + eps), AgentMarkFrames.thinkingLoop(at: 0.30)))
    }

    @Test func aFoldEndsOnTheFirstDotOfTheNextFigure() {
        // To a command: the burst's 7 pt dot. Back to thinking: the fan's 3.5 pt dot.
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        let end = s.dots(at: 10 + 0.2 - eps)
        #expect(end.allSatisfy { abs($0.d - 7) < 0.1 && $0.x == 0 })
        s.set(.thinking, at: 20)
        let back = s.dots(at: 20 + 0.2 - eps)
        #expect(back.allSatisfy { abs($0.d - 3.5) < 0.1 && $0.x == 0 })
    }

    @Test func aSecondCommandStepFoldsAndBurstsAgainOnceTheDwellIsOver() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        // Well past the dwell (0.2 + 0.2 + 1.26 s), in the loop.
        let t = 12.0
        let looping = s.dots(at: t)
        #expect(!looping.isEmpty)
        s.set(.command, at: t, restart: true)
        #expect(same(s.dots(at: t), looping))
        #expect(!s.dots(at: t + 0.1).isEmpty)
        #expect(same(s.dots(at: t + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
        #expect(same(s.dots(at: t + 0.2 + 0.2 + eps), AgentMarkFrames.commandLoop(at: 0)))
        // Without `restart` the same phase is left alone, and `restart` means
        // nothing for the three-dot figure.
        var plain = AgentMarkSequencer(start: 0)
        plain.set(.command, at: 10)
        plain.set(.command, at: t)
        #expect(same(plain.dots(at: t), looping))
        var thinking = AgentMarkSequencer(start: 0)
        let before = thinking.dots(at: 3)
        thinking.set(.thinking, at: 3, restart: true)
        #expect(same(thinking.dots(at: 3), before))
    }

    // MARK: Dwell

    /// A real turn: three bash steps that each end within a second, with
    /// thinking in between.
    private func fastTurn() -> AgentMarkSequencer {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10.25)     // the burst starts at 10.45
        s.set(.thinking, at: 10.55)    // too soon: waits
        s.set(.command, at: 10.80)     // continues the same figure
        s.set(.thinking, at: 11.00)    // waits again
        s.set(.command, at: 11.30)
        s.set(.thinking, at: 11.50)
        return s
    }

    @Test func fastCommandStepsKeepTheFourDotFigureForAFullShear() {
        let s = fastTurn()
        let burstStart = 10.25 + 0.2
        let dwellEnd = burstStart + 0.2 + 1.26
        // From the burst to the end of the dwell it is one unbroken figure:
        // the burst, then the loop, never a fold, never a restart.
        for t in stride(from: burstStart + 0.002, to: dwellEnd, by: 0.005) {
            let expected = t - burstStart < 0.2
                ? AgentMarkFrames.burst(at: t - burstStart)
                : AgentMarkFrames.commandLoop(at: t - burstStart - 0.2)
            #expect(same(s.dots(at: t), expected), "frame at \(t)")
        }
        // The square formed, in full.
        let square = dots([(-6, -6, 5), (6, -6, 5), (-6, 6, 5), (6, 6, 5)])
        #expect(same(s.dots(at: burstStart + 0.2), square))
        // Only then does it fold back, from the square, at the end of the dwell.
        #expect(same(s.dots(at: dwellEnd + 0.001), AgentMarkFrames.collapse(
            from: AgentMarkFrames.commandLoop(at: 1.26), at: 0.001, endSize: 3.5)))
        #expect(same(s.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.arrival(at: 0.48)))
    }

    @Test func aFastPhaseSequenceNeverShowsABlankFrame() {
        let s = fastTurn()
        // 60 fps from just before the first command to well after the last return.
        var t = 10.0
        while t < 14.0 {
            #expect(!s.dots(at: t).isEmpty, "blank frame at \(t)")
            t += 1.0 / 60
        }
    }

    @Test func aCommandInsideTheDwellCancelsTheWaitingReturnAndBurstsAtItsEnd() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        s.set(.thinking, at: 10.5)
        s.set(.command, at: 10.8)
        let dwellEnd = 10.2 + 1.46
        // Until the dwell ends it is the same figure: the return never happens.
        #expect(same(s.dots(at: 11.0), AgentMarkFrames.commandLoop(at: 11.0 - 10.2 - 0.2)))
        #expect(same(s.dots(at: dwellEnd - 0.01), AgentMarkFrames.commandLoop(at: dwellEnd - 0.01 - 10.2 - 0.2)))
        // The command that came after the return is a new step: it bursts, and
        // the mark does not go back to thinking.
        #expect(!s.dots(at: dwellEnd + 0.1).isEmpty)
        #expect(same(s.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
        #expect(same(s.dots(at: dwellEnd + 0.4 + eps), AgentMarkFrames.commandLoop(at: 0)))
        #expect(same(s.dots(at: dwellEnd + 3), AgentMarkFrames.commandLoop(at: 3 - 0.4)))
    }

    @Test func aDeferredRestartSurvivesALaterReturnAndAPlainCommand() {
        // Command A, command B (a restart), brief thinking, command C (plain):
        // C is a new step, so one burst is still owed at the dwell's end.
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        s.set(.command, at: 10.4, restart: true)
        s.set(.thinking, at: 10.6)
        s.set(.command, at: 10.9)
        let dwellEnd = 10.2 + 1.46
        #expect(same(s.dots(at: 11.2), AgentMarkFrames.commandLoop(at: 11.2 - 10.2 - 0.2)))
        #expect(same(s.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
        // The same without the plain command at the end: the return wins.
        var ended = AgentMarkSequencer(start: 0)
        ended.set(.command, at: 10)
        ended.set(.command, at: 10.4, restart: true)
        ended.set(.thinking, at: 10.6)
        #expect(same(ended.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.arrival(at: 0.48)))
        // And a restart with nothing after it bursts.
        var restart = AgentMarkSequencer(start: 0)
        restart.set(.command, at: 10)
        restart.set(.command, at: 10.4, restart: true)
        #expect(same(restart.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
    }

    @Test func aStepOnlyNowGettingItsIdIsNotANewStep() {
        #expect(!AgentMarkSequencer.isNewCommandStep(from: nil, to: "c1"))
        #expect(!AgentMarkSequencer.isNewCommandStep(from: "c1", to: nil))
        #expect(!AgentMarkSequencer.isNewCommandStep(from: "c1", to: "c1"))
        #expect(AgentMarkSequencer.isNewCommandStep(from: "c1", to: "c2"))
    }

    @Test func aRestartInsideTheDwellWaitsForItsEndAndThenBursts() {
        // A long command that follows a short one still gets its burst.
        var r = AgentMarkSequencer(start: 0)
        r.set(.command, at: 10)
        let dwellEnd = 10.2 + 1.46
        let before = r.dots(at: 10.7)
        r.set(.command, at: 10.7, restart: true)
        #expect(same(r.dots(at: 10.7), before))
        // Until the dwell is over it is the same figure.
        for t in stride(from: 10.8, to: dwellEnd, by: 0.02) {
            #expect(same(r.dots(at: t), AgentMarkFrames.commandLoop(at: t - 10.2 - 0.2)), "frame at \(t)")
        }
        // Then it folds and bursts again.
        #expect(!r.dots(at: dwellEnd + 0.1).isEmpty)
        #expect(same(r.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.burst(at: 0)))
        #expect(same(r.dots(at: dwellEnd + 0.2 + 0.2 + eps), AgentMarkFrames.commandLoop(at: 0)))
        // A command that already ended by then (a return to thinking after the
        // restart) wins over the burst.
        var ended = AgentMarkSequencer(start: 0)
        ended.set(.command, at: 10)
        ended.set(.command, at: 10.7, restart: true)
        ended.set(.thinking, at: 10.9)
        #expect(same(ended.dots(at: dwellEnd + 0.2 + eps), AgentMarkFrames.arrival(at: 0.48)))
    }

    // MARK: Hand-overs have no pop

    @Test func theArrivalHandsOverToTheLoopWithoutAJump() {
        let s = AgentMarkSequencer(start: 100)
        let before = s.dots(at: 100.66 - 0.001)
        let after = s.dots(at: 100.66 + 0.001)
        #expect(before.count == after.count)
        #expect(zip(before, after).allSatisfy { abs($0.x - $1.x) < 0.1 && abs($0.y - $1.y) < 0.1 && abs($0.d - $1.d) < 0.1 })
    }

    @Test func theFanBackToThreeHandsOverToTheLoopWithoutAJump() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        s.set(.thinking, at: 20)
        let join = 20 + 0.2 + 0.18
        let before = s.dots(at: join - 0.001)
        let after = s.dots(at: join + 0.001)
        #expect(before.count == after.count)
        #expect(zip(before, after).allSatisfy { abs($0.x - $1.x) < 0.1 && abs($0.y - $1.y) < 0.1 && abs($0.d - $1.d) < 0.1 })
        // And the fold ends on the fan's first dot.
        let dot = s.dots(at: 20 + 0.2 - 0.001)
        let fan = s.dots(at: 20 + 0.2 + 0.001)
        #expect(zip(dot, fan).allSatisfy { abs($0.d - $1.d) < 0.25 })
    }

    @Test func theLatestReturnWinsAndAFinishedTurnDoesNotWait() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        s.set(.thinking, at: 10.5)
        // The turn ends inside the dwell: the dots shrink away at once.
        let showing = s.dots(at: 10.6)
        s.set(.done, at: 10.6)
        #expect(same(s.dots(at: 10.6), showing))
        #expect(s.dots(at: 10.66).isEmpty)
        // A new turn then arrives afresh.
        s.set(.thinking, at: 20)
        #expect(same(s.dots(at: 20), AgentMarkFrames.arrival(at: 0)))
    }

    @Test func aRowThatOpensOnACommandHoldsItForTheDwellToo() {
        var s = AgentMarkSequencer(start: 100, phase: .command, arrives: true)
        s.set(.thinking, at: 100.5)
        #expect(same(s.dots(at: 101.0), AgentMarkFrames.commandLoop(at: 101.0 - 100.2)))
        #expect(!s.dots(at: 101.5).isEmpty)
        // The dwell ends at 100 + 0.2 + 1.26.
        #expect(!s.dots(at: 101.5).isEmpty)
        #expect(same(s.dots(at: 101.46 + 0.2 + eps), AgentMarkFrames.arrival(at: 0.48)))
    }

    @Test func aPhaseChangeMidFoldFoldsFromWhatIsOnScreen() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.command, at: 10)
        s.set(.thinking, at: 20)
        let half = s.dots(at: 20.1)
        #expect(!half.isEmpty)
        s.set(.command, at: 20.1)
        #expect(same(s.dots(at: 20.1), half))
    }

    @Test func aPhaseChangeOnAnEmptyFrameGoesStraightToTheEntry() {
        // The arrival blinks out for a frame at 0.44 s. A command that starts
        // then has nothing to fold, so the burst starts at once.
        var t = AgentMarkSequencer(start: 0)
        #expect(t.dots(at: 0.45).isEmpty)
        t.set(.command, at: 0.45)
        #expect(same(t.dots(at: 0.45 + eps), AgentMarkFrames.burst(at: 0)))
    }

    @Test func doneShrinksTheDotsThatWereShowingAndLeavesNothing() {
        var s = AgentMarkSequencer(start: 0)
        let showing = s.dots(at: 5)
        s.set(.done, at: 5)
        #expect(same(s.dots(at: 5), showing))
        #expect(s.dots(at: 5.06).isEmpty)
        #expect(s.dots(at: 50).isEmpty)
        // Setting the same phase again changes nothing.
        s.set(.done, at: 6)
        #expect(s.dots(at: 6).isEmpty)
    }

    @Test func doneToThinkingIsAFreshArrival() {
        var s = AgentMarkSequencer(start: 0)
        s.set(.done, at: 5)
        s.set(.thinking, at: 8)
        #expect(same(s.dots(at: 8), AgentMarkFrames.arrival(at: 0)))
        #expect(same(s.dots(at: 8.07), AgentMarkFrames.arrival(at: 0.07)))
        // Done, then a command: the burst, with no fold of nothing.
        var c = AgentMarkSequencer(start: 0)
        c.set(.done, at: 5)
        c.set(.command, at: 8)
        #expect(same(c.dots(at: 8), AgentMarkFrames.burst(at: 0)))
    }

    @Test func aClockThatRunsBehindTheStageStartDrawsTheFirstFrameNotABlankOne() {
        let s = AgentMarkSequencer(start: 100)
        #expect(same(s.dots(at: 99.99), s.dots(at: 100)))
        #expect(!s.dots(at: 99.99).isEmpty)
        var c = AgentMarkSequencer(start: 100)
        c.set(.command, at: 105)
        #expect(same(c.dots(at: 104.9), c.dots(at: 105)))
    }

    // MARK: Shimmer

    @Test func shimmerFirstSweepComesSeventyHundredthsAfterTheLabelAppears() {
        #expect(AgentShimmer.bandCentre(elapsed: 0, width: 200) == nil)
        #expect(AgentShimmer.bandCentre(elapsed: 0.69, width: 200) == nil)
        let start = AgentShimmer.bandCentre(elapsed: 0.7, width: 200)
        #expect(start != nil)
        // The band begins clear of the label's left edge.
        #expect(abs((start ?? 0) + 65) < 0.001)
    }

    @Test func shimmerMovesAtAboutFourHundredEightyFivePointsASecondEveryThreeSeconds() {
        let a = AgentShimmer.bandCentre(elapsed: 0.7 + 0.1, width: 400)
        let b = AgentShimmer.bandCentre(elapsed: 0.7 + 0.2, width: 400)
        #expect(abs((b ?? 0) - (a ?? 0) - 48.5) < 0.001)
        // Repeats every 3.0 s while the label stays up.
        let again = AgentShimmer.bandCentre(elapsed: 0.7 + 3.0 + 0.1, width: 400)
        #expect(abs((again ?? 0) - (a ?? 0)) < 0.001)
        // Between sweeps there is no band.
        #expect(AgentShimmer.bandCentre(elapsed: 0.7 + 2.0, width: 400) == nil)
        // A longer label takes longer to cross: constant speed.
        #expect(AgentShimmer.sweepDuration(width: 400) > AgentShimmer.sweepDuration(width: 140))
        #expect(abs(AgentShimmer.sweepDuration(width: 485 - 130) - 1.0) < 0.001)
    }

    @Test func timerAndFirstLabelTimings() {
        #expect(AgentShimmer.timerAfter == 5)
        #expect(AgentShimmer.firstLabelDelay == 0.6)
    }

    // MARK: Easing

    @Test func easingCurvesMatchTheBrandCurves() {
        // cubic-bezier(0.22, 1, 0.36, 1) is front-loaded: nearly done at 40%.
        #expect(Ease.out(0.4) > 0.88)
        #expect(Ease.out(0) == 0 && Ease.out(1) == 1)
        // The loop curve is symmetric.
        #expect(abs(Ease.inOut(0.5) - 0.5) < 0.0001)
        #expect(abs(Ease.inOut(0.3) + Ease.inOut(0.7) - 1) < 0.0001)
        // Shrinks start slow.
        #expect(Ease.shrink(0.3) < 0.3)
    }

    // MARK: TurnActivity

    @Test func onlyABashStepRunsACommand() {
        #expect(TurnActivity.tool("bash", detail: "npm test").runsCommand)
        #expect(TurnActivity.tool("bash").runsCommand)
        #expect(!TurnActivity.tool("web_search").runsCommand)
        // install_cli also runs a command but is a step of its own ("Setting up a tool").
        #expect(!TurnActivity.tool("install_cli").runsCommand)
        #expect(!TurnActivity.thinking.runsCommand)
        #expect(!TurnActivity.working.runsCommand)
        #expect(TurnActivity.tool("bash").label == "Running a command")
        #expect(TurnActivity.tool("web_search").label == "Searching the web")
    }

    // MARK: Label hold

    @Test func aLabelStaysUpForAtLeastEightHundredMilliseconds() {
        var hold = LabelHold("Thinking", at: 100)
        hold.offer("Running a command", at: 100.3)
        #expect(hold.shown(at: 100.3) == "Thinking")
        #expect(hold.shown(at: 100.79) == "Thinking")
        #expect(hold.shown(at: 100.8) == "Running a command")
        #expect(abs((hold.due ?? 0) - 100.8) < 1e-9)
    }

    @Test func aRapidLabelSequenceCoalescesToTheLatestOne() {
        // Thinking, a command, thinking, a command, a search: all within 0.5 s.
        var hold = LabelHold("Thinking", at: 100)
        hold.offer("Running a command", at: 100.1)
        hold.offer("Thinking", at: 100.2)
        hold.offer("Running a command", at: 100.3)
        hold.offer("Searching the web", at: 100.5)
        // Nothing changes until the first label's hold ends, and then only
        // the last offer shows: the ones in between never appear.
        for t in stride(from: 100.0, to: 100.79, by: 0.01) { #expect(hold.shown(at: t) == "Thinking") }
        #expect(hold.shown(at: 100.8) == "Searching the web")
        // It then holds for its own 0.8 s.
        hold.offer("Thinking", at: 101.0)
        #expect(hold.shown(at: 101.0) == "Searching the web")
        #expect(hold.shown(at: 101.59) == "Searching the web")
        #expect(hold.shown(at: 101.6) == "Thinking")
    }

    @Test func swapsAreAtLeastAHoldApartSoCrossfadesNeverOverlap() {
        var hold = LabelHold("a", at: 0)
        var swaps: [Double] = []
        var last = hold.shown
        // A new label every 50 ms for 5 s.
        var n = 0
        for step in 0..<100 {
            let t = Double(step) * 0.05
            hold.offer("label \(n)", at: t)
            n += 1
            for dt in stride(from: 0.0, to: 0.05, by: 0.001) {
                let shown = hold.shown(at: t + dt)
                if shown != last {
                    swaps.append(t + dt)
                    last = shown
                }
            }
        }
        #expect(swaps.count >= 5)
        for (a, b) in zip(swaps, swaps.dropFirst()) { #expect(b - a >= 0.8 - 0.002) }
    }

    @Test func offeringTheShownLabelAgainDropsAPendingOne() {
        var hold = LabelHold("Thinking", at: 100)
        hold.offer("Running a command", at: 100.2)
        hold.offer("Thinking", at: 100.4)
        #expect(hold.due == nil)
        #expect(hold.shown(at: 105) == "Thinking")
    }

    @Test func aRestartBetweenAnOfferAndItsDueTimeStillShowsThePendingLabel() {
        // The reveal restarts the hold while a label waits: the due time moves
        // later, so a waiter that woke at the old time must go on waiting, and
        // the label must show once the new time comes.
        var hold = LabelHold("Thinking", at: 100)
        hold.offer("Running a command", at: 100.3)
        #expect(abs((hold.due ?? 0) - 100.8) < 1e-9)
        hold.restart(at: 100.6)
        let due = hold.due
        #expect(due != nil && abs((due ?? 0) - 101.4) < 1e-9)
        // The woken-early waiter settles at 100.8 and finds nothing to do ...
        hold.settle(at: 100.8)
        #expect(hold.shown == "Thinking")
        #expect(hold.due != nil)
        // ... and the loop's next wake, at the new due time, shows it.
        hold.settle(at: 101.4)
        #expect(hold.shown == "Running a command")
        #expect(hold.due == nil)
    }

    @Test func aLabelThatOnlyBecameVisibleLaterHoldsFromThen() {
        var hold = LabelHold("Thinking", at: 100)
        hold.restart(at: 100.6)
        hold.offer("Running a command", at: 100.7)
        #expect(hold.shown(at: 101.3) == "Thinking")
        #expect(hold.shown(at: 101.4) == "Running a command")
    }
}

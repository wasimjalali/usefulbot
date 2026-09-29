import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct BrandMotionTests {
    private func motion() throws -> BrandMotion {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("brand/source/motion.json"))
        let motion = try JSONDecoder().decode(BrandMotion.self, from: data)
        try motion.validate()
        return motion
    }

    @Test func approvedKeyframesMatchTheSVG() throws {
        let motion = try motion()
        #expect(motion.duration == 2.8)
        #expect(motion.frame(at: 0) == BrandMotion.Frame())
        #expect(abs(motion.frame(at: 1.176).wave + 3) < 0.00001)
        #expect(abs(motion.frame(at: 1.176).float + 7) < 0.00001)
        #expect(abs(motion.frame(at: 1.792).blink - 0.08) < 0.00001)
        #expect(abs(motion.frame(at: 2.268).squashX - 1.012) < 0.00001)
        #expect(abs(motion.frame(at: 2.268).squashY - 0.988) < 0.00001)
    }

    @Test func launchSettlesAndReducedMotionIsAlwaysIdle() throws {
        let motion = try motion()
        for time in [0.0, 0.7, 1.176, 1.792, 2.268, 2.8, 20] {
            #expect(motion.frame(at: time, reducedMotion: true) == BrandMotion.Frame())
        }
        #expect(motion.frame(at: 2.8) == BrandMotion.Frame())
        let end = motion.frame(at: 20, repeating: false)
        #expect(abs(end.float) < 0.00001)
        #expect(abs(end.squashX - 1) < 0.00001)
        #expect(motion.frame(at: .nan) == BrandMotion.Frame())
    }

    @Test func motionStaysInsideItsSmallApprovedRange() throws {
        let motion = try motion()
        for tick in 0...280 {
            let frame = motion.frame(at: Double(tick) / 100)
            #expect((-7.00001...0.00001).contains(frame.float))
            #expect((-3.00001...1.00001).contains(frame.wave))
            #expect((0.07999...1.00001).contains(frame.blink))
            #expect((0.99499...1.01201).contains(frame.squashX))
        }
        let intermediate = motion.frame(at: 0.63).float
        #expect(intermediate < 0 && intermediate > -7)
    }

    @Test func malformedTimingFailsLoudly() throws {
        let source = """
        {"duration":0,"float":[],"wave":[],"blink":[],"squashX":[],"squashY":[]}
        """
        let motion = try JSONDecoder().decode(BrandMotion.self, from: Data(source.utf8))
        #expect(throws: BrandMotion.InvalidTiming.self) { try motion.validate() }
    }
}

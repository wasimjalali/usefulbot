import Foundation

/// Decodes brand/source/motion.json, shared with the SVG animation generator.
public struct BrandMotion: Decodable, Sendable {
    public let duration: Double
    let float: [[Double]]
    let wave: [[Double]]
    let blink: [[Double]]
    let squashX: [[Double]]
    let squashY: [[Double]]

    public struct Frame: Equatable, Sendable {
        public var float: Double = 0
        public var wave: Double = 0
        public var blink: Double = 1
        public var squashX: Double = 1
        public var squashY: Double = 1
        public init() {}
    }

    public func frame(at elapsed: TimeInterval, repeating: Bool = true, reducedMotion: Bool = false) -> Frame {
        guard !reducedMotion, elapsed.isFinite, elapsed > 0 else { return Frame() }
        let time = repeating ? elapsed.truncatingRemainder(dividingBy: duration) : min(elapsed, duration)
        let percent = time / duration * 100
        var frame = Frame()
        frame.float = value(float, at: percent)
        frame.wave = value(wave, at: percent)
        frame.blink = value(blink, at: percent)
        frame.squashX = value(squashX, at: percent)
        frame.squashY = value(squashY, at: percent)
        return frame
    }

    public func validate() throws {
        guard duration.isFinite, duration > 0 else { throw InvalidTiming() }
        for track in [float, wave, blink, squashX, squashY] {
            guard track.count >= 2, track.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isFinite) }),
                  track.first?[0] == 0, track.last?[0] == 100 else { throw InvalidTiming() }
            for pair in zip(track, track.dropFirst()) where pair.0[0] >= pair.1[0] { throw InvalidTiming() }
        }
    }

    public struct InvalidTiming: Error {}

    private func value(_ track: [[Double]], at percent: Double) -> Double {
        for (start, end) in zip(track, track.dropFirst()) where percent <= end[0] {
            let progress = max(0, min(1, (percent - start[0]) / (end[0] - start[0])))
            return start[1] + (end[1] - start[1]) * Self.easeInOut(progress)
        }
        return track[track.count - 1][1]
    }

    // CSS ease-in-out is cubic-bezier(.42, 0, .58, 1), not a sine wave.
    private static func easeInOut(_ progress: Double) -> Double {
        var low = 0.0, high = 1.0
        for _ in 0..<24 {
            let t = (low + high) / 2, inverse = 1 - t
            let x = 3 * inverse * inverse * t * 0.42 + 3 * inverse * t * t * 0.58 + t * t * t
            if x < progress { low = t } else { high = t }
        }
        let t = (low + high) / 2
        return 3 * (1 - t) * t * t + t * t * t
    }
}

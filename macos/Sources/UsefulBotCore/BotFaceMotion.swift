import Foundation

/// What a bot's face is doing. The eyes carry the state: a glance up while
/// it thinks, a left-to-right scan while it writes, a look down while a tool
/// runs. An idle face never moves.
public enum BotFacePose: Equatable, Sendable {
    case idle
    case thinking
    case writing
    case tool

    public init(activity: TurnActivity) {
        switch activity {
        case .thinking, .compacting: self = .thinking
        case .working: self = .writing
        case .tool, .subagent: self = .tool
        }
    }
}

/// The face's motion as data, in the face's own units (the 768-unit square
/// of brand/source/avatar-face.svg, y down). The macOS view installs each
/// track as a Core Animation keyframe animation, so the loops run on the
/// render server at the display's rate with no per-frame app work.
public enum BotFaceMotion {
    public enum Part: Sendable { case body, eyes, eye }
    public enum Property: Sendable { case translateX, translateY, scaleX, scaleY, rotation }

    public struct Track: Equatable, Sendable {
        public let part: Part
        public let property: Property
        public let duration: Double
        /// 0...1, ascending, first 0 and last 1.
        public let keyTimes: [Double]
        /// Offsets from rest: 0 for translation and rotation (radians), 1 for scale.
        public let values: [Double]
    }

    /// The looping tracks for a pose. Idle has none.
    public static func tracks(for pose: BotFacePose) -> [Track] {
        switch pose {
        case .idle:
            return []
        case .thinking:
            let d = 2.6
            return [
                Track(part: .eyes, property: .translateX, duration: d,
                      keyTimes: [0, 0.12, 0.28, 0.62, 0.78, 1], values: [0, 0, 14, 14, 0, 0]),
                Track(part: .eyes, property: .translateY, duration: d,
                      keyTimes: [0, 0.12, 0.28, 0.62, 0.78, 1], values: [0, 0, -14, -14, 0, 0]),
                Track(part: .body, property: .translateY, duration: d,
                      keyTimes: [0, 0.12, 0.40, 0.62, 0.78, 1], values: [0, 0, -12, -8, 0, 0]),
                blink(duration: d, at: 0.84),
            ]
        case .writing:
            return [
                Track(part: .eyes, property: .translateX, duration: 1.3,
                      keyTimes: [0, 0.72, 0.86, 1], values: [-16, 16, -16, -16]),
                Track(part: .eyes, property: .translateY, duration: 1.3,
                      keyTimes: [0, 1], values: [6, 6]),
                blink(duration: 3.9, at: 0.92),
            ]
        case .tool:
            let tilt = 4 * Double.pi / 180
            return [
                Track(part: .eyes, property: .translateY, duration: 0.9,
                      keyTimes: [0, 1], values: [16, 16]),
                Track(part: .body, property: .rotation, duration: 0.9,
                      keyTimes: [0, 0.25, 0.75, 1], values: [0, -tilt, tilt, 0]),
                blink(duration: 2.7, at: 0.92),
            ]
        }
    }

    /// Where the eyes rest when motion is reduced: the pose, held still.
    public static func stillEyes(for pose: BotFacePose) -> (x: Double, y: Double) {
        switch pose {
        case .idle: return (0, 0)
        case .thinking: return (14, -14)
        case .writing: return (0, 6)
        case .tool: return (0, 16)
        }
    }

    /// One squash, hop and settle when a reply lands in a chat that isn't open.
    public static let hop: [Track] = {
        let d = 0.9
        let times = [0, 0.172, 0.483, 0.793, 1]
        return [
            Track(part: .body, property: .translateY, duration: d, keyTimes: times, values: [0, 0, -100, 0, 0]),
            Track(part: .body, property: .scaleX, duration: d, keyTimes: times, values: [1, 1.08, 0.95, 1.06, 1]),
            Track(part: .body, property: .scaleY, duration: d, keyTimes: times, values: [1, 0.9, 1.06, 0.94, 1]),
        ]
    }()

    private static func blink(duration: Double, at start: Double) -> Track {
        let step = 0.04 * 2.6 / duration
        return Track(part: .eye, property: .scaleY, duration: duration,
                     keyTimes: [0, start, start + step, start + 2 * step, 1], values: [1, 1, 0.1, 1, 1])
    }
}

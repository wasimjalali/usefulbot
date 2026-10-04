import Foundation

/// Native port of shared/bot-face.ts. The web version had a signed-bitwise bug
/// in randomFace (negative indices produced undefined shapes); this one works
/// in UInt32 throughout.
public enum FacePalette {
    public static let shapes = ["circle", "oval", "square", "pill", "triangle", "hex", "blob", "drop"]
    /// The picker's grid: 10 hues in three tones, one row per tone. Neutral
    /// light keeps the legacy id "ink" (the default bot's color).
    public static let hues = ["neutral", "red", "orange", "amber", "yellow", "green", "teal", "sky", "blue", "lilac"]
    public static let tones = ["light", "mid", "deep"]
    public static let gridColors: [String] = tones.flatMap { tone in
        hues.map { hue in hue == "neutral" && tone == "light" ? "ink" : "\(hue)-\(tone)" }
    }
    /// Ids from before the grid. They still validate and render for bots that
    /// have them, but the picker no longer offers them.
    public static let legacyColors = [
        "brown", "red", "orange", "gold", "green", "teal", "blue", "purple", "pink", "gray",
    ]
    public static let colors = gridColors + legacyColors
    // The authoritative tint palette is brand/source/avatar-palette.json.
    // Legacy shape IDs remain decodable, but aren't selectable or rendered.

    public struct Face: Equatable, Sendable {
        public var shape: String
        public var color: String
        public init(shape: String, color: String) {
            self.shape = shape
            self.color = color
        }
    }

    public static func isShape(_ value: String?) -> Bool {
        guard let value else { return false }
        return shapes.contains(value)
    }

    public static func isColor(_ value: String?) -> Bool {
        guard let value else { return false }
        return colors.contains(value)
    }

    public static func defaultFace(for id: String) -> Face {
        // Walk UTF-16 code units like `charCodeAt` in `shared/bot-face.ts` so both sides
        // derive the same face for the same id, including emoji ids.
        var hash: UInt32 = 0
        for (index, unit) in id.utf16.enumerated() {
            hash = hash &+ (UInt32(unit) &* UInt32(index + 3))
        }
        return Face(
            shape: shapes[Int(hash % UInt32(shapes.count))],
            color: gridColors[Int((hash >> 3) % UInt32(gridColors.count))]
        )
    }

    public static func randomFace(seed: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)) -> Face {
        let mixed = splitmix64(seed)
        return Face(
            shape: shapes[Int(mixed % UInt64(shapes.count))],
            color: gridColors[Int((mixed >> 4) % UInt64(gridColors.count))]
        )
    }

    public static func displayColor(for bot: ShellBot) -> String {
        if bot.id == Threads.defaultBotId && !bot.avatarCustom { return "ink" }
        return isColor(bot.avatarColor) ? bot.avatarColor : "ink"
    }

    private static func splitmix64(_ value: UInt64) -> UInt64 {
        var z = value &+ 0x9E37_79B9_7F4A_7C15
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

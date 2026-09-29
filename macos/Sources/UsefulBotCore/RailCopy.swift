import Foundation

/// Copy the rail computes rather than stores.
public enum RailCopy {
    /// A section can be empty because its bots are pinned to the top or
    /// hidden; name the reason instead of leaving a dead header behind. A
    /// genuinely empty section still gets a line, so every header has a body.
    public static func emptySectionHint(pinned: Int, hidden: Int) -> String {
        var parts: [String] = []
        if pinned > 0 {
            parts.append(pinned == 1 ? "1 pinned bot shows at the top." : "\(pinned) pinned bots show at the top.")
        }
        if hidden > 0 {
            parts.append(hidden == 1 ? "1 bot here is hidden." : "\(hidden) bots here are hidden.")
        }
        if !parts.isEmpty { return parts.joined(separator: " ") }
        return "No bots here yet."
    }
}

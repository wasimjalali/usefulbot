import Foundation

/// Who a transcript row is attributed to. A row can name a bot the roster no
/// longer holds, or carry a name with no id at all, so the fallbacks live here
/// as pure decisions instead of inside the view.
public enum ChatAttribution {
    /// The face a row shows beside its text.
    public enum Face: Equatable, Sendable {
        /// The open chat's own bot.
        case owner
        /// A teammate the roster resolved.
        case speaker
        /// Attributed to a bot the roster no longer holds. The owner's face on
        /// another bot's words would be wrong, an empty slot is only a gap.
        case unknown
    }

    /// `speakerResolved` is true when `authorBotId` names a bot still in the
    /// roster.
    public static func face(
        authorBotId: String?,
        ownerBotId: String,
        speakerResolved: Bool
    ) -> Face {
        guard let authorBotId, authorBotId != ownerBotId else { return .owner }
        return speakerResolved ? .speaker : .unknown
    }

    /// The name line above a row: the live roster wins, then the stored author
    /// name, then nothing rather than a blank line.
    public static func label(speakerName: String?, author: String?) -> String? {
        let name = speakerName ?? author ?? ""
        return name.isEmpty ? nil : name.uppercased()
    }

    /// The trailing name on a cross-bot strip ("Messaged Growth", "Message
    /// from CEO"): a live roster name, else the stored name, else a count.
    public static func metaLabel(idCount: Int, resolved: [String], names: [String]) -> String {
        if idCount > 1 { return "\(idCount) Bots" }
        if let name = resolved.first(where: { !$0.isEmpty }) { return name }
        if let name = names.first(where: { !$0.isEmpty }) { return name }
        return idCount == 1 ? "1 Bot" : "Bot"
    }
}

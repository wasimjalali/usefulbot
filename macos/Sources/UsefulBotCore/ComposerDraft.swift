import Foundation

/// Pure composer bookkeeping, kept out of the app target so it can be tested.
public enum ComposerDraft {
    /// What remains of the draft after a send is accepted:
    /// - the exact sent text clears fully,
    /// - a draft that still carries the sent text as a prefix keeps only what
    ///   was typed after it,
    /// - anything else (an edit or replacement) is left untouched.
    public static func remainder(_ draft: String, afterSending sent: String) -> String {
        if draft == sent { return "" }
        if draft.hasPrefix(sent) { return String(draft.dropFirst(sent.count)) }
        return draft
    }

    /// Trim to a UTF-16 unit budget without splitting a grapheme, matching
    /// what the server keeps.
    public static func clip(_ text: String, toUTF16 limit: Int) -> String {
        var result = ""
        var units = 0
        for character in text {
            let count = character.utf16.count
            if units + count > limit { break }
            result.append(character)
            units += count
        }
        return result
    }

}

/// A sent message folds in the transcript the way Claude.ai and Slack fold
/// one: by how much of the screen it takes, not by how it is punctuated. The
/// bubble shows its first `previewLines` rendered lines and a Show more, and
/// only when what is hidden is worth a button (`hidesEnough`): folding a
/// nine-line message to eight just trades one line for a control.
public enum LongMessage {
    public static let previewLines = 8
    /// The least a fold has to hide, in points: about two chat lines.
    public static let minHiddenHeight: CGFloat = 40

    /// A cheap gate before any measuring: a message this short cannot fill
    /// `previewLines` lines even in the narrowest bubble (160 points, about
    /// 18 characters a line), so its row never measures.
    public static func mayFold(_ text: String) -> Bool {
        let newlines = text.filter { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }.count
        return newlines >= previewLines || text.count > 150
    }

    /// Whether the measured full height hides enough behind the preview.
    public static func hidesEnough(full: CGFloat, preview: CGFloat) -> Bool {
        full - preview >= minHiddenHeight
    }
}

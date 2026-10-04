import Foundation

/// Routing and attribution, ported from `shared/threads.ts`. Pure functions so
/// the transcript can label a group reply with the member it answered as.
public struct Speaker: Equatable, Sendable {
    public let id: String
    public let kind: String
    public let name: String
    public let title: String
    public let hidden: Bool

    public init(id: String, kind: String, name: String, title: String, hidden: Bool = false) {
        self.id = id
        self.kind = kind
        self.name = name
        self.title = title
        self.hidden = hidden
    }
}

public enum Threads {
    public static let groupMinMembers = 2
    public static let groupMaxMembers = 6
    public static let groupRosterMax = 6
    public static let defaultBotId = "bot-useful"
    /// Upper bound on the number of names and ids folded into the mention
    /// regex. A pathological roster must not build an unbounded alternation.
    /// Longest names sort first, so the most specific matches survive the cap.
    public static let mentionSourceMax = 64

    public static func speakers(from bots: [ShellBot]) -> [Speaker] {
        bots.map {
            Speaker(id: $0.id, kind: $0.kind, name: $0.name, title: $0.label, hidden: $0.hidden)
        }
    }

    /// The server's orchestrator rule (shared/shell-store.ts orchestratorId):
    /// the default bot while it is present and visible, else the first visible
    /// 1:1 bot. Nil when no visible 1:1 bot exists.
    public static func orchestrator(in speakers: [Speaker]) -> Speaker? {
        let visible = speakers.filter { $0.kind == "bot" && !$0.hidden }
        return visible.first { $0.id == defaultBotId } ?? visible.first
    }

    /// The orchestrator is never a member; it defaults to the default bot.
    public static func groupMembers(
        _ speakers: [Speaker],
        memberIds: [String],
        orchestratorId: String? = defaultBotId
    ) -> [Speaker] {
        var members: [Speaker] = []
        for id in memberIds {
            if members.contains(where: { $0.id == id }) { continue }
            guard let bot = speakers.first(where: { $0.id == id }) else { continue }
            guard bot.kind == "bot", bot.id != defaultBotId, bot.id != orchestratorId, !bot.hidden else { continue }
            members.append(bot)
            if members.count >= groupRosterMax { break }
        }
        return members
    }

    public static func parseMentions(
        _ text: String,
        bots: [Speaker]
    ) -> (mentionIds: [String], unknown: [String]) {
        var mentionIds: [String] = []
        var unknown: [String] = []
        var seen = Set<String>()
        func claim(_ id: String) {
            if seen.contains(id) { return }
            seen.insert(id)
            mentionIds.append(id)
        }

        let named = Array(
            bots
                .map { (bot: $0, name: $0.name.trimmingCharacters(in: .whitespacesAndNewlines)) }
                .filter { !$0.name.isEmpty }
                .sorted { $0.name.count > $1.name.count }
                .prefix(mentionSourceMax)
        )

        if !named.isEmpty {
            let pattern = named.map { NSRegularExpression.escapedPattern(for: $0.name) }.joined(separator: "|")
            if let regex = try? NSRegularExpression(pattern: "@(?:\(pattern))(?![\\w-])", options: [.caseInsensitive]) {
                for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    guard let range = Range(match.range, in: text) else { continue }
                    let name = String(text[range].dropFirst()).lowercased()
                    if let hit = named.first(where: { $0.name.lowercased() == name }) {
                        claim(hit.bot.id)
                    }
                }
            }
        }

        let ids = Array(
            bots
                .filter { $0.id.range(of: "^[\\w.:-]+$", options: .regularExpression) != nil }
                .prefix(mentionSourceMax)
        )
        if !ids.isEmpty {
            let pattern = ids.map { NSRegularExpression.escapedPattern(for: $0.id) }.joined(separator: "|")
            if let regex = try? NSRegularExpression(pattern: "@(\(pattern))(?![\\w-])", options: [.caseInsensitive]) {
                for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    guard let range = Range(match.range(at: 1), in: text) else { continue }
                    let token = String(text[range]).lowercased()
                    if let hit = ids.first(where: { $0.id.lowercased() == token }) {
                        claim(hit.id)
                    }
                }
            }
        }

        if let any = try? NSRegularExpression(pattern: "@([^\\s@,.;:!?]+)") {
            for match in any.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let range = Range(match.range(at: 1), in: text) else { continue }
                let token = String(text[range])
                let known = named.contains { $0.name.lowercased().hasPrefix(token.lowercased()) }
                    || ids.contains { $0.id.lowercased() == token.lowercased() }
                if !known && !unknown.contains(token) { unknown.append(token) }
            }
        }
        return (mentionIds, unknown)
    }

    /// Transcript label for the bot a routed turn answered as, matching
    /// `speakerLabel` in `shared/threads.ts`. A group reply is the
    /// orchestrator's, whoever the owner mentioned: the member does not speak.
    public static func speakerLabel(
        bot: ShellBot?,
        orchestrator: Speaker? = nil
    ) -> (authorBotId: String?, authorName: String?) {
        guard let bot, bot.id != defaultBotId else { return (nil, nil) }
        if bot.kind != "group" { return (bot.id, bot.name) }
        let id = orchestrator.flatMap { $0.id == defaultBotId ? nil : $0.id }
        return (id, orchestrator?.name)
    }
}

import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ThreadsTests {
    private func speakers() -> [Speaker] {
        [
            Speaker(id: "b1", kind: "bot", name: "Research", title: ""),
            Speaker(id: "b2", kind: "bot", name: "Research Lead", title: ""),
            Speaker(id: "b3", kind: "bot", name: "Sam", title: ""),
        ]
    }

    @Test func mentionsMatchLongestNameFirstAndIgnoreCase() {
        let longest = Threads.parseMentions("@Research Lead take this", bots: speakers())
        #expect(longest.mentionIds == ["b2"])
        let both = Threads.parseMentions("@research and @SAM please", bots: speakers())
        #expect(both.mentionIds == ["b1", "b3"])
        let unknown = Threads.parseMentions("@nobody look", bots: speakers())
        #expect(unknown.mentionIds.isEmpty)
        #expect(unknown.unknown == ["nobody"])
    }

    @Test func aBotNamedSamDoesNotCatchSamantha() {
        let mentions = Threads.parseMentions("@Samantha hello", bots: speakers())
        #expect(mentions.mentionIds.isEmpty)
    }

    @Test func idsResolveAfterNames() {
        let mentions = Threads.parseMentions("@b3 here", bots: speakers())
        #expect(mentions.mentionIds == ["b3"])
    }

    @Test func mentionScanCapsTheRegexSourceWithoutLosingLongNames() {
        // A large roster must not build an unbounded alternation; the cap
        // keeps the longest names, so the most specific mention still wins.
        var roster: [Speaker] = (0..<200).map {
            Speaker(id: "b\($0)", kind: "bot", name: "Bot\($0)", title: "")
        }
        roster.append(Speaker(id: "long", kind: "bot", name: "A Very Long Name", title: ""))
        let mentions = Threads.parseMentions("@A Very Long Name go", bots: roster)
        #expect(mentions.mentionIds == ["long"])
    }

    @Test func groupMembersExcludeTheDefaultBotGroupsAndHiddenBots() {
        let roster = [
            Speaker(id: "bot-useful", kind: "bot", name: "Useful Bot", title: ""),
            Speaker(id: "g1", kind: "group", name: "Room", title: ""),
            Speaker(id: "b1", kind: "bot", name: "Research", title: ""),
            Speaker(id: "b2", kind: "bot", name: "Hidden", title: "", hidden: true),
            Speaker(id: "b3", kind: "bot", name: "Writer", title: ""),
        ]
        let members = Threads.groupMembers(roster, memberIds: ["bot-useful", "g1", "b1", "b2", "b3"])
        #expect(members.map(\.id) == ["b1", "b3"])
    }

    @Test func speakerLabelPicksTheMentionedMemberForAGroup() {
        let group = ShellBot.sample(id: "g1", kind: "group", name: "Launch")
        let roster = speakers()
        let labelled = Threads.speakerLabel(bot: group, speakers: roster, mentionIds: ["b2"])
        #expect(labelled.authorBotId == "b2")
        #expect(labelled.authorName == "Research Lead")
        let untargeted = Threads.speakerLabel(bot: group, speakers: roster, mentionIds: [])
        #expect(untargeted.authorName == "Useful Bot")
        #expect(untargeted.authorBotId == nil)
    }

    @Test func speakerLabelForAOneOnOneBotIsItself() {
        let bot = ShellBot.sample(id: "b1", kind: "bot", name: "Research")
        let labelled = Threads.speakerLabel(bot: bot, speakers: speakers(), mentionIds: [])
        #expect(labelled.authorBotId == "b1")
    }
}

extension ShellBot {
    /// Test-only convenience: the decoder is the production path, so build the
    /// JSON and decode rather than adding a second initializer.
    static func sample(id: String, kind: String, name: String) -> ShellBot {
        let json = """
        {"id":"\(id)","kind":"\(kind)","name":"\(name)","label":"","description":"","memberIds":[]}
        """
        return try! JSONDecoder().decode(ShellBot.self, from: Data(json.utf8))
    }
}

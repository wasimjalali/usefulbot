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

    @Test func orchestratorIsTheDefaultBotWhileVisibleElseTheFirstVisibleBot() {
        let def = Speaker(id: Threads.defaultBotId, kind: "bot", name: "Useful Bot", title: "")
        let group = Speaker(id: "g1", kind: "group", name: "Team", title: "")
        let hiddenFirst = Speaker(id: "h1", kind: "bot", name: "Hidden", title: "", hidden: true)
        let sam = Speaker(id: "b3", kind: "bot", name: "Sam", title: "")
        #expect(Threads.orchestrator(in: [sam, def, group])?.id == Threads.defaultBotId)
        #expect(Threads.orchestrator(in: [group, hiddenFirst, sam, def])?.id == Threads.defaultBotId)
        let hiddenDefault = Speaker(id: Threads.defaultBotId, kind: "bot", name: "Useful Bot", title: "", hidden: true)
        #expect(Threads.orchestrator(in: [group, hiddenDefault, hiddenFirst, sam])?.id == "b3")
        #expect(Threads.orchestrator(in: [group, hiddenFirst]) == nil)
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

    @Test func aGroupReplyIsCreditedToTheOrchestratorNeverTheMember() {
        let group = ShellBot.sample(id: "g1", kind: "group", name: "Launch")
        let roster = speakers()
        // No orchestrator named: no name and no bot id, never a made-up one.
        let plain = Threads.speakerLabel(bot: group)
        #expect(plain.authorName == nil)
        #expect(plain.authorBotId == nil)
        // The default bot as orchestrator: its real name, still no bot id.
        let generalist = Speaker(id: "bot-useful", kind: "bot", name: "Generalist", title: "")
        let byDefault = Threads.speakerLabel(bot: group, orchestrator: generalist)
        #expect(byDefault.authorName == "Generalist")
        #expect(byDefault.authorBotId == nil)
        // A fallback orchestrator is credited by id and name, never a member of the roster.
        let fallback = roster[0]
        let credited = Threads.speakerLabel(bot: group, orchestrator: fallback)
        #expect(credited.authorBotId == fallback.id)
        #expect(credited.authorName == fallback.name)
    }

    @Test func groupMembersExcludeTheOrchestratorWhoeverItIs() {
        let roster = [
            Speaker(id: "b1", kind: "bot", name: "Research", title: ""),
            Speaker(id: "b3", kind: "bot", name: "Writer", title: ""),
        ]
        let members = Threads.groupMembers(roster, memberIds: ["b1", "b3"], orchestratorId: "b1")
        #expect(members.map(\.id) == ["b3"])
    }

    @Test func speakerLabelForAOneOnOneBotIsItself() {
        let bot = ShellBot.sample(id: "b1", kind: "bot", name: "Research")
        let labelled = Threads.speakerLabel(bot: bot)
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

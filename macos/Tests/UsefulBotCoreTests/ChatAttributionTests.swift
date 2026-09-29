import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ChatAttributionTests {
    @Test func anAuthorTheRosterLostShowsNoFaceRatherThanTheOwners() {
        #expect(ChatAttribution.face(authorBotId: "gone", ownerBotId: "owner", speakerResolved: false) == .unknown)
        #expect(ChatAttribution.face(authorBotId: "mate", ownerBotId: "owner", speakerResolved: true) == .speaker)
        #expect(ChatAttribution.face(authorBotId: "owner", ownerBotId: "owner", speakerResolved: false) == .owner)
        #expect(ChatAttribution.face(authorBotId: nil, ownerBotId: "owner", speakerResolved: false) == .owner)
    }

    @Test func theLabelFallsBackToTheStoredAuthorName() {
        #expect(ChatAttribution.label(speakerName: "Scout", author: "Stale") == "SCOUT")
        #expect(ChatAttribution.label(speakerName: nil, author: "Scout") == "SCOUT")
        #expect(ChatAttribution.label(speakerName: nil, author: "") == nil)
        #expect(ChatAttribution.label(speakerName: nil, author: nil) == nil)
    }

    @Test func theMetaLabelPrefersTheLiveRosterThenTheStoredName() {
        #expect(ChatAttribution.metaLabel(idCount: 1, resolved: ["Growth"], names: ["Stale"]) == "Growth")
        #expect(ChatAttribution.metaLabel(idCount: 1, resolved: [], names: ["a teammate"]) == "a teammate")
        #expect(ChatAttribution.metaLabel(idCount: 2, resolved: ["Growth"], names: []) == "2 Bots")
        #expect(ChatAttribution.metaLabel(idCount: 1, resolved: [], names: [""]) == "1 Bot")
        #expect(ChatAttribution.metaLabel(idCount: 0, resolved: [], names: []) == "Bot")
    }
}

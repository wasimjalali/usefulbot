import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ShellActionsTests {
    @Test func updateBotSendsNullsForClearedFields() throws {
        let action = ShellActions.updateBot(botId: "b1", patch: [
            "name": "Scout",
            "label": "",
            "avatarImage": nil,
        ])
        #expect(action["type"] as? String == "updateBot")
        let patch = try #require(action["patch"] as? [String: Any])
        #expect(patch["name"] as? String == "Scout")
        #expect(patch["avatarImage"] is NSNull)
    }

    @Test func setSessionSendsNullToDropThePointer() throws {
        let dropped = ShellActions.setSession(botId: "b1", sessionId: nil)
        #expect(dropped["type"] as? String == "setSession")
        #expect(dropped["sessionId"] is NSNull)
        let set = ShellActions.setSession(botId: "b1", sessionId: "wrun_1")
        #expect(set["sessionId"] as? String == "wrun_1")
    }

    @Test func moveToUnassignedSendsNull() throws {
        let action = ShellActions.move(botId: "b1", sectionId: nil)
        #expect(action["sectionId"] is NSNull)
        let pinned = ShellActions.pin(botId: "b1", pinned: true)
        #expect(pinned["pinned"] as? Bool == true)
    }

    @Test func createBotProposalConfirmMatchesEveryPayloadField() throws {
        let proposal = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p1","kind":"createBot","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "name":"Scout","petname":"New Bot 2","title":"Research","description":"Find things",
         "sectionId":"s1"}
        """.utf8))
        let action = try #require(ProposalActions.confirm(proposal))
        #expect(action["type"] as? String == "createBot")
        #expect(action["name"] as? String == "Scout")
        #expect(action["petname"] as? String == "New Bot 2")
        #expect(action["label"] as? String == "Research")
        #expect(action["description"] as? String == "Find things")
        #expect(action["sectionId"] as? String == "s1")
    }

    @Test func profileConfirmCarriesValidFacesAndDropsPetname() throws {
        let valid = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p2","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Scout","title":"Lead","description":"D","avatarShape":"hex","avatarColor":"blue","petname":"Scout Two"}}
        """.utf8))
        let patch = try #require(ProposalActions.confirm(valid)?["patch"] as? [String: Any])
        #expect(patch["name"] as? String == "Scout")
        #expect(patch["label"] as? String == "Lead")
        #expect(patch["avatarShape"] as? String == "hex")
        #expect(patch["avatarColor"] as? String == "blue")
        #expect(patch["petname"] == nil)

        let invalid = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p3","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Scout","title":"Lead","description":"D","avatarShape":"nope"}}
        """.utf8))
        let clean = try #require(ProposalActions.confirm(invalid)?["patch"] as? [String: Any])
        #expect(clean["avatarShape"] == nil)
    }

    @Test func profileConfirmSendsNoDescriptionWhenTheCardHasNone() throws {
        let rename = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p5","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Analyst","title":"Lead"}}
        """.utf8))
        let patch = try #require(ProposalActions.confirm(rename)?["patch"] as? [String: Any])
        #expect(patch["name"] as? String == "Analyst")
        #expect(patch["description"] == nil)

        let withText = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p6","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Scout","title":"Lead","description":"Exact text"}}
        """.utf8))
        let kept = try #require(ProposalActions.confirm(withText)?["patch"] as? [String: Any])
        #expect(kept["description"] as? String == "Exact text")
    }

    @Test func fanoutConfirmTargetsTheGroupWhenThereIsOne() throws {
        let proposal = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p4","kind":"fanout","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "message":"ship it","targetIds":["b1","b2"],"groupId":"g1","sourceBotId":"b9"}
        """.utf8))
        let action = try #require(ProposalActions.confirm(proposal))
        #expect(action["botId"] as? String == "g1")
        #expect(action["message"] as? String == "ship it")
        #expect(action["sourceBotId"] as? String == "b9")
    }

    @Test func updateBotOmitsNilForFieldsThatDoNotClear() throws {
        let action = ShellActions.updateBot(botId: "b1", patch: [
            "name": nil,
            "label": nil,
            "petname": nil,
            "avatarImage": nil,
        ])
        let patch = try #require(action["patch"] as? [String: Any])
        #expect(patch["name"] == nil)
        #expect(patch["label"] == nil)
        #expect(patch["petname"] is NSNull)
        #expect(patch["avatarImage"] is NSNull)
    }

    @Test func pathComponentsEncodeSeparatorsAndPercent() {
        #expect(BackendClient.pathComponent("abc-123_x.y~z") == "abc-123_x.y~z")
        #expect(BackendClient.pathComponent("a/b") == "a%2Fb")
        #expect(BackendClient.pathComponent("a?b#c") == "a%3Fb%23c")
        #expect(BackendClient.pathComponent("%2F") == "%252F")
        #expect(BackendClient.pathComponent("..") == "_")
        #expect(BackendClient.pathComponent("") == "_")
    }

    @Test func shellErrorsSurfaceReadableCopy() {
        #expect(
            BackendError.shell("proposal_missing").errorDescription
                == "That proposal is no longer available."
        )
        #expect(BackendError.shell("custom_thing").errorDescription == "Custom Thing")
        #expect(BackendError.shell("proposal_missing").shellCode == "proposal_missing")
    }

    @Test func keychainExitCodesMapToDistinctErrors() {
        // 44 (errSecItemNotFound) is the only status that really means the
        // token is absent; the interactive failures are distinct.
        #expect(BackendClient.keychainFailure(for: 44) == .deviceTokenMissing)
        #expect(BackendClient.keychainFailure(for: 36) == .keychainLocked)
        #expect(BackendClient.keychainFailure(for: 51) == .keychainDenied)
        #expect(BackendClient.keychainFailure(for: 128) == .keychainCancelled)
        #expect(BackendClient.keychainFailure(for: 1) == .deviceTokenMissing)
        #expect(BackendError.keychainLocked.errorDescription != BackendError.deviceTokenMissing.errorDescription)
    }

    @Test func connectAppConfirmCarriesTheSlug() throws {
        let proposal = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p5","kind":"connectApp","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "slug":"notion","name":"Notion","purpose":"x","phase":"proposed"}
        """.utf8))
        let action = try #require(ProposalActions.confirm(proposal))
        #expect(action["type"] as? String == "connectApp")
        #expect(action["slug"] as? String == "notion")
        let blank = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p6","kind":"connectApp","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z","slug":""}
        """.utf8))
        #expect(ProposalActions.confirm(blank) == nil)
    }

    @Test func connectServerConfirmCarriesTheId() throws {
        let proposal = try JSONDecoder().decode(Proposal.self, from: Data("""
        {"id":"p7","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "connectionId":"excalidraw","name":"Excalidraw","authKind":"none","phase":"proposed"}
        """.utf8))
        let action = try #require(ProposalActions.confirm(proposal))
        #expect(action["type"] as? String == "connectServer")
        #expect(action["connectionId"] as? String == "excalidraw")
    }
}

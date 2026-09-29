import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ProposalTests {
    private func decode(_ json: String) throws -> Proposal {
        try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
    }

    @Test func decodesACreateBotProposal() throws {
        let proposal = try decode("""
        {"id":"p1","kind":"createBot","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "name":"Scout","petname":"New Bot 2","title":"Research","description":"Find things",
         "sectionId":null,"brief":"Find pricing","threadId":"bot-useful"}
        """)
        #expect(proposal.kind == .createBot)
        #expect(proposal.name == "Scout")
        #expect(proposal.petname == "New Bot 2")
        #expect(proposal.title == "Research")
        #expect(proposal.brief == "Find pricing")
        #expect(proposal.isOpen())
    }

    @Test func decodesAProfileProposalWithAPatch() throws {
        let proposal = try decode("""
        {"id":"p2","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Scout","petname":"Scout","title":"Research Lead",
         "description":"Owns research","avatarShape":"hex","avatarColor":"blue"}}
        """)
        #expect(proposal.botId == "b1")
        #expect(proposal.patch?.avatarShape == "hex")
        #expect(proposal.patch?.title == "Research Lead")
    }

    @Test func decodesAFanoutProposal() throws {
        let proposal = try decode("""
        {"id":"p3","kind":"fanout","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "message":"ship it","targetIds":["b1","b2"],"groupId":"g1","sourceBotId":"b9"}
        """)
        #expect(proposal.fanoutTargetId == "g1")
        #expect(proposal.sourceBotId == "b9")
    }

    @Test func aPrunedFanoutHasNoTarget() throws {
        let proposal = try decode("""
        {"id":"p4","kind":"fanout","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "message":"nobody","targetIds":[],"groupId":null}
        """)
        #expect(proposal.fanoutTargetId == nil)
        #expect(ProposalActions.confirm(proposal) == nil)
    }

    @Test func expiredOrAnsweredProposalsAreNotOpen() throws {
        let expired = try decode("""
        {"id":"p5","kind":"createBot","status":"pending","expiresAt":"2000-01-01T00:00:00.000Z","name":"Old"}
        """)
        #expect(!expired.isOpen())
        let dismissed = try decode("""
        {"id":"p6","kind":"createBot","status":"dismissed","expiresAt":"2099-01-01T00:00:00.000Z","name":"No"}
        """)
        #expect(!dismissed.isOpen())
    }

    @Test func unknownKindsNeverConfirm() throws {
        let proposal = try decode("""
        {"id":"p7","kind":"teleportBot","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "targetIds":["b1"],"message":"go"}
        """)
        #expect(proposal.kind == .unknown)
        #expect(ProposalActions.confirm(proposal) == nil)
    }

    @Test func profileProposalWithoutAPatchNeverConfirms() throws {
        let proposal = try decode("""
        {"id":"p8","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":null}
        """)
        #expect(proposal.patch == nil)
        #expect(ProposalActions.confirm(proposal) == nil)
    }

    @Test func unparseableExpiryIsClosed() throws {
        let proposal = try decode("""
        {"id":"p9","kind":"createBot","status":"pending","expiresAt":"not a date","name":"Scout"}
        """)
        #expect(!proposal.isOpen())
    }

    @Test func profileConfirmCarriesVisibleFieldsAndValidFaces() throws {
        // Name/title/description plus a valid avatar travel; petname is never
        // sent and the server's confirm would reject a mismatched avatar.
        let proposal = try decode("""
        {"id":"p10","kind":"updateBotProfile","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "botId":"b1","patch":{"name":"Scout","petname":"Scout Two","title":"Research","description":"Owns it",
          "avatarShape":"hex","avatarColor":"blue"}}
        """)
        let action = try #require(ProposalActions.confirm(proposal))
        let patch = try #require(action["patch"] as? [String: Any])
        #expect(patch["name"] as? String == "Scout")
        #expect(patch["label"] as? String == "Research")
        #expect(patch["petname"] == nil)
        #expect(patch["avatarShape"] as? String == "hex")
        #expect(patch["avatarColor"] as? String == "blue")
    }

    @Test func createConfirmRequiresAName() throws {
        let proposal = try decode("""
        {"id":"p12","kind":"createBot","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z"}
        """)
        #expect(ProposalActions.confirm(proposal) == nil)
    }

    @Test func decodesAConnectAppProposalInEveryPhase() throws {
        let cases: [(String, Proposal.ConnectPhase)] = [
            ("proposed", .proposed), ("waiting", .waiting), ("connected", .connected), ("expired", .expired), ("bogus", .proposed),
        ]
        for (raw, expected) in cases {
            let proposal = try decode("""
            {"id":"p4","kind":"connectApp","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
             "slug":"gmail","name":"Gmail","logo":"https://logos.composio.dev/api/gmail","purpose":"Find the invoice",
             "phase":"\(raw)","accountId":null,"waitingSince":null,"toolCount":31,"threadId":"b1","sourceBotId":"b1"}
            """)
            #expect(proposal.kind == .connectApp)
            #expect(proposal.slug == "gmail")
            #expect(proposal.logo == "https://logos.composio.dev/api/gmail")
            #expect(proposal.purpose == "Find the invoice")
            #expect(proposal.phase == expected)
            #expect(proposal.toolCount == 31)
            #expect(proposal.isOpen())
        }
    }

    @Test func decodesAConnectServerProposal() throws {
        let proposal = try decode("""
        {"id":"p7","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "connectionId":"excalidraw","name":"Excalidraw","urlHost":"mcp.excalidraw.com",
         "purpose":"Draw a cat","authKind":"none","phase":"proposed","threadId":"b1"}
        """)
        #expect(proposal.kind == .connectServer)
        #expect(proposal.connectionId == "excalidraw")
        #expect(proposal.urlHost == "mcp.excalidraw.com")
        #expect(proposal.authKind == .none)
        #expect(proposal.phase == .proposed)
        let action = try #require(ProposalActions.confirm(proposal))
        #expect(action["type"] as? String == "connectServer")
        #expect(action["connectionId"] as? String == "excalidraw")
    }

    @Test func serverRedirectsFailClosedWithoutAStoredHost() {
        #expect(!Proposal.connectRedirectAllowed(
            "https://auth.example.com/authorize",
            kind: .connectServer,
            expectedHost: nil
        ))
        #expect(!Proposal.connectRedirectAllowed(
            "https://auth.example.com/authorize",
            kind: .connectServer,
            expectedHost: ""
        ))
        #expect(!Proposal.connectRedirectAllowed(
            "https://evil.example.com/authorize",
            kind: .connectServer,
            expectedHost: "auth.example.com"
        ))
        #expect(Proposal.connectRedirectAllowed(
            "https://auth.example.com/authorize?x=1",
            kind: .connectServer,
            expectedHost: "auth.example.com"
        ))
        #expect(!Proposal.connectRedirectAllowed(
            "http://auth.example.com/authorize",
            kind: .connectServer,
            expectedHost: "auth.example.com"
        ))
        #expect(Proposal.connectRedirectAllowed(
            "https://connect.composio.dev/gmail",
            kind: .connectApp,
            expectedHost: nil
        ))
        #expect(!Proposal.connectRedirectAllowed(
            "https://evil.example/gmail",
            kind: .connectApp,
            expectedHost: nil
        ))
    }
}

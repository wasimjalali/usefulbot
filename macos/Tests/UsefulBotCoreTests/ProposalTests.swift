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
            ("proposed", .proposed), ("waiting", .waiting), ("connected", .connected), ("expired", .expired), ("bogus", .unknown),
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

    @Test func aFailedServerCardIsFailedWithItsReasonNotProposed() throws {
        let reasons: [(String, Proposal.ConnectFailure, String)] = [
            ("auth_failed", .authFailed, "Signed in, but the server refused access."),
            ("expired", .expired, "The sign-in expired."),
            ("unreachable", .unreachable, "Couldn't reach the server."),
            ("malformed", .malformed, "The server's tools couldn't be read."),
            ("discovery_failed", .discoveryFailed, "Couldn't list the server's tools."),
        ]
        for (raw, reason, line) in reasons {
            let proposal = try decode("""
            {"id":"p8","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
             "connectionId":"tella","name":"Tella","urlHost":"api.tella.com","authKind":"oauth",
             "phase":"failed","reason":"\(raw)"}
            """)
            #expect(proposal.phase == .failed)
            #expect(proposal.reason == reason)
            #expect(proposal.isOpen())
            #expect(Proposal.ConnectFailure.line(for: proposal.reason) == line)
            // Try again is the normal confirm action.
            let action = try #require(ProposalActions.confirm(proposal))
            #expect(action["type"] as? String == "connectServer")
        }
    }

    @Test func aFailedCardWithAnUnknownReasonStillFails() throws {
        let proposal = try decode("""
        {"id":"p9","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
         "connectionId":"tella","phase":"failed","reason":"from_the_future"}
        """)
        #expect(proposal.phase == .failed)
        #expect(proposal.reason == nil)
        #expect(Proposal.ConnectFailure.line(for: proposal.reason) == "The connection failed.")
    }

    @Test func connectedToolsLine() throws {
        func line(_ phase: String, _ count: String) throws -> String? {
            try decode("""
            {"id":"p10","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
             "connectionId":"x","phase":"\(phase)","toolCount":\(count)}
            """).connectedToolsLine
        }
        #expect(try line("connected", "0") == "Connected, no tools")
        #expect(try line("connected", "1") == "1 tool")
        #expect(try line("connected", "5") == "5 tools")
        #expect(try line("connected", "null") == nil)
        #expect(try line("failed", "0") == nil)
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

    @Test func aTappedConnectCardKeepsItsBusyMarkForTenSecondsAfterItsRequestReturnsInAnyPhase() throws {
        let tap = Date(timeIntervalSince1970: 1_000)
        func card(_ phase: String, waitingSince: String? = nil) throws -> Proposal {
            let since = waitingSince.map { "\"\($0)\"" } ?? "null"
            return try decode("""
            {"id":"c1","kind":"connectServer","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z",
             "phase":"\(phase)","waitingSince":\(since),"name":"Tella","url":"https://api.tella.com/mcp"}
            """)
        }
        // Left in proposed after a refused redirect: buttons come back after 10 s.
        let proposed = try card("proposed")
        #expect(proposed.busyMarkHolds(tapPhase: .proposed, tapWaitingSince: nil, requestFinishedAt: tap, now: tap.addingTimeInterval(5)))
        #expect(!proposed.busyMarkHolds(tapPhase: .proposed, tapWaitingSince: nil, requestFinishedAt: tap, now: tap.addingTimeInterval(10)))
        // Waiting and failed cards are settled as soon as they move on, or after 10 s.
        let waiting = try card("waiting", waitingSince: "2026-10-04T10:00:00.000Z")
        #expect(waiting.busyMarkHolds(tapPhase: .waiting, tapWaitingSince: "2026-10-04T10:00:00.000Z", requestFinishedAt: tap, now: tap.addingTimeInterval(5)))
        #expect(!waiting.busyMarkHolds(tapPhase: .waiting, tapWaitingSince: "2026-10-04T09:00:00.000Z", requestFinishedAt: tap, now: tap.addingTimeInterval(5)))
        #expect(!waiting.busyMarkHolds(tapPhase: .failed, tapWaitingSince: "2026-10-04T10:00:00.000Z", requestFinishedAt: tap, now: tap.addingTimeInterval(5)))
        #expect(!waiting.busyMarkHolds(tapPhase: .waiting, tapWaitingSince: "2026-10-04T10:00:00.000Z", requestFinishedAt: tap, now: tap.addingTimeInterval(11)))
        // A request that has not returned yet keeps the mark however long it takes:
        // the cap runs from when the request finished, not from the tap.
        #expect(proposed.busyMarkHolds(tapPhase: .proposed, tapWaitingSince: nil, requestFinishedAt: nil, now: tap.addingTimeInterval(60)))
        #expect(waiting.busyMarkHolds(tapPhase: .waiting, tapWaitingSince: "2026-10-04T10:00:00.000Z", requestFinishedAt: nil, now: tap.addingTimeInterval(60)))
        // A card that is not a connect card has no tap record to cap it.
        let other = try decode("""
        {"id":"p9","kind":"createBot","status":"pending","expiresAt":"2099-01-01T00:00:00.000Z","name":"Old"}
        """)
        #expect(other.busyMarkHolds(tapPhase: .proposed, tapWaitingSince: nil, requestFinishedAt: tap, now: tap.addingTimeInterval(60)))
    }
}

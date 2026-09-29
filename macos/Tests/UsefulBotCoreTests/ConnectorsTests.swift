import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ConnectorsTests {
    private func decode(_ json: String) throws -> ConnectorsPayload {
        try JSONDecoder().decode(ConnectorsPayload.self, from: Data(json.utf8))
    }

    @Test func decodesTheCatalogueWithConnectionState() throws {
        let payload = try decode("""
        {"ok":true,"hasKey":true,"last4":"7f2a","connectedToolkits":["gmail"],
         "toolkits":[
           {"slug":"gmail","name":"Gmail","logo":"https://logos.composio.dev/api/gmail","noAuth":false,
            "connected":true,"accountId":"ca_1","status":"ACTIVE"},
           {"slug":"slack","name":"Slack","logo":null,"noAuth":false,"connected":false,"accountId":null,"status":null}
         ]}
        """)
        #expect(payload.hasKey)
        #expect(payload.last4 == "7f2a")
        #expect(payload.error == nil)
        #expect(payload.toolkits.map(\.slug) == ["gmail", "slack"])
        #expect(payload.toolkits[0].connected)
        #expect(payload.toolkits[0].accountId == "ca_1")
        #expect(payload.toolkits[1].logo == nil)
        #expect(payload.toolkits[1].status == nil)
    }

    @Test func decodesTheNoKeyAndUnavailableShapes() throws {
        let noKey = try decode(#"{"ok":true,"hasKey":false,"last4":null,"connectedToolkits":[],"toolkits":[]}"#)
        #expect(!noKey.hasKey)
        #expect(noKey.toolkits.isEmpty)

        let down = try decode(#"{"ok":false,"error":"connectors_unavailable","hasKey":true,"last4":"7f2a","toolkits":[]}"#)
        #expect(down.hasKey)
        #expect(down.error == "connectors_unavailable")
    }

    @Test func toleratesSparseRows() throws {
        let payload = try decode(#"{"hasKey":true,"toolkits":[{"slug":"notion"}]}"#)
        let row = try #require(payload.toolkits.first)
        #expect(row.name == "notion")
        #expect(!row.connected)
        #expect(!row.noAuth)
        #expect(row.id == "notion")
    }

    @Test func decodesTheOwnAppFlagAndForm() throws {
        let payload = try decode(#"{"hasKey":true,"toolkits":[{"slug":"tiktok","name":"Tiktok","ownApp":true},{"slug":"gmail"}]}"#)
        #expect(payload.toolkits[0].ownApp)
        #expect(!payload.toolkits[1].ownApp)

        let form = try JSONDecoder().decode(OwnAppForm.self, from: Data("""
        {"ok":true,"toolkit":"tiktok","authScheme":"OAUTH2",
         "redirectUri":"https://backend.composio.dev/api/v3/toolkits/auth/callback",
         "fields":[{"name":"client_id","label":"Client id","description":"Client id of the app","secret":false},
                   {"name":"client_secret","label":"Client secret","secret":true}]}
        """.utf8))
        #expect(form.toolkit == "tiktok")
        #expect(form.redirectUri.hasPrefix("https://backend.composio.dev/"))
        #expect(form.fields.map(\.id) == ["client_id", "client_secret"])
        #expect(!form.fields[0].secret)
        #expect(form.fields[1].secret)
        #expect(form.fields[1].description == "")
    }

    @Test func keyNeverDecodesIntoThePayload() throws {
        // A server bug that leaked the key would still not reach any field the
        // dialog renders: the payload has no place for it.
        let payload = try decode(#"{"hasKey":true,"apiKey":"ak_should_not_exist","toolkits":[]}"#)
        let mirror = Mirror(reflecting: payload)
        #expect(!mirror.children.contains { "\($0.value)".contains("ak_should_not_exist") })
    }
}

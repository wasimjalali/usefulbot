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

@Suite struct DirectConnectionsTests {
    private func decode(_ json: String) throws -> DirectConnectionsPayload {
        try JSONDecoder().decode(DirectConnectionsPayload.self, from: Data(json.utf8))
    }

    private func row(_ state: String, auth: String = "oauth", builtin: Bool = false) throws -> DirectConnection {
        let payload = try decode("""
        {"ok":true,"connections":[{"id":"c1","name":"Tella","url":"https://api.tella.com/mcp","kind":"mcp",
         "authKind":"\(auth)","builtin":\(builtin),"state":"\(state)","lastError":null,"checkedAt":null,
         "toolCount":null,"tools":[]}]}
        """)
        return payload.connections[0]
    }

    @Test func decodesAFullRow() throws {
        let payload = try decode("""
        {"ok":true,"connections":[{"id":"tella","name":"Tella","url":"https://api.tella.com/mcp","kind":"mcp",
         "authKind":"oauth","builtin":false,"state":"auth_failed",
         "lastError":{"code":"auth","message":"Token refused"},"checkedAt":"2026-10-04T10:00:00.000Z",
         "toolCount":2,"tools":[{"name":"list_videos","description":"List videos"},{"name":"get_video"}]}]}
        """)
        let c = try #require(payload.connections.first)
        #expect(c.id == "tella")
        #expect(c.host == "api.tella.com")
        #expect(c.kind == .mcp)
        #expect(c.authKind == .oauth)
        #expect(c.state == .authFailed)
        #expect(c.lastError?.message == "Token refused")
        #expect(c.toolCount == 2)
        #expect(c.tools.map(\.name) == ["list_videos", "get_video"])
        #expect(c.tools[1].description == nil)
    }

    @Test func toleratesMissingOptionalFields() throws {
        let payload = try decode(#"{"connections":[{"id":"x","name":"X","url":"https://x.example","state":"ready"}]}"#)
        let c = try #require(payload.connections.first)
        #expect(c.kind == .unknown)
        #expect(c.kind.label == "Server")
        #expect(c.authKind == .none)
        #expect(c.builtin)
        #expect(!c.canRemove)
        #expect(c.lastError == nil)
        #expect(c.toolCount == nil)
        #expect(c.tools.isEmpty)
    }

    @Test func anUnknownKindIsServerAndNotRemovable() throws {
        let payload = try decode(#"{"connections":[{"id":"x","name":"X","url":"https://x.example","kind":"grpc","state":"ready"}]}"#)
        let c = try #require(payload.connections.first)
        #expect(c.kind == .unknown)
        #expect(c.kind.label == "Server")
        #expect(DirectConnection.Kind.openapi.label == "OpenAPI")
    }

    @Test func aBadToolIsSkippedAndTheRestKept() throws {
        let payload = try decode(#"{"connections":[{"id":"x","name":"X","url":"https://x.example","state":"ready","tools":[{"name":"a"},{"description":"no name"},{"name":"b","description":"B"}]}]}"#)
        let c = try #require(payload.connections.first)
        #expect(c.tools.map(\.name) == ["a", "b"])
    }

    @Test func noToolsNoteOnlyWhenTheListIsKnownEmpty() throws {
        #expect(try row("ready").showsNoToolsNote)
        #expect(try row("zero_tools").showsNoToolsNote)
        #expect(!(try row("pending")).showsNoToolsNote)
        #expect(!(try row("unreachable")).showsNoToolsNote)
        #expect(!(try row("quantum")).showsNoToolsNote)
    }

    @Test func zeroToolsRowSaysNoToolsOnce() throws {
        let c = try JSONDecoder().decode(DirectConnectionsPayload.self, from: Data(#"{"connections":[{"id":"x","name":"X","url":"https://x.example","state":"zero_tools","toolCount":0}]}"#.utf8)).connections[0]
        #expect(c.toolCountLine == nil)
        let ready = try JSONDecoder().decode(DirectConnectionsPayload.self, from: Data(#"{"connections":[{"id":"x","name":"X","url":"https://x.example","state":"ready","toolCount":3}]}"#.utf8)).connections[0]
        #expect(ready.toolCountLine == "3 tools")
    }

    @Test func aRowWithoutAnIdIsDroppedNotInvented() throws {
        let payload = try decode(#"{"connections":[{"name":"X"},{"id":"y","name":"Y","url":"https://y.example","state":"ready"}]}"#)
        #expect(payload.connections.map(\.id) == ["y"])
    }

    @Test func aFutureStateStaysVisibleAndNeverReady() throws {
        let c = try row("quantum")
        #expect(c.state == .unknown("quantum"))
        #expect(c.state.label == "Status unknown")
        #expect(c.state != .ready)
    }

    @Test func everyStateHasItsLabel() {
        let labels: [(String, String)] = [
            ("ready", "Ready"), ("zero_tools", "No tools"), ("pending", "Checking..."),
            ("auth_failed", "Needs sign-in"), ("expired", "Sign-in expired"),
            ("unreachable", "Can't reach server"), ("malformed", "Tools unreadable"),
            ("discovery_failed", "Couldn't list tools"),
        ]
        for (raw, label) in labels {
            #expect(DirectConnection.State(raw: raw).label == label)
        }
        #expect(DirectConnection.State(raw: "pending").isChecking)
        #expect(!DirectConnection.State(raw: "ready").isChecking)
    }

    @Test func reconnectRefusalsSayWhatToDo() {
        #expect(DirectConnection.reconnectFailureCopy(code: "authorization_server_changed", name: "Tella")
            == "The sign-in server changed. Remove this server and connect it again.")
        #expect(DirectConnection.reconnectFailureCopy(code: "oauth_issuer_mismatch", name: "Tella")
            == "The sign-in server changed. Remove this server and connect it again.")
        #expect(DirectConnection.reconnectFailureCopy(code: "oauth_resource_origin", name: "Tella")
            == "The sign-in server changed. Remove this server and connect it again.")
        #expect(DirectConnection.reconnectFailureCopy(code: "oauth_no_pkce", name: "Tella")
            == "This server's sign-in isn't secure enough to use.")
        #expect(DirectConnection.reconnectFailureCopy(code: "credential_missing", name: "Tella")
            == "Remove this server and connect it again.")
        #expect(DirectConnection.reconnectFailureCopy(code: "other", name: "Tella") == "Couldn't reconnect Tella.")
        #expect(DirectConnection.reconnectFailureCopy(code: nil, name: "Tella") == "Couldn't reconnect Tella.")
    }

    @Test func builtinRowsCannotBeRemoved() throws {
        #expect(!(try row("ready", auth: "none", builtin: true)).canRemove)
        #expect((try row("ready", auth: "none", builtin: false)).canRemove)
    }

    @Test func reconnectIsOnlyForOAuthAndProminentWhenSignInIsBroken() throws {
        #expect((try row("ready", auth: "oauth")).canReconnect)
        #expect(!(try row("ready", auth: "apiKey")).canReconnect)
        #expect(!(try row("auth_failed", auth: "bearer")).canReconnect)
        #expect(!(try row("auth_failed", auth: "none")).canReconnect)
        #expect((try row("auth_failed")).reconnectProminent)
        #expect((try row("expired")).reconnectProminent)
        #expect(!(try row("ready")).reconnectProminent)
        #expect(!(try row("expired", auth: "apiKey")).reconnectProminent)
    }

    @Test func toolCountLine() throws {
        #expect(DirectConnection.toolCountLabel(nil) == nil)
        #expect(DirectConnection.toolCountLabel(0) == "0 tools")
        #expect(DirectConnection.toolCountLabel(1) == "1 tool")
        #expect(DirectConnection.toolCountLabel(12) == "12 tools")
    }

    @Test func decodesTheReauthorizeAnswer() throws {
        let a = try JSONDecoder().decode(ConnectionReauthorize.self, from: Data(#"{"ok":true,"authorizeUrl":"https://auth.tella.com/a","redirectHost":"auth.tella.com"}"#.utf8))
        #expect(a.authorizeUrl == "https://auth.tella.com/a")
        #expect(a.redirectHost == "auth.tella.com")
    }
}

import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ConnectorTileTests {
    private func server(_ id: String, name: String, state: String, icon: String? = nil) throws -> DirectConnection {
        let iconField = icon.map { #","icon":"\#($0)""# } ?? ""
        let json = #"{"id":"\#(id)","name":"\#(name)","url":"https://api.\#(id).com/mcp","kind":"mcp","authKind":"oauth","builtin":false,"state":"\#(state)","tools":[]\#(iconField)}"#
        return try JSONDecoder().decode(DirectConnection.self, from: Data(json.utf8))
    }

    @Test func readyServerWithToolCountShowsKindAndCount() throws {
        func ready(_ count: Int) throws -> ConnectorTile {
            let json = #"{"id":"x","name":"X","url":"https://x.com/mcp","kind":"mcp","authKind":"none","builtin":false,"state":"ready","toolCount":\#(count),"tools":[]}"#
            return ConnectorTile(server: try JSONDecoder().decode(DirectConnection.self, from: Data(json.utf8)))
        }
        #expect(try ready(2).status == "MCP server · 2 tools")
        #expect(try ready(1).status == "MCP server · 1 tool")
    }

    private func app(_ slug: String, name: String, connected: Bool = true) -> ConnectorToolkit {
        ConnectorToolkit(slug: slug, name: name, logo: "https://logos.composio.dev/api/\(slug)", noAuth: false, connected: connected, accountId: "ca_\(slug)", status: "ACTIVE")
    }

    @Test func serverStatusAndMarkPerState() throws {
        let expected: [(String, String, ConnectorTile.Mark)] = [
            ("ready", "Ready to use", .added),
            ("pending", "Checking...", .checking),
            ("auth_failed", "Needs sign-in", .warning("Not ready")),
            ("expired", "Sign-in expired", .warning("Not ready")),
            ("unreachable", "Can't reach server", .warning("Not ready")),
            ("zero_tools", "No tools", .warning("Not ready")),
            ("malformed", "Tools unreadable", .warning("Not ready")),
            ("discovery_failed", "Couldn't list tools", .warning("Not ready")),
            ("from_the_future", "Status unknown", .warning("Not ready")),
        ]
        for (state, line, mark) in expected {
            let tile = ConnectorTile(server: try server("x", name: "X", state: state))
            #expect(tile.status == line, "\(state)")
            #expect(tile.mark == mark, "\(state)")
            #expect(tile.isReady == (mark == .added))
        }
    }

    @Test func appTileIsReadyAndKeepsItsLogo() {
        let tile = ConnectorTile(app: app("gmail", name: "Gmail"))
        #expect(tile.status == "Ready to use")
        #expect(tile.mark == .added)
        #expect(tile.logoURL == "https://logos.composio.dev/api/gmail")
        #expect(tile.id == "app:gmail")
    }

    @Test func rowDecodesEveryAccountIdAndDefaultsToTheOne() throws {
        let many = #"{"slug":"gmail","name":"Gmail","accountId":"ca_1","accountIds":["ca_1","ca_2"],"needsSignIn":true}"#
        #expect(try JSONDecoder().decode(ConnectorToolkit.self, from: Data(many.utf8)).accountIds == ["ca_1", "ca_2"])
        let old = #"{"slug":"gmail","name":"Gmail"}"#
        #expect(try JSONDecoder().decode(ConnectorToolkit.self, from: Data(old.utf8)).accountIds == [])
        #expect(app("gmail", name: "Gmail").accountIds == ["ca_gmail"])
    }

    @Test func appWhoseSignInLapsedStaysAddedWithSignInAgain() throws {
        let lapsed = ConnectorToolkit(slug: "gmail", name: "Gmail", logo: nil, noAuth: false, connected: false, accountId: "ca_gmail", status: "EXPIRED", needsSignIn: true)
        let tile = ConnectorTile(app: lapsed)
        #expect(tile.needsSignIn)
        #expect(tile.mark == .added)
        #expect(tile.status == "Sign-in expired")
        // An app that is neither connected nor lapsed is still left out of the added list.
        let tiles = ConnectorTile.merge(apps: [lapsed, app("notion", name: "Notion", connected: false)], servers: [])
        #expect(tiles.map(\.id) == ["app:gmail"])
    }

    @Test func mergeListsReadyFirstThenByNameAndSkipsUnconnectedApps() throws {
        let tiles = ConnectorTile.merge(
            apps: [app("slack", name: "slack"), app("notion", name: "Notion", connected: false), app("gmail", name: "Gmail")],
            servers: [
                try server("tella", name: "Tella", state: "auth_failed"),
                try server("excalidraw", name: "Excalidraw", state: "ready"),
                try server("zeta", name: "Zeta", state: "pending"),
            ]
        )
        #expect(tiles.map(\.name) == ["Excalidraw", "Gmail", "slack", "Tella", "Zeta"])
        #expect(tiles.map(\.id) == ["server:excalidraw", "app:gmail", "app:slack", "server:tella", "server:zeta"])
    }

    @Test func iconDecodesOnlyASmallBase64Image() throws {
        let png = Data([137, 80, 78, 71, 1, 2]).base64EncodedString()
        #expect(ConnectorTile.decodeIcon("data:image/png;base64,\(png)") == Data([137, 80, 78, 71, 1, 2]))
        #expect(ConnectorTile.decodeIcon(nil) == nil)
        #expect(ConnectorTile.decodeIcon("https://x.com/a.png") == nil)
        #expect(ConnectorTile.decodeIcon("data:text/html;base64,\(png)") == nil)
        #expect(ConnectorTile.decodeIcon("data:image/png,\(png)") == nil)
        #expect(ConnectorTile.decodeIcon("data:image/png;base64,!!!") == nil)
        #expect(ConnectorTile.decodeIcon("data:image/png;base64,") == nil)
        let big = Data(count: 64 * 1024 + 1).base64EncodedString()
        #expect(ConnectorTile.decodeIcon("data:image/png;base64,\(big)") == nil)
        #expect(ConnectorTile(server: try server("a", name: "A", state: "ready", icon: "data:image/png;base64,\(png)")).iconData != nil)
        #expect(ConnectorTile(server: try server("a", name: "A", state: "ready", icon: "junk")).iconData == nil)
    }

    @Test func decodesTheToolListPayload() throws {
        let payload = try JSONDecoder().decode(
            ConnectorToolsPayload.self,
            from: Data(#"{"ok":true,"tools":[{"name":"GMAIL_SEND","description":"Send"},{"nope":1},{"name":"B"}]}"#.utf8)
        )
        #expect(payload.tools.map(\.name) == ["GMAIL_SEND", "B"])
    }
}

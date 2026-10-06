import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ProvidersV2Tests {
    private func decode(_ json: String) throws -> ProvidersPayload {
        try JSONDecoder().decode(ProvidersPayload.self, from: Data(json.utf8))
    }

    @Test func decodesTheFullPayload() throws {
        let payload = try decode("""
        {"ok":true,
         "catalog":[
           {"providerId":"openai","mode":"oauth","label":"ChatGPT","kindLabel":"Subscription",
            "monogram":"Cg","icon":"openai","hint":"Sign in with ChatGPT","keyUrl":null,"fields":null,
            "oauth":true,"connected":true},
           {"providerId":"anthropic","mode":"api","label":"Anthropic","kindLabel":"API",
            "monogram":"An","icon":"anthropic","hint":"Paste a key from console.anthropic.com",
            "keyUrl":"https://console.anthropic.com/","fields":null,
            "oauth":false,"connected":false},
           {"providerId":"cloudflare","mode":"api","label":"Cloudflare Workers AI","kindLabel":"API",
            "monogram":"Cf","icon":"cloudflare","hint":"Needs the account id too.",
            "keyUrl":null,"fields":[{"id":"accountId","label":"Account ID","placeholder":"abc123"}],
            "oauth":false,"connected":false}
         ],
         "connections":[
           {"id":"openai:oauth","providerId":"openai","mode":"oauth","label":"ChatGPT",
            "kindLabel":"Subscription","monogram":"Cg","icon":"openai","connected":true,"last4":null,
            "source":"settings","active":true,"status":"ok","lastError":null,
            "accountId":"acct_1","fields":{},"models":[{"id":"gpt-5.2-codex","label":"GPT 5.2 Codex"}]}
         ],
         "roles":{
           "default":{"connectionId":"openai:oauth","connectionLabel":"ChatGPT",
             "connectionIcon":"openai",
             "modelId":"gpt-5.2-codex","modelLabel":"GPT 5.2 Codex",
             "effort":"high","effortLabel":"High",
             "efforts":[{"id":"low","label":"Low"},{"id":"high","label":"High"}],
             "models":[{"connectionId":"openai:oauth","connectionLabel":"ChatGPT","icon":"openai",
               "id":"gpt-5.2-codex","label":"GPT 5.2 Codex"}]},
           "reviewer":{"connectionId":null,"connectionLabel":"","connectionIcon":"","modelId":"","modelLabel":"",
             "effort":null,"effortLabel":null,"efforts":[],"models":[]}
         },
         "composer":{"modelId":"gpt-5.2-codex","modelLabel":"GPT 5.2 Codex","effort":"high",
           "effortLabel":"High","speed":"standard","efforts":[],"speeds":[],"models":[]},
         "providers":[{"id":"openai","name":"OpenAI","kind":"api","hint":"API key",
           "compatible":true,"connected":false,"last4":null,"source":null,"active":false}],
         "activeProviderId":"openai"}
        """)
        #expect(payload.catalog.count == 3)
        #expect(payload.catalog[0].oauth)
        #expect(payload.catalog[0].fields == nil)
        #expect(payload.catalog[0].icon == "openai")
        #expect(payload.catalog[2].fields?.first?.id == "accountId")
        #expect(payload.catalog[2].icon == "cloudflare")
        #expect(payload.connections.count == 1)
        #expect(payload.connections[0].accountId == "acct_1")
        #expect(payload.connections[0].icon == "openai")
        #expect(payload.connections[0].models.first?.id == "gpt-5.2-codex")
        #expect(payload.defaultRole?.effort == "high")
        #expect(payload.defaultRole?.connectionIcon == "openai")
        #expect(payload.defaultRole?.models.count == 1)
        #expect(payload.defaultRole?.models.first?.icon == "openai")
        #expect(payload.reviewerRole?.efforts.isEmpty == true)
        #expect(payload.composer?.modelId == "gpt-5.2-codex")
        #expect(payload.legacyProviders.count == 1)
        #expect(payload.legacyActiveProviderId == "openai")
    }

    @Test func toleratesSparseRowsAndUnknownKeys() throws {
        let payload = try decode("""
        {"catalog":[{"providerId":"zai","future":"ignored"}],
         "connections":[{"id":"zai:plan","unknownBlock":{"a":1}}],
         "roles":{"default":{"modelId":"glm-5"},"reviewer":null},
         "mystery":true}
        """)
        let entry = try #require(payload.catalog.first)
        #expect(entry.mode == "api")
        #expect(entry.label == "zai")
        #expect(entry.icon == "")
        #expect(!entry.oauth)
        #expect(!entry.connected)
        let connection = try #require(payload.connections.first)
        #expect(connection.status == "ok")
        #expect(connection.icon == "")
        #expect(connection.fields.isEmpty)
        #expect(connection.models.isEmpty)
        #expect(payload.defaultRole?.modelId == "glm-5")
        #expect(payload.defaultRole?.connectionIcon == "")
        #expect(payload.defaultRole?.efforts.isEmpty == true)
        #expect(payload.reviewerRole == nil)
        #expect(payload.composer == nil)
        #expect(payload.legacyProviders.isEmpty)
    }

    @Test func keyNeverDecodesIntoThePayload() throws {
        let payload = try decode("""
        {"catalog":[],"connections":[
          {"id":"anthropic:api","key":"sk-should-not-exist","credential":{"key":"sk-hidden"}}]}
        """)
        let mirror = Mirror(reflecting: payload)
        #expect(!mirror.children.contains { "\($0.value)".contains("sk-") })
        let connection = try #require(payload.connections.first)
        #expect(connection.last4 == nil)
        #expect(connection.fields.isEmpty)
    }

    @Test func retiredConnectionsDecodeApartFromLiveOnes() throws {
        let sentence = "Z.ai only allows the GLM Coding Plan in its supported coding tools, so Useful Bot can't use it. Connect a Z.ai API key instead, then disconnect this one."
        let payload = try decode("""
        {"connections":[{"id":"opencode-go:plan","status":"ok"}],
         "retired":[{"id":"zai:plan","providerId":"zai","mode":"plan","status":"retired","lastError":"\(sentence)"}]}
        """)
        #expect(payload.connections.map(\.id) == ["opencode-go:plan"])
        let retired = try #require(payload.retired.first)
        #expect(retired.status == "retired")
        #expect(retired.lastError == sentence)
        // A server from before the retirement sends none.
        #expect(try decode(#"{"connections":[]}"#).retired.isEmpty)
    }

    @Test func aUserWhoseOnlyConnectionWasTurnedOffSeesWhy() throws {
        let sentence = "Z.ai only allows the GLM Coding Plan in its supported coding tools, so Useful Bot can't use it. Connect a Z.ai API key instead, then disconnect this one."
        let payload = try decode("""
        {"connections":[{"id":"opencode-go:plan","status":"ok"}],
         "retired":[{"id":"zai:plan","providerId":"zai","mode":"plan","status":"retired","lastError":"\(sentence)"}]}
        """)
        let alone = try decode("""
        {"connections":[],
         "retired":[{"id":"zai:plan","providerId":"zai","mode":"plan","status":"retired","lastError":"\(sentence)"}]}
        """)
        #expect(ConnectionPublic.retiredReason(connected: alone.connections, retired: alone.retired) == sentence)
        // Something usable is connected: the generic empty state never applies, so no reason is offered.
        #expect(ConnectionPublic.retiredReason(connected: payload.connections, retired: payload.retired) == nil)
        // Nothing connected and nothing turned off: the plain "connect a model" copy.
        #expect(ConnectionPublic.retiredReason(connected: [], retired: []) == nil)
    }

    @Test func decodesTheDeviceFlowStart() throws {
        let flow = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p1","userCode":"ABCD-1234",
         "verificationUrl":"https://example.com/device",
         "verificationUrlComplete":"https://example.com/device?code=ABCD-1234",
         "expiresAt":900000,"intervalMs":2000}
        """.utf8))
        #expect(flow.pollId == "p1")
        #expect(flow.userCode == "ABCD-1234")
        #expect(flow.verificationUrlComplete?.contains("ABCD-1234") == true)
        #expect(flow.intervalMs == 2000)
    }

    @Test func theDeviceFlowStartDefaultsToDeviceAndReadsTheBrowserFlow() throws {
        let older = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p1","userCode":"ABCD-1234","verificationUrl":"https://example.com/device"}
        """.utf8))
        #expect(older.flow == "device")
        let browser = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p2","flow":"browser","userCode":"",
         "verificationUrl":"https://auth.openai.com/api/accounts/authorize?x=1",
         "verificationUrlComplete":null,"expiresAt":900000,"intervalMs":2000}
        """.utf8))
        #expect(older.account == nil)
        #expect(older.accounts.isEmpty)
        #expect(!older.reusesSaved)
        let saved = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p4","flow":"browser","account":"a@example.com","reusesSaved":true,
         "accounts":[{"clientId":"c1","label":"a@example.com"},{"clientId":"c2","label":"b@example.com"}],
         "userCode":"","verificationUrl":"https://auth.openai.com/x"}
        """.utf8))
        #expect(saved.reusesSaved)
        #expect(saved.clientId == nil)
        #expect(older.clientId == nil)
        let withClient = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p5","flow":"browser","clientId":"c2","userCode":"","verificationUrl":"https://auth.openai.com/x"}
        """.utf8))
        #expect(withClient.clientId == "c2")
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: false, retryClientId: "c9")["retryClientId"] as? String == "c9")
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: false)["retryClientId"] == nil)
        #expect(saved.accounts == [SavedChatGptAccount(clientId: "c1", label: "a@example.com"), SavedChatGptAccount(clientId: "c2", label: "b@example.com")])
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: false, clientId: "c2")["clientId"] as? String == "c2")
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: false)["clientId"] == nil)
        #expect(browser.account == nil)
        let continued = try JSONDecoder().decode(DeviceFlowStart.self, from: Data("""
        {"ok":true,"pollId":"p3","flow":"browser","account":"me@example.com","userCode":"","verificationUrl":"https://auth.openai.com/x"}
        """.utf8))
        #expect(continued.account == "me@example.com")
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: false)["newAccount"] == nil)
        #expect(BackendClient.startOAuthBody(providerId: "openai", newAccount: true)["newAccount"] as? Bool == true)
        #expect(browser.flow == "browser")
        #expect(browser.userCode.isEmpty)
        #expect(browser.verificationUrl.hasPrefix("https://auth.openai.com/"))
    }

    @Test func readsTheAccountLabelAndTheNoticeWhenPresent() throws {
        let older = try decode("""
        {"catalog":[],"connections":[{"id":"openai:oauth","status":"ok"}]}
        """)
        #expect(older.connections.first?.accountLabel == nil)
        #expect(older.notice == nil)
        let newer = try decode("""
        {"catalog":[],"notice":"chatgpt_revoke_unconfirmed",
         "connections":[{"id":"openai:oauth","status":"expired","accountLabel":"me@example.com"}]}
        """)
        #expect(newer.connections.first?.accountLabel == "me@example.com")
        #expect(newer.connections.first?.status == "expired")
        #expect(newer.notice == "chatgpt_revoke_unconfirmed")
    }

    @Test func aRemovedConnectionWithPinnedBotsKeepsTheServerMessage() {
        let body = Data("""
        {"ok":false,"error":"connection_removed_bots_pinned","message":"The connection could not be removed because some bots that name it could not be reset. Try again."}
        """.utf8)
        let error = BackendClient.providersFailure(status: 500, data: body)
        #expect(error == .providerNotice(code: "connection_removed_bots_pinned", message: "The connection could not be removed because some bots that name it could not be reset. Try again."))
        #expect(error.errorDescription == "The connection could not be removed because some bots that name it could not be reset. Try again.")
        #expect(error.providerCode == "connection_removed_bots_pinned")
        // Any other code keeps its plain shape, and a bare pinned code without a message does too.
        #expect(BackendClient.providersFailure(status: 400, data: Data("{\"error\":\"provider_key\"}".utf8)) == .provider("provider_key"))
        #expect(BackendClient.providersFailure(status: 500, data: Data("{\"error\":\"connection_removed_bots_pinned\"}".utf8)) == .provider("connection_removed_bots_pinned"))
    }

    @Test func aWriteOnATurnedOffRouteKeepsTheServerSentence() {
        let sentence = "Z.ai only allows the GLM Coding Plan in its supported coding tools, so Useful Bot can't use it. Connect a Z.ai API key instead, then disconnect this one."
        let body = Data(#"{"ok":false,"error":"provider_route_retired","message":"\#(sentence)"}"#.utf8)
        let error = BackendClient.providersFailure(status: 409, data: body)
        #expect(error == .providerNotice(code: "provider_route_retired", message: sentence))
        #expect(error.errorDescription == sentence)
        // Without a message it stays the plain code.
        #expect(BackendClient.providersFailure(status: 409, data: Data(#"{"error":"provider_route_retired"}"#.utf8)) == .provider("provider_route_retired"))
    }

    @Test func aReviewerRoleOnATurnedOffRouteDecodesItsReason() throws {
        let json = Data(#"{"connectionId":"zai:plan","connectionLabel":"Z.ai","modelId":"glm-5.3","modelLabel":"GLM 5.3","unavailable":"Turned off."}"#.utf8)
        let role = try JSONDecoder().decode(RolePublic.self, from: json)
        #expect(role.unavailable == "Turned off.")
        let live = try JSONDecoder().decode(RolePublic.self, from: Data(#"{"connectionId":"opencode-go:plan","modelId":"x"}"#.utf8))
        #expect(live.unavailable == nil)
    }
}

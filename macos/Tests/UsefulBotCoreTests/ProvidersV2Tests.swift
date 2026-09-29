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
}

import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct ComposerGroupsTests {
    @Test func decodesGroupsWithTheActiveConnectionFirst() throws {
        let composer = try JSONDecoder().decode(ComposerState.self, from: Data("""
        {"connectionId":"deepseek:api","modelId":"deepseek-chat","modelLabel":"DeepSeek Chat",
         "effort":null,"effortLabel":null,"speed":"standard","efforts":[],"speeds":[],
         "models":[{"id":"deepseek-chat","label":"DeepSeek Chat"}],
         "groups":[
           {"connectionId":"deepseek:api","label":"DeepSeek","icon":"deepseek",
            "models":[{"id":"deepseek-chat","label":"DeepSeek Chat"}]},
           {"connectionId":"openai:api","label":"OpenAI","icon":"openai",
            "models":[{"id":"gpt-4.1-mini","label":"GPT-4.1 Mini"}]}]}
        """.utf8))
        #expect(composer.connectionId == "deepseek:api")
        #expect(composer.groups.count == 2)
        #expect(composer.groups[0].connectionId == "deepseek:api")
        #expect(composer.groups[0].icon == "deepseek")
        #expect(composer.groups[1].label == "OpenAI")
        #expect(composer.groups[1].models.first?.id == "gpt-4.1-mini")
    }

    @Test func missingGroupsDecodesToEmpty() throws {
        let composer = try JSONDecoder().decode(ComposerState.self, from: Data("""
        {"modelId":"glm-5.3-flash","modelLabel":"GLM 5.3 Flash","speed":"standard"}
        """.utf8))
        #expect(composer.connectionId == "")
        #expect(composer.groups.isEmpty)
        #expect(composer.modelId == "glm-5.3-flash")
    }
}

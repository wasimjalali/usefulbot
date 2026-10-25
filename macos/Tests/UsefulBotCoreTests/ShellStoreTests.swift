import Foundation
import Testing
@testable import UsefulBotCore

/// One bot, many chats: the shell store carries the bot and the chat it has
/// open, and an approval says which chat raised it.
@Suite struct ShellStoreTests {
    private func decodeStore(_ json: String) throws -> ShellStore {
        try JSONDecoder().decode(ShellStore.self, from: Data(json.utf8))
    }

    @Test func theStoreCarriesTheOneBotAndItsOpenChat() throws {
        let store = try decodeStore("""
        {"schemaVersion":2,"selectedBotId":"bot-useful","bots":[
         {"id":"bot-useful","name":"Useful Bot","chatId":"c4a7f00d-1111-4111-8111-111111111111",
          "lastPreview":"hi","lastAt":"2026-10-25T12:00:00.000Z","permission":"auto","notify":true}
        ]}
        """)
        #expect(store.bots.map(\.id) == ["bot-useful"])
        #expect(store.bot?.chatId == "c4a7f00d-1111-4111-8111-111111111111")
        #expect(store.bot?.notify == true)
        #expect(store.bot?.permission == "auto")
    }

    @Test func aBotWithNoChatYetHasNone() throws {
        let store = try decodeStore(#"{"bots":[{"id":"bot-useful","name":"Useful Bot","chatId":null}]}"#)
        #expect(store.bot?.chatId == nil)
    }

    @Test func theDefaultBotIsTheOneAndAnyOtherIsOnlyAFallback() throws {
        let store = try decodeStore(#"{"bots":[{"id":"x","name":"X"},{"id":"bot-useful","name":"Useful Bot"}]}"#)
        #expect(store.bot?.id == "bot-useful")
        let fallback = try decodeStore(#"{"bots":[{"id":"x","name":"X"}]}"#)
        #expect(fallback.bot?.id == "x")
        #expect(try decodeStore(#"{"bots":[]}"#).bot == nil)
    }

    @Test func anApprovalNamesTheChatThatRaisedIt() throws {
        let item = try JSONDecoder().decode(ApprovalItem.self, from: Data("""
        {"id":"a1","actionSha256":"abc","preview":"rm -rf build","tool":"bash","botId":"bot-useful","chatId":"chat-2"}
        """.utf8))
        #expect(item.id == "a1")
        #expect(item.tool == "bash")
        #expect(item.chatId == "chat-2")
        #expect(item.botId == "bot-useful")
    }

    @Test func anApprovalWithoutAChatStillDecodes() throws {
        let item = try JSONDecoder().decode(ApprovalItem.self, from: Data(#"{"id":"a1","actionSha256":"abc","preview":"p","tool":"bash"}"#.utf8))
        #expect(item.chatId == nil)
    }
}

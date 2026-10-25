import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct MediaChatLinkTests {
    private func decode(_ extra: String) throws -> MediaItem {
        let json = #"{"id":"img1","kind":"image","path":"/tmp/a.png","botId":"b","botName":"B","title":"T","prompt":"p","model":"m","provider":"x","mime":"image/png","createdAt":"2026-10-25T00:00:00.000Z","exists":true\#(extra)}"#
        return try JSONDecoder().decode(MediaItem.self, from: Data(json.utf8))
    }

    @Test func decodesChatIdAndTreatsMissingOrNullAsNone() throws {
        #expect(try decode(#","chatId":"chat-1""#).chatId == "chat-1")
        #expect(try decode(#","chatId":null"#).chatId == nil)
        #expect(try decode("").chatId == nil)
    }

    @Test func linkIsOpenWhileTheChatExists() throws {
        let item = try decode(#","chatId":"chat-1""#)
        #expect(item.chatLink(isGone: { _ in false }) == .open("chat-1"))
    }

    @Test func linkIsDeletedOnceTheChatIsGone() throws {
        let item = try decode(#","chatId":"chat-1""#)
        #expect(item.chatLink(isGone: { $0 == "chat-1" }) == .deleted)
    }

    @Test func noChatShowsNeitherButtonNorNote() throws {
        #expect(try decode("").chatLink(isGone: { _ in true }) == MediaChatLink.none)
        #expect(try decode(#","chatId":"""#).chatLink(isGone: { _ in false }) == MediaChatLink.none)
    }
}

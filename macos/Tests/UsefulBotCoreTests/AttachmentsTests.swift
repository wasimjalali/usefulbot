import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct AttachmentsTests {
    @Test func safeNameStripsPathsAndUnsafeCharacters() throws {
        #expect(try Attachments.safeName("/tmp/hello world.txt") == "hello_world.txt")
        #expect(try Attachments.safeName("../../etc/passwd") == "passwd")
        #expect(try Attachments.safeName("..") == "file")
        #expect(try Attachments.safeName(".") == "file")
    }

    @Test func secretNamesAreRejected() {
        #expect(throws: Attachments.NameError.forbidden) {
            _ = try Attachments.safeName("server.pem")
        }
        #expect(throws: Attachments.NameError.forbidden) {
            _ = try Attachments.safeName("prod.env")
        }
        #expect(throws: Attachments.NameError.forbidden) {
            _ = try Attachments.safeName("api.key")
        }
    }

    @Test func onlyAPictureWithItsBytesIsAnImage() {
        let dataUrl = "data:image/png;base64,iVBORw0KGgo="
        let shot = Attachment(id: "1", name: "shot.png", bytes: 11, text: nil, mediaType: "image/png", dataUrl: dataUrl)
        let note = Attachment(id: "2", name: "notes.md", bytes: 2, text: "hi")
        let bare = Attachment(id: "3", name: "gone.png", bytes: 2, text: nil, mediaType: "image/png", dataUrl: nil)
        #expect(shot.isImage)
        #expect(!note.isImage)
        #expect(!bare.isImage)
    }

    @Test func safeMIMELowercasesEssenceAndRejectsUTIs() {
        #expect(Attachments.safeMIME("Text/Plain; charset=utf-8") == "text/plain")
        #expect(Attachments.safeMIME("application/json") == "application/json")
        #expect(Attachments.safeMIME("public.plain-text") == nil)
        #expect(Attachments.safeMIME("text/plain\r\nX-Injected: 1") == nil)
        #expect(Attachments.safeMIME("") == nil)
    }

    /// A picture is known by its name alone once it is sent, so two different
    /// pictures pasted as `image.png` must not share one.
    @Test func aContentNameSeparatesPicturesThatShareAFileName() {
        let a = Attachments.contentName("image.png", data: Data([1, 2, 3]))
        let b = Attachments.contentName("image.png", data: Data([4, 5, 6]))
        #expect(a != b)
        #expect(a.hasPrefix("image-") && a.hasSuffix(".png"))
        // Naming it again changes nothing.
        #expect(Attachments.contentName(a, data: Data([1, 2, 3])) == a)
        #expect(Attachments.contentName("README", data: Data([1])).hasPrefix("README-"))
    }

    @Test func aDataURLGivesBackItsBytes() {
        let bytes = Data([1, 2, 3, 4])
        #expect(Attachments.bytes(ofDataURL: "data:image/png;base64,\(bytes.base64EncodedString())") == bytes)
        #expect(Attachments.bytes(ofDataURL: "https://example.com/x.png") == nil)
    }
}

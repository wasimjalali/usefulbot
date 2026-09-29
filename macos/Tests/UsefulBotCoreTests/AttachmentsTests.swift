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

    @Test func messageEmbedsReadableTextAndDescribesBinary() {
        let files = [
            Attachment(id: "1", name: "notes.md", bytes: 12, text: "hi there"),
            Attachment(id: "2", name: "photo.png", bytes: 2048, text: nil),
        ]
        let text = Attachments.formatMessage("look", files: files)
        #expect(text.contains("look"))
        #expect(text.contains("Attached file: notes.md\n```\nhi there\n```"))
        #expect(text.contains("Attached file: photo.png (2048 bytes). Contents are not readable as text."))
    }

    @Test func imagesRideAsFilePartsAndEchoAsFileLines() throws {
        let dataUrl = "data:image/png;base64,iVBORw0KGgo="
        let shot = Attachment(id: "1", name: "shot.png", bytes: 11, text: nil, mediaType: "image/png", dataUrl: dataUrl)
        let note = Attachment(id: "2", name: "notes.md", bytes: 2, text: "hi")
        #expect(shot.isImage)
        #expect(!note.isImage)
        let flat = Attachments.formatMessage("look", files: [note, shot])
        #expect(flat.contains("Attached file: notes.md"))
        #expect(flat.contains("Attached image: shot.png"))
        #expect(!flat.contains("not readable"))
        // No image: the turn is the plain string the text path always sent.
        #expect(Attachments.turnMessage(formatted: flat, images: [note]) as? String == flat)
        // With one: the composed text goes through as it is, once, plus the part.
        let parts = try #require(Attachments.turnMessage(formatted: flat, images: [note, shot]) as? [[String: String]])
        #expect(parts.count == 2)
        #expect(parts[0] == ["type": "text", "text": flat])
        #expect(flat.components(separatedBy: "Attached image").count == 2)
        #expect(parts[1] == ["type": "file", "data": dataUrl, "mediaType": "image/png", "filename": "shot.png"])
        #expect(Attachments.echoedMessage(flat, images: [shot]) == "\(flat)\n[file: shot.png (image/png)]")
        #expect(Attachments.echoedMessage(flat, images: []) == flat)
    }

    @Test func emptyTextWithNoFilesTrimsToEmpty() {
        #expect(Attachments.formatMessage("   ", files: []) == "")
    }

    @Test func safeMIMELowercasesEssenceAndRejectsUTIs() {
        #expect(Attachments.safeMIME("Text/Plain; charset=utf-8") == "text/plain")
        #expect(Attachments.safeMIME("application/json") == "application/json")
        #expect(Attachments.safeMIME("public.plain-text") == nil)
        #expect(Attachments.safeMIME("text/plain\r\nX-Injected: 1") == nil)
        #expect(Attachments.safeMIME("") == nil)
    }

    @Test func messageFenceOutgrowsFencesInTheBody() {
        let body = "see\n```\nnot a close\n```\n"
        let files = [Attachment(id: "1", name: "notes.md", bytes: 30, text: body)]
        let text = Attachments.formatMessage("read", files: files)
        #expect(text.contains("Attached file: notes.md\n````\n"))
        #expect(text.contains("````\n\(body)\n````"))
    }
}

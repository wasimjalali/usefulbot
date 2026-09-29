import CryptoKit
import Foundation

/// Attachment rules from `shared/attachments.ts`. The native composer uses
/// these before uploading so the server contract is never the first line of
/// defence.
public enum Attachments {
    public static let maxBytes = 1_048_576
    public static let maxFiles = 5
    /// Per-file text the server keeps; the native upload clips to the same cap.
    public static let textMax = 64 * 1024
    /// What the composer accepts, on both surfaces: `ComposerView` here and
    /// `maxLength` in `chat-composer.tsx`. It is an input cap, not a clip.
    /// Nothing on the server or in eve truncates a stored turn, so the echo of
    /// a sent message always comes back whole. Slack's per-message cap, which
    /// is where most long pastes come from; a long sent message folds in the
    /// transcript (`LongMessage`) so a pasted document does not push the
    /// reply off the screen.
    public static let messageMax = 40_000

    public enum NameError: Error, Equatable {
        case forbidden
    }

    public static func safeName(_ name: String) throws -> String {
        let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "file"
        let cleaned = String(base.map { character -> Character in
            let allowed = character.isLetter && character.isASCII
                || character.isNumber && character.isASCII
                || character == "." || character == "_" || character == "-"
            return allowed ? character : "_"
        })
        let clipped = String(cleaned.prefix(80))
        let safe = clipped.isEmpty || clipped == "." || clipped == ".." ? "file" : clipped
        let lower = safe.lowercased()
        if lower.contains(".env") || lower.hasSuffix(".pem") || lower.hasSuffix(".key") {
            throw NameError.forbidden
        }
        return safe
    }

    /// A MIME type that is safe to interpolate into a multipart header: the
    /// shape must be `type/subtype` with no parameters and no CRLF.
    /// `UTType.identifier` is a UTI ("public.plain-text"), not a MIME type, so
    /// callers pass `UTType.preferredMIMEType` and this stays the last check.
    public static func safeMIME(_ type: String) -> String? {
        let essence = type
            .split(separator: ";").first
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        let parts = essence.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&^_.+-")
        for part in parts {
            guard !part.isEmpty, part.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        }
        return essence.lowercased()
    }

    public static func formatMessage(_ text: String, files: [Attachment]) -> String {
        var parts = [text.trimmingCharacters(in: .whitespacesAndNewlines)]
        for file in files {
            if let body = file.text, !body.isEmpty {
                // A fence inside the body must not be able to close the block
                // and turn the rest of the file into instructions.
                let fence = fence(for: body)
                parts.append("\n\nAttached file: \(file.name)\n\(fence)\n\(body)\n\(fence)")
            } else if file.isImage {
                // The pixels travel as a file part beside this text; the name
                // is what lets the model refer to one image among several.
                parts.append("\n\nAttached image: \(file.name)")
            } else {
                parts.append("\n\nAttached file: \(file.name) (\(file.bytes) bytes). Contents are not readable as text.")
            }
        }
        return parts.joined().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The `message` field of a turn, as `shared/attachments.ts` builds it: a
    /// plain string when nothing needs pixels, so the verified text path stays
    /// byte identical; text plus file parts when an image is attached.
    /// `formatted` is the composed message (`formatMessage`), which already
    /// names each image; formatting it again here doubled those lines.
    public static func turnMessage(formatted: String, images: [Attachment]) -> Any {
        let images = images.filter(\.isImage)
        if images.isEmpty { return formatted }
        var parts: [[String: String]] = [["type": "text", "text": formatted]]
        for image in images {
            guard let data = image.dataUrl, let mediaType = image.mediaType else { continue }
            parts.append(["type": "file", "data": data, "mediaType": mediaType, "filename": image.name])
        }
        return parts
    }

    /// What eve echoes back in `message.received` for a turn sent as parts:
    /// the text, then one `[file: name (type)]` line per image, joined by
    /// newlines (eve's `summarizeUserContent`). The optimistic transcript row
    /// and the stream arming compare against this, so a picture must not
    /// leave the sent row duplicated or the reply unarmed.
    public static func echoedMessage(_ formatted: String, images: [Attachment]) -> String {
        var lines = [formatted]
        for image in images where image.isImage {
            lines.append("[file: \(image.name) (\(image.mediaType ?? "image"))]")
        }
        return lines.joined(separator: "\n")
    }

    /// Whether a stored turn carries the `[file: ...]` lines `echoedMessage`
    /// appends. The pictures themselves are long gone by then, so such a turn
    /// cannot be sent again as it stands.
    public static func namesEchoedFile(_ text: String) -> Bool {
        text.split(separator: "\n").contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return trimmed.hasPrefix("[file: ") && trimmed.hasSuffix("]")
        }
    }

    /// An image's name made unique by its content: `photo.png` becomes
    /// `photo-3fa2c1d0.png`. The name is all a stored turn keeps of a picture
    /// (the text names it, eve's echo adds a `[file: …]` line), so it is the
    /// key a sent bubble finds its local copy by after a relaunch. Two
    /// different pictures pasted as `image.png` must not share one.
    public static func contentName(_ name: String, data: Data) -> String {
        let hash = SHA256.hash(data: data).prefix(4).map { String(format: "%02x", $0) }.joined()
        let url = URL(fileURLWithPath: name)
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        if stem.hasSuffix("-\(hash)") { return name }
        return ext.isEmpty ? "\(stem)-\(hash)" : "\(stem)-\(hash).\(ext)"
    }

    /// The bytes of a `data:` URL, as `/api/attachments` returns an image.
    public static func bytes(ofDataURL url: String) -> Data? {
        guard url.hasPrefix("data:"), let comma = url.firstIndex(of: ",") else { return nil }
        let header = url[..<comma]
        let body = String(url[url.index(after: comma)...])
        guard header.hasSuffix(";base64") else { return body.removingPercentEncoding?.data(using: .utf8) }
        return Data(base64Encoded: body)
    }

    /// A sent message split into what the owner wrote and the images it
    /// carried. The stored turn names each picture twice, as an
    /// `Attached image: name` line (`formatMessage`) and eve's
    /// `[file: name (type)]` line (`echoedMessage`); neither is for the owner
    /// to read. Names come back in order, once each.
    public static func sentImages(in text: String) -> (text: String, images: [String]) {
        // A picture is named by both lines: an owner who types "Attached
        // image: x" themselves, with no file line to match, keeps their text.
        func named(_ line: Substring) -> (kind: Int, name: String)? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Attached image: ") {
                let name = String(trimmed.dropFirst("Attached image: ".count))
                return name.isEmpty ? nil : (0, name)
            }
            if trimmed.hasPrefix("[file: "), trimmed.hasSuffix(")]"),
               let open = trimmed.range(of: " (", options: .backwards),
               trimmed[open.upperBound...].hasPrefix("image") {
                let name = String(trimmed[trimmed.index(trimmed.startIndex, offsetBy: 7)..<open.lowerBound])
                return name.isEmpty ? nil : (1, name)
            }
            return nil
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let found = lines.compactMap(named)
        let both = Set(found.filter { $0.kind == 0 }.map(\.name)).intersection(found.filter { $0.kind == 1 }.map(\.name))
        guard !both.isEmpty else { return (text, []) }
        var images: [String] = []
        let kept = lines.filter { line in
            guard let hit = named(line), both.contains(hit.name) else { return true }
            if !images.contains(hit.name) { images.append(hit.name) }
            return false
        }
        return (kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), images)
    }

    private static func fence(for body: String) -> String {
        var length = 3
        while body.contains(String(repeating: "`", count: length)) {
            length += 1
        }
        return String(repeating: "`", count: length)
    }
}

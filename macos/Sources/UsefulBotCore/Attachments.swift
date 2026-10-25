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
    /// What the composer accepts. It is an input cap, not a clip: the engine
    /// stores a turn whole, so the row of a sent message comes back whole.
    /// Slack's per-message cap, which is where most long pastes come from; a
    /// long sent message folds in the transcript (`LongMessage`) so a pasted
    /// document does not push the reply off the screen.
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

    /// An image's name made unique by its content: `photo.png` becomes
    /// `photo-3fa2c1d0.png`. The name is all a chat row keeps of a picture, so
    /// it is the key a sent bubble finds its local copy by after a relaunch. Two
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
}

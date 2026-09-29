import Foundation

/// The scanned or typed pairing payload (spec 6.1):
/// `{"v":1,"host":"https://<mac>.<tailnet>.ts.net","token":"<base64url-32B>","name":"Mac Studio"}`.
///
/// Validation order is the spec's: `v`, then the endpoint policy on `host`,
/// then the token shape. A wrong version is its own error so the copy can say
/// "from a newer version of Useful Bot" instead of a generic parse failure.
public struct PairingPayload: Sendable, Equatable {
    public static let currentVersion = 1

    public let host: CanonicalOrigin
    public let token: String
    public let name: String

    public enum ValidationError: Error, Equatable {
        case unreadable
        case versionUnknown(Int)
        case endpoint(EndpointError)
        case tokenMalformed
        case tokenShort
        case nameMissing
    }

    /// Decode and validate a QR/manual payload. `manualToken` lets the manual
    /// path supply the token field separately (the field stays masked and is
    /// never parsed as JSON).
    public init(json text: String, manualToken: String? = nil) throws {
        struct Raw: Decodable {
            let v: Int?
            let host: String?
            let token: String?
            let name: String?
        }
        guard let data = text.data(using: .utf8),
              let raw = try? JSONDecoder().decode(Raw.self, from: data) else {
            throw ValidationError.unreadable
        }
        guard let version = raw.v else {
            throw ValidationError.unreadable
        }
        guard version == Self.currentVersion else {
            throw ValidationError.versionUnknown(version)
        }
        guard let hostString = raw.host else {
            throw ValidationError.unreadable
        }
        do {
            host = try TailnetEndpointPolicy.validate(hostString)
        } catch let error as EndpointError {
            throw ValidationError.endpoint(error)
        }
        let token = manualToken ?? raw.token ?? ""
        guard !token.isEmpty else { throw ValidationError.tokenMalformed }
        guard Self.isBase64URL(token) else {
            throw ValidationError.tokenMalformed
        }
        // base64url of 32 random bytes decodes back to >= 32 bytes; anything
        // shorter was never minted by setup-local.
        let decoded = Self.decodeBase64URL(token)
        guard decoded.count >= 32 else {
            throw ValidationError.tokenShort
        }
        self.token = token
        guard let name = raw.name?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else {
            throw ValidationError.nameMissing
        }
        self.name = name
    }

    /// The manual path has no JSON envelope: host + token fields, and the Mac
    /// name is learned from the first session (`/api/status` does not carry
    /// it, so the pairing screen keeps the address as the display name until
    /// then — the design's "Connected to <name>" falls back to the host).
    public init(manualHost hostString: String, token: String) throws {
        do {
            // The manual field asks for an address, not a URL: a scheme-less
            // entry is read as https, which is the only scheme the tailnet
            // path permits anyway. Anything already carrying a scheme is
            // validated as written — `http://` still fails off-loopback.
            let candidate = hostString.contains("://") ? hostString : "https://\(hostString)"
            host = try TailnetEndpointPolicy.validate(candidate)
        } catch let error as EndpointError {
            throw ValidationError.endpoint(error)
        }
        guard !token.isEmpty, Self.isBase64URL(token) else {
            throw ValidationError.tokenMalformed
        }
        guard Self.decodeBase64URL(token).count >= 32 else {
            throw ValidationError.tokenShort
        }
        self.token = token
        self.name = host.url.host ?? host.value
    }

    private static func isBase64URL(_ value: String) -> Bool {
        let padding = value.drop(while: { $0 != "=" })
        // '=' is legal only as a trailing pad of one or two characters.
        guard padding.allSatisfy({ $0 == "=" }), padding.count <= 2 else { return false }
        return value.dropLast(padding.count).allSatisfy {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
        }
    }

    private static func decodeBase64URL(_ value: String) -> Data {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64) ?? Data()
    }
}

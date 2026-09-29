import Foundation

/// The canonical form a paired endpoint is stored and compared under (spec
/// 4.7): `url.origin` — scheme, host, normalized port — and nothing else.
/// Equality on this string is what binds the Keychain account, the stored
/// pairing and every request the phone sends.
public struct CanonicalOrigin: Sendable, Equatable {
    public let value: String

    public init(_ value: String) {
        self.value = value
    }

    /// The origin as a URL, safe to append path components to.
    public var url: URL {
        // An origin that survived TailnetEndpointPolicy.validate always has
        // this shape; force-unwrap would hide a policy bug, so fail loudly.
        guard let url = URL(string: value) else {
            preconditionFailure("CanonicalOrigin carried a non-URL: \(value)")
        }
        return url
    }
}

/// One endpoint rule violation, named so pairing copy can say exactly which
/// rule failed (spec 6.1.5: "the endpoint rule that failed").
public enum EndpointError: Error, Equatable {
    case unreadable
    case schemeNotAllowed
    case hostEmpty
    case userinfo
    case pathQueryFragment
    case portNotAllowed
}

extension EndpointError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unreadable:
            return "That address is not a URL this app can read."
        case .schemeNotAllowed:
            return "The address must be https (or http only for a loopback host)."
        case .hostEmpty:
            return "The address has no host."
        case .userinfo:
            return "The address must not carry a username or password."
        case .pathQueryFragment:
            return "The address must be the origin only — no path, query or fragment."
        case .portNotAllowed:
            return "An https address may only use port 443."
        }
    }
}

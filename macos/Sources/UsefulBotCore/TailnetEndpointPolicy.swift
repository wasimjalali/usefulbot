import Foundation

/// The phone's endpoint rule (spec 4.7): `https` to the paired Mac (port 443
/// normalized away), or `http` only when the host is loopback — the simulator
/// dev path (§7.3). No userinfo, path, query or fragment; what is stored is
/// the canonical origin string and nothing else.
///
/// An input that fails is refused with the rule it broke; nothing is
/// substituted, ever — a substituted endpoint could carry the device token
/// somewhere the owner never pointed it.
public struct TailnetEndpointPolicy: EndpointPolicy {

    public init() {}

    /// Validate a raw input string (pairing payload host, manual entry, or a
    /// stored origin on launch) down to its canonical origin.
    public static func validate(_ input: String) throws -> CanonicalOrigin {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              !scheme.isEmpty else {
            throw EndpointError.unreadable
        }
        guard let host = components.host, !host.isEmpty else {
            throw EndpointError.hostEmpty
        }
        let isHttps = scheme == "https"
        let isLoopbackHttp = scheme == "http" && LocalHost.isLoopback(host)
        guard isHttps || isLoopbackHttp else {
            throw EndpointError.schemeNotAllowed
        }
        if components.user != nil || components.password != nil {
            throw EndpointError.userinfo
        }
        let path = components.path
        if !(path.isEmpty || path == "/") || components.query != nil || components.fragment != nil {
            throw EndpointError.pathQueryFragment
        }
        if let port = components.port, isHttps, port != 443 {
            // The only legal explicit port is 443 on https, which canonical
            // form normalizes away; loopback http takes any port.
            throw EndpointError.portNotAllowed
        }
        guard let canonical = URL(string: trimmed)?.originString else {
            throw EndpointError.unreadable
        }
        return CanonicalOrigin(canonical)
    }

    /// EndpointPolicy: a proposed base must itself validate; there is no
    /// fallback endpoint on the phone.
    public func endpoint(for proposed: URL) throws -> ServerEndpoint {
        let origin = try Self.validate(proposed.absoluteString)
        return ServerEndpoint(baseURL: origin.url)
    }
}

extension URL {
    /// `scheme://host[:port]` with the default port dropped — the canonical
    /// origin. Nil when the URL has no scheme or host.
    var originString: String? {
        guard let components = URLComponents(url: self, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased() else {
            return nil
        }
        // URLComponents keeps the brackets on a v6 literal; wrap bare ones.
        let bare = host.hasPrefix("[") && host.hasSuffix("]")
            ? String(host.dropFirst().dropLast()) : host
        var result = "\(scheme)://\(bare.contains(":") ? "[\(bare)]" : bare)"
        if let port = components.port {
            let isDefault = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            if !isDefault {
                result += ":\(port)"
            }
        }
        return result
    }
}

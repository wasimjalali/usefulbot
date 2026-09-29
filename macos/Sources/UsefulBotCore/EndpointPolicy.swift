import Foundation

/// Decides which endpoint a client may use for a proposed base URL. The
/// desktop substitutes the supervised local service for anything that is not
/// loopback, so a stray remote base can never carry the device token; the
/// phone answers the paired origin it validated under spec 4.7.
public protocol EndpointPolicy: Sendable {
    /// Answers the endpoint the proposed base may use, or throws (spec 4.7
    /// requires rejection to be expressible; a policy must never have to
    /// trap or silently substitute).
    func endpoint(for proposed: URL) throws -> ServerEndpoint
}

#if os(macOS)
/// The desktop rule, unchanged: loopback input passes through; anything else
/// resolves to `ServerConfig.resolved().baseURL`.
public struct DesktopEndpointPolicy: EndpointPolicy {
    public init() {}

    public func endpoint(for proposed: URL) -> ServerEndpoint {
        if LocalHost.isLoopback(proposed.host) {
            return ServerEndpoint(baseURL: proposed)
        }
        return ServerEndpoint(baseURL: ServerConfig.resolved().baseURL)
    }
}
#endif

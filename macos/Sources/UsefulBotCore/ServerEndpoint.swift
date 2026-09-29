import Foundation

/// Where a `BackendClient` may talk: the base URL of the web service it reads
/// and writes. Portable so the desktop and the phone share the type; the
/// canonical-origin rules for pairing (spec 4.7) arrive with the phone's
/// Tailnet implementation in PR-2.
public struct ServerEndpoint: Sendable, Equatable {
    public var baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

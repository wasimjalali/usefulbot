import Foundation

/// A confirmation the bot asked for, mirroring `Proposal` in
/// `shared/agent-store.ts`. Payload fields are flattened onto the record, so
/// decoding is tolerant per kind and the UI reads only what it needs.
public struct Proposal: Identifiable, Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case connectApp
        case connectServer
        /// A kind this build does not know. It renders as unsupported and can
        /// never be confirmed; it must not collapse into a known action.
        case unknown

        init(wire raw: String) {
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum ServerAuthKind: String, Sendable {
        case none, apiKey, bearer, oauth
    }

    /// Where a connect card is, mirroring `ConnectPhase` in the store.
    public enum ConnectPhase: String, Sendable {
        case proposed, waiting, connected, expired
        /// The sign-in or the tool listing failed; `reason` says how.
        case failed
        /// A phase this build doesn't know. The card renders as a plain line
        /// and can only be put away.
        case unknown
    }

    /// Why a failed connect card failed, mirroring the server's `reason`.
    public enum ConnectFailure: String, Sendable {
        case authFailed = "auth_failed"
        case expired
        case unreachable
        case malformed
        case discoveryFailed = "discovery_failed"

        public var line: String {
            switch self {
            case .authFailed: return "Signed in, but the server refused access."
            case .expired: return "The sign-in expired."
            case .unreachable: return "Couldn't reach the server."
            case .malformed: return "The server's tools couldn't be read."
            case .discoveryFailed: return "Couldn't list the server's tools."
            }
        }

        /// A reason this app doesn't know still reads as a failure.
        public static func line(for reason: ConnectFailure?) -> String {
            reason?.line ?? "The connection failed."
        }
    }

    public let id: String
    public let kind: Kind
    public let status: String
    public let expiresAt: String

    public let name: String?
    public let slug: String?
    public let logo: String?
    public let purpose: String?
    public let phase: ConnectPhase
    public let reason: ConnectFailure?
    public let toolCount: Int?
    public let connectionId: String?
    public let urlHost: String?
    public let authKind: ServerAuthKind
    public let redirectHost: String?
    public let waitingSince: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = Kind(wire: (try? c.decode(String.self, forKey: .kind)) ?? "")
        status = (try? c.decode(String.self, forKey: .status)) ?? "pending"
        expiresAt = (try? c.decode(String.self, forKey: .expiresAt)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        slug = try? c.decodeIfPresent(String.self, forKey: .slug)
        logo = try? c.decodeIfPresent(String.self, forKey: .logo)
        purpose = try? c.decodeIfPresent(String.self, forKey: .purpose)
        if let rawPhase = try? c.decodeIfPresent(String.self, forKey: .phase), !rawPhase.isEmpty {
            phase = ConnectPhase(rawValue: rawPhase) ?? .unknown
        } else {
            phase = .proposed
        }
        reason = ConnectFailure(rawValue: (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? "")
        toolCount = try? c.decodeIfPresent(Int.self, forKey: .toolCount)
        connectionId = try? c.decodeIfPresent(String.self, forKey: .connectionId)
        urlHost = try? c.decodeIfPresent(String.self, forKey: .urlHost)
        authKind = ServerAuthKind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .authKind)) ?? "") ?? .none
        redirectHost = try? c.decodeIfPresent(String.self, forKey: .redirectHost)
        waitingSince = try? c.decodeIfPresent(String.self, forKey: .waitingSince)
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, status, expiresAt, name
        case slug, logo, purpose, phase, reason, toolCount
        case connectionId, urlHost, authKind, redirectHost, waitingSince
    }

    /// The tool-count line of a connected card: a listing that came back empty
    /// says so rather than "0 tools". Nil when the count is unknown.
    public var connectedToolsLine: String? {
        guard phase == .connected, let count = toolCount else { return nil }
        if count == 0 { return "Connected, no tools" }
        return count == 1 ? "1 tool" : "\(count) tools"
    }

    /// Pending and not past its TTL. A date that does not parse is treated as
    /// closed.
    public func isOpen(now: Date = Date()) -> Bool {
        guard status == "pending" else { return false }
        guard let expiry = RailClock.date(from: expiresAt) else { return false }
        return expiry > now
    }

    /// Whether the busy mark set when the owner tapped this card still holds.
    /// A connect card's mark is capped at 10 s in any phase, counted from when
    /// the confirm request returned (`requestFinishedAt`; nil while it is still
    /// out, so a slow request keeps its mark until it returns), so a card left
    /// where it was after a refused redirect gets its buttons back; one that
    /// is waiting or failed is settled sooner when it differs from what it was
    /// at tap time (another phase, or a newer `waitingSince`). Any other kind
    /// clears its own mark when its request ends.
    public func busyMarkHolds(
        tapPhase: ConnectPhase,
        tapWaitingSince: String?,
        requestFinishedAt: Date?,
        now: Date = Date()
    ) -> Bool {
        guard kind == .connectApp || kind == .connectServer else { return true }
        if let finished = requestFinishedAt, now.timeIntervalSince(finished) >= 10 { return false }
        guard phase == .waiting || phase == .failed else { return true }
        return phase == tapPhase && waitingSince == tapWaitingSince
    }

    /// Composio cards only open composio.dev. Server cards only open the
    /// authorize host stored on the card. A missing host is a refusal.
    public static func connectRedirectAllowed(_ raw: String, kind: Kind, expectedHost: String?) -> Bool {
        guard let url = URL(string: raw), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if url.user != nil || url.password != nil { return false }
        if kind == .connectApp {
            return host == "composio.dev" || host.hasSuffix(".composio.dev")
        }
        if kind == .connectServer {
            guard let expected = expectedHost?.lowercased(), !expected.isEmpty else { return false }
            guard isPublicAuthorizeHost(host) else { return false }
            return host == expected
        }
        return false
    }
}

private func isPublicAuthorizeHost(_ host: String) -> Bool {
    if LocalHost.isLocal(host) { return false }
    if host.contains(":") { return false }
    if !host.contains(".") { return false }
    return host.contains(where: \.isLetter)
}

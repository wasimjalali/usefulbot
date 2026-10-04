import Foundation

/// A confirmation the bot asked for, mirroring `Proposal` in
/// `shared/agent-store.ts`. Payload fields are flattened onto the record, so
/// decoding is tolerant per kind and the UI reads only what it needs.
public struct Proposal: Identifiable, Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case createBot
        case createGroup
        case updateBotProfile
        case fanout
        case connectApp
        case connectServer
        /// A kind this build does not know. It renders as unsupported and can
        /// never be confirmed; it must not collapse into a known action.
        case unknown
    }

    public enum ServerAuthKind: String, Sendable {
        case none, apiKey, bearer, oauth
    }

    /// Where a connect card is, mirroring `ConnectPhase` in the store.
    public enum ConnectPhase: String, Sendable {
        case proposed, waiting, connected, expired
    }

    public struct ProfilePatch: Decodable, Equatable, Sendable {
        public var name: String
        public var title: String
        /// Nil means the card leaves the description alone.
        public var description: String?
        public var petname: String?
        public var avatarShape: String?
        public var avatarColor: String?
    }

    public let id: String
    public let kind: Kind
    public let status: String
    public let expiresAt: String

    public let name: String?
    public let petname: String?
    public let title: String?
    public let description: String?
    public let sectionId: String?
    public let brief: String?
    public let memberIds: [String]
    public let botId: String?
    public let patch: ProfilePatch?
    public let message: String?
    public let targetIds: [String]
    public let groupId: String?
    public let sourceBotId: String?
    public let slug: String?
    public let logo: String?
    public let purpose: String?
    public let phase: ConnectPhase
    public let toolCount: Int?
    public let connectionId: String?
    public let urlHost: String?
    public let authKind: ServerAuthKind
    public let redirectHost: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = Kind(rawValue: (try? c.decode(String.self, forKey: .kind)) ?? "") ?? .unknown
        status = (try? c.decode(String.self, forKey: .status)) ?? "pending"
        expiresAt = (try? c.decode(String.self, forKey: .expiresAt)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        petname = try? c.decodeIfPresent(String.self, forKey: .petname)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        sectionId = try? c.decodeIfPresent(String.self, forKey: .sectionId)
        brief = try? c.decodeIfPresent(String.self, forKey: .brief)
        memberIds = (try? c.decode([String].self, forKey: .memberIds)) ?? []
        botId = try? c.decodeIfPresent(String.self, forKey: .botId)
        if let raw = try? c.decodeIfPresent(ProfilePatch.self, forKey: .patch) {
            patch = raw
        } else {
            patch = nil
        }
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        targetIds = (try? c.decode([String].self, forKey: .targetIds)) ?? []
        groupId = try? c.decodeIfPresent(String.self, forKey: .groupId)
        sourceBotId = try? c.decodeIfPresent(String.self, forKey: .sourceBotId)
        slug = try? c.decodeIfPresent(String.self, forKey: .slug)
        logo = try? c.decodeIfPresent(String.self, forKey: .logo)
        purpose = try? c.decodeIfPresent(String.self, forKey: .purpose)
        phase = ConnectPhase(rawValue: (try? c.decodeIfPresent(String.self, forKey: .phase)) ?? "") ?? .proposed
        toolCount = try? c.decodeIfPresent(Int.self, forKey: .toolCount)
        connectionId = try? c.decodeIfPresent(String.self, forKey: .connectionId)
        urlHost = try? c.decodeIfPresent(String.self, forKey: .urlHost)
        authKind = ServerAuthKind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .authKind)) ?? "") ?? .none
        redirectHost = try? c.decodeIfPresent(String.self, forKey: .redirectHost)
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, status, expiresAt, name, petname, title, description
        case sectionId, brief, memberIds, botId, patch, message, targetIds, groupId, sourceBotId
        case slug, logo, purpose, phase, toolCount
        case connectionId, urlHost, authKind, redirectHost
    }

    /// Pending and not past its TTL. A date that does not parse is treated as
    /// closed.
    public func isOpen(now: Date = Date()) -> Bool {
        guard status == "pending" else { return false }
        guard let expiry = RailClock.date(from: expiresAt) else { return false }
        return expiry > now
    }

    /// The bot a fan-out proposal sends to, or nil when every target was
    /// pruned. A nil means confirm must be disabled, never a guessed recipient.
    public var fanoutTargetId: String? {
        if let groupId { return groupId }
        return targetIds.first
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

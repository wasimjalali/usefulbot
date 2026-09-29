import Foundation

/// Wire types for the local web server. Decoding is tolerant: a field a newer
/// server adds is ignored, and a field this client doesn't know yet falls back
/// to a safe default instead of failing the whole store.
public struct ShellBot: Codable, Identifiable, Equatable, Sendable {    public let id: String
    public let kind: String
    public var name: String
    public var petname: String?
    public var label: String
    public var description: String
    public var notify: Bool
    public var pinned: Bool
    public var hidden: Bool
    public var sectionId: String?
    public var sessionId: String?
    public var memberIds: [String]
    public var lastPreview: String
    public var lastAt: String?
    public var avatarShape: String
    public var avatarColor: String
    public var avatarImage: String?
    public var avatarCustom: Bool
    /// What the bot may do on this Mac, in the attached folder or under the
    /// owner's home. A string, like `BotWorkspace.permission`, so a newer
    /// server's value survives the decode.
    public var permission: String
    public var workspace: BotWorkspace?

    public var isGroup: Bool { kind == "group" }


    public var isReadOnly: Bool { permission == "read_only" }
    public var isFullAccess: Bool { permission == "full_access" }

    public var permissionLabel: String {
        switch permission {
        case "read_only": return "Read only"
        case "full_access": return "Full access"
        default: return "Auto"
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, name, petname, label, description, notify, pinned, hidden
        case sectionId, sessionId, memberIds, lastPreview, lastAt
        case avatarShape, avatarColor, avatarImage, avatarCustom
        case permission, workspace
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "bot"
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        petname = try? c.decodeIfPresent(String.self, forKey: .petname)
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        description = (try? c.decode(String.self, forKey: .description)) ?? ""
        notify = (try? c.decode(Bool.self, forKey: .notify)) ?? false
        pinned = (try? c.decode(Bool.self, forKey: .pinned)) ?? false
        hidden = (try? c.decode(Bool.self, forKey: .hidden)) ?? false
        sectionId = try? c.decodeIfPresent(String.self, forKey: .sectionId)
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        memberIds = (try? c.decode([String].self, forKey: .memberIds)) ?? []
        lastPreview = (try? c.decode(String.self, forKey: .lastPreview)) ?? ""
        lastAt = try? c.decodeIfPresent(String.self, forKey: .lastAt)
        avatarShape = (try? c.decode(String.self, forKey: .avatarShape)) ?? "circle"
        avatarColor = (try? c.decode(String.self, forKey: .avatarColor)) ?? "ink"
        avatarImage = try? c.decodeIfPresent(String.self, forKey: .avatarImage)
        avatarCustom = (try? c.decode(Bool.self, forKey: .avatarCustom)) ?? false
        workspace = try? c.decodeIfPresent(BotWorkspace.self, forKey: .workspace)
        // An older server carried the permission on the folder only.
        let decoded = (try? c.decode(String.self, forKey: .permission)) ?? workspace?.permission ?? "auto"
        permission = decoded == "guard" ? "auto" : decoded
    }
}

/// One folder in the composer's project recents.
public struct ProjectEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let path: String
    public let name: String
    public let lastUsedAt: String
}

struct WorkspaceProjectsResponse: Codable {
    let ok: Bool
    let projects: [ProjectEntry]
}

/// The folder this conversation works in, as the shell store carries it.
/// `permission` stays a string here: an unknown value from a newer server
/// renders as its raw word instead of failing the whole store.
public struct BotWorkspace: Codable, Equatable, Sendable {
    public let path: String
    public let permission: String

    /// A folder name comes from the filesystem, so control characters are
    /// stripped before it can reach the composer or a message.
    public var folderName: String {
        let cleaned = BotWorkspace.sanitized((path as NSString).lastPathComponent)
        return cleaned.isEmpty ? "Folder" : String(cleaned.prefix(80))
    }

    /// Drop C0/C1 controls, Unicode format characters and the line and
    /// paragraph separators. Format carries the bidi overrides and zero-width
    /// joiners that spoof a menu row; U+2028 and U+2029 are not controls but
    /// break a line all the same, which is a prompt line a crafted folder name
    /// would otherwise write.
    static func sanitized(_ value: String) -> String {
        String(value.unicodeScalars.filter { scalar in
            guard scalar.value >= 0x20, !(scalar.value >= 0x7f && scalar.value <= 0x9f) else { return false }
            switch scalar.properties.generalCategory {
            case .format, .lineSeparator, .paragraphSeparator, .control:
                return false
            default:
                return true
            }
        })
    }

    public var isReadOnly: Bool { permission == "read_only" }
    public var isFullAccess: Bool { permission == "full_access" }

    public var permissionLabel: String {
        switch permission {
        case "read_only": return "Read only"
        case "full_access": return "Full access"
        default: return "Auto"
        }
    }

    enum CodingKeys: String, CodingKey {
        case path, permission
    }

    public init?(path: String, permission: String) {
        // A grant is a filesystem capability: an empty or relative path is no
        // folder, and a workspace that cannot say where it points must not
        // render as one.
        guard !path.isEmpty, path.hasPrefix("/") else { return nil }
        self.path = path
        self.permission = permission
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decodedPath = (try? c.decode(String.self, forKey: .path)) ?? ""
        guard !decodedPath.isEmpty, decodedPath.hasPrefix("/") else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "workspace path must be absolute"
            ))
        }
        path = decodedPath
        // "guard" is what this mode was called before it became Auto; a store
        // written by that build still reads as the same posture.
        let decoded = (try? c.decode(String.self, forKey: .permission)) ?? "auto"
        permission = decoded == "guard" ? "auto" : decoded
    }
}

public struct ShellSection: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var collapsed: Bool
    public var order: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? "Section"
        collapsed = (try? c.decode(Bool.self, forKey: .collapsed)) ?? false
        order = (try? c.decode(Int.self, forKey: .order)) ?? 0
    }

    enum CodingKeys: String, CodingKey { case id, name, collapsed, order }
}

public struct ShellRecent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var botId: String
    public var title: String
    public var sessionId: String?
    public var preview: String
    public var updatedAt: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = (try? c.decode(String.self, forKey: .botId)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? "Chat"
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        preview = (try? c.decode(String.self, forKey: .preview)) ?? ""
        updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
    }

    enum CodingKeys: String, CodingKey { case id, botId, title, sessionId, preview, updatedAt }
}

public struct ShellStore: Codable, Equatable, Sendable {
    public var selectedBotId: String?
    public var collapsedUnassigned: Bool
    public var collapsedHidden: Bool
    public var bots: [ShellBot]
    public var sections: [ShellSection]
    public var recents: [ShellRecent]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        selectedBotId = try? c.decodeIfPresent(String.self, forKey: .selectedBotId)
        collapsedUnassigned = (try? c.decode(Bool.self, forKey: .collapsedUnassigned)) ?? false
        // The web defaults Hidden to collapsed unless the store says otherwise.
        collapsedHidden = (try? c.decode(Bool.self, forKey: .collapsedHidden)) ?? true
        bots = (try? c.decode([ShellBot].self, forKey: .bots)) ?? []
        sections = (try? c.decode([ShellSection].self, forKey: .sections)) ?? []
        recents = (try? c.decode([ShellRecent].self, forKey: .recents)) ?? []
    }

    public var pinnedBots: [ShellBot] { bots.filter { $0.pinned && !$0.hidden } }
    public var hiddenBots: [ShellBot] { bots.filter(\.hidden) }
    public func sectionBots(_ sectionId: String?) -> [ShellBot] {
        bots.filter { !$0.hidden && !$0.pinned && $0.sectionId == sectionId }
    }

    enum CodingKeys: String, CodingKey {
        case selectedBotId, collapsedUnassigned, collapsedHidden, bots, sections, recents
    }
}

public struct AgentEvent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    /// Server write time, ISO 8601. Older stores omit it, so it stays optional.
    public let at: String?
    public let kind: String
    public let text: String
    public let authorBotId: String?
    public let authorName: String?
    public let targetBotIds: [String]
    public let proposalId: String?
    public let handoffId: String?
    public let widgetId: String?
    /// Generated image the row renders, fetched from `/api/agent/image/<id>`.
    /// On a "page" row, the Library item of the HTML file.
    public let imageId: String?
    /// On the host's "connected" note: what was added, and its logo.
    public let connectedName: String?
    public let connectedLogo: String?

    enum CodingKeys: String, CodingKey {
        case id, at, kind, text, authorBotId, authorName, targetBotIds, proposalId, handoffId, widgetId, imageId
        case connectedName, connectedLogo
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        kind = try c.decode(String.self, forKey: .kind)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        authorBotId = try? c.decodeIfPresent(String.self, forKey: .authorBotId)
        authorName = try? c.decodeIfPresent(String.self, forKey: .authorName)
        targetBotIds = (try? c.decode([String].self, forKey: .targetBotIds)) ?? []
        proposalId = try? c.decodeIfPresent(String.self, forKey: .proposalId)
        handoffId = try? c.decodeIfPresent(String.self, forKey: .handoffId)
        widgetId = try? c.decodeIfPresent(String.self, forKey: .widgetId)
        imageId = try? c.decodeIfPresent(String.self, forKey: .imageId)
        connectedName = try? c.decodeIfPresent(String.self, forKey: .connectedName)
        connectedLogo = try? c.decodeIfPresent(String.self, forKey: .connectedLogo)
    }
}

/// One note from `/api/memory`, shown in the bot settings pane.
public struct MemoryNote: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var body: String
    public var updatedAt: String
    public var truncated: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? "Note"
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        truncated = (try? c.decode(Bool.self, forKey: .truncated)) ?? false
    }

    enum CodingKeys: String, CodingKey { case id, title, body, updatedAt, truncated }
}

/// `/api/providers` composer state, mirrored from `ComposerPublic`.
public struct ComposerState: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public let id: String
        public let label: String
    }

    /// One connected connection's models, mirrored from `ComposerGroup`.
    /// The server orders these with the active connection first.
    public struct Group: Codable, Equatable, Sendable {
        public let connectionId: String
        public let label: String
        public let icon: String
        public var models: [Option]

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            connectionId = (try? c.decode(String.self, forKey: .connectionId)) ?? ""
            label = (try? c.decode(String.self, forKey: .label)) ?? ""
            icon = (try? c.decode(String.self, forKey: .icon)) ?? ""
            models = (try? c.decode([Option].self, forKey: .models)) ?? []
        }

        enum CodingKeys: String, CodingKey { case connectionId, label, icon, models }
    }

    public var connectionId: String
    public var modelId: String
    public var modelLabel: String
    public var effort: String?
    public var effortLabel: String?
    public var speed: String
    public var efforts: [Option]
    public var speeds: [Option]
    public var models: [Option]
    public var groups: [Group]

    /// What the chip shows after the model name: effort plus fast, or nil
    /// when neither applies.
    public var chipMeta: String? {
        let parts = [effortLabel, speed == "fast" ? "Fast" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    enum CodingKeys: String, CodingKey {
        case connectionId, modelId, modelLabel, effort, effortLabel, speed, efforts, speeds, models, groups
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionId = (try? c.decode(String.self, forKey: .connectionId)) ?? ""
        modelId = (try? c.decode(String.self, forKey: .modelId)) ?? ""
        modelLabel = (try? c.decode(String.self, forKey: .modelLabel)) ?? ""
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        effortLabel = try? c.decodeIfPresent(String.self, forKey: .effortLabel)
        speed = (try? c.decode(String.self, forKey: .speed)) ?? "standard"
        efforts = (try? c.decode([Option].self, forKey: .efforts)) ?? []
        speeds = (try? c.decode([Option].self, forKey: .speeds)) ?? []
        models = (try? c.decode([Option].self, forKey: .models)) ?? []
        groups = (try? c.decode([Group].self, forKey: .groups)) ?? []
    }
}

/// A file that survived `POST /api/attachments`.
public struct Attachment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var bytes: Int
    public var text: String?
    /// Set for images: the media type the turn sends the part with.
    public var mediaType: String?
    /// Set for images: a `data:` URL of the bytes, as `/api/attachments` returned it.
    public var dataUrl: String?

    public init(id: String, name: String, bytes: Int, text: String?, mediaType: String? = nil, dataUrl: String? = nil) {
        self.id = id
        self.name = name
        self.bytes = bytes
        self.text = text
        self.mediaType = mediaType
        self.dataUrl = dataUrl
    }

    public var isImage: Bool { mediaType != nil && dataUrl != nil }
}

/// One pending write or command from `/api/approvals`, shown above the chat.
public struct ApprovalItem: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let actionSha256: String
    public let preview: String
    public let tool: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        actionSha256 = (try? c.decode(String.self, forKey: .actionSha256)) ?? ""
        preview = (try? c.decode(String.self, forKey: .preview)) ?? ""
        tool = (try? c.decode(String.self, forKey: .tool)) ?? ""
    }

    public init(id: String, actionSha256: String, preview: String, tool: String) {
        self.id = id
        self.actionSha256 = actionSha256
        self.preview = preview
        self.tool = tool
    }

    enum CodingKeys: String, CodingKey { case id, actionSha256, preview, tool }
}

/// `/api/providers` row, mirrored from `ProviderPublic`. Legacy shape, kept so
/// the old settings dialog path and existing tests keep decoding.
public struct ProviderPublic: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let hint: String
    public let compatible: Bool
    public let connected: Bool
    public let last4: String?
    public let source: String?
    public let active: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "api"
        hint = (try? c.decode(String.self, forKey: .hint)) ?? ""
        compatible = (try? c.decode(Bool.self, forKey: .compatible)) ?? true
        connected = (try? c.decode(Bool.self, forKey: .connected)) ?? false
        last4 = try? c.decodeIfPresent(String.self, forKey: .last4)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        active = (try? c.decode(Bool.self, forKey: .active)) ?? false
    }

    enum CodingKeys: String, CodingKey {
        case id, name, kind, hint, compatible, connected, last4, source, active
    }
}

/// One extra text field the connect sheet collects, from `ProviderMode.fields`.
public struct CatalogField: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let placeholder: String
    public var secret: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
        placeholder = (try? c.decode(String.self, forKey: .placeholder)) ?? ""
        secret = (try? c.decode(Bool.self, forKey: .secret)) ?? false
    }

    public init(id: String, label: String, placeholder: String, secret: Bool = false) {
        self.id = id
        self.label = label
        self.placeholder = placeholder
        self.secret = secret
    }

    enum CodingKeys: String, CodingKey { case id, label, placeholder, secret }
}

/// One connectable (provider, mode) row from `GET /api/providers`, mirrored
/// from `CatalogPublic`. Decode is tolerant like `ProviderPublic`: unknown keys
/// are ignored and missing optionals fall back instead of failing the payload.
public struct CatalogPublic: Codable, Identifiable, Equatable, Sendable {
    public let providerId: String
    public let mode: String
    public let label: String
    public let kindLabel: String
    public let monogram: String
    public let icon: String
    public let hint: String
    public let keyUrl: String?
    public var fields: [CatalogField]?
    public var oauth: Bool
    public var connected: Bool

    public var id: String { "\(providerId):\(mode)" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providerId = try c.decode(String.self, forKey: .providerId)
        mode = (try? c.decode(String.self, forKey: .mode)) ?? "api"
        label = (try? c.decode(String.self, forKey: .label)) ?? providerId
        kindLabel = (try? c.decode(String.self, forKey: .kindLabel)) ?? "API"
        monogram = (try? c.decode(String.self, forKey: .monogram)) ?? "?"
        icon = (try? c.decode(String.self, forKey: .icon)) ?? ""
        hint = (try? c.decode(String.self, forKey: .hint)) ?? ""
        keyUrl = try? c.decodeIfPresent(String.self, forKey: .keyUrl)
        fields = try? c.decodeIfPresent([CatalogField].self, forKey: .fields)
        oauth = (try? c.decode(Bool.self, forKey: .oauth)) ?? false
        connected = (try? c.decode(Bool.self, forKey: .connected)) ?? false
    }

    enum CodingKeys: String, CodingKey {
        case providerId, mode, label, kindLabel, monogram, icon, hint, keyUrl, fields, oauth, connected
    }
}

/// One model listed for a connection.
public struct ConnectionModelOption: Codable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
    }

    enum CodingKeys: String, CodingKey { case id, label }
}

/// One connected connection from `GET /api/providers`, mirrored from
/// `ConnectionPublic`. Never carries a key, only `last4`.
public struct ConnectionPublic: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let providerId: String
    public let mode: String
    public let label: String
    public let kindLabel: String
    public let monogram: String
    public let icon: String
    public var connected: Bool
    public let last4: String?
    public let source: String?
    public var active: Bool
    public var status: String
    public let lastError: String?
    public let accountId: String?
    public var fields: [String: String]
    public var models: [ConnectionModelOption]
    /// The catalogue's everyday model for this connection; nil from an older server.
    public let defaultModelId: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        providerId = (try? c.decode(String.self, forKey: .providerId)) ?? id
        mode = (try? c.decode(String.self, forKey: .mode)) ?? "api"
        label = (try? c.decode(String.self, forKey: .label)) ?? providerId
        kindLabel = (try? c.decode(String.self, forKey: .kindLabel)) ?? "API"
        monogram = (try? c.decode(String.self, forKey: .monogram)) ?? "?"
        icon = (try? c.decode(String.self, forKey: .icon)) ?? ""
        connected = (try? c.decode(Bool.self, forKey: .connected)) ?? false
        last4 = try? c.decodeIfPresent(String.self, forKey: .last4)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        active = (try? c.decode(Bool.self, forKey: .active)) ?? false
        status = (try? c.decode(String.self, forKey: .status)) ?? "ok"
        lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
        accountId = try? c.decodeIfPresent(String.self, forKey: .accountId)
        fields = (try? c.decode([String: String].self, forKey: .fields)) ?? [:]
        models = (try? c.decode([ConnectionModelOption].self, forKey: .models)) ?? []
        defaultModelId = try? c.decodeIfPresent(String.self, forKey: .defaultModelId)
    }

    enum CodingKeys: String, CodingKey {
        case id, providerId, mode, label, kindLabel, monogram, icon, connected, last4
        case source, active, status, lastError, accountId, fields, models, defaultModelId
    }
}

/// One reasoning effort choice on a role.
public struct RoleEffortOption: Codable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
    }

    enum CodingKeys: String, CodingKey { case id, label }
}

/// One model choice on a role, grouped by its connection.
public struct RoleModelOption: Codable, Equatable, Sendable {
    public let connectionId: String
    public let connectionLabel: String
    public let icon: String
    public let id: String
    public let label: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionId = (try? c.decode(String.self, forKey: .connectionId)) ?? ""
        connectionLabel = (try? c.decode(String.self, forKey: .connectionLabel)) ?? ""
        icon = (try? c.decode(String.self, forKey: .icon)) ?? ""
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
    }

    enum CodingKeys: String, CodingKey { case connectionId, connectionLabel, icon, id, label }
}

/// One task-model role from `GET /api/providers`, mirrored from `RolePublic`.
public struct RolePublic: Codable, Equatable, Sendable {
    public var connectionId: String?
    public var connectionLabel: String
    public var connectionIcon: String
    public var modelId: String
    public var modelLabel: String
    public var effort: String?
    public var effortLabel: String?
    public var efforts: [RoleEffortOption]
    public var models: [RoleModelOption]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionId = try? c.decodeIfPresent(String.self, forKey: .connectionId)
        connectionLabel = (try? c.decode(String.self, forKey: .connectionLabel)) ?? ""
        connectionIcon = (try? c.decode(String.self, forKey: .connectionIcon)) ?? ""
        modelId = (try? c.decode(String.self, forKey: .modelId)) ?? ""
        modelLabel = (try? c.decode(String.self, forKey: .modelLabel)) ?? ""
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        effortLabel = try? c.decodeIfPresent(String.self, forKey: .effortLabel)
        efforts = (try? c.decode([RoleEffortOption].self, forKey: .efforts)) ?? []
        models = (try? c.decode([RoleModelOption].self, forKey: .models)) ?? []
    }

    enum CodingKeys: String, CodingKey {
        case connectionId, connectionLabel, connectionIcon, modelId, modelLabel
        case effort, effortLabel, efforts, models
    }
}

/// `GET /api/providers` payload: the catalogue, the connected connections, the
/// task-model roles, the composer state and the legacy rows the old web dialog
/// still reads. Every section defaults, so a newer or older server cannot fail
/// the whole pane.
public struct ProvidersPayload: Decodable, Equatable, Sendable {
    public var catalog: [CatalogPublic]
    public var connections: [ConnectionPublic]
    public var defaultRole: RolePublic?
    public var reviewerRole: RolePublic?
    public var imageRole: RolePublic?
    public var composer: ComposerState?
    public var legacyProviders: [ProviderPublic]
    public var legacyActiveProviderId: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        catalog = (try? c.decode([CatalogPublic].self, forKey: .catalog)) ?? []
        connections = (try? c.decode([ConnectionPublic].self, forKey: .connections)) ?? []
        if let roles = try? c.nestedContainer(keyedBy: RoleKeys.self, forKey: .roles) {
            defaultRole = try? roles.decodeIfPresent(RolePublic.self, forKey: .default)
            reviewerRole = try? roles.decodeIfPresent(RolePublic.self, forKey: .reviewer)
            imageRole = try? roles.decodeIfPresent(RolePublic.self, forKey: .image)
        } else {
            defaultRole = nil
            reviewerRole = nil
            imageRole = nil
        }
        composer = try? c.decodeIfPresent(ComposerState.self, forKey: .composer)
        legacyProviders = (try? c.decode([ProviderPublic].self, forKey: .providers)) ?? []
        legacyActiveProviderId = try? c.decodeIfPresent(String.self, forKey: .activeProviderId)
    }

    enum CodingKeys: String, CodingKey {
        case catalog, connections, roles, composer, providers, activeProviderId
    }

    enum RoleKeys: String, CodingKey { case `default`, reviewer, image }
}

/// `POST /api/providers/oauth` answer: what the device sheet shows.
public struct DeviceFlowStart: Codable, Equatable, Sendable {
    public let pollId: String
    public let userCode: String
    public let verificationUrl: String
    public let verificationUrlComplete: String?
    public let expiresAt: Double
    public let intervalMs: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pollId = try c.decode(String.self, forKey: .pollId)
        userCode = (try? c.decode(String.self, forKey: .userCode)) ?? ""
        verificationUrl = (try? c.decode(String.self, forKey: .verificationUrl)) ?? ""
        verificationUrlComplete = try? c.decodeIfPresent(String.self, forKey: .verificationUrlComplete)
        if let expires = try? c.decode(Double.self, forKey: .expiresAt) {
            expiresAt = expires
        } else if let millis = try? c.decode(Int.self, forKey: .expiresAt) {
            expiresAt = Double(millis)
        } else {
            expiresAt = 0
        }
        intervalMs = (try? c.decode(Int.self, forKey: .intervalMs)) ?? 2000
    }

    enum CodingKeys: String, CodingKey {
        case pollId, userCode, verificationUrl, verificationUrlComplete, expiresAt, intervalMs
    }
}

/// `/api/usage` payload.
public struct UsagePayload: Codable, Equatable, Sendable {
    public struct ModelRow: Codable, Identifiable, Equatable, Sendable {
        public let provider: String
        public let model: String
        public let requests: Int
        public let inputTokens: Int
        public let outputTokens: Int

        public var id: String { "\(provider)-\(model)" }

        enum CodingKeys: String, CodingKey {
            case provider, model, requests, inputTokens, outputTokens
        }
    }

    public struct Caps: Codable, Equatable, Sendable {
        public let requests24h: Int
        public let input24h: Int
        public let output24h: Int
    }

    /// The seven-day totals, shown as history beside the day the caps govern.
    public struct Window: Codable, Equatable, Sendable {
        public let observedInputTokens: Int
        public let observedOutputTokens: Int
        public let requests: Int

        public var totalTokens: Int { observedInputTokens + observedOutputTokens }

        enum CodingKeys: String, CodingKey {
            case observedInputTokens = "observed_input_tokens"
            case observedOutputTokens = "observed_output_tokens"
            case requests
        }
    }

    /// What the router charges against the caps right now: observed usage plus
    /// the turns it has reserved for. This, not the observed half, is what the
    /// meter compares against the cap.
    public struct Charged: Codable, Equatable, Sendable {
        public let inputTokens: Int
        public let outputTokens: Int

        enum CodingKeys: String, CodingKey {
            case inputTokens = "input_tokens"
            case outputTokens = "output_tokens"
        }
    }

    /// The owner's daily token budget and the range the control may move it in.
    public struct Budget: Codable, Equatable, Sendable {
        public let tokens: Int
        public let isDefault: Bool
        public let `default`: Int
        public let min: Int
        public let max: Int
        public let step: Int
    }

    public let observedInputTokens: Int
    public let observedOutputTokens: Int
    public let requests: Int
    public let byModel: [ModelRow]
    public let caps: Caps
    public let week: Window?
    public let budget: Budget?
    public let charged: Charged?

    /// Tokens spent in the rolling 24 hours the caps are measured over.
    public var totalTokens: Int { observedInputTokens + observedOutputTokens }
    public var totalCap: Int { caps.input24h + caps.output24h }
    /// What the meters read. A server that does not report the charged totals
    /// falls back to the observed ones rather than drawing nothing.
    public var chargedInputTokens: Int { charged?.inputTokens ?? observedInputTokens }
    public var chargedOutputTokens: Int { charged?.outputTokens ?? observedOutputTokens }

    enum CodingKeys: String, CodingKey {
        case observedInputTokens = "observed_input_tokens"
        case observedOutputTokens = "observed_output_tokens"
        case requests
        case byModel = "by_model"
        case caps
        case week
        case budget
        case charged
    }
}

/// `/api/status` identity plus build info for the settings dialog. S15 adds
/// `apiVersion` and the calling session's `profile`; `eve` is the readiness
/// probe ("available" | "limited" | "unknown") that §7.2's `runtimeDown`
/// level reads.
public struct AppStatus: Codable, Equatable, Sendable {
    public let name: String?
    public let initials: String?
    public let version: String?
    public let theme: String?
    public let apiVersion: Int?
    public let profile: String?
    public let eve: String?

    public init(name: String?, initials: String?, version: String?, theme: String?,
                apiVersion: Int? = nil, profile: String? = nil, eve: String? = nil) {
        self.name = name
        self.initials = initials
        self.version = version
        self.theme = theme
        self.apiVersion = apiVersion
        self.profile = profile
        self.eve = eve
    }

    enum CodingKeys: String, CodingKey {
        case name, initials, version, theme, apiVersion, profile, eve
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TopKeys.self)
        let operatorRow = try? c.nestedContainer(keyedBy: CodingKeys.self, forKey: .`operator`)
        name = try? operatorRow?.decodeIfPresent(String.self, forKey: .name)
        initials = try? operatorRow?.decodeIfPresent(String.self, forKey: .initials)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        theme = try? c.decodeIfPresent(String.self, forKey: .theme)
        apiVersion = try? c.decodeIfPresent(Int.self, forKey: .apiVersion)
        profile = try? c.decodeIfPresent(String.self, forKey: .profile)
        eve = try? c.decodeIfPresent(String.self, forKey: .eve)
    }

    enum TopKeys: String, CodingKey {
        case `operator`, version, theme, apiVersion, profile, eve
    }
}

/// One row of the Connectors catalogue from `/api/connectors`.
public struct ConnectorToolkit: Codable, Identifiable, Equatable, Sendable {
    public let slug: String
    public let name: String
    public let logo: String?
    public let noAuth: Bool
    /// Connect needs the owner's own OAuth app: Composio has none for it.
    public let ownApp: Bool
    public let connected: Bool
    public let accountId: String?
    public let status: String?

    public var id: String { slug }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        name = (try? c.decode(String.self, forKey: .name)) ?? slug
        logo = try? c.decodeIfPresent(String.self, forKey: .logo)
        noAuth = (try? c.decode(Bool.self, forKey: .noAuth)) ?? false
        ownApp = (try? c.decode(Bool.self, forKey: .ownApp)) ?? false
        connected = (try? c.decode(Bool.self, forKey: .connected)) ?? false
        accountId = try? c.decodeIfPresent(String.self, forKey: .accountId)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
    }

    public init(slug: String, name: String, logo: String?, noAuth: Bool, ownApp: Bool = false, connected: Bool, accountId: String?, status: String?) {
        self.slug = slug
        self.name = name
        self.logo = logo
        self.noAuth = noAuth
        self.ownApp = ownApp
        self.connected = connected
        self.accountId = accountId
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case slug, name, logo, noAuth, ownApp, connected, accountId, status
    }
}

/// One credential the owner's own OAuth app supplies (client id, secret, ...).
public struct OwnAppField: Codable, Identifiable, Equatable, Sendable {
    public let name: String
    public let label: String
    public let description: String
    /// Typed hidden.
    public let secret: Bool

    public var id: String { name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        label = (try? c.decode(String.self, forKey: .label)) ?? name
        description = (try? c.decode(String.self, forKey: .description)) ?? ""
        secret = (try? c.decode(Bool.self, forKey: .secret)) ?? false
    }

    public init(name: String, label: String, description: String = "", secret: Bool) {
        self.name = name
        self.label = label
        self.description = description
        self.secret = secret
    }

    enum CodingKeys: String, CodingKey {
        case name, label, description, secret
    }
}

/// `/api/connectors/own-app` payload: what an app needs from the owner's own
/// OAuth app, and the redirect URI to register with the provider.
public struct OwnAppForm: Codable, Equatable, Sendable {
    public let toolkit: String
    public let fields: [OwnAppField]
    public let redirectUri: String

    public init(toolkit: String, fields: [OwnAppField], redirectUri: String) {
        self.toolkit = toolkit
        self.fields = fields
        self.redirectUri = redirectUri
    }
}

/// `/api/connectors` payload: whether a Composio key is set, its last four
/// characters, and the catalogue rows. The key itself never travels.
public struct ConnectorsPayload: Codable, Equatable, Sendable {
    public let hasKey: Bool
    public let last4: String?
    public var toolkits: [ConnectorToolkit]
    /// Set when the route could not reach Composio; the rows are then empty.
    public let error: String?
    /// Rows matching the query in total, and where the next page starts.
    public var total: Int
    public var nextOffset: Int?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasKey = (try? c.decode(Bool.self, forKey: .hasKey)) ?? false
        last4 = try? c.decodeIfPresent(String.self, forKey: .last4)
        toolkits = (try? c.decode([ConnectorToolkit].self, forKey: .toolkits)) ?? []
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        total = (try? c.decode(Int.self, forKey: .total)) ?? toolkits.count
        nextOffset = try? c.decodeIfPresent(Int.self, forKey: .nextOffset)
    }

    public init(hasKey: Bool, last4: String?, toolkits: [ConnectorToolkit], error: String?, total: Int? = nil, nextOffset: Int? = nil) {
        self.hasKey = hasKey
        self.last4 = last4
        self.toolkits = toolkits
        self.error = error
        self.total = total ?? toolkits.count
        self.nextOffset = nextOffset
    }

    enum CodingKeys: String, CodingKey {
        case hasKey, last4, toolkits, error, total, nextOffset
    }
}

/// One saved image or drawing in the owner's media folder, as the Library
/// lists it. `exists` is false when the file is no longer at `path`.
public struct MediaItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// "image", "drawing" or "page" (an HTML file a bot wrote).
    public let kind: String
    public let path: String
    public let botId: String
    public let botName: String
    public let title: String
    public let prompt: String
    public let model: String
    public let provider: String
    public let mime: String
    public let createdAt: String
    public let exists: Bool

    public init(id: String, kind: String, path: String, botId: String, botName: String, title: String,
                prompt: String, model: String, provider: String, mime: String, createdAt: String, exists: Bool) {
        self.id = id
        self.kind = kind
        self.path = path
        self.botId = botId
        self.botName = botName
        self.title = title
        self.prompt = prompt
        self.model = model
        self.provider = provider
        self.mime = mime
        self.createdAt = createdAt
        self.exists = exists
    }
}

/// What `/api/agent/image/<id>` answered: the bytes, a file the owner moved
/// (the row offers Locate), or nothing at all (the row offers Regenerate).
public enum ImageFetch: Equatable, Sendable {
    case loaded(Data)
    case moved
    case missing
}

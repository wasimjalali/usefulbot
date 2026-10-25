import Foundation

/// Shell action payloads for `PUT /api/shell`, matching `ShellAction` in
/// `shared/shell-store.ts`. Building them in one place keeps the native client
/// from drifting from the web contract. There is one bot: no payload creates,
/// deletes, selects or arranges bots.
public enum ShellActions {
    public static func rename(botId: String, name: String) -> [String: Any] {
        ["type": "renameBot", "botId": botId, "name": name]
    }

    /// Attach or detach the folder this conversation works in. `nil` detaches.
    public static func setWorkspace(botId: String, workspace: BotWorkspace?) -> [String: Any] {
        let payload: Any = workspace.map { ws in
            [
                "path": ws.path,
                "permission": ws.permission,
            ] as [String: Any]
        } ?? NSNull()
        return ["type": "setWorkspace", "botId": botId, "workspace": payload]
    }

    /// What the bot may do on this Mac: read_only, auto or full_access. With
    /// or without a folder attached.
    public static func setPermission(botId: String, permission: String) -> [String: Any] {
        ["type": "setPermission", "botId": botId, "permission": permission]
    }

    /// A nil value is left out: no field of the bot clears on null.
    public static func updateBot(botId: String, patch: [String: Any?]) -> [String: Any] {
        var clean: [String: Any] = [:]
        for (key, value) in patch {
            if let value { clean[key] = value }
        }
        return ["type": "updateBot", "botId": botId, "patch": clean]
    }
}

/// Confirm payloads for each proposal kind.
public enum ProposalActions {
    public static func confirm(_ proposal: Proposal) -> [String: Any]? {
        switch proposal.kind {
        case .connectApp:
            guard let slug = proposal.slug, !slug.isEmpty else { return nil }
            return ["type": "connectApp", "slug": slug]
        case .connectServer:
            guard let id = proposal.connectionId, !id.isEmpty else { return nil }
            return ["type": "connectServer", "connectionId": id]
        case .unknown:
            return nil
        }
    }
}

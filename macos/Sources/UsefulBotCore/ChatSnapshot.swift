import Foundation

/// A chat as it was last left at rest, kept on disk so the next open paints it
/// at once and reads only what the session gained since.
///
/// Chat turns live only in the eve session, and eve answers a read from zero
/// by opening every chunk file the session has, one at a time. A long chat
/// (12,554 events for YT Producer) took four to seven seconds behind the
/// mascot on every first open. The projection here is exactly the state that
/// replay would have reached at `cursor`, so a resume applies events
/// `cursor...` to it and ends up where a full replay would have.
///
/// Only a chat at rest is written: no turn in flight, no send of this app's
/// running, and a load that finished. A turn in flight is still read from
/// zero, which is the only read that sees where it began.
public struct ChatSnapshot: Codable, Equatable, Sendable {
    /// Bumped whenever the stored shape or meaning of `StreamProjection`, or
    /// of any type stored inside it, changes. A snapshot of another version is
    /// never restored; the chat is replayed from zero instead and written
    /// again. `ChatSnapshotTests` pins the stored names to this number.
    public static let formatVersion = 4

    public var version: Int
    public var botId: String
    /// The session the projection and the cursor were read from. A snapshot
    /// for any other session than the bot's current pointer is stale.
    public var sessionId: String
    /// The first event index the projection does not hold yet.
    public var cursor: Int
    /// The id of the event at `cursor - 1`. A resume whose session's newest
    /// event carries this id is already caught up and reads nothing.
    public var lastEventId: String?
    public var projection: StreamProjection
    /// The durable side channel (notes, handoffs, routine rows) the rows were
    /// merged from, so the first paint is the full merge.
    public var durableEvents: [AgentEvent]
    /// Every turn id read off the session, for the send's stale-turn check.
    public var seenTurnIds: [String]
    /// Turns a local send painted to their end past `cursor`. The resume
    /// meets their events again and passes over them, as the follower does.
    public var localTurnIds: [String]
    public var savedAt: Date
    /// The replay logic that wrote it (the app passes a hash of this module's
    /// sources and of the AppModel that feeds it). The fold logic in
    /// `StreamProjection.apply` changes without renaming a field, and a
    /// snapshot is only what a replay from zero gives under the logic that
    /// made it, so other logic replays the chat and writes it afresh.
    public var build: String = ""

    public init(
        botId: String,
        sessionId: String,
        cursor: Int,
        lastEventId: String?,
        projection: StreamProjection,
        durableEvents: [AgentEvent],
        seenTurnIds: Set<String>,
        localTurnIds: Set<String>,
        savedAt: Date = Date()
    ) {
        self.version = Self.formatVersion
        self.botId = botId
        self.sessionId = sessionId
        self.cursor = cursor
        self.lastEventId = lastEventId
        self.projection = projection
        self.durableEvents = durableEvents
        self.seenTurnIds = seenTurnIds.sorted()
        self.localTurnIds = localTurnIds.sorted()
        self.savedAt = savedAt
    }
}

/// Reads and writes `ChatSnapshot`s, one file per bot. Every failure reads as
/// "no snapshot": the caller then replays from zero, which is always correct.
public struct ChatSnapshotStore: Sendable {
    public let directory: URL
    /// Stamped on every save and required on every load.
    public let build: String
    /// A snapshot older than this is replayed from zero instead, so anything
    /// it got wrong heals within a week even under one build.
    public let maxAge: TimeInterval

    public init(directory: URL, build: String = "", maxAge: TimeInterval = 7 * 24 * 3600) {
        self.directory = directory
        self.build = build
        self.maxAge = maxAge
    }

    /// `~/Library/Caches/UsefulBot/chat-snapshots`. A cache: everything in it
    /// can be rebuilt from the eve session, so the system may purge it.
    public static var defaultDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches
            .appendingPathComponent("UsefulBot", isDirectory: true)
            .appendingPathComponent("chat-snapshots", isDirectory: true)
    }

    /// Bot ids are server-minted, but a file name is never taken on trust:
    /// anything outside a plain id alphabet is hex-encoded.
    public func fileURL(botId: String) -> URL {
        directory.appendingPathComponent("\(Self.fileStem(botId)).json")
    }

    /// Where the prewarm notes a session it could not snapshot at rest.
    private func unbuildableURL(botId: String) -> URL {
        directory.appendingPathComponent("\(Self.fileStem(botId)).none")
    }

    private static func fileStem(_ botId: String) -> String {
        let plain = !botId.isEmpty && botId.utf8.count <= 128 && botId.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-"
        }
        return plain ? botId : "x" + botId.utf8.map { String(format: "%02x", $0) }.joined().prefix(200)
    }

    /// The snapshot for this bot's current session, or nil when there is none,
    /// it belongs to another session, another format, or cannot be read.
    public func load(botId: String, sessionId: String) -> ChatSnapshot? {
        guard !sessionId.isEmpty,
              let data = try? Data(contentsOf: fileURL(botId: botId)) else { return nil }
        return Self.decode(data, botId: botId, sessionId: sessionId, build: build, maxAge: maxAge)
    }

    public static func decode(
        _ data: Data,
        botId: String,
        sessionId: String,
        build: String = "",
        maxAge: TimeInterval = .infinity,
        now: Date = Date()
    ) -> ChatSnapshot? {
        guard let snapshot = try? JSONDecoder().decode(ChatSnapshot.self, from: data),
              snapshot.version == ChatSnapshot.formatVersion,
              snapshot.build == build,
              now.timeIntervalSince(snapshot.savedAt) <= maxAge,
              snapshot.botId == botId,
              snapshot.sessionId == sessionId,
              snapshot.cursor >= 0,
              snapshot.projection.isConsistent else { return nil }
        return snapshot
    }

    public static func encode(_ snapshot: ChatSnapshot) throws -> Data {
        try JSONEncoder().encode(snapshot)
    }

    /// Written whole and swapped in, owner-only: the file holds the chat.
    public func save(_ snapshot: ChatSnapshot) throws {
        var stamped = snapshot
        stamped.build = build
        try save(Self.encode(stamped), botId: snapshot.botId)
    }

    public func save(_ data: Data, botId: String) throws {
        try save(data, to: fileURL(botId: botId))
    }

    private func save(_ data: Data, to target: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temp = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        // rename(2) swaps the file in atomically, over an older one or not.
        guard rename(temp.path, target.path) == 0 else {
            let code = errno
            try? fm.removeItem(at: temp)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
    }

    public func remove(botId: String) {
        try? FileManager.default.removeItem(at: fileURL(botId: botId))
        try? FileManager.default.removeItem(at: unbuildableURL(botId: botId))
    }

    /// Notes that this session, read up to `newestEventId`, ends on a turn
    /// still open, so no snapshot of it can be taken at rest. The prewarm
    /// skips it while the session's newest event is still that one; once the
    /// session moves on (the turn ended, a new one ran) it is tried again.
    public func markUnbuildable(botId: String, sessionId: String, newestEventId: String) throws {
        try save(Data("\(sessionId)\n\(newestEventId)".utf8), to: unbuildableURL(botId: botId))
    }

    public func isMarkedUnbuildable(botId: String, sessionId: String, newestEventId: String) -> Bool {
        guard let data = try? Data(contentsOf: unbuildableURL(botId: botId)) else { return false }
        return String(decoding: data, as: UTF8.self) == "\(sessionId)\n\(newestEventId)"
    }

    /// Removes every file that belongs to no bot in `botIds`: chats deleted
    /// while this app was closed, or from another surface.
    public func prune(keeping botIds: Set<String>) {
        let keep = Set(botIds.flatMap { ["\(Self.fileStem($0)).json", "\(Self.fileStem($0)).none"] })
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where !keep.contains(name) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}

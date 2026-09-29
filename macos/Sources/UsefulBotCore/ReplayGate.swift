import Foundation

/// Decides when a session replay has caught up with the durable transcript.
///
/// The durable rows already render the whole history, so the replay must be
/// applied silently: republishing it row by row makes a settled transcript
/// look like it is generating again and jitters the scroll. The decision is a
/// pure function of the durable snapshot and one event, so every arm can be
/// tested without a stream.
public enum ReplayGate {
    /// The durable transcript a replay has to catch up with.
    public struct Durable: Equatable, Sendable {
        /// The newest durable user/assistant row. The stream carries only
        /// those, so a durable handoff/post/note can never appear in it.
        public let tailId: String?
        /// The tail's server stamp, when the store is new enough to write one.
        public let tailAt: Date?
        /// Every durable id, so a replayed row can be told from a new one.
        public let ids: Set<String>
        /// Whether any durable row carries a usable stamp at all.
        public let hasStamps: Bool

        public init(tailId: String?, tailAt: Date?, ids: Set<String>, hasStamps: Bool) {
            self.tailId = tailId
            self.tailAt = tailAt
            self.ids = ids
            self.hasStamps = hasStamps
        }

        public init(events: [AgentEvent]) {
            let tail = events.last { $0.kind == "user" || $0.kind == "assistant" }
            self.init(
                tailId: tail?.id,
                tailAt: TranscriptBlocks.date(fromISO8601: tail?.at),
                ids: Set(events.map(\.id)),
                hasStamps: events.contains { TranscriptBlocks.date(fromISO8601: $0.at) != nil }
            )
        }

        /// Nothing to catch up with: the stream is live from its first event.
        public var startsLive: Bool { tailId == nil }
    }

    /// The stream events a durable row is written for. An unknown id proves
    /// novelty only for these: delta chunks and tool results carry ids the
    /// store never holds, so they say nothing about where the replay is.
    private static let durableTypes: Set<String> = ["message.received", "message.completed"]

    /// Whether a turn has actually begun since the replay caught up.
    ///
    /// `StreamProjection.pending` cannot answer this on its own. It is set by
    /// every `message.received` and cleared only by the terminal event that
    /// follows it, so while the replay walks the tail of a conversation that
    /// finished long ago it reads as pending, between the last reply and the
    /// `turn.completed` after it. Coming back to a settled chat flashed a
    /// working row for exactly that stretch.
    ///
    /// A turn counts as live only if it began at or after the live tail. The
    /// event that opens the gate is the tail itself, so a user turn already
    /// durable when the replay started still counts: that is the turn a
    /// handoff or a routine is running right now.
    public struct LiveTurn: Equatable, Sendable {
        /// True while a turn that began after the gate opened has not ended.
        public private(set) var running = false
        /// True when that turn began on an event the durable store has never
        /// written. The store holds a row for every user and assistant
        /// message, so an id it does not know is one that arrived after this
        /// reload read the transcript: proof on its own that the turn is now,
        /// without waiting for the history burst to go quiet.
        public private(set) var novelStart = false

        public init() {}

        private static let starts: Set<String> = ["turn.started", "message.received"]
        private static let ends: Set<String> = [
            "turn.completed", "turn.cancelled", "turn.failed",
            "session.completed", "session.failed", "session.waiting",
        ]

        public mutating func apply(_ event: EveEvent, atLiveTail: Bool, novel: Bool = false) {
            // An end counts wherever it lands: a turn the replay watched start
            // is over the moment its terminal event arrives.
            if Self.ends.contains(event.type) {
                running = false
                novelStart = false
                return
            }
            guard atLiveTail, Self.starts.contains(event.type) else { return }
            running = true
            if novel { novelStart = true }
        }
    }

    /// Whether a working row may show for a turn the replay found running.
    ///
    /// When the server said where its history ended, that is the answer: no
    /// row while the read is still inside it, however live an old turn looks
    /// as it goes by. The two older signals stand in only for a server that
    /// did not say. They misfire on a chat whose rows live in the session and
    /// not in the store: every id there is one the store never wrote, so the
    /// whole history read as a turn happening now, and the row walked through
    /// old steps for as long as the replay took.
    public static func mayShowWorking(historyRemaining: Int?, drained: Bool, novelStart: Bool) -> Bool {
        if let historyRemaining { return historyRemaining <= 0 }
        return drained || novelStart
    }

    /// True once this event proves the replay reached the live tail.
    public static func reachedLiveTail(durable: Durable, event: EveEvent) -> Bool {
        guard let tailId = durable.tailId else { return true }
        if let id = event.id, id == tailId { return true }
        if let tailAt = durable.tailAt,
           let at = TranscriptBlocks.date(fromISO8601: event.metaAt),
           at >= tailAt {
            // The timeline moved past the newest durable row: the replay has
            // caught up.
            return true
        }
        // A store too old to stamp its rows cannot be compared on time, and a
        // server that stamps the whole replay would otherwise flip the gate on
        // the first event of the history the store already shows. Only an id
        // the store never wrote proves the replay moved past it.
        guard !durable.hasStamps, durableTypes.contains(event.type), let id = event.id else {
            return false
        }
        return !durable.ids.contains(id)
    }
}

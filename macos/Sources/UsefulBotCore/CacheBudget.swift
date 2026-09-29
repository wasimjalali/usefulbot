import Foundation

/// Which per-bot caches to drop to fit a byte budget: the least recently
/// used first, never a pinned one (a bot with a send in flight or a turn
/// running in the background is still painting into its cache).
public enum CacheBudget {
    public struct Entry: Equatable, Sendable {
        public var id: String
        public var bytes: Int
        public var lastUsed: Date
        public var pinned: Bool

        public init(id: String, bytes: Int, lastUsed: Date, pinned: Bool) {
            self.id = id
            self.bytes = bytes
            self.lastUsed = lastUsed
            self.pinned = pinned
        }
    }

    /// The ids to evict, oldest first, until what remains fits `budget`.
    /// Pinned entries count toward the total but are never returned, so a
    /// budget held entirely by pinned entries evicts everything else and
    /// stays over.
    public static func evictions(_ entries: [Entry], budget: Int) -> [String] {
        var total = entries.reduce(0) { $0 + $1.bytes }
        guard total > budget else { return [] }
        var evicted: [String] = []
        for entry in entries.filter({ !$0.pinned }).sorted(by: { $0.lastUsed < $1.lastUsed }) {
            guard total > budget else { break }
            evicted.append(entry.id)
            total -= entry.bytes
        }
        return evicted
    }
}

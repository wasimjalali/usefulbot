import Foundation

/// Whether the app opens on the first-run flow. It shows once: finishing or
/// skipping it is remembered, and an owner who already has a provider never
/// sees it (and is marked done the first time that is known).
public enum FirstRunGate {
    /// UserDefaults key for "the first run is behind this Mac".
    public static let completedKey = "ub.firstRunCompleted"
    /// Launch argument that shows the flow regardless, for verification. It
    /// writes nothing: completion is never persisted from a forced run.
    public static let forceArgument = "--force-first-run"

    public enum Decision: Equatable, Sendable {
        case show
        case skip
        /// Not known yet: the providers have not loaded.
        case wait
    }

    /// - Parameters:
    ///   - freshMac: this Mac had no provider store
    ///     (`~/.useful-bot/providers.json`) at launch, so nothing can be
    ///     connected yet and the flow can show while services start. Any
    ///     store at all means the gate waits for the connections.
    ///   - harnessRun: a scripted launch (the performance guard).
    ///   - connections: connected providers, nil until they have loaded.
    ///   - providersFailed: the providers read failed; the app opens rather
    ///     than waiting on it.
    public static func decide(
        forced: Bool,
        completed: Bool,
        freshMac: Bool,
        harnessRun: Bool,
        connections: Int?,
        providersFailed: Bool
    ) -> Decision {
        if forced { return .show }
        if harnessRun || completed { return .skip }
        guard let connections else {
            if freshMac { return .show }
            return providersFailed ? .skip : .wait
        }
        return connections > 0 ? .skip : .show
    }

    /// An owner who already has a provider is marked done the first time it is
    /// known, so later launches do not wait on the providers read.
    public static func marksDone(forced: Bool, completed: Bool, connections: Int?) -> Bool {
        !forced && !completed && (connections ?? 0) > 0
    }

    /// Finishing or skipping is remembered, except on a forced run.
    public static func persistsFinish(forced: Bool) -> Bool {
        !forced
    }
}

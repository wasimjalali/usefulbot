import Foundation

/// Saving a drawing to its chat, with the retries owned by the save itself.
///
/// The save used to be retried only when something else published the
/// transcript. A drawing that landed at the end of a turn, on a chat that then
/// went quiet, could fail once and never be tried again: it stayed on screen,
/// stopped below its cap without an error, and was gone on the next reload.
/// Here one call runs every attempt on a fixed schedule and always ends in an
/// outcome the caller can show.
public enum WidgetSaveRetry {
    public enum Outcome: Equatable, Sendable {
        case saved
        /// The server will not keep it (too large, thread at its limit), so
        /// asking again cannot succeed.
        case refused
        /// Every attempt failed for a reason that might have passed.
        case gaveUp
    }

    /// The wait before the second and third attempts. The server is loopback,
    /// so a failure is a restart or a held store lock, both over in seconds.
    public static let defaultDelays: [UInt64] = [1_000_000_000, 4_000_000_000]

    public static func isRefusal(_ error: Error) -> Bool {
        if case BackendError.http(let status) = error {
            return (400...499).contains(status) && status != 429
        }
        // A 403 by code or a rejected credential is just as final as a 4xx.
        if case BackendError.forbidden = error { return true }
        if case BackendError.credentialInvalid = error { return true }
        return false
    }

    /// Runs `save` once, then once more after each delay, until it succeeds or
    /// is refused. A cancelled task stops waiting and reports `gaveUp`.
    public static func run(
        delays: [UInt64] = defaultDelays,
        save: @Sendable () async throws -> Void
    ) async -> Outcome {
        var waits = delays.makeIterator()
        while true {
            do {
                try await save()
                return .saved
            } catch {
                if isRefusal(error) { return .refused }
            }
            guard let wait = waits.next() else { return .gaveUp }
            do {
                try await Task.sleep(nanoseconds: wait)
            } catch {
                return .gaveUp
            }
        }
    }
}

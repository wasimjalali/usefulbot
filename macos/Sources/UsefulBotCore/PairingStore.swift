#if os(iOS)
import Foundation
import Combine

/// The phone's lifecycle states (spec 4.8). Persisted in UserDefaults: the
/// enum and the non-secret pairing metadata carry nothing sensitive — the
/// token itself lives only in the Keychain.
public enum PairingState: String, Sendable {
    /// No token, no host, no cached data.
    case unpaired
    /// Token in Keychain; sessions are exchanged on demand.
    case paired
    /// Token kept; no automatic session exchange; cache kept but not shown.
    case signedOut
    /// Token rejected (revoked, expired, disabled) or the stored endpoint no
    /// longer validates on launch.
    case credentialInvalid
}

/**
 * The pairing record the app keeps outside the Keychain, plus the state
 * transitions that are pure data. Network effects (session exchange, DELETE
 * on sign-out) belong to the coordinating object that owns a BackendClient;
 * this store guarantees the durable part is always right:
 *
 *  - `unpair()` purges every byte the pairing left behind (token, cookies,
 *    disk cache, drafts, temp files, pending composer state) and bumps
 *    `dataGeneration` so a late response from the old pairing is dropped
 *    before it can repopulate anything.
 *  - `signOut()` keeps the token and the cache but stops automatic exchange
 *    until `signIn()` runs again.
 *  - `markCredentialInvalid(_:)` records the terminal 401 (or a stored origin
 *    that fails validation on launch) without touching stored data.
 */
@MainActor
public final class PairingStore: ObservableObject {
    @Published public private(set) var state: PairingState
    /// The canonical origin of the paired Mac (nil while unpaired).
    @Published public private(set) var pairedOrigin: String?
    /// The Mac's display name from the pairing payload / manual entry.
    @Published public private(set) var pairedName: String?
    /// Session expiry the last sign-in returned, shown on Settings > Devices.
    @Published public private(set) var sessionExpiresAt: Date?
    /// The credential's own expiry when the server reported it (30-day row).
    @Published public private(set) var credentialExpiresAt: Date?
    /// Bumped on every unpair, sign-out and cross-Mac re-pair; every
    /// in-flight response is checked against it.
    @Published public private(set) var dataGeneration: Int
    /// The credential expiry the seven-day warning already fired for — the
    /// banner is one-time per credential (spec 11), so a re-pair or rotation
    /// (a different `credentialExpiresAt`) resets it.
    @Published public private(set) var expiryWarnedFor: Date?

    /// Non-secret defaults keys, all under the app's suite.
    private enum Key {
        static let state = "pairing.state"
        static let origin = "pairing.origin"
        static let name = "pairing.name"
        static let sessionExpiresAt = "pairing.sessionExpiresAt"
        static let credentialExpiresAt = "pairing.credentialExpiresAt"
        static let dataGeneration = "pairing.dataGeneration"
        static let expiryWarnedFor = "pairing.expiryWarnedFor"
    }

    private let defaults: UserDefaults
    /// Directories the pairing owns, purged by unpair. Injected so tests do
    /// not have to live in the real Application Support.
    private let purgeDirs: [URL]

    public init(defaults: UserDefaults = .standard, purgeDirs: [URL]? = nil) {
        self.defaults = defaults
        self.purgeDirs = purgeDirs ?? Self.defaultPurgeDirs()
        self.state = PairingState(rawValue: defaults.string(forKey: Key.state) ?? "") ?? .unpaired
        self.pairedOrigin = defaults.string(forKey: Key.origin)
        self.pairedName = defaults.string(forKey: Key.name)
        self.sessionExpiresAt = defaults.object(forKey: Key.sessionExpiresAt) as? Date
        self.credentialExpiresAt = defaults.object(forKey: Key.credentialExpiresAt) as? Date
        self.dataGeneration = defaults.integer(forKey: Key.dataGeneration)
        self.expiryWarnedFor = defaults.object(forKey: Key.expiryWarnedFor) as? Date
        // A persisted non-unpaired state without a stored origin is corrupt:
        // it cannot name the endpoint a token belongs to, so fail to
        // credentialInvalid rather than guess one.
        if state != .unpaired, pairedOrigin == nil {
            state = .credentialInvalid
        }
    }

    /// The directories a pairing may have written under. v1 has only the
    /// shared cache directory; drafts/attachment temp dirs land with PR-3/5
    /// and join this list as they appear.
    private static func defaultPurgeDirs() -> [URL] {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return [support, caches]
            .compactMap { $0?.appendingPathComponent("UsefulBot", isDirectory: true) }
    }

    /// Pairing succeeded: token already in the Keychain by the caller; here
    /// the durable record lands.
    public func markPaired(origin: CanonicalOrigin, name: String) {
        // Re-pairing a different Mac must not keep the old Mac's cache.
        if let prior = pairedOrigin, prior != origin.value {
            purgeData()
        }
        pairedOrigin = origin.value
        pairedName = name
        sessionExpiresAt = nil
        credentialExpiresAt = nil
        expiryWarnedFor = nil
        state = .paired
        persist()
    }

    public func markSignedIn(sessionExpiresAt: Date?, credentialExpiresAt: Date?) {
        self.sessionExpiresAt = sessionExpiresAt
        self.credentialExpiresAt = credentialExpiresAt
        state = .paired
        persist()
    }

    /// Sign out: session exchange stops until Sign in; token and cache stay.
    /// `credentialInvalid` is not signed-out-able (spec 4.8: its only exits
    /// are re-pair and unpair).
    public func signOut() {
        guard state == .paired else { return }
        sessionExpiresAt = nil
        state = .signedOut
        // Same stale-response rule as unpair: a sign-in still in flight
        // must not land `.paired` after this transition.
        dataGeneration &+= 1
        persist()
    }

    /// A terminal 401 `credential_invalid` or a stored origin that failed
    /// launch validation. The token and cache stay for forensics only — the
    /// UI never reads them again before a re-pair or unpair.
    public func markCredentialInvalid() {
        guard state != .unpaired else { return }
        state = .credentialInvalid
        persist()
    }

    /// Wipe the whole pairing. The Keychain item is the caller's (it owns the
    /// concrete store); everything else this pairing touched dies here.
    public func unpair() {
        purgeData()
        pairedOrigin = nil
        pairedName = nil
        sessionExpiresAt = nil
        credentialExpiresAt = nil
        expiryWarnedFor = nil
        state = .unpaired
        persist()
    }

    /// The credential-expiry banner rendered once (spec 11: one-time at
    /// seven days); keyed to the expiry so a rotated credential warns again.
    public func markExpiryWarned() {
        expiryWarnedFor = credentialExpiresAt
        persist()
    }

    /// The in-flight-response guard: a response stamped with an older
    /// generation is dropped before it can repopulate the model.
    public func isCurrent(generation: Int) -> Bool {
        generation == dataGeneration
    }

    private func purgeData() {
        dataGeneration &+= 1
        for dir in purgeDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        // Purged alongside the file dirs: anything defaults-cached that is
        // pairing-scoped. Only the pairing keys exist today; PR-3+ cache keys
        // list themselves here.
        defaults.removeObject(forKey: Key.sessionExpiresAt)
    }

    private func persist() {
        defaults.set(state.rawValue, forKey: Key.state)
        defaults.set(pairedOrigin, forKey: Key.origin)
        defaults.set(pairedName, forKey: Key.name)
        defaults.set(sessionExpiresAt, forKey: Key.sessionExpiresAt)
        defaults.set(credentialExpiresAt, forKey: Key.credentialExpiresAt)
        defaults.set(dataGeneration, forKey: Key.dataGeneration)
        defaults.set(expiryWarnedFor, forKey: Key.expiryWarnedFor)
        // UserDefaults batches writes; a lifecycle record must survive the
        // process dying the next moment (revocation, unpair, kill -9), so
        // flush synchronously. Writes are rare — state transitions only.
        defaults.synchronize()
    }
}
#endif

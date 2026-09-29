import Combine
import Foundation
import SwiftUI
import UsefulBotCore

/// Coordinates the pairing lifecycle end to end: the durable record
/// (`PairingStore`), the token (`PhoneKeychainStore`), the one client the
/// pairing is allowed to talk through (`BackendClient`), and the §7.2
/// readiness level. Views read state; every mutation goes through here so the
/// §4.8 transitions can never be half-applied.
@MainActor
final class PairingCoordinator: ObservableObject {
    /// Where the pairing UI is in a connect attempt (design 1.1's Loading /
    /// Success / Error rows).
    enum ConnectPhase: Equatable {
        case idle
        case connecting
        case connected(String)
        case failed(String)
    }

    @Published private(set) var client: BackendClient?
    @Published var phase: ConnectPhase = .idle
    @Published var readiness: MacReadiness?
    /// Last successful contact with the Mac — the banner's "Last seen …"
    /// line quotes it.
    @Published private(set) var lastContact: Date?
    /// Stamped on each foreground resync (spec 8.5); the Bots list re-fetches
    /// `/api/shell` off it.
    @Published private(set) var resyncAt = Date()

    let store: PairingStore
    let monitor: PathMonitor

    private var monitorLink: AnyCancellable?
    private var monitorLevelLink: AnyCancellable?

    init(store: PairingStore, monitor: PathMonitor) {
        self.store = store
        self.monitor = monitor
        // `PathMonitor` is its own `ObservableObject` but views only hold
        // the coordinator — without forwarding, `isOnline` flips never
        // re-render the §11 offline states.
        monitorLink = monitor.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor in self?.objectWillChange.send() }
            }
        // §7.2: the path state is itself a readiness input — a drop demotes
        // the level at once, a regain re-derives it, or the banner would
        // only ever show whatever the last probe left.
        monitorLevelLink = monitor.$isOnline
            .dropFirst()
            .sink { [weak self] online in
                Task { @MainActor in self?.monitorDidFlip(online: online) }
            }
    }

    /// Pairing screens read `monitor.isOnline` directly; the level drives
    /// the paired surfaces' §11 banner.
    private func monitorDidFlip(online: Bool) {
        guard store.state == .paired else { return }
        if online {
            Task { await probeReadiness() }
        } else {
            readiness = .noNetwork
        }
    }

    /// The live default: constructs its own store and monitor. Kept separate
    /// from the injectable init so tests can substitute both — default
    /// arguments are evaluated in the caller's (non-isolated) context.
    convenience init() {
        // UI-test seam: UB_OFFLINE pins the path monitor unsatisfied so the
        // visual gate can capture the no-network banner without killing the
        // simulator's real network.
        let monitor = ProcessInfo.processInfo.environment["UB_OFFLINE"] == "1"
            ? PathMonitor(online: false)
            : PathMonitor()
        self.init(store: PairingStore(), monitor: monitor)
        // UI-test seam: a launch with UB_RESET_PAIRING wipes the pairing so a
        // flow test always starts at `unpaired` regardless of prior runs.
        // Never set outside the test harness.
        if ProcessInfo.processInfo.environment["UB_RESET_PAIRING"] == "1" {
            if let originValue = store.pairedOrigin,
               let origin = try? TailnetEndpointPolicy.validate(originValue) {
                PhoneKeychainStore(account: origin).deleteToken()
            }
            store.unpair()
        }
    }

    // MARK: - Launch

    /// Rebuild the client from the stored origin and, when the state is
    /// `paired`, exchange the session immediately (spec 6.2). A stored origin
    /// that fails §4.7 validation goes straight to `credentialInvalid` —
    /// nothing is substituted.
    func bootstrap() async {
        guard store.state != .unpaired, let originValue = store.pairedOrigin else {
            return
        }
        do {
            let origin = try TailnetEndpointPolicy.validate(originValue)
            client = try BackendClient(
                base: origin.url,
                tokenStore: PhoneKeychainStore(account: origin),
                endpointPolicy: TailnetEndpointPolicy()
            )
        } catch {
            store.markCredentialInvalid()
            // A stale `.connected` phase would read as "Connected to <name>"
            // on the credential-invalid screen's status line.
            phase = .idle
            return
        }
        if store.state == .paired {
            await exchangeSession()
        }
    }

    // MARK: - Pairing

    /// A scanned payload or a completed manual form. Validates, stores the
    /// token under the canonical origin, exchanges the session, then moves to
    /// `paired` — or lands the error copy on the status line.
    func pair(scanned raw: String) async {
        await connect {
            try PairingPayload(json: raw)
        }
    }

    func pairManually(host: String, token: String) async {
        await connect {
            try PairingPayload(manualHost: host, token: token)
        }
    }

    private func connect(_ makePayload: () throws -> PairingPayload) async {
        // Connecting and the 600 ms connected hold are both busy: a second
        // scan or Connect tap mid-flight would interleave Keychain writes
        // and store transitions (and can retire the token the first attempt
        // just stored). Failed retries still enter.
        switch phase {
        case .connecting, .connected:
            return
        case .idle, .failed:
            break
        }
        guard monitor.isOnline else {
            phase = .failed("You're offline")
            return
        }
        let payload: PairingPayload
        do {
            payload = try makePayload()
        } catch let error as PairingPayload.ValidationError {
            phase = .failed(Self.copy(for: error))
            return
        } catch {
            phase = .failed("That code could not be read.")
            return
        }
        phase = .connecting
        // Spec 8.1's stale-response rule, applied to the whole attempt:
        // unpair, sign-out or a cross-Mac re-pair landing mid-flight bumps
        // the generation, and every post-await write below checks it — a
        // late answer must not repopulate a wiped or superseded pairing.
        let generation = store.dataGeneration
        let keychain = PhoneKeychainStore(account: payload.host)
        // A same-host re-pair holds the incumbent until the candidate
        // validates: the sign-in runs against an in-memory store so the
        // shared Keychain item is never unvalidated — an in-flight re-auth
        // on the live client reading it mid-attempt would mint against a
        // token nobody has proved and burn a healthy pairing on refusal.
        let incumbent = payload.host.value == store.pairedOrigin ? try? keychain.token() : nil
        /// Roll back only this attempt's write: the item is touched iff the
        /// live value is still ours (a concurrent attempt's overwrite is not
        /// ours to delete), and the incumbent it replaced goes back — except
        /// after an unpair, where the credential must die, not come back.
        /// Only callable post-write; before the store call the item still
        /// holds the incumbent (or nothing), so the guard exits.
        func rollbackToken() {
            guard (try? keychain.token()) == payload.token else { return }
            if let incumbent, store.state != .unpaired {
                try? keychain.store(token: incumbent)
            } else {
                keychain.deleteToken()
            }
        }
        // Hoisted so a catch can still retire the mint: a sign-in that
        // throws after its POST leaves a live session on the dropped
        // client, and the stale-generation exits below drop it the same
        // way — either path calls `signOut` before `next` dies.
        var pendingClient: BackendClient?
        do {
            let next = try BackendClient(
                base: payload.host.url,
                tokenStore: InMemoryDeviceTokenStore(payload.token),
                endpointPolicy: TailnetEndpointPolicy()
            )
            pendingClient = next
            let info = try await next.signIn()
            // The connected pulse is a post-await write like any other:
            // gate it on the generation or it stomps the `.idle` a
            // mid-flight unpair/sign-out already landed — leaving the
            // pairing surface busy forever (the busy gate at the top of
            // this function then refuses every retry). Stale exits write
            // nothing: the generation bump already wrote `.idle`. The mint
            // still needs its server-side death — `next` is never swapped
            // in, so its session would otherwise live to expiry.
            guard store.isCurrent(generation: generation) else {
                await next.signOut()
                return
            }
            // The credential proved out — now it takes over the Keychain
            // item (the in-memory store stays on `next`; value-identical).
            do {
                try keychain.store(token: payload.token)
            } catch {
                await next.signOut()
                if let incumbent, store.state != .unpaired {
                    try? keychain.store(token: incumbent)
                }
                guard store.isCurrent(generation: generation) else { return }
                phase = .failed("The token could not be stored in the Keychain.")
                return
            }
            // Design 1.1: the success line "Connected to <name>" reads for
            // 600 ms before the root swaps the pairing screen for the Bots
            // list — so `paired` lands after the pause, not on sign-in.
            // UB_HOLD_CONNECTED stretches that hold for the visual gate
            // (seconds); never set outside the test harness.
            phase = .connected(payload.name)
            let holdSeconds = ProcessInfo.processInfo.environment["UB_HOLD_CONNECTED"]
                .flatMap(Double.init) ?? 0.6
            try await Task.sleep(for: .milliseconds(Int(holdSeconds * 1000)))
            guard store.isCurrent(generation: generation) else {
                rollbackToken()
                await next.signOut()
                return
            }
            // Re-pairing to a different Mac retires the old origin's Keychain
            // token: purgeData clears defaults and dirs, not Keychain items.
            let priorOrigin = store.pairedOrigin
            store.markPaired(origin: payload.host, name: payload.name)
            // The client swaps only once the pairing is durable — a failed
            // re-pair from `.paired` keeps the working session path, so the
            // store can never sit `.paired` over a nil client.
            client = next
            if priorOrigin != payload.host.value,
               let stale = PhoneKeychainStore(storedOrigin: priorOrigin) {
                stale.deleteToken()
            }
            store.markSignedIn(
                sessionExpiresAt: info.expiresAt,
                credentialExpiresAt: credentialExpiry(reporting: info.credentialExpiresAt)
            )
            readiness = .ready
            // The mounted Bots list re-fetches off resyncAt (§8.5); a re-pair
            // to a different Mac is exactly when its roster is stale.
            resyncAt = Date()
            // The hold is spent and the pairing landed: leave .connected
            // behind or the busy-gated rows (Devices' sign-out/unpair) read
            // it as a still-running connect.
            phase = .idle
        } catch {
            // A failed sign-in never touched the Keychain — the incumbent
            // credential still stands (rollbackToken is a no-op pre-write),
            // and the client, never swapped, still walks the live pairing.
            rollbackToken()
            await pendingClient?.signOut()
            guard store.isCurrent(generation: generation) else { return }
            phase = .failed(Self.copy(for: error))
        }
    }

    /// The stored pairing re-exchanges a session: on launch, on Sign in from
    /// `signedOut`, and on foreground when the level dropped below ready.
    func exchangeSession() async {
        guard let client else { return }
        // Reached only on explicit sign-in intent (bootstrap while paired,
        // the Sign-in button): re-open the exchange a `signOut()` closed —
        // a request's silent re-auth never does (§6.2).
        await client.reopenExchange()
        // An unpair/sign-out landing while the exchange is in flight bumps
        // the generation — a late 200 must not re-mark the store `.paired`.
        let generation = store.dataGeneration
        do {
            // ensureSession, not a bare signIn: a request racing this
            // exchange (a status probe off `.active`) joins the in-flight
            // mint instead of POSTing a second session that retires the
            // first one's cookie out from under it.
            let info = try await client.ensureSession()
            guard store.isCurrent(generation: generation) else { return }
            store.markSignedIn(
                sessionExpiresAt: info.expiresAt,
                credentialExpiresAt: credentialExpiry(reporting: info.credentialExpiresAt)
            )
            lastContact = Date()
        } catch BackendError.credentialInvalid, BackendError.deviceTokenMissing {
            // A rejected credential and a vanished Keychain item are the same
            // terminal verdict (§4.8): `kSecAttrAccessibleWhenPasscodeSet-
            // ThisDeviceOnly` + non-syncable means the item never survives a
            // device migration or a removed passcode, while the `paired`
            // record in defaults does.
            guard store.isCurrent(generation: generation) else { return }
            store.markCredentialInvalid()
            phase = .idle
        } catch {
            await probeReadiness()
            // A probe that landed credentialInvalid already owns the
            // verdict — `.failed` on top would show reachability copy on the
            // credential-invalid screen, which renders `.failed` first.
            // Stale (superseded by an unpair/sign-out mid-flight) likewise
            // writes nothing.
            if store.isCurrent(generation: generation),
               store.state != .credentialInvalid {
                // On the signed-out surface this is the Sign-in result —
                // render it instead of leaving the button silently re-enabled.
                phase = .failed(Self.copy(for: error))
            }
        }
    }

    /// Spec 8.5: the one resync on `.active` — a status probe (a dead
    /// credential lands on `credentialInvalid` here, a dropped session
    /// re-auths inside the request) plus the shell re-fetch the list runs
    /// off `resyncAt`.
    func sceneBecameActive() async {
        guard store.state == .paired else { return }
        await probeReadiness()
        resyncAt = Date()
    }

    /// UI-test seam: UB_CREDENTIAL_EXPIRY_DAYS overrides the reported
    /// credential expiry so the seven-day banner (spec 11) is shot-able
    /// without waiting out a real 30-day credential. Never set outside the
    /// harness.
    private func credentialExpiry(reporting reported: Date?) -> Date? {
        let env = ProcessInfo.processInfo.environment
        if let days = env["UB_CREDENTIAL_EXPIRY_DAYS"].flatMap(Double.init) {
            return Date().addingTimeInterval(days * 86_400)
        }
        return reported
    }

    /// Sign in from `signedOut` (class C — no biometric, spec 4.4).
    func signIn() async {
        phase = .connecting
        // No .connected pulse here — that phase exists to close a pushed
        // re-pair and hold the pairing screen's success line, neither of
        // which applies on the signed-out surface; defer lands it on idle.
        defer { if case .connecting = phase { phase = .idle } }
        await exchangeSession()
    }

    // MARK: - Sign out / unpair

    /// Sign out (class C): the jar clears locally whether or not the DELETE
    /// reaches the Mac — the state must work offline.
    func signOut() async {
        // The store transition lands before the network await: its
        // generation bump retires every in-flight exchange/probe write —
        // under the old order a `markCredentialInvalid` racing the await
        // flipped `paired → credentialInvalid` mid-sign-out and the
        // paired-guard inside `store.signOut()` then silently no-oped.
        store.signOut()
        readiness = nil
        // A `.failed` left by a failed probe/re-auth is not part of signing
        // out; the signed-out screen would read it as a fresh error.
        phase = .idle
        await client?.signOut()
    }

    /// Unpair (class A — the caller has already run the biometric gate):
    /// purge token, cookies, caches and drafts, bump `dataGeneration`.
    /// Same ordering as signOut: the store write (and its generation bump)
    /// precedes the client's drain-and-DELETE so nothing in flight can
    /// repopulate state the wipe just cleared.
    func unpair() async {
        let originValue = store.pairedOrigin
        store.unpair()
        if let originValue,
           let keychain = PhoneKeychainStore(storedOrigin: originValue) {
            keychain.deleteToken()
        }
        await client?.signOut()
        client = nil
        readiness = nil
        phase = .idle
    }

    // MARK: - Readiness (spec 7.2)

    /// Derive the level from the path monitor plus one `/api/status` probe.
    /// `runtimeDown` when the eve probe inside status reports not-available.
    func probeReadiness() async {
        await probeReadiness(reschedule429: true)
    }

    private func probeReadiness(reschedule429: Bool) async {
        // §6.2: signed-out exchanges nothing until Sign in — and the armed
        // 60 s re-probe below re-enters through this same guard, so a timer
        // surviving the sign-out cannot mint a session behind the
        // Signed-out screen.
        guard store.state == .paired else { return }
        guard monitor.isOnline else {
            readiness = .noNetwork
            return
        }
        guard let client else { return }
        let generation = store.dataGeneration
        do {
            let status = try await client.status()
            guard store.isCurrent(generation: generation) else { return }
            lastContact = Date()
            // S15: absent or malformed apiVersion is not a version the
            // client knows — fail closed, never silently ready. The Mac
            // demonstrably answered, so this is a version refusal, not a
            // reachability or runtime failure (§7.2).
            guard let version = status.apiVersion, APIVersion.known.contains(version) else {
                readiness = .unsupportedVersion
                return
            }
            readiness = status.eve == "available" ? .ready : .runtimeDown
        } catch BackendError.credentialInvalid, BackendError.deviceTokenMissing {
            // Same terminal verdict as in exchangeSession: the token can no
            // longer be used, so the pairing's only exits are re-pair and
            // unpair — never a permanent "unreachable" banner.
            guard store.isCurrent(generation: generation) else { return }
            store.markCredentialInvalid()
            phase = .idle
        } catch BackendError.unauthorized {
            // §8.4: a 401 that survived the single-flight re-auth means the
            // credential is refused — the same terminal verdict as a
            // revoked token, not a runtime outage. A sign-out mid-probe
            // throws this too, but the generation guard swallows it.
            guard store.isCurrent(generation: generation) else { return }
            store.markCredentialInvalid()
            phase = .idle
        } catch BackendError.forbidden(let code)
                    where code == "credential_invalid" || code == "not_phone" {
            // Gate refusals that name the credential: the pairing is dead,
            // not the runtime.
            guard store.isCurrent(generation: generation) else { return }
            store.markCredentialInvalid()
            phase = .idle
        } catch BackendError.forbidden(let code) {
            // Any other 403 (`ingress`, `forbidden`, `origin`, `csrf`) is an
            // edge refusal — the request was refused before the app could
            // answer, so §7.2's reachability level applies, not runtimeDown
            // (its copy asserts an eve-probe failure that never ran). The
            // refusal is itself proof the DNS/TLS/HTTP chain carried.
            guard store.isCurrent(generation: generation) else { return }
            readiness = .macUnreachable(
                lastSeen: lastContact, detail: code, diagnostics: .answered)
        } catch {
            guard store.isCurrent(generation: generation) else { return }
            if case BackendError.http(429) = error {
                // §8.4: 429 backs off on the server's window, not the
                // reachability banner — the Mac answered (the status probe's
                // single-flight re-auth hit the rate-limited session POST).
                // The 429 carries no Retry-After and the bucket is
                // per-minute, so re-probe once a window later; a repeat 429
                // does not reschedule — the level then waits for the next
                // trigger (foreground resync, Retry).
                lastContact = Date()
                if reschedule429 {
                    Task { [weak self] in
                        try? await Task.sleep(for: .seconds(60))
                        await self?.probeReadiness(reschedule429: false)
                    }
                }
                return
            }
            // §7.2 draws the line at "status answered": a typed BackendError
            // (non-2xx, decode) means the Mac answered and its runtime is
            // the failure — `macUnreachable` is for a probe the Mac could
            // not answer at all (timeout, TLS, DNS).
            if error is BackendError {
                lastContact = Date()
                readiness = .runtimeDown
            } else {
                readiness = .macUnreachable(
                    lastSeen: lastContact,
                    detail: String(describing: error),
                    diagnostics: ReachabilityDiagnostics.classify(error))
            }
        }
    }

    // MARK: - Copy

    /// Spec 6.1.5's status-line copy, verbatim where the spec pins it.
    static func copy(for error: Error) -> String {
        switch error {
        case PairingPayload.ValidationError.unreadable:
            return "That code is not a Useful Bot pairing code."
        case let PairingPayload.ValidationError.versionUnknown(v):
            return v > PairingPayload.currentVersion
                ? "This code is from a newer version of Useful Bot"
                : "This pairing code is not understood."
        case let PairingPayload.ValidationError.endpoint(rule):
            return rule.localizedDescription
        case PairingPayload.ValidationError.tokenMalformed, PairingPayload.ValidationError.tokenShort:
            return "The pairing token is not valid."
        case PairingPayload.ValidationError.nameMissing:
            return "That code is not a Useful Bot pairing code."
        case BackendError.credentialInvalid, BackendError.unauthorized:
            return "This pairing was revoked. Re-pair from the Mac"
        case BackendError.deviceTokenMissing:
            // The shared BackendError copy names a macOS remediation; on
            // iOS a vanished item is only cured by a fresh pair.
            return "This iPhone lost its pairing token. Pair again from your Mac."
        default:
            break
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
                 .secureConnectionFailed, .clientCertificateRejected,
                 .clientCertificateRequired:
                return "The secure connection to your Mac failed: \(urlError.localizedDescription)"
            default:
                return "Can't reach your Mac. Is it awake and on Tailscale?"
            }
        }
        if let backend = error as? BackendError {
            return backend.localizedDescription
        }
        return "Can't reach your Mac. Is it awake and on Tailscale?"
    }
}

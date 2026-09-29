import Foundation
import Testing
@testable import UsefulBotCore

/// §18 phone coverage for this phase: endpoint policy (§4.7), pairing
/// payload validation (§6.1), the lifecycle state machine (§4.8), and the
/// LocalHost block list extension to the paired host and tailnet space.
@Suite struct PhonePairingTests {

    // MARK: - §4.7 endpoint policy

    @Test func httpsTailnetOriginCanonicalizes() throws {
        let origin = try TailnetEndpointPolicy.validate("https://Mac.Tailnet-Name.ts.net")
        #expect(origin.value == "https://mac.tailnet-name.ts.net")
        // :443 is the default https port — it normalizes away.
        let explicit = try TailnetEndpointPolicy.validate("https://mac.tailnet-name.ts.net:443")
        #expect(explicit.value == "https://mac.tailnet-name.ts.net")
    }

    @Test func httpLoopbackAllowedOnAnyPort() throws {
        #expect(try TailnetEndpointPolicy.validate("http://127.0.0.1:4320").value == "http://127.0.0.1:4320")
        #expect(try TailnetEndpointPolicy.validate("http://localhost").value == "http://localhost")
        #expect(try TailnetEndpointPolicy.validate("http://[::1]:9").value == "http://[::1]:9")
    }

    @Test func httpOffLoopbackRejected() {
        for candidate in ["http://mac.tailnet-name.ts.net", "http://192.168.1.5", "http://8.8.8.8"] {
            #expect(throws: EndpointError.schemeNotAllowed) {
                try TailnetEndpointPolicy.validate(candidate)
            }
        }
    }

    @Test func httpsOffDefaultPortRejected() {
        #expect(throws: EndpointError.portNotAllowed) {
            try TailnetEndpointPolicy.validate("https://mac.tailnet-name.ts.net:8443")
        }
    }

    @Test func userinfoPathQueryFragmentRejected() {
        #expect(throws: EndpointError.userinfo) {
            try TailnetEndpointPolicy.validate("https://user@mac.tailnet-name.ts.net")
        }
        for candidate in [
            "https://mac.tailnet-name.ts.net/pair",
            "https://mac.tailnet-name.ts.net?x=1",
            "https://mac.tailnet-name.ts.net#f",
        ] {
            #expect(throws: EndpointError.pathQueryFragment) {
                try TailnetEndpointPolicy.validate(candidate)
            }
        }
    }

    @Test func unreadableAndEmptyHostsRejected() {
        #expect(throws: EndpointError.unreadable) {
            try TailnetEndpointPolicy.validate("not a url at all ://")
        }
        #expect(throws: EndpointError.self) {
            try TailnetEndpointPolicy.validate("https://")
        }
    }

    // MARK: - §6.1 pairing payload

    private func payloadJSON(
        host: String = "https://mac.tailnet-name.ts.net",
        token: String = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        name: String? = "Mac Studio",
        version: Int = 1
    ) -> String {
        let nameField = name.map { #""name":"\#($0)","# } ?? ""
        return #"{"v":\#(version),"host":"\#(host)",\#(nameField)"token":"\#(token)"}"#
    }

    @Test func validPayloadDecodes() throws {
        let payload = try PairingPayload(json: payloadJSON())
        #expect(payload.host.value == "https://mac.tailnet-name.ts.net")
        #expect(payload.name == "Mac Studio")
        #expect(payload.token.count >= 32)
    }

    @Test func unknownVersionRejected() {
        #expect(throws: PairingPayload.ValidationError.versionUnknown(2)) {
            try PairingPayload(json: payloadJSON(version: 2))
        }
        // The version-unknown error names a newer-app code, never a generic one.
        #expect(throws: PairingPayload.ValidationError.self) {
            try PairingPayload(json: #"{"host":"https://mac.tailnet-name.ts.net","token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#)
        }
    }

    @Test func payloadEndpointAndTokenValidated() {
        #expect(throws: PairingPayload.ValidationError.endpoint(.schemeNotAllowed)) {
            try PairingPayload(json: payloadJSON(host: "http://mac.tailnet-name.ts.net"))
        }
        #expect(throws: PairingPayload.ValidationError.tokenShort) {
            try PairingPayload(json: payloadJSON(token: "AAAA"))
        }
        #expect(throws: PairingPayload.ValidationError.tokenMalformed) {
            // '!' is outside base64url; a '*' pad that is not '=' too.
            try PairingPayload(json: payloadJSON(token: "AAA!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
        }
        #expect(throws: PairingPayload.ValidationError.tokenMalformed) {
            try PairingPayload(json: payloadJSON(token: "AA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
        }
        #expect(throws: PairingPayload.ValidationError.unreadable) {
            try PairingPayload(json: "not json")
        }
    }

    @Test func tokenPaddingRules() throws {
        // base64url: 32 bytes encode to 43 chars + '='; 34 bytes to 44 + '=='.
        #expect(try PairingPayload(json: payloadJSON(token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")).token.count == 43 + 1)
        #expect(try PairingPayload(json: payloadJSON(token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==")).token.count == 44 + 2)
        // The same-length '==' at 31 bytes is still short — padding is not length.
        #expect(throws: PairingPayload.ValidationError.tokenShort) {
            try PairingPayload(json: payloadJSON(token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="))
        }
    }

    @Test func manualEntryFallsBackToHostForName() throws {
        let payload = try PairingPayload(
            manualHost: "mac.tailnet-name.ts.net",
            token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        #expect(payload.name == "mac.tailnet-name.ts.net")
        // A scheme-less manual host is a bare host → https.
        #expect(payload.host.value == "https://mac.tailnet-name.ts.net")
    }

    // MARK: - LocalHost pairing block list (§4.7 / §18)

    @Test func pairedHostIsBlocked() {
        #expect(LocalHost.isBlocked("Mac.Tailnet-Name.TS.NET", pairedHost: "mac.tailnet-name.ts.net"))
        #expect(!LocalHost.isBlocked("other.tailnet-name.ts.net", pairedHost: "mac.tailnet-name.ts.net"))
        #expect(!LocalHost.isBlocked("mac.tailnet-name.ts.net", pairedHost: nil))
        // Same host in every DNS-spellable spelling: whitespace, trailing
        // dot, brackets, an IPv6 zone — all normalize to the paired host.
        #expect(LocalHost.isBlocked("  mac.tailnet-name.ts.net  ", pairedHost: "mac.tailnet-name.ts.net"))
        #expect(LocalHost.isBlocked("mac.tailnet-name.ts.net.", pairedHost: "mac.tailnet-name.ts.net"))
        #expect(LocalHost.isBlocked("[mac.tailnet-name.ts.net]", pairedHost: "mac.tailnet-name.ts.net"))
        #expect(LocalHost.isBlocked("mac.tailnet-name.ts.net.", pairedHost: " mac.tailnet-name.ts.net "))
    }

    @Test func tailnetAndPrivateRangesBlocked() {
        for host in [
            "100.64.0.1", "100.127.255.254",           // 100.64.0.0/10 tailnet
            "fd7a:115c:a1e0::1", "fc00::5",            // tailnet v6 + ULA
            "fe80::1234",                              // link-local
            "169.254.1.1",                             // v4 link-local
            "10.0.0.9", "192.168.0.9", "172.16.0.9",
        ] {
            #expect(LocalHost.isBlocked(host, pairedHost: nil), "expected \(host) blocked")
        }
        // The /10 boundary: 100.63 is ordinary space, 100.128 too.
        #expect(!LocalHost.isBlocked("100.63.255.255", pairedHost: nil))
        #expect(!LocalHost.isBlocked("100.128.0.1", pairedHost: nil))
        #expect(!LocalHost.isBlocked("8.8.8.8", pairedHost: nil))
    }
}

/// §1.15 Diagnostics: the reachability classifier maps each transport
/// layer's failure to its pills — a failure leaves the lower rows bad too.
@Suite struct ReachabilityDiagnosticsTests {

    private static func urlError(_ code: URLError.Code) -> URLError {
        URLError(code)
    }

    @Test func dnsFailureMarksAllThreeBad() {
        for code: URLError.Code in [.cannotFindHost, .dnsLookupFailed] {
            let d = ReachabilityDiagnostics.classify(Self.urlError(code))
            #expect(d == .init(resolved: .bad, tls: .bad, httpStatus: .bad))
        }
    }

    @Test func tlsFailureLeavesResolvedOk() {
        for code: URLError.Code in [
            .secureConnectionFailed, .serverCertificateHasBadDate,
            .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
            .serverCertificateNotYetValid, .clientCertificateRejected,
            .appTransportSecurityRequiresSecureConnection,
        ] {
            let d = ReachabilityDiagnostics.classify(Self.urlError(code))
            #expect(d == .init(resolved: .ok, tls: .bad, httpStatus: .bad))
        }
    }

    @Test func notConnectedMarksAllBad() {
        let d = ReachabilityDiagnostics.classify(Self.urlError(.notConnectedToInternet))
        #expect(d == .init(resolved: .bad, tls: .bad, httpStatus: .bad))
    }

    @Test func unansweredTransportLeavesUpperLayersOk() {
        for code: URLError.Code in [.timedOut, .cannotConnectToHost, .networkConnectionLost] {
            let d = ReachabilityDiagnostics.classify(Self.urlError(code))
            #expect(d == .init(resolved: .ok, tls: .ok, httpStatus: .bad))
        }
    }

    @Test func nonURLErrorMarksOnlyHTTPBad() {
        struct Odd: Error {}
        let d = ReachabilityDiagnostics.classify(Odd())
        #expect(d == .init(resolved: .ok, tls: .ok, httpStatus: .bad))
    }

    @Test func answeredConstantIsAllOk() {
        #expect(ReachabilityDiagnostics.answered
            == .init(resolved: .ok, tls: .ok, httpStatus: .ok))
    }
}

#if os(iOS)
/// §4.8 lifecycle: the only legal edges are unpaired→paired→signedOut,
/// anything→credentialInvalid, and →unpaired from anywhere. Data purges on
/// unpair and on re-pair to a different host; the generation counter gates
/// stale responses.
@Suite(.serialized) @MainActor struct PairingStoreTests {

    private func makeStore() -> (PairingStore, URL) {
        let suite = "PairingStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (PairingStore(defaults: defaults, purgeDirs: [dir]), dir)
    }

    private func origin(_ value: String) -> CanonicalOrigin {
        CanonicalOrigin(value)
    }

    @Test func fullLifecycleEdges() {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(store.state == .unpaired)
        // signOut from unpaired is a no-op, not a state.
        store.signOut()
        #expect(store.state == .unpaired)

        let host = try! TailnetEndpointPolicy.validate("https://mac.tailnet-name.ts.net")
        store.markPaired(origin: host, name: "Mac Studio")
        #expect(store.state == .paired)
        #expect(store.pairedOrigin == "https://mac.tailnet-name.ts.net")
        #expect(store.pairedName == "Mac Studio")

        store.signOut()
        #expect(store.state == .signedOut)

        store.markCredentialInvalid()
        #expect(store.state == .credentialInvalid)
        // signOut is not an exit from credentialInvalid (spec 4.8).
        store.signOut()
        #expect(store.state == .credentialInvalid)

        store.unpair()
        #expect(store.state == .unpaired)
        #expect(store.pairedOrigin == nil)
    }

    @Test func signInRecordsBothClocks() {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let host = try! TailnetEndpointPolicy.validate("https://mac.tailnet-name.ts.net")
        store.markPaired(origin: host, name: "Mac Studio")
        let session = Date().addingTimeInterval(3600)
        let credential = Date().addingTimeInterval(86400)
        store.markSignedIn(sessionExpiresAt: session, credentialExpiresAt: credential)
        #expect(store.sessionExpiresAt == session)
        #expect(store.credentialExpiresAt == credential)
        #expect(store.state == .paired)
        store.signOut()
        #expect(store.sessionExpiresAt == nil)
        // The credential clock survives sign-out (sign-out clears the
        // session only — spec 4.8).
        #expect(store.credentialExpiresAt == credential)
    }

    /// §11: the seven-day warning is one-time per credential — keyed to the
    /// expiry, so rotation/re-pair (a different expiresAt) warns again and
    /// unpair/re-pair clears the record entirely.
    @Test func expiryWarningIsOncePerCredential() {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let host = try! TailnetEndpointPolicy.validate("https://mac.tailnet-name.ts.net")
        store.markPaired(origin: host, name: "Mac Studio")
        let expiry = Date().addingTimeInterval(3 * 86_400)
        store.markSignedIn(sessionExpiresAt: nil, credentialExpiresAt: expiry)

        #expect(store.expiryWarnedFor == nil)
        store.markExpiryWarned()
        #expect(store.expiryWarnedFor == expiry)

        // A rotated credential reports a different expiry → warnable again.
        let rotated = expiry.addingTimeInterval(30 * 86_400)
        store.markSignedIn(sessionExpiresAt: nil, credentialExpiresAt: rotated)
        #expect(store.expiryWarnedFor != rotated)

        // Re-pair clears the record outright.
        store.markPaired(origin: host, name: "Mac Studio")
        #expect(store.expiryWarnedFor == nil)
    }

    @Test func repairToDifferentHostPurgesData() throws {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let generation = store.dataGeneration
        let scratch = dir.appendingPathComponent("cache-fragment")
        try Data("stale".utf8).write(to: scratch)

        store.markPaired(origin: origin("https://a.tailnet-name.ts.net"), name: "A")
        #expect(store.dataGeneration == generation) // same pairing, no bump

        store.markPaired(origin: origin("https://b.tailnet-name.ts.net"), name: "B")
        #expect(store.pairedName == "B")
        #expect(store.dataGeneration > generation)
        #expect(!FileManager.default.fileExists(atPath: scratch.path))
    }

    @Test func unpairPurgesAndBumpsGeneration() throws {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        store.markPaired(origin: origin("https://a.tailnet-name.ts.net"), name: "A")
        let scratch = dir.appendingPathComponent("cache-fragment")
        try Data("stale".utf8).write(to: scratch)
        let generation = store.dataGeneration

        store.unpair()
        #expect(store.dataGeneration > generation)
        #expect(!FileManager.default.fileExists(atPath: scratch.path))
        #expect(!store.isCurrent(generation: generation))
        #expect(store.isCurrent(generation: store.dataGeneration))
    }

    /// Sign-out bumps the generation like unpair does (no purge): a sign-in
    /// still in flight must not land `.paired` after the transition.
    @Test func signOutBumpsGeneration() throws {
        let (store, dir) = makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        store.markPaired(origin: origin("https://a.tailnet-name.ts.net"), name: "A")
        let generation = store.dataGeneration

        store.signOut()
        #expect(store.state == .signedOut)
        #expect(!store.isCurrent(generation: generation))
    }

    @Test func persistedStateSurvivesReinit() {
        let suite = "PairingStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var store = PairingStore(defaults: defaults, purgeDirs: [dir])
        store.markPaired(origin: origin("https://a.tailnet-name.ts.net"), name: "A")

        store = PairingStore(defaults: defaults, purgeDirs: [dir])
        #expect(store.state == .paired)
        #expect(store.pairedOrigin == "https://a.tailnet-name.ts.net")
    }

    @Test func corruptPersistedStateFailsToCredentialInvalid() {
        let suite = "PairingStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        // A paired state with no origin can never name its token's endpoint.
        defaults.set("paired", forKey: "pairing.state")
        let store = PairingStore(defaults: defaults, purgeDirs: [])
        #expect(store.state == .credentialInvalid)
    }
}
#endif

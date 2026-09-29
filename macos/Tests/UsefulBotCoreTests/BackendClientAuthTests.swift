import Foundation
import Testing
@testable import UsefulBotCore

/// Canned-answer transport: each test installs a handler and the client's
/// session is built on this protocol's configuration, so no server runs.
private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (HTTPURLResponse, Data) = { _ in
        (HTTPURLResponse(url: URL(string: "http://127.0.0.1:9")!, statusCode: 500,
                         httpVersion: nil, headerFields: nil)!, Data())
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (response, data) = Self.handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private struct StubTokenStore: DeviceTokenStore {
    func token() throws -> String { "device-token" }
}

private struct AllowEndpoint: EndpointPolicy {
    func endpoint(for proposed: URL) throws -> ServerEndpoint { ServerEndpoint(baseURL: proposed) }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var value = 0
    func bump() { lock.lock(); value += 1; lock.unlock() }
}

/// §6.2/§8.4 taxonomy on iOS (401 `unauthorized` -> one shared re-auth then
/// terminal `credentialInvalid`; `credential_invalid` immediate; any 403 ->
/// `forbidden(code)`, never a re-auth) against the preserved macOS contract
/// (retry once on 401/403, `unauthorized`/typed codes as before).
@Suite(.serialized) struct BackendClientAuthTests {
    private func makeClient() throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        // The ephemeral jar, not `HTTPCookieStorage()`. Every auth test ran
        // against a jar that keeps nothing, so none of them could have caught
        // the dropped session cookie however close it came.
        return try BackendClient(
            base: URL(string: "http://127.0.0.1:9")!,
            tokenStore: StubTokenStore(),
            endpointPolicy: AllowEndpoint(),
            session: URLSession(configuration: config)
        )
    }

    private func respond(_ status: Int, _ json: String, to url: URL) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                         headerFields: ["content-type": "application/json"])!,
         Data(json.utf8))
    }

    @Test func repeated401IsTerminalAfterOneReauth() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session" {
                signIns.bump()
                return self.respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return self.respond(401, #"{"ok":false,"error":"unauthorized"}"#, to: request.url!)
        }
        let client = try makeClient()
        await #expect(throws: BackendError.self) { try await client.shell() }
        #expect(signIns.value == 1)
        do {
            _ = try await client.shell()
            Issue.record("expected a thrown BackendError")
        } catch let error as BackendError {
#if os(iOS)
            #expect(error == .credentialInvalid)
#else
            #expect(error == .shell("unauthorized"))
#endif
        }
        // Two failed shell() calls -> exactly two re-auths, one per call.
        #expect(signIns.value == 2)
    }

    @Test func credentialInvalidSkipsReauthOnIOS() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session" {
                signIns.bump()
                return self.respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return self.respond(401, #"{"ok":false,"error":"credential_invalid"}"#, to: request.url!)
        }
        let client = try makeClient()
        do {
            _ = try await client.shell()
            Issue.record("expected a thrown BackendError")
        } catch let error as BackendError {
#if os(iOS)
            #expect(error == .credentialInvalid)
            #expect(signIns.value == 0)
#else
            // macOS treats a 401 as a rotated session and signs in once.
            #expect(signIns.value == 1)
#endif
        }
    }

    @Test func forbiddenSurfacesByCodeWithoutReauth() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session" {
                signIns.bump()
                return self.respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return self.respond(403, #"{"ok":false,"error":"csrf"}"#, to: request.url!)
        }
        let client = try makeClient()
        do {
            _ = try await client.shell()
            Issue.record("expected a thrown BackendError")
        } catch let error as BackendError {
#if os(iOS)
            #expect(error == .forbidden("csrf"))
            #expect(signIns.value == 0)
#else
            #expect(error == .shell("csrf"))
            #expect(signIns.value == 1)
#endif
        }
    }

    @Test func reauthIsSingleFlight() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session" {
                signIns.bump()
                Thread.sleep(forTimeInterval: 0.05)
                return self.respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return self.respond(401, #"{"ok":false,"error":"unauthorized"}"#, to: request.url!)
        }
        let client = try makeClient()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<4 {
                group.addTask { _ = try? await client.shell() }
            }
        }
        // Four concurrent 401s, one 50 ms sign-in: every caller shares the
        // in-flight task, so the auth endpoint is hit exactly once.
        #expect(signIns.value == 1)
    }

    /// The default session carries the isolation controls themselves: no
    /// shared URLCache for authed GET bodies, a private cookie jar that is
    /// not the shared one (the client also re-attaches `ub_session` as a
    /// header per request, which opts out of cookie handling anyway), and
    /// the no-redirect delegate. Removing one must fail a test, not slip
    /// through.
    @Test func defaultSessionIsIsolated() {
        let session = BackendClient.makeSession()
        let config = session.configuration
        #expect(config.urlCache == nil)
        #expect(config.httpCookieStorage !== HTTPCookieStorage.shared)
        #expect(config.httpShouldSetCookies == true)
        #expect(session.delegate is BackendClient.NoRedirectDelegate)
        // A jar has to keep what it is given. `HTTPCookieStorage()` passes
        // every check above and keeps nothing, so the session cookie from
        // sign-in was dropped and the app launched to "Unauthorized" with no
        // test to show for it.
        let base = URL(string: "http://127.0.0.1:4320")!
        let cookie = HTTPCookie(properties: [
            .domain: "127.0.0.1", .path: "/", .name: "ub_session", .value: "probe",
        ])
        #expect(cookie != nil)
        if let cookie { config.httpCookieStorage?.setCookie(cookie) }
        #expect(config.httpCookieStorage?.cookies(for: base)?.isEmpty == false)
    }

    /// The sign-in response's `Set-Cookie` is captured and replayed as a
    /// `Cookie` header on the next request — the jar is never consulted.
    @Test func sessionCookieRidesAsHeader() async throws {
        let cookieHeader = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session" {
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: [
                        "content-type": "application/json",
                        "set-cookie": "ub_session=abc123; Path=/; HttpOnly; SameSite=Strict",
                    ])!
                return (response, Data(#"{"ok":true,"csrfToken":"t"}"#.utf8))
            }
            if request.value(forHTTPHeaderField: "cookie") == "ub_session=abc123" {
                cookieHeader.bump()
            }
            return self.respond(200, #"{"store":{"bots":[]}}"#, to: request.url!)
        }
        let client = try makeClient()
        try await client.signIn()
        _ = try? await client.shell()
        #expect(cookieHeader.value == 1)
    }

    /// The exchange POST must carry the live session cookie itself — the
    /// detached jar never would, and the server retires the session being
    /// replaced by reading it. A second signIn sends the first's cookie.
    @Test func resignInCarriesLiveCookie() async throws {
        let postsWithoutCookie = CallCounter()
        var postCount = 0
        StubURLProtocol.handler = { [self] request in
            let isPost = request.httpMethod == "POST"
                && request.url?.path == "/api/auth/session"
            if isPost {
                postCount += 1
                if postCount > 1,
                   request.value(forHTTPHeaderField: "cookie") != "ub_session=abc123" {
                    postsWithoutCookie.bump()
                }
            }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: [
                    "content-type": "application/json",
                    "set-cookie": "ub_session=abc123; Path=/; HttpOnly; SameSite=Strict",
                ])!
            return (response, Data(#"{"ok":true,"csrfToken":"t","profile":"phone"}"#.utf8))
        }
        let client = try makeClient()
        try await client.signIn()
        try await client.signIn()
        #expect(postCount == 2)
        #expect(postsWithoutCookie.value == 0)
    }

    @Test func refusalCoversNewTerminalErrors() {
        #expect(WidgetSaveRetry.isRefusal(BackendError.forbidden("csrf")))
        #expect(WidgetSaveRetry.isRefusal(BackendError.credentialInvalid))
        #expect(!WidgetSaveRetry.isRefusal(BackendError.http(429)))
    }

    /// §6.2: once `signOut()` runs the exchange stays closed — a later
    /// request's re-auth must refuse rather than mint into the cleared jar.
    @Test func exchangeStaysClosedAfterSignOut() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session", request.httpMethod == "POST" {
                signIns.bump()
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: [
                        "content-type": "application/json",
                        "set-cookie": "ub_session=abc123; Path=/; HttpOnly; SameSite=Strict",
                    ])!
                return (response, Data(#"{"ok":true,"csrfToken":"t"}"#.utf8))
            }
            return self.respond(401, #"{"ok":false,"error":"unauthorized"}"#, to: request.url!)
        }
        let client = try makeClient()
        try await client.signIn()
        await client.signOut()
        // The drain already consumed the mint's DELETE; signIn count is 1.
        #expect(signIns.value == 1)
        do {
            _ = try await client.shell()
            Issue.record("expected a thrown BackendError")
        } catch {
            #expect(error is BackendError)
        }
        // The 401's re-auth hit the closed exchange — no second mint.
        #expect(signIns.value == 1)
    }

    /// `signIn()` is the explicit path that re-arms the exchange `signOut`
    /// closed — signed-out then sign-in works end to end.
    @Test func signInReopensExchangeAfterSignOut() async throws {
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session", request.httpMethod == "POST" {
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: [
                        "content-type": "application/json",
                        "set-cookie": "ub_session=abc123; Path=/; HttpOnly; SameSite=Strict",
                    ])!
                return (response, Data(#"{"ok":true,"csrfToken":"t"}"#.utf8))
            }
            return self.respond(200, #"{"store":{"bots":[]}}"#, to: request.url!)
        }
        let client = try makeClient()
        try await client.signIn()
        await client.signOut()
        try await client.signIn()
        _ = try await client.shell()
    }

    /// A mint that lands after `signOut()`'s DELETE fired must retire
    /// itself with ITS OWN cookie and CSRF — the jar's cleared values can
    /// never satisfy the new session's DELETE. The stub holds the second
    /// POST open long enough for sign-out to land underneath it.
    @Test func retireMintedSessionSendsMintedCsrf() async throws {
        let deletes = CallCounter()
        let mintedDelete = CallCounter()
        let mintedCsrf = CallCounter()
        let posts = CallCounter()
        StubURLProtocol.handler = { [self] request in
            let isSession = request.url?.path == "/api/auth/session"
            if isSession, request.httpMethod == "DELETE" {
                deletes.bump()
                if request.value(forHTTPHeaderField: "cookie") == "ub_session=minted-b" {
                    mintedDelete.bump()
                    if request.value(forHTTPHeaderField: "x-ub-csrf") == "csrf-b" {
                        mintedCsrf.bump()
                    }
                }
                return self.respond(200, #"{"ok":true}"#, to: request.url!)
            }
            if isSession, request.httpMethod == "POST" {
                posts.bump()
                let isSecond = posts.value == 2
                if isSecond {
                    // Hold the mint open while the test signs out.
                    Thread.sleep(forTimeInterval: 0.8)
                }
                let cookie = isSecond ? "ub_session=minted-b" : "ub_session=first"
                let token = isSecond ? "csrf-b" : "csrf-a"
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: [
                        "content-type": "application/json",
                        "set-cookie": "\(cookie); Path=/; HttpOnly; SameSite=Strict",
                    ])!
                return (response, Data(#"{"ok":true,"csrfToken":"\#(token)"}"#.utf8))
            }
            return self.respond(200, #"{"store":{"bots":[]}}"#, to: request.url!)
        }
        let client = try makeClient()
        try await client.signIn()
        let mint = Task { try await client.signIn() }
        // Give the second POST a moment to reach the held handler, then
        // sign out underneath it — the mint lands after the DELETE.
        try await Task.sleep(for: .milliseconds(200))
        await client.signOut()
        await #expect(throws: BackendError.self) { try await mint.value }
        #expect(deletes.value == 2) // sign-out's DELETE + the retire
        #expect(mintedDelete.value == 1)
        #expect(mintedCsrf.value == 1)
    }

    /// A 401 that surfaces after a mid-flight sign-out must not mint: the
    /// epoch and cookie the request observed are gone, so `reauth` is a
    /// no-op and the caller sees the failure.
    @Test func reauthSkipsMintAfterMidRequestSignOut() async throws {
        let signIns = CallCounter()
        StubURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/auth/session", request.httpMethod == "POST" {
                signIns.bump()
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: [
                        "content-type": "application/json",
                        "set-cookie": "ub_session=first; Path=/; HttpOnly; SameSite=Strict",
                    ])!
                return (response, Data(#"{"ok":true,"csrfToken":"csrf-a"}"#.utf8))
            }
            if request.url?.path == "/api/auth/session" { // DELETE
                return self.respond(200, #"{"ok":true}"#, to: request.url!)
            }
            // The request under test: hold the 401 open so sign-out lands
            // between send and failure.
            if request.value(forHTTPHeaderField: "cookie") == "ub_session=first" {
                Thread.sleep(forTimeInterval: 0.8)
            }
            return self.respond(401, #"{"ok":false,"error":"unauthorized"}"#, to: request.url!)
        }
        let client = try makeClient()
        try await client.signIn()
        let call = Task { try await client.shell() }
        // Give shell's request a moment to reach the held handler, then
        // sign out underneath it.
        try await Task.sleep(for: .milliseconds(200))
        await client.signOut()
        do {
            _ = try await call.value
            Issue.record("expected a thrown BackendError")
        } catch {
            #expect(error is BackendError)
        }
        // One mint total — the 401's re-auth saw the moved epoch/cookie.
        #expect(signIns.value == 1)
    }
}

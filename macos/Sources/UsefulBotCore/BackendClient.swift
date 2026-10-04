import Foundation

public enum BackendError: Error, LocalizedError, Equatable {
    case deviceTokenMissing
    /// The Keychain was locked or blocked an interaction prompt, so the CLI
    /// could not return the token.
    case keychainLocked
    /// The Keychain refused access to the stored token.
    case keychainDenied
    /// The owner dismissed the Keychain prompt.
    case keychainCancelled
    case unauthorized
    /// The credential itself was rejected (401 `credential_invalid` or a
    /// terminal 401 on iOS): the app moves to `credentialInvalid` (§4.8),
    /// never a re-auth.
    case credentialInvalid
    /// A 403 keeps its server code (`forbidden`, `origin`, `csrf`,
    /// `ingress`, `phone_forbidden_action`): §8.4 surfaces it by code.
    case forbidden(String)
    case http(Int)
    case decoding
    /// `/api/providers` answered with its own error code.
    case provider(String)
    /// `/api/providers` removed the connection but could not finish: the server's
    /// own sentence (`message`) says what is left to do, so it is shown as is.
    case providerNotice(code: String, message: String)
    /// `/api/attachments` answered with its own error code.
    case attachment(String)
    /// `/api/shell` answered with its own error code.
    case shell(String)
    /// eve retired the session this chat pointed at (a failed turn ends a
    /// session for good), so nothing can be sent to it again.
    case sessionEnded
    /// The chat was already carried over into a newer session elsewhere.
    case sessionMoved
    /// The event stream ended before the turn did, so the reply on screen
    /// may be missing its tail.
    case streamInterrupted
    /// The turn carried an image and the selected model is text-only.
    case modelNoVision
    /// Regenerate on a lost image answered with its own error code.
    case regenerate(String)
    /// The send was refused before reaching eve: the bot's stored model or
    /// connection is gone, and the server never substitutes another.
    case modelSelectionUnavailable

    public var errorDescription: String? {
        switch self {
        case .deviceTokenMissing:
            return "The device token is missing from the Keychain. Run scripts/setup-local.mjs once."
        case .keychainLocked:
            return "The Keychain is locked or waiting on a prompt, so the device token could not be read. Unlock it and retry."
        case .keychainDenied:
            return "The Keychain refused access to the device token. Allow Useful Bot in Keychain Access, or run scripts/setup-local.mjs again."
        case .keychainCancelled:
            return "The Keychain prompt was dismissed. Retry and approve it to continue."
        case .unauthorized:
            return "The local server rejected the device token."
        case .credentialInvalid:
            return "This device's credential was revoked or expired. Pair again to reconnect."
        case .forbidden(let code):
            return "The server refused the request (\(code))."
        case .http(let status):
            // A status code is not an answer. The ones a send can actually
            // meet get said in words, and the rest say it plainly too: a bare
            // number told the owner nothing they could act on.
            switch status {
            case 409:
                // Busy session, a replayed request and a stale revision all
                // land here, and the honest thing they share is that this one
                // did not take. Nothing is promised about sending again.
                return "That request conflicted with one already in flight."
            case 429:
                // A rate limit clears in seconds; an exhausted day does not.
                // The turn-failure banner names the budget when it knows; this
                // is the generic case, so it points at both.
                return "The router refused this: either too many requests just now, or the daily token limit is used up."
            case 502, 503, 504:
                return "The local server could not complete this request."
            case 401:
                return "The local server rejected the device token."
            case 403:
                return "The local server refused it."
            case 400:
                return "The local server couldn't accept it."
            default:
                return "The local server couldn't take it right now."
            }
        case .decoding:
            return "The local server sent data this app could not read."
        case .provider(let code):
            return code
        case .providerNotice(_, let message):
            return message
        case .attachment(let code):
            return code
        case .shell(let code):
            return Self.shellCopy(code)
        case .regenerate(let code):
            return BackendClient.regenerateCopy(code)
        case .sessionEnded:
            return "This chat's session ended. Send again to start a new one."
        case .sessionMoved:
            return "This chat just continued in a newer session. Send again."
        case .streamInterrupted:
            return "The connection dropped before the reply finished."
        case .modelNoVision:
            return "This model can't see images. Pick one that can from the model menu."
        case .modelSelectionUnavailable:
            return TurnFailure.modelSelectionUnavailableCopy
        }
    }

    private static func shellCopy(_ code: String) -> String {
        switch code {
        case "proposal_missing":
            return "That proposal is no longer available."
        case "proposal_expired":
            return "That proposal has expired."
        case "proposal_mismatch":
            return "That proposal no longer matches this app."
        case "tool_budget_exceeded":
            return "This would give your bots more tools than a turn can carry, so it was not connected."
        case "tool_name_too_long":
            return "That service names its tools longer than a model accepts, so it was not connected."
        case "tool_count_unknown":
            return "That service's tool list could not be read, so it was not connected. Try again."
        case "target_missing":
            return "The target bot no longer exists."
        case "fanout_empty":
            return "There is nobody left to send this to."
        case "csrf":
            return "The local server rejected that write. Try again."
        case "routine_missing":
            return "That routine no longer exists."
        case "routine_busy":
            return "That routine is already running."
        case "routine_name_required":
            return "Give the routine a name."
        case "routine_instruction_required":
            return "Give the routine an instruction."
        case "routine_limit":
            return "This bot already has the maximum number of routines."
        case "shell_description_too_long":
            return "Instructions can be up to \(InstructionsLimit.grouped(InstructionsLimit.max)) characters."
        case "agent_credential_missing":
            return "Routines need the agent credential. Restart the local services."
        default:
            return code.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// The `/api/providers` error code, when the failure came from that route.
    public var providerCode: String? {
        if case .provider(let code) = self { return code }
        if case .providerNotice(let code, _) = self { return code }
        return nil
    }

    /// The `/api/attachments` error code, when the failure came from that route.
    public var attachmentCode: String? {
        if case .attachment(let code) = self { return code }
        return nil
    }

    /// The `/api/shell` error code, when the failure came from that route.
    public var shellCode: String? {
        if case .shell(let code) = self { return code }
        return nil
    }
}

/// The only decisions the approvals route accepts.
public enum ApprovalDecision: String, Sendable {
    case approve
    case deny
}

private struct ShellResponse: Decodable {
    let store: ShellStore
    /// Set when the server committed the roster change but could not finish
    /// what hangs off it (a deleted bot's routines or transcript). The tick
    /// sweeps the remainder, so this is a warning, never a failure.
    let detachError: String?
    /// Set once, on a connect card's Authorize: the hosted sign-in to open.
    let redirectUrl: String?
    /// Authorize host the server stored on the card. Required to open it.
    let redirectHost: String?
}
private struct StateResponse: Decodable {
    let events: [AgentEvent]?
    let proposals: [Proposal]?
}
private struct SendResponse: Decodable { let sessionId: String? }
/// The proxy's error envelope for an upstream refusal. `code` is only ever
/// the one value the proxy relays, `session_not_active`.
private struct EveErrorResponse: Decodable { let code: String?; let error: String? }
private struct ShellErrorResponse: Decodable { let error: String? }
private struct ProvidersResponse: Decodable {
    let composer: ComposerState?
    let providers: [ProviderPublic]?
    let error: String?
}
private struct ProvidersErrorResponse: Decodable { let error: String?; let message: String? }
private struct ApprovalsResponse: Decodable { let approvals: [ApprovalItem] }
private struct ConnectionRefreshAnswer: Decodable { let connection: DirectConnection }
private struct ConnectorAuthorizeResponse: Decodable {
    let ok: Bool?
    let redirectUrl: String?
    let error: String?
}
private struct ConnectorsErrorResponse: Decodable { let error: String? }
private struct RoutinesResponse: Decodable { let routines: [Routine]? }
private struct RoutineResponse: Decodable { let routine: Routine? }
private struct MemoryResponse: Decodable { let notes: [MemoryNote] }
private struct AttachmentResponse: Decodable {
    let name: String?
    let bytes: Int?
    let text: String?
    let mediaType: String?
    let dataUrl: String?
    let error: String?
}

private final class ActivityBox: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    func touch() {
        lock.lock()
        last = Date()
        lock.unlock()
    }
    var idle: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return Date().timeIntervalSince(last)
    }
}

private final class FlagBox: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }
    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}

/// The tail index a stream's response reported, for the caller that started it.
private final class TailBox: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Int?
    var value: Int? {
        lock.lock()
        defer { lock.unlock() }
        return tail
    }
    func set(_ next: Int?) {
        lock.lock()
        tail = next
        lock.unlock()
    }
}

private final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    func set(_ next: Task<Void, Never>?) {
        lock.lock()
        task = next
        lock.unlock()
    }
    func cancel() {
        lock.lock()
        let current = task
        lock.unlock()
        current?.cancel()
    }
}

/// Talks to the local web server on behalf of the native app: device-token
/// sign-in, the shell store, durable thread events, turn sending and the
/// session event stream. Cookies live in a jar private to this client, so the
/// session never leaks into the shared storage other code might read.
public actor BackendClient {
    public let base: URL
    private let session: URLSession
    private let tokenStore: any DeviceTokenStore
    private var csrf = ""
    /// The `ub_session` credential, captured from the sign-in response and
    /// re-attached as a `Cookie` header on every request. A detached
    /// `HTTPCookieStorage` is inert on modern Foundation (it never stores),
    /// and the shared jar would leak the cookie into web views, so the client
    /// carries the pair itself.
    private var sessionCookie: String?
    /// The one in-flight re-authentication; concurrent 401s share it.
    private var reauthTask: Task<SessionInfo, Error>?
    /// Bumped once per `signOut()`. A request that was already in flight
    /// when the owner signed out compares its snapshot against this before
    /// re-authing or writing the jar: a mint that lands after the clear is
    /// retired, not kept.
    private var signOutEpoch = 0
    /// §6.2: once sign-out/unpair begins the exchange stays closed until an
    /// explicit sign-in re-opens it (`reopenExchange`, `signIn`) — a stale
    /// request's re-auth or an armed retry must never mint into the jar a
    /// sign-out just cleared.
    private var exchangeClosed = false

    public init(
        base: URL = AppVariant.current.webBaseURL,
        tokenStore: any DeviceTokenStore,
        endpointPolicy: any EndpointPolicy
    ) throws {
        try self.init(base: base, tokenStore: tokenStore, endpointPolicy: endpointPolicy, session: nil)
    }

    /// Test seam: a session built on a stubbed `URLProtocol` configuration
    /// answers canned responses without a server.
    init(
        base: URL,
        tokenStore: any DeviceTokenStore,
        endpointPolicy: any EndpointPolicy,
        session: URLSession?
    ) throws {
        // The device token and cookies ride on every request: the platform's
        // policy decides which base is allowed to carry them.
        self.base = try endpointPolicy.endpoint(for: base).baseURL
        self.tokenStore = tokenStore
        self.session = session ?? Self.makeSession()
    }

#if os(macOS)
    /// The desktop construction the app has always used: the device token comes
    /// from the login Keychain through `security`, and a non-loopback base
    /// resolves to the supervised local service.
    public init(
        base: URL = AppVariant.current.webBaseURL,
        tokenService: String = AppVariant.current.deviceTokenService
    ) throws {
        try self.init(
            base: base,
            tokenStore: ProcessDeviceTokenStore(service: tokenService),
            endpointPolicy: DesktopEndpointPolicy()
        )
    }
#endif

    /// Internal (not private) so tests can pin the isolation controls.
    static func makeSession() -> URLSession {
        // An ephemeral configuration is how a client gets a cookie jar of its
        // own. `HTTPCookieStorage()` looks like one and is not: a jar built
        // that way keeps nothing, so the session cookie the sign-in sets was
        // dropped and every authenticated call after it came back 401. The app
        // signed in and then showed "Local server unavailable / Unauthorized"
        // on every launch. Measured against the running service: sign-in 200,
        // cookies kept 0, next call 401; ephemeral keeps the cookie, answers
        // 200, and still leaves the shared jar untouched. `send(_:)` opts out
        // per request (`httpShouldHandleCookies = false`) and carries the
        // `ub_session` pair itself, so the jar only ever holds sign-in output.
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        // Authenticated GET bodies are the app's own cached state, not the
        // shared URLCache's: §13 sanctions one cache and §4.8's unpair purge
        // cannot reach Cache.db. No disk caching here.
        config.urlCache = nil
        return URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    /// Spec 4.7/8.1: follow no redirects. A 3xx from the server is an error
    /// surfaced through `expectOK`, never silently followed with credentials.
    /// Internal so tests can pin the delegate on the default session.
    final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping @Sendable (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    // MARK: - Auth

    /// What a sign-in established: the session expiry and, when the session
    /// is credential-bound (S9), the credential's own expiry — the two clocks
    /// Settings > Devices shows (spec 6.2).
    public struct SessionInfo: Sendable, Equatable {
        public let profile: String?
        public let expiresAt: Date?
        public let credentialExpiresAt: Date?
    }

    /// Bootstrap's exchange rides the same single flight as a 401-triggered
    /// re-auth: without it, a request racing the launch exchange mints a
    /// second session, `destroySession` retires the first one's cookie, and
    /// the client ends up holding dead state through the next call.
    public func ensureSession() async throws -> SessionInfo {
        if exchangeClosed { throw BackendError.unauthorized }
        if let task = reauthTask { return try await task.value }
        let task = Task { try await performSignIn() }
        reauthTask = task
        defer { reauthTask = nil }
        return try await task.value
    }

    /// Re-open the session exchange `signOut()` closed. Called only by the
    /// coordinator's explicit sign-in path — a request's silent re-auth
    /// never re-opens it.
    public func reopenExchange() {
        exchangeClosed = false
    }

    @discardableResult
    public func signIn() async throws -> SessionInfo {
        // An explicit sign-in re-opens the exchange a `signOut()` closed;
        // the epoch check inside `performSignIn` still retires a mint that
        // predates the latest wipe.
        exchangeClosed = false
        return try await performSignIn()
    }

    /// The session mint shared by `signIn` and `ensureSession`. The flight
    /// path goes through `performSignIn` so a queued re-auth task cannot
    /// re-open an exchange a concurrent `signOut` just closed.
    private func performSignIn() async throws -> SessionInfo {
        // Snapshot the sign-out epoch before the credential read: any
        // signOut() that lands while this mint is in flight retires its
        // session instead of letting it repopulate the cleared jar.
        let epoch = signOutEpoch
        // Read the credential off the actor executor: a token store can block
        // behind a Keychain prompt and must not stall other requests.
        // The item can report a transient miss for a beat while the keybag
        // settles around install/launch — look once more before declaring
        // the §4.8 terminal absence.
        let token = try await Task.detached { [tokenStore] in
            do {
                return try tokenStore.token()
            } catch BackendError.deviceTokenMissing {
                try? await Task.sleep(for: .milliseconds(150))
                return try tokenStore.token()
            }
        }.value
        var request = URLRequest(url: base.appendingPathComponent("api/auth/session"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        // The cookie jar is manual (detached HTTPCookieStorage is inert), so
        // send() never runs here: attach the live cookie ourselves or the
        // server's destroySession cannot retire the session this replaces.
        if let sessionCookie {
            request.setValue(sessionCookie, forHTTPHeaderField: "Cookie")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.decoding }
        guard (200...299).contains(http.statusCode) else {
#if os(iOS)
            // The device token is rejected: revoked, expired or disabled.
            // That is terminal for the pairing, not a retryable 401 (§4.8).
            if http.statusCode == 401 { throw BackendError.credentialInvalid }
            if http.statusCode == 403 {
                throw BackendError.forbidden(Self.errorCode(data) ?? "forbidden")
            }
            throw BackendError.http(http.statusCode)
#else
            throw http.statusCode == 401 ? BackendError.unauthorized : BackendError.http(http.statusCode)
#endif
        }
        // A sign-out that landed mid-mint already fired its DELETE without
        // this cookie — the session it just created would live server-side
        // to its expiry while the UI reads signed-out. Retire it with its
        // own cookie and surface the mint as failed.
        if epoch != signOutEpoch {
            if let cookie = Self.sessionCookie(from: http, url: base) {
                // The session being destroyed accepts only its own CSRF —
                // self.csrf is another session's (or empty after sign-out).
                // Newer servers echo it in the POST body; older ones answer
                // it on a read against the minted cookie.
                var mintedCsrf = ((try? JSONSerialization.jsonObject(with: data))
                    as? [String: Any])?["csrfToken"] as? String
                if mintedCsrf == nil {
                    var probe = URLRequest(url: base.appendingPathComponent("api/auth/session"))
                    probe.httpShouldHandleCookies = false
                    probe.setValue(cookie, forHTTPHeaderField: "cookie")
                    if let (probeData, _) = try? await session.data(for: probe) {
                        mintedCsrf = ((try? JSONSerialization.jsonObject(with: probeData))
                            as? [String: Any])?["csrfToken"] as? String
                    }
                }
                await retireMintedSession(cookie, csrf: mintedCsrf)
            }
            throw BackendError.unauthorized
        }
        if let cookie = Self.sessionCookie(from: http, url: base) {
            sessionCookie = cookie
        }
        if let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let token = body["csrfToken"] as? String, !token.isEmpty {
            csrf = token
            return Self.sessionInfo(body)
        }
        // Older servers may not echo the token, so read the session back.
        let (sessionData, sessionResponse) = try await send(
            URLRequest(url: base.appendingPathComponent("api/auth/session"))
        )
        guard let sessionHttp = sessionResponse as? HTTPURLResponse else {
            throw BackendError.decoding
        }
        guard (200...299).contains(sessionHttp.statusCode) else {
#if os(iOS)
            // Same taxonomy as the POST above: a rejected credential is
            // terminal, a 403 carries its code (§8.4).
            throw Self.failure(
                status: sessionHttp.statusCode,
                code: Self.errorCode(sessionData),
                fallback: "session_failed",
                typed: { _ in .http(sessionHttp.statusCode) }
            )
#else
            throw BackendError.http(sessionHttp.statusCode)
#endif
        }
        let body = (try? JSONSerialization.jsonObject(with: sessionData)) as? [String: Any]
        // A missing CSRF token would make every write 403 and loop through
        // re-sign-in; fail loudly instead of carrying an empty header.
        guard let csrfToken = body?["csrfToken"] as? String, !csrfToken.isEmpty else {
            throw BackendError.unauthorized
        }
        csrf = csrfToken
        return Self.sessionInfo(body ?? [:])
    }

    /// The `{expiresAt, credentialExpiresAt, profile}` block both session
    /// responses carry; epoch milliseconds on the wire.
    private static func sessionInfo(_ body: [String: Any]) -> SessionInfo {
        func millis(_ key: String) -> Date? {
            if let seconds = body[key] as? Double { return Date(timeIntervalSince1970: seconds / 1000) }
            if let iso = body[key] as? String {
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
            }
            return nil
        }
        return SessionInfo(
            profile: body["profile"] as? String,
            expiresAt: millis("expiresAt"),
            credentialExpiresAt: millis("credentialExpiresAt")
        )
    }

    /// Sign out (spec 6.2): clear the local cookie jar and CSRF for real, and
    /// tell the server with a best-effort DELETE — the call must work offline
    /// because signed-out is a local state first.
    public func signOut() async {
        // Quiesce before wipe: closing the exchange stops a request issued
        // after this point from minting, and the drain below waits out a
        // mint already in flight so its cookie rides the DELETE (the
        // server destroys the session it just made). A mint that lands
        // too late to drain — a direct signIn still suspended in the
        // network — retires itself in its write path instead of
        // repopulating the jar.
        exchangeClosed = true
        while let task = reauthTask {
            _ = try? await task.value
        }
        signOutEpoch &+= 1
        var request = URLRequest(url: base.appendingPathComponent("api/auth/session"))
        request.httpMethod = "DELETE"
        if !csrf.isEmpty {
            request.setValue(csrf, forHTTPHeaderField: "x-ub-csrf")
        }
        _ = try? await send(request)
        csrf = ""
        sessionCookie = nil
        session.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
    }

    /// Retire a session minted after `signOut()`'s DELETE fired — the DELETE
    /// could not carry this cookie, so the session would otherwise stay
    /// live server-side to its expiry. Best-effort like sign-out itself:
    /// signed-out is a local state even when this call cannot reach the Mac.
    /// `csrf` must be the minted session's own token — self.csrf belongs to
    /// whichever session was live before it (or is already cleared).
    private func retireMintedSession(_ cookie: String, csrf: String?) async {
        var request = URLRequest(url: base.appendingPathComponent("api/auth/session"))
        request.httpMethod = "DELETE"
        request.httpShouldHandleCookies = false
        if let csrf, !csrf.isEmpty {
            request.setValue(csrf, forHTTPHeaderField: "x-ub-csrf")
        }
        request.setValue(cookie, forHTTPHeaderField: "cookie")
        _ = try? await session.data(for: request)
    }

    /// Maps the `security` CLI exit status to a specific Keychain failure.
    /// The CLI truncates the OSStatus to a process exit code, so the values
    /// are the low byte of the matching `errSec*`: 36 is
    /// `errSecInteractionNotAllowed`, 51 `errSecAuthFailed`, 128
    /// `errSecUserCanceled`, and 44 `errSecItemNotFound` (the only one that
    /// genuinely means the token is missing).
    static func keychainFailure(for status: Int32) -> BackendError {
        switch status {
        case 36: return .keychainLocked
        case 51: return .keychainDenied
        case 128: return .keychainCancelled
        default: return .deviceTokenMissing
        }
    }

    /// §4.3.3/§8.5: re-auth is single-flight across requests and streams —
    /// a burst of 401s shares one sign-in instead of stampeding the
    /// rate-limited endpoint. `ensureSession` owns the shared task so a
    /// launch-time exchange joins the same flight.
    ///
    /// `sentCookie` is the cookie the failed request carried. When a
    /// parallel 401 already re-minted, the jar holds a session that
    /// postdates the failure — minting again would destroy *that* session
    /// (every mint runs destroySession) and hand the retry another dead
    /// cookie. Without this check, N concurrent 401s produce N mints that
    /// retire each other's sessions — the pattern observed as
    /// `POST session 200 → GET status 401` repeating through boot.
    /// The same comparison covers a cleared jar: a sign-out landing between
    /// the request's send and its 401 leaves `sessionCookie` nil — minting
    /// then would create a session on a pairing the user just signed out.
    /// `sentEpoch` is the sign-out epoch the failed request observed: a bump
    /// since the send means this request predates the sign-out even when the
    /// cookie compare still passes (cleared-jar `nil == nil` included), so
    /// the mint is skipped.
    private func reauth(unlessRotatedFrom sentCookie: String?, signedOutSince sentEpoch: Int) async throws {
        if sessionCookie != sentCookie || signOutEpoch != sentEpoch { return }
        _ = try await ensureSession()
    }

    /// Pull the `{ok:false,error:"code"}` code out of a small error body.
    private static func errorCode(_ data: Data) -> String? {
        (try? JSONDecoder().decode(ShellErrorResponse.self, from: data))?.error
    }

    /// §6.2/§8.4 applied to the endpoints that decode `{error: code}` bodies:
    /// on iOS a 401 is the terminal `credentialInvalid` (§4.8) and a 403 is
    /// `forbidden(code)` — never the endpoint's own error shape; on macOS the
    /// typed code (or its per-route fallback) stands, exactly as before.
    private static func failure(
        status: Int, code: String?, fallback: String, typed: (String) -> BackendError
    ) -> BackendError {
#if os(iOS)
        if status == 401 { return .credentialInvalid }
        if status == 403 { return .forbidden(code?.isEmpty == false ? code! : "forbidden") }
        if let code, !code.isEmpty { return typed(code) }
        return .http(status)
#else
        return typed(code?.isEmpty == false ? code! : fallback)
#endif
    }

    /// The same code read off a failed stream's body: bounded to a prefix so
    /// a malformed endpoint cannot pin the reader.
    private static func errorCode(_ bytes: URLSession.AsyncBytes) async throws -> String? {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= 4096 { break }
        }
        return errorCode(data)
    }

    /// Run a request and, on an expired or rotated session, sign in once more
    /// and retry it. Without this a server restart leaves the app broken until
    /// relaunch.
    private func perform(_ build: (BackendClient, String) throws -> URLRequest) async throws -> (Data, URLResponse) {
        let sentCookie = sessionCookie
        let sentEpoch = signOutEpoch
        var result = try await send(try build(self, csrf))
        if let http = result.1 as? HTTPURLResponse {
#if os(iOS)
            // §6.2/§8.4: 401 re-auths through the single flight once (an
            // immediate `credential_invalid` does not even retry); a 403 is
            // never a re-auth trigger and keeps its code.
            if http.statusCode == 401, Self.errorCode(result.0) != "credential_invalid" {
                try await reauth(unlessRotatedFrom: sentCookie, signedOutSince: sentEpoch)
                // Rebuild with the fresh token, not the one from the failed try.
                result = try await send(try build(self, csrf))
            }
#else
            if http.statusCode == 401 || http.statusCode == 403 {
                try await reauth(unlessRotatedFrom: sentCookie, signedOutSince: sentEpoch)
                // Rebuild with the fresh token, not the one from the failed try.
                result = try await send(try build(self, csrf))
            }
#endif
        }
        return result
    }

    /// Send one request with the session cookie attached. Automatic cookie
    /// handling stays off so the shared jar never sees `ub_session`; the
    /// header below is the whole cookie story.
    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        var request = request
        request.httpShouldHandleCookies = false
        if let sessionCookie {
            request.setValue(sessionCookie, forHTTPHeaderField: "cookie")
        }
        return try await session.data(for: request)
    }

    /// `send(_:)` for the byte-stream variant the event pipe uses. The
    /// third return is the cookie actually attached and the fourth the
    /// sign-out epoch at send — the 401 handler compares both against the
    /// jar to detect a rotation or sign-out that already happened between
    /// send and failure (`reauth(unlessRotatedFrom:signedOutSince:)`).
    private func sendBytes(_ request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse, String?, Int) {
        var request = request
        request.httpShouldHandleCookies = false
        let sentCookie = sessionCookie
        // Read at send: a sign-out landing mid-request bumps the epoch, and
        // a post-await read would return the NEW epoch and look unmoved.
        let sentEpoch = signOutEpoch
        if let sentCookie {
            request.setValue(sentCookie, forHTTPHeaderField: "cookie")
        }
        let (bytes, response) = try await session.bytes(for: request)
        return (bytes, response, sentCookie, sentEpoch)
    }

    /// Pull the `ub_session` pair out of a sign-in `Set-Cookie` header.
    private static func sessionCookie(from http: HTTPURLResponse, url: URL) -> String? {
        guard let fields = http.allHeaderFields as? [String: String] else { return nil }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) {
            if cookie.name == "ub_session" { return "\(cookie.name)=\(cookie.value)" }
        }
        return nil
    }

    // MARK: - Reads

    public func shell() async throws -> ShellStore {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/shell"))
        }
        try Self.expectShellOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ShellResponse.self, from: data) else {
            if let failure = try? JSONDecoder().decode(ShellErrorResponse.self, from: data),
               let code = failure.error, !code.isEmpty {
                throw BackendError.shell(code)
            }
            throw BackendError.decoding
        }
        return decoded.store
    }

    public func threadState(botId: String) async throws -> (events: [AgentEvent], proposals: [Proposal]) {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/agent/state"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "botId", value: botId)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(StateResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return (decoded.events ?? [], decoded.proposals ?? [])
    }

    public func events(botId: String) async throws -> [AgentEvent] {
        try await threadState(botId: botId).events
    }

    /// The operator identity and build info shown in the rail and settings.
    public func status() async throws -> AppStatus {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/status"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(AppStatus.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Pending approvals the agent is waiting on.
    public func approvals() async throws -> [ApprovalItem] {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/approvals"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ApprovalsResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.approvals
    }

    /// Approve or deny one pending action; the hash must match the row.
    public func decideApproval(id: String, decision: ApprovalDecision, hash: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/approvals/\(Self.pathComponent(id))"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "decision": decision.rawValue,
                "actionSha256": hash,
            ])
            return request
        }
        try Self.expectOK(data, response)
    }

    /// Provider rows for the settings dialog.
    public func providers() async throws -> [ProviderPublic] {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/providers"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ProvidersResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.providers ?? []
    }

    @discardableResult
    public func connectProvider(id: String, key: String) async throws -> [ProviderPublic] {
        try await providerWrite(method: "PUT", body: ["providerId": id, "key": key])
    }

    @discardableResult
    public func activateProvider(id: String) async throws -> [ProviderPublic] {
        try await providerWrite(method: "PUT", body: ["activeProviderId": id])
    }

    @discardableResult
    public func disconnectProvider(id: String) async throws -> [ProviderPublic] {
        try await providerWrite(method: "DELETE", body: ["providerId": id])
    }

    // MARK: - Providers v2

    /// The full providers payload: catalogue, connections, roles, composer
    /// and the legacy rows.
    public func providersPayload() async throws -> ProvidersPayload {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/providers"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ProvidersPayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Connect or replace a key, plan or local connection. A nil or empty key
    /// is left out of the body, so local modes connect without one.
    @discardableResult
    public func connect(providerId: String, mode: String, key: String?, fields: [String: String]?) async throws -> ProvidersPayload {
        var body: [String: Any] = ["providerId": providerId, "mode": mode]
        if let key, !key.isEmpty { body["key"] = key }
        if let fields { body["fields"] = fields }
        return try await providersWrite(method: "PUT", body: body)
    }

    @discardableResult
    public func setActiveConnection(_ connectionId: String) async throws -> ProvidersPayload {
        try await providersWrite(method: "PUT", body: ["activeConnectionId": connectionId])
    }

    @discardableResult
    public func disconnectConnection(_ connectionId: String) async throws -> ProvidersPayload {
        try await providersWrite(method: "DELETE", body: ["connectionId": connectionId])
    }

    /// Save one role's model pick. `modelId` may be
    /// "<connectionId>::<modelId>" to switch connection and model in one
    /// write. A nil `modelId` clears a reviewer choice. Nil subkeys are left
    /// out, so an unchanged effort is kept, not cleared.
    @discardableResult
    public func setRole(
        _ role: String,
        connectionId: String?,
        modelId: String?,
        effort: String?
    ) async throws -> ProvidersPayload {
        let selection: Any
        if let modelId {
            var row: [String: Any] = ["modelId": modelId]
            if let connectionId { row["connectionId"] = connectionId }
            if let effort { row["effort"] = effort }
            selection = row
        } else {
            selection = NSNull()
        }
        return try await providersWrite(method: "PUT", body: ["roles": [role: selection]])
    }

    /// Save the default (chat) model pick through the composer keys.
    @discardableResult
    public func setDefaultModel(connectionId: String?, modelId: String, effort: String?) async throws -> ProvidersPayload {
        var body: [String: Any] = [:]
        if let connectionId {
            body["modelId"] = "\(connectionId)::\(modelId)"
        } else {
            body["modelId"] = modelId
        }
        if let effort { body["effort"] = effort }
        return try await providersWrite(method: "PUT", body: body)
    }

    private func providersWrite(method: String, body: [String: Any]) async throws -> ProvidersPayload {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/providers"))
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            // The route reports its own code in the body; surface that so the
            // dialog can say why a connect was refused.
            throw Self.providersFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(ProvidersPayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// A failed `/api/providers` write as the error the app shows. A removed
    /// connection that left pinned bots behind carries the server's message,
    /// not a bare code, because the code alone reads as "nothing happened".
    static func providersFailure(status: Int, data: Data) -> BackendError {
        let decoded = try? JSONDecoder().decode(ProvidersErrorResponse.self, from: data)
        if decoded?.error == "connection_removed_bots_pinned", let message = decoded?.message, !message.isEmpty {
            return .providerNotice(code: "connection_removed_bots_pinned", message: message)
        }
        return failure(status: status, code: decoded?.error, fallback: "provider_failed", typed: BackendError.provider)
    }

    /// Start a device flow for one OAuth provider. Answers with what the
    /// device sheet shows.
    public func startOAuth(providerId: String) async throws -> DeviceFlowStart {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/providers/oauth"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["providerId": providerId])
            return request
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let decoded = try? JSONDecoder().decode(ProvidersErrorResponse.self, from: data)
            throw Self.failure(status: http.statusCode, code: decoded?.error, fallback: "provider_failed", typed: BackendError.provider)
        }
        guard let decoded = try? JSONDecoder().decode(DeviceFlowStart.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Poll one device flow. On `complete` the route also returns the full GET
    /// payload, decoded here when present. Every poll answer carries the next
    /// `intervalMs` the server wants between polls.
    public func pollOAuth(pollId: String) async throws -> (status: String, intervalMs: Int?, payload: ProvidersPayload?) {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/providers/oauth/\(Self.pathComponent(pollId))"))
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectOK(data, response)
        struct Poll: Decodable { let status: String?; let intervalMs: Int? }
        guard let poll = try? JSONDecoder().decode(Poll.self, from: data),
              let status = poll.status, !status.isEmpty else {
            throw BackendError.decoding
        }
        let payload = try? JSONDecoder().decode(ProvidersPayload.self, from: data)
        let hasPayload = payload.map { !$0.catalog.isEmpty || !$0.connections.isEmpty } ?? false
        return (status, poll.intervalMs, hasPayload ? payload : nil)
    }

    public func cancelOAuth(pollId: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(
                url: client.base.appendingPathComponent("api/providers/oauth/\(Self.pathComponent(pollId))")
            )
            request.httpMethod = "DELETE"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectOK(data, response)
    }

    private func providerWrite(method: String, body: [String: Any]) async throws -> [ProviderPublic] {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/providers"))
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            // The route reports its own code in the body; surface that so the
            // dialog can say why a key was refused.
            throw Self.providersFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(ProvidersResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.providers ?? []
    }

    // MARK: - Connectors

    /// The Connectors catalogue, optionally narrowed by a search string. A 502
    /// (Composio unreachable) still decodes: `error` is set and the rows are
    /// empty, so the dialog can say what happened instead of going blank.
    public func connectors(search: String? = nil, offset: Int = 0, limit: Int = 30) async throws -> ConnectorsPayload {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/connectors"),
                resolvingAgainstBaseURL: false
            )
            var items = [URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "limit", value: String(limit))]
            if let search, !search.isEmpty {
                items.append(URLQueryItem(name: "search", value: search))
            }
            components?.queryItems = items
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        if let http = response as? HTTPURLResponse, http.statusCode != 502 {
            try Self.expectOK(data, response)
        }
        guard let decoded = try? JSONDecoder().decode(ConnectorsPayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// The tools one connected app offers, for the detail view.
    public func connectorTools(toolkit: String) async throws -> [DirectConnectionTool] {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/connectors/tools"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "toolkit", value: toolkit)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ConnectorToolsPayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.tools
    }

    /// Stores the Composio key on the Mac. Pass nil to remove it.
    public func setConnectorsKey(_ key: String?) async throws {
        try await connectorsWrite(method: "PUT", body: ["apiKey": key ?? NSNull()])
    }

    /// Starts the hosted OAuth flow for one app and returns the page to open.
    public func authorizeConnector(slug: String) async throws -> String {
        let data = try await connectorsWrite(method: "POST", body: ["toolkit": slug])
        guard let decoded = try? JSONDecoder().decode(ConnectorAuthorizeResponse.self, from: data),
              let url = decoded.redirectUrl, !url.isEmpty else {
            throw BackendError.decoding
        }
        return url
    }

    /// Revokes one connected account.
    public func disconnectConnector(accountId: String) async throws {
        _ = try await connectorsWrite(method: "DELETE", body: ["accountId": accountId])
    }

    /// What one app needs from the owner's own OAuth app, for an app Composio
    /// has no app of its own for.
    public func connectorOwnAppForm(slug: String) async throws -> OwnAppForm {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/connectors/own-app"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "toolkit", value: slug)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let decoded = try? JSONDecoder().decode(ConnectorsErrorResponse.self, from: data)
            throw Self.failure(status: http.statusCode, code: decoded?.error, fallback: "own_app_unavailable", typed: BackendError.provider)
        }
        guard let decoded = try? JSONDecoder().decode(OwnAppForm.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Hands the owner's own OAuth app credentials to Composio and starts the
    /// sign-in; returns the page to open. The credentials travel once and are
    /// kept nowhere on this side.
    public func connectOwnApp(slug: String, credentials: [String: String]) async throws -> String {
        let data = try await connectorsWrite(
            path: "api/connectors/own-app", method: "POST", body: ["toolkit": slug, "credentials": credentials]
        )
        guard let decoded = try? JSONDecoder().decode(ConnectorAuthorizeResponse.self, from: data),
              let url = decoded.redirectUrl, !url.isEmpty else {
            throw BackendError.decoding
        }
        return url
    }

    @discardableResult
    private func connectorsWrite(path: String = "api/connectors", method: String, body: [String: Any]) async throws -> Data {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent(path))
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let decoded = try? JSONDecoder().decode(ConnectorsErrorResponse.self, from: data)
            throw Self.failure(status: http.statusCode, code: decoded?.error, fallback: "connectors_failed", typed: BackendError.provider)
        }
        return data
    }

    // MARK: - Direct connections

    /// The direct MCP and OpenAPI connections, with their state and tools.
    public func directConnections() async throws -> [DirectConnection] {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/connections"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(DirectConnectionsPayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.connections
    }

    /// Re-lists one connection's tools and answers with its new row.
    public func refreshDirectConnection(id: String) async throws -> DirectConnection {
        let data = try await connectorsWrite(
            path: "api/connections", method: "POST", body: ["id": id, "action": "refresh"]
        )
        guard let decoded = try? JSONDecoder().decode(ConnectionRefreshAnswer.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.connection
    }

    /// Starts a fresh sign-in for one OAuth connection.
    public func reauthorizeDirectConnection(id: String) async throws -> ConnectionReauthorize {
        let data = try await connectorsWrite(
            path: "api/connections", method: "POST", body: ["id": id, "action": "reauthorize"]
        )
        guard let decoded = try? JSONDecoder().decode(ConnectionReauthorize.self, from: data),
              !decoded.authorizeUrl.isEmpty else {
            throw BackendError.decoding
        }
        return decoded
    }

    public func removeDirectConnection(id: String) async throws {
        _ = try await connectorsWrite(path: "api/connections", method: "DELETE", body: ["id": id])
    }

    /// Observed token traffic for the settings Usage tab.
    public func usage() async throws -> UsagePayload {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/usage"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(UsagePayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Move the router's daily token budget. `nil` restores the shipped
    /// default. Answers with the refreshed usage so the pane never shows a
    /// number the server did not accept. The request budget is left alone.
    public func setDailyTokenBudget(_ tokens: Int?) async throws -> UsagePayload {
        try await putBudget(["dailyTokenBudget": tokens as Any? ?? NSNull()])
    }

    /// Move the daily request budget; same contract as the token one.
    public func setDailyRequestBudget(_ requests: Int?) async throws -> UsagePayload {
        try await putBudget(["dailyRequestBudget": requests as Any? ?? NSNull()])
    }

    private func putBudget(_ body: [String: Any]) async throws -> UsagePayload {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/usage"))
            request.httpMethod = "PUT"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let decoded = try? JSONDecoder().decode(ConnectorsErrorResponse.self, from: data)
            throw Self.failure(status: http.statusCode, code: decoded?.error, fallback: "budget_failed", typed: BackendError.provider)
        }
        guard let decoded = try? JSONDecoder().decode(UsagePayload.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded
    }

    /// Ask the proxy to cancel the active turn on a session.
    /// `reportOnly` marks the app's own cancel of a turn that only carries
    /// cancelled reports of sub-agents the owner stopped: the proxy then retires
    /// that session's cards alone, not those of sub-agents still running.
    public func cancel(sessionId: String, reportOnly: Bool = false) async throws {
        let (data, response) = try await perform { client, token in
            let path = client.base.appendingPathComponent("eve/v1/session/\(Self.pathComponent(sessionId))/cancel")
            var request = URLRequest(
                url: reportOnly ? path.appending(queryItems: [URLQueryItem(name: "scope", value: "report")]) : path
            )
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectOK(data, response)
    }

    /// Cancel a sub-agent's own turn. The proxy verifies the child the same way
    /// it does a stream read: by the parent session and the index of the
    /// parent's `subagent.called` for it.
    public func cancelChild(
        botId: String, childSessionId: String, parentSessionId: String, at: Int, agentId: String? = nil
    ) async throws {
        let (data, response) = try await perform { client, token in
            var components = URLComponents(
                url: client.base.appendingPathComponent("eve/v1/session/\(Self.pathComponent(childSessionId))/cancel"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [
                URLQueryItem(name: "parent", value: parentSessionId),
                URLQueryItem(name: "at", value: String(at)),
            ]
            // The server uses it to keep the stopped agent from being relaunched.
            if let agentId { components?.queryItems?.append(URLQueryItem(name: "agentId", value: agentId)) }
            guard let url = components?.url else { throw BackendError.decoding }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectOK(data, response)
    }

    // MARK: - Routines

    public func routines(botId: String) async throws -> [Routine] {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/routines"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "botId", value: botId)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectShellOK(data, response)
        guard let decoded = try? JSONDecoder().decode(RoutinesResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.routines ?? []
    }

    @discardableResult
    public func createRoutine(
        botId: String,
        name: String,
        instruction: String,
        schedules: [RoutineSchedule],
        timezone: String = TimeZone.current.identifier
    ) async throws -> Routine {
        let body: [String: Any] = [
            "botId": botId,
            "name": name,
            "instruction": instruction,
            "schedules": schedules.map(\.wire),
            "timezone": timezone,
        ]
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/routines"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        try Self.expectShellOK(data, response)
        guard let routine = (try? JSONDecoder().decode(RoutineResponse.self, from: data))?.routine else {
            throw BackendError.decoding
        }
        return routine
    }

    /// Patch one routine. Only the keys the caller passes are sent, so a form
    /// that edits the name cannot blank the schedule.
    @discardableResult
    public func updateRoutine(
        id: String,
        name: String? = nil,
        instruction: String? = nil,
        schedules: [RoutineSchedule]? = nil,
        active: Bool? = nil,
        timezone: String? = nil
    ) async throws -> Routine {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let instruction { body["instruction"] = instruction }
        if let schedules { body["schedules"] = schedules.map(\.wire) }
        if let active { body["active"] = active }
        if let timezone { body["timezone"] = timezone }
        let (data, response) = try await perform { client, token in
            var request = URLRequest(
                url: client.base.appendingPathComponent("api/routines/\(Self.pathComponent(id))")
            )
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        try Self.expectShellOK(data, response)
        guard let routine = (try? JSONDecoder().decode(RoutineResponse.self, from: data))?.routine else {
            throw BackendError.decoding
        }
        return routine
    }

    public func deleteRoutine(id: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(
                url: client.base.appendingPathComponent("api/routines/\(Self.pathComponent(id))")
            )
            request.httpMethod = "DELETE"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectShellOK(data, response)
    }

    /// Start a manual run. The server answers as soon as the turn is queued;
    /// the outcome lands in the routine's run history.
    public func runRoutine(id: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(
                url: client.base.appendingPathComponent("api/routines/\(Self.pathComponent(id))/run")
            )
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectShellOK(data, response)
    }

    public func memoryNotes(botId: String) async throws -> [MemoryNote] {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/memory"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "botId", value: botId)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(MemoryResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.notes
    }

    /// The JSON body of `DELETE /api/memory`.
    static func memoryDeleteBody(botId: String, id: String, revision: MemoryRevision?) throws -> Data {
        var body: [String: Any] = ["botId": botId, "id": id]
        if let revision { body["revision"] = revision.json }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    /// `GET /api/memory?botId=&id=`: one full note.
    public func memoryNote(botId: String, id: String) async throws -> MemoryNote {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/memory"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "botId", value: botId), URLQueryItem(name: "id", value: id)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        struct One: Decodable { let note: MemoryNote }
        guard let decoded = try? JSONDecoder().decode(One.self, from: data) else { throw BackendError.decoding }
        return decoded.note
    }

    public func deleteMemoryNote(botId: String, id: String, revision: MemoryRevision?) async throws {
        let body = try Self.memoryDeleteBody(botId: botId, id: id, revision: revision)
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/memory"))
            request.httpMethod = "DELETE"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = body
            return request
        }
        try Self.expectOK(data, response)
    }

    public func botContext(botId: String) async throws -> BotContextInfo {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/bots/context"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "botId", value: botId)]
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(BotContextInfo.self, from: data) else { throw BackendError.decoding }
        return decoded
    }

    /// The chip's state for one bot: its own model, effort and speed. Without
    /// a bot id the server answers with the last pick, which is only right
    /// before a bot is known.
    public func composer(botId: String? = nil) async throws -> ComposerState? {
        let (data, response) = try await perform { client, _ in
            var url = client.base.appendingPathComponent("api/providers")
            if let botId, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                parts.queryItems = [URLQueryItem(name: "botId", value: botId)]
                if let withQuery = parts.url { url = withQuery }
            }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ProvidersResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.composer
    }

    /// Drain the handoff pump the way the web poll does. Best effort: the next
    /// poll retries and the agent-side wake-up also drives the queue. Returns
    /// bot ids with a handoff currently being delivered, so the rail can pulse.
    public func tick() async -> [String]? {
        let result = try? await perform { client, token in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/agent/tick"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "limit", value: "2")]
            guard let url = components?.url else { throw BackendError.decoding }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        guard let (data, _) = result else { return nil }
        struct TickBody: Decodable { let workingBotIds: [String]? }
        guard let decoded = try? JSONDecoder().decode(TickBody.self, from: data) else { return nil }
        return decoded.workingBotIds ?? []
    }

    // MARK: - Writes

    /// Project recents for the composer's project chip. Best-effort reads: an
    /// empty list only means the menu offers New project alone.
    public func workspaceProjects() async throws -> [ProjectEntry] {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base.appendingPathComponent("api/workspace"))
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(WorkspaceProjectsResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.projects
    }

    @discardableResult
    public func addWorkspaceProject(path: String) async throws -> [ProjectEntry] {
        try await workspaceProjectCall(["action": "addProject", "path": path])
    }

    @discardableResult
    public func removeWorkspaceProject(id: String) async throws -> [ProjectEntry] {
        try await workspaceProjectCall(["action": "removeProject", "id": id])
    }

    private func workspaceProjectCall(_ body: [String: Any]) async throws -> [ProjectEntry] {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/workspace"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(WorkspaceProjectsResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.projects
    }


    /// Post a turn. `images` ride beside the text as file parts; with none
    /// the body is the plain string the text path has always sent.
    /// `continueFrom` names the session a fresh one carries over from: the
    /// proxy folds a brief of it into the new session's first turn. `retry`
    /// marks the owner's Retry, so the bot checks what already happened
    /// before repeating any step.
    public func send(
        botId: String,
        sessionId: String?,
        message: String,
        images: [Attachment] = [],
        continueFrom: String? = nil,
        retry: Bool = false
    ) async throws -> String {
        // An empty stored session means "start one", not a trailing-slash path
        // the proxy rejects.
        let normalized = sessionId.flatMap { $0.isEmpty ? nil : $0 }
        let turn = Attachments.turnMessage(formatted: message, images: images)
        let (data, response) = try await perform { client, token in
            let path = normalized.map { "eve/v1/session/\(Self.pathComponent($0))" } ?? "eve/v1/session"
            var request = URLRequest(url: client.base.appendingPathComponent(path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            var body: [String: Any] = [
                "message": turn,
                "botId": botId,
            ]
            if let continueFrom, !continueFrom.isEmpty, normalized == nil { body["continueFrom"] = continueFrom }
            if retry { body["retry"] = true }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        // A 409 with the relayed code means the stored session is gone, not
        // busy: the caller starts a fresh one instead of showing a dead end.
        if let http = response as? HTTPURLResponse, http.statusCode == 409,
           let failure = try? JSONDecoder().decode(EveErrorResponse.self, from: data),
           failure.code == "session_not_active" {
            throw BackendError.sessionEnded
        }
        // The carry-over this send asked for already happened elsewhere (the
        // handoff pump, another window): the chat lives in a newer session.
        if let http = response as? HTTPURLResponse, http.statusCode == 409,
           let failure = try? JSONDecoder().decode(EveErrorResponse.self, from: data),
           failure.code == "session_moved" {
            throw BackendError.sessionMoved
        }
        // The bot's stored model or connection is gone. The proxy refuses the
        // turn before eve and never swaps in another model.
        if let http = response as? HTTPURLResponse, http.statusCode == 409,
           Self.refusalCode(in: data) == "model_selection_unavailable" {
            throw BackendError.modelSelectionUnavailable
        }
        // The proxy refuses a picture for a model that cannot look at it
        // before the turn exists, so the draft and its files come back.
        if let http = response as? HTTPURLResponse, http.statusCode == 400,
           let failure = try? JSONDecoder().decode(EveErrorResponse.self, from: data),
           failure.error == "model_no_vision" {
            throw BackendError.modelNoVision
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(SendResponse.self, from: data) else {
            throw BackendError.decoding
        }
        guard let sid = decoded.sessionId ?? normalized, !sid.isEmpty else {
            throw BackendError.decoding
        }
        return sid
    }

    /// Answer an eve input request (a session limit, a tool approval). It goes
    /// to the same session route a turn does, as `inputResponses`, never as a
    /// message.
    public func answerInput(botId: String, sessionId: String, requestId: String, optionId: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("eve/v1/session/\(Self.pathComponent(sessionId))"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            let body: [String: Any] = [
                "botId": botId,
                "inputResponses": [["requestId": requestId, "optionId": optionId]],
            ]
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        // The session is gone, so the request it raised can never be answered.
        if let http = response as? HTTPURLResponse, http.statusCode == 409,
           let failure = try? JSONDecoder().decode(EveErrorResponse.self, from: data),
           failure.code == "session_not_active" {
            throw BackendError.sessionEnded
        }
        try Self.expectOK(data, response)
    }

    /// The code of a refusal body, whichever shape carries it: a top-level
    /// `code`, an `error` string, or `error: { code }`.
    static func refusalCode(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let code = object["code"] as? String { return code }
        if let error = object["error"] as? String { return error }
        if let error = object["error"] as? [String: Any] { return error["code"] as? String }
        return nil
    }

    /// Persist the session pointer and preview for a bot, the same shell
    /// action to send after a turn starts. Without it a poll
    /// would read back a null session and the next send would start a new one.
    public func touchChat(botId: String, preview: String, sessionId: String) async throws {
        let (data, response) = try await perform { client, token in
            let action: [String: Any] = [
                "type": "touchChat",
                "botId": botId,
                "preview": preview,
                "sessionId": sessionId,
            ]
            var request = URLRequest(url: client.base.appendingPathComponent("api/shell"))
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["action": action])
            return request
        }
        try Self.expectShellOK(data, response)
        // A 200 body can still carry {ok:false,error}; never treat that as a
        // persisted session pointer.
        if let failure = try? JSONDecoder().decode(ShellErrorResponse.self, from: data),
           let code = failure.error, !code.isEmpty {
            throw BackendError.shell(code)
        }
    }

    /// Apply a profile patch through the shell action endpoint. Nil values are
    /// sent as null: the server treats them as "clear this field".
    public func patchBot(botId: String, patch: [String: Any?]) async throws {
        _ = try await shellAction(ShellActions.updateBot(botId: botId, patch: patch))
    }

    /// Send any shell action, optionally resolving a proposal in the same
    /// write. Returns the authoritative store the server echoed back.
    /// A shell action's full answer: the new store plus anything the server
    /// could not finish alongside it.
    public struct ShellActionResult: Sendable {
        public let store: ShellStore
        public let detachError: String?
        public let redirectUrl: String?
        public let redirectHost: String?
    }

    @discardableResult
    public func shellAction(
        _ action: [String: Any],
        proposalId: String? = nil,
        proposalStatus: String? = nil
    ) async throws -> ShellStore {
        try await shellActionResult(action, proposalId: proposalId, proposalStatus: proposalStatus).store
    }

    public func shellActionResult(
        _ action: [String: Any],
        proposalId: String? = nil,
        proposalStatus: String? = nil
    ) async throws -> ShellActionResult {
        var body: [String: Any] = ["action": action]
        if let proposalId { body["proposalId"] = proposalId }
        if let proposalStatus { body["proposalStatus"] = proposalStatus }
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/shell"))
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            return request
        }
        try Self.expectShellOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ShellResponse.self, from: data) else {
            if let failure = try? JSONDecoder().decode(ShellErrorResponse.self, from: data),
               let code = failure.error, !code.isEmpty {
                throw BackendError.shell(code)
            }
            throw BackendError.decoding
        }
        return ShellActionResult(
            store: decoded.store,
            detachError: decoded.detachError,
            redirectUrl: decoded.redirectUrl,
            redirectHost: decoded.redirectHost
        )
    }

    public func persistWidget(botId: String, widget: LiveWidget) async throws {
        var arguments: [String: Any] = [:]
        for (key, value) in widget.arguments {
            arguments[key] = value.jsonObject
        }
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/agent/widget"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "botId": botId,
                "callId": widget.callId,
                "data": [
                    "toolName": widget.toolName,
                    "arguments": arguments,
                ],
            ])
            return request
        }
        try Self.expectOK(data, response)
        _ = data
    }

    /// The host page for a saved drawing. Fetched here, with the session this
    /// client holds, so the web view that shows it never carries the cookie.
    public func widgetPage(id: String) async throws -> String {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base
                .appendingPathComponent("api/connections/widget")
                .appendingPathComponent(id))
        }
        try Self.expectOK(data, response)
        guard let html = String(data: data, encoding: .utf8) else { throw BackendError.decoding }
        return html
    }

    /// One generated image's bytes. Fetched here, with the session this
    /// client holds, so the transcript row that names it never carries a URL
    /// into a context without the session.
    public func image(id: String) async throws -> (data: Data, mime: String) {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base
                .appendingPathComponent("api/agent/image")
                .appendingPathComponent(id))
        }
        try Self.expectOK(data, response)
        let mime = (response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "content-type")?
            .split(separator: ";").first?
            .trimmingCharacters(in: .whitespaces) ?? "image/png"
        return (data, mime)
    }

    /// One generated image, telling a moved file from a missing one: a 404
    /// names which in its body, so the row can offer Locate or Regenerate.
    public func imageFetch(id: String) async throws -> ImageFetch {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base
                .appendingPathComponent("api/agent/image")
                .appendingPathComponent(id))
        }
        if (response as? HTTPURLResponse)?.statusCode == 404 {
            // Only the route's own answers count: any other 404 (a route
            // missing mid-upgrade) must not read as "gone for good".
            switch String(data: data, encoding: .utf8) {
            case "moved": return .moved
            case "missing": return .missing
            default: throw BackendError.http(404)
            }
        }
        try Self.expectOK(data, response)
        return .loaded(data)
    }

    /// The Library: every saved image and drawing, newest first, and the
    /// folder they live in.
    public func mediaList(kind: String? = nil, botId: String? = nil, query: String? = nil) async throws -> (root: String, items: [MediaItem], held: Int) {
        let (data, response) = try await perform { client, _ in
            var components = URLComponents(
                url: client.base.appendingPathComponent("api/agent/media"),
                resolvingAgainstBaseURL: false
            )
            var items: [URLQueryItem] = []
            if let kind { items.append(URLQueryItem(name: "kind", value: kind)) }
            if let botId { items.append(URLQueryItem(name: "botId", value: botId)) }
            if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
            components?.queryItems = items.isEmpty ? nil : items
            guard let url = components?.url else { throw BackendError.decoding }
            return URLRequest(url: url)
        }
        try Self.expectOK(data, response)
        struct Response: Decodable { let root: String; let items: [MediaItem]; let held: Int? }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else { throw BackendError.decoding }
        return (decoded.root, decoded.items, decoded.held ?? 0)
    }

    /// One Library item by id, nil when the Library no longer has it.
    public func mediaItem(id: String) async throws -> MediaItem? {
        let (data, response) = try await perform { client, _ in
            URLRequest(url: client.base
                .appendingPathComponent("api/agent/media")
                .appendingPathComponent(id))
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 404 { return nil }
        try Self.expectOK(data, response)
        struct Response: Decodable { let item: MediaItem }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else { throw BackendError.decoding }
        return decoded.item
    }

    /// Point a moved item at the file the owner picked.
    public func relinkMedia(id: String, path: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base
                .appendingPathComponent("api/agent/media")
                .appendingPathComponent(id))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["path": path])
            return request
        }
        try Self.expectOK(data, response)
    }

    /// Draw a lost image again from the prompt the server kept, in place under
    /// the same id. Slow (an image model call), so the caller shows progress.
    public func regenerateImage(id: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base
                .appendingPathComponent("api/agent/image")
                .appendingPathComponent(id)
                .appendingPathComponent("regenerate"))
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.timeoutInterval = 180
            return request
        }
        guard let http = response as? HTTPURLResponse else { throw BackendError.decoding }
        guard (200...299).contains(http.statusCode) else {
            throw Self.failure(status: http.statusCode, code: Self.errorCode(data), fallback: "regenerate_failed", typed: BackendError.regenerate)
        }
    }

    /// What a failed Regenerate says, by the server's code.
    public static func regenerateCopy(_ code: String) -> String {
        switch code {
        case "router_token_missing":
            return "Image generation isn't connected. Restart Useful Bot, then try again."
        case "image_present":
            return "This image is already there."
        case "rate_limited":
            return "Too many regenerations just now. Wait a minute, then try again."
        case "image_prompt_missing":
            return "This image's prompt wasn't saved, so it can't be drawn again."
        case "regenerate_timeout", "timeout":
            return "The image model took too long. It may still have been billed, so check the Library before trying again."
        case "image_removed":
            return "This image was removed from the Library while it was drawn, so it stays removed."
        case "upstream_usage_limit", "upstream_usage_not_included", "upstream_quota_exhausted":
            return "The image provider's plan or credit limit is used up. Pick another image model in Settings."
        case "upstream_rate_limited":
            return "The image provider is rate limiting. Wait a minute, then try again."
        case "image_unusable":
            return "The image model sent back something that isn't a usable image."
        case "image_not_saved":
            return "The image was drawn but couldn't be saved on this Mac. Check disk space and access to Documents."
        default:
            return "The image couldn't be generated again (\(code))."
        }
    }

    /// Forget an item after its file went to the Trash.
    public func forgetMedia(id: String) async throws {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base
                .appendingPathComponent("api/agent/media")
                .appendingPathComponent(id))
            request.httpMethod = "DELETE"
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            return request
        }
        try Self.expectOK(data, response)
    }

    /// One of a drawing's own tool calls (Excalidraw's export). The server
    /// runs only tools the MCP server marked for its app; the result goes
    /// back to the app as JSON.
    public func widgetToolCall(id: String, name: String, arguments: [String: Any]) async throws -> Any {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base
                .appendingPathComponent("api/connections/widget")
                .appendingPathComponent(id)
                .appendingPathComponent("call"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "name": name,
                "arguments": arguments,
            ])
            return request
        }
        try Self.expectOK(data, response)
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = body["result"] as? [String: Any] else {
            throw BackendError.decoding
        }
        return result
    }

    /// Resolve a proposal without a shell action (the dismiss path).
    @discardableResult
    public func resolveProposal(proposalId: String, status: String) async throws -> ShellStore {
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/shell"))
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "proposalId": proposalId,
                "proposalStatus": status,
            ])
            return request
        }
        try Self.expectShellOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ShellResponse.self, from: data) else {
            if let failure = try? JSONDecoder().decode(ShellErrorResponse.self, from: data),
               let code = failure.error, !code.isEmpty {
                throw BackendError.shell(code)
            }
            throw BackendError.decoding
        }
        return decoded.store
    }

    /// Persist effort/speed/model choices from the composer chip.
    @discardableResult
    public func updateComposer(botId: String? = nil, modelId: String? = nil, effort: String? = nil, speed: String? = nil) async throws -> ComposerState? {
        let patch = Self.composerPatch(botId: botId, modelId: modelId, effort: effort, speed: speed)
        let (data, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/providers"))
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = try JSONSerialization.data(withJSONObject: patch)
            return request
        }
        try Self.expectOK(data, response)
        guard let decoded = try? JSONDecoder().decode(ProvidersResponse.self, from: data) else {
            throw BackendError.decoding
        }
        return decoded.composer
    }

    /// The PUT body for a chip save. The bot id rides in the body so the
    /// server writes that bot's selection and not only the last pick.
    static func composerPatch(botId: String?, modelId: String?, effort: String?, speed: String?) -> [String: Any] {
        var patch: [String: Any] = [:]
        if let botId { patch["botId"] = botId }
        if let modelId { patch["modelId"] = modelId }
        if let effort { patch["effort"] = effort }
        if let speed { patch["speed"] = speed }
        return patch
    }

    /// Upload one attachment for the composer. The caller is responsible for
    /// the extension/size checks in `Attachments`.
    public func uploadAttachment(fileURL: URL, mimeType: String) async throws -> Attachment {
        let name = try Attachments.safeName(fileURL.lastPathComponent)
        // Bounded read: never let a huge or unknown-size file land in memory
        // before the cap is enforced.
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: fileURL)
        } catch {
            throw BackendError.attachment("attachment_missing")
        }
        defer { try? handle.close() }
        var data = Data()
        while data.count <= Attachments.maxBytes {
            guard let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        guard data.count <= Attachments.maxBytes else {
            throw BackendError.attachment("attachment_size")
        }
        // `UTType.identifier` is a UTI, not a MIME type; only an allow-listed
        // `type/subtype` may reach the multipart header. The server falls back
        // to the file extension when the header is generic.
        let type = Attachments.safeMIME(mimeType) ?? "application/octet-stream"
        let boundary = "useful-bot-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(type)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        let (responseData, response) = try await perform { client, token in
            var request = URLRequest(url: client.base.appendingPathComponent("api/attachments"))
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
            request.setValue(token, forHTTPHeaderField: "x-ub-csrf")
            request.httpBody = body
            return request
        }
        let decoded = try? JSONDecoder().decode(AttachmentResponse.self, from: responseData)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw Self.failure(status: http.statusCode, code: decoded?.error, fallback: "attachment_failed", typed: BackendError.attachment)
        }
        guard let decoded, let resolvedName = decoded.name, let bytes = decoded.bytes else {
            throw BackendError.decoding
        }
        // The server echo is sanitised again before it can reach the composer
        // or the prompt, and the local id is unique per attachment so two
        // picks that normalise to the same name cannot collapse into one.
        let displayName = (try? Attachments.safeName(resolvedName)) ?? name
        // Clip here too: the prompt must not carry more than the server keeps.
        let text = decoded.text.map { String($0.prefix(Attachments.textMax)) }
        // Only a data URL of an image type goes into a turn; anything else
        // the server might echo is dropped here rather than sent on.
        let mediaType = decoded.mediaType.flatMap(Attachments.safeMIME).flatMap { $0.hasPrefix("image/") ? $0 : nil }
        let dataUrl = decoded.dataUrl.flatMap { url in
            mediaType.map { url.hasPrefix("data:\($0);base64,") } == true ? url : nil
        }
        return Attachment(
            id: UUID().uuidString,
            name: displayName,
            bytes: bytes,
            text: text,
            mediaType: dataUrl == nil ? nil : mediaType,
            dataUrl: dataUrl
        )
    }

    // MARK: - Stream

    /// What a session held just before a send: the turn ids on record, and
    /// where the read for the new turn can begin.
    public struct HistorySnapshot: Equatable, Sendable {
        /// Turn ids already recorded. The next turn is the first with an id
        /// outside this set, which keeps a resend of identical text from
        /// arming the stream on the earlier turn.
        public let turnIds: Set<String>
        /// The first event index the session had not recorded yet, or nil when
        /// the server did not say where its record ended. Taken before the
        /// turn is posted, so the new turn's first event is at or after it.
        public let nextIndex: Int?

        public init(turnIds: Set<String>, nextIndex: Int?) {
            self.turnIds = turnIds
            self.nextIndex = nextIndex
        }

        /// `tail` is the zero-based index of the last recorded event, -1 for
        /// an empty session, nil when unreported. The server's tail is the
        /// authority, never the index the read began at: a cursor that had
        /// somehow run ahead of the record would start the send's stream past
        /// its own turn, and the reply would never arm.
        public static func nextIndex(tail: Int?) -> Int? {
            guard let tail else { return nil }
            return max(0, tail + 1)
        }
    }

    /// Snapshot the session before a send. `start` lets a caller that already
    /// holds the session up to an index read only what came after it; the
    /// send's own stream then begins at `nextIndex`, so neither read walks the
    /// whole history. Both used to start at zero, which put two full replays
    /// of the session in front of the first token of every reply.
    public func historySnapshot(sessionId: String, readFrom start: Int = 0) async throws -> HistorySnapshot {
        var ids = Set<String>()
        let tail = TailBox()
        // A snapshot of what is already recorded, so it stops at the durable
        // tail. Waiting for the stream to go quiet instead put more than three
        // seconds in front of every send into an existing chat.
        for try await event in stream(sessionId: sessionId, expectedSuffix: nil, startIndex: start, untilTail: true, tailBox: tail) {
            if let turnId = event.turnId, !turnId.isEmpty {
                ids.insert(turnId)
            }
        }
        let next = HistorySnapshot.nextIndex(tail: tail.value)
        if next == nil, start > 0 {
            // No tail, so the send has to read from zero, and for that the
            // turn ids have to cover the whole session, not just its end.
            return try await historySnapshot(sessionId: sessionId, readFrom: 0)
        }
        return HistorySnapshot(turnIds: ids, nextIndex: next)
    }

    /// The id of the newest event the session has recorded, or nil when it has
    /// none, cannot be read, or does not answer within `timeout`.
    ///
    /// Read with a negative `startIndex`, which eve documents as relative to
    /// the tail: it opens only the last chunk file. Asking for the tail index
    /// instead (`includeTailIndex`) makes eve open every chunk file of the
    /// session before it answers, 1.25 s for a 12,554-event chat, and a load
    /// only needs to know which event is the last one it will call history.
    public func newestEventId(sessionId: String, timeout: TimeInterval = 0.8) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            group.addTask { try? await self.readNewestEventId(sessionId: sessionId, timeout: timeout) }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func readNewestEventId(sessionId: String, timeout: TimeInterval) async throws -> String? {
        var components = URLComponents(
            url: base.appendingPathComponent("eve/v1/session/\(Self.pathComponent(sessionId))/stream"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "startIndex", value: "-1")]
        guard let url = components?.url else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        for attempt in 0..<2 {
            let (bytes, response, sentCookie, sentEpoch) = try await sendBytes(request)
            // The read follows the live stream after that one event; it is
            // dropped as soon as the event is in.
            defer { bytes.task.cancel() }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
#if os(macOS)
            // The same one re-sign-in the stream makes after a server restart
            // rotated the session. Without it every first open after one fell
            // back to the whole-session scan.
            if status == 401 || status == 403, attempt == 0 {
                try await reauth(unlessRotatedFrom: sentCookie, signedOutSince: sentEpoch)
                continue
            }
#else
            _ = (attempt, sentCookie, sentEpoch)
#endif
            guard (200...299).contains(status) else { return nil }
            for try await line in bytes.lines {
                guard let payload = EveStream.payload(of: line) else { continue }
                return EveStream.eventId(ofPayload: payload)
            }
            return nil
        }
        return nil
    }

    /// Replay the session and yield events live. With `expectedSuffix` set, the
    /// stream ignores replay until it sees the turn carrying that text with a
    /// turn id not in `historyTurnIds`, then finishes on that turn's completion.
    /// Without it, the stream finishes after a short quiet period: history is
    /// replayed instantly by the local server, and the connection otherwise
    /// stays open forever.
    ///
    /// `startIndex` is eve's absolute event count: the read begins there, and
    /// every yielded event carries its own `index`, so a caller that keeps
    /// `index + 1` can resume later without replaying what it already has.
    /// With `untilTail` the read is a catch-up: the server reports the last
    /// durably recorded index and the stream finishes on reaching it, without
    /// waiting out the quiet period. A server that does not report a tail
    /// leaves the quiet period as the only end, as before.
    /// `allowUntaggedTurn` keeps the old tolerance for a server that tags no
    /// turns: a matching message with no turn id arms the stream when
    /// `historyTurnIds` is empty. A caller whose id set does not span the whole
    /// session passes false, because there an empty set proves nothing.
    /// With `markHistory` the server is asked for the same tail but the read
    /// carries on past it: each event says how far it sat from the end of the
    /// history, and the caller tells a replay from a live turn by that.
    /// With `markHistory` and a `historyMarker` (from `newestEventId`) the
    /// tail is not asked for: every event up to the one carrying that id is
    /// history (`historyRemaining` 1, then 0 on the marker) and the read
    /// finishes there. A read that ends any other way throws, so a caller
    /// that finishes the loop knows it reached the marker.
    public nonisolated func stream(
        sessionId: String,
        expectedSuffix: String? = nil,
        historyTurnIds: Set<String> = [],
        startIndex: Int = 0,
        untilTail: Bool = false,
        markHistory: Bool = false,
        historyMarker: String? = nil,
        allowUntaggedTurn: Bool = true,
        parentSessionId: String? = nil,
        calledAt: Int? = nil,
        tailCount: Int? = nil
    ) -> AsyncThrowingStream<EveEvent, Error> {
        stream(
            sessionId: sessionId,
            expectedSuffix: expectedSuffix,
            historyTurnIds: historyTurnIds,
            startIndex: startIndex,
            untilTail: untilTail,
            markHistory: markHistory,
            historyMarker: historyMarker,
            allowUntaggedTurn: allowUntaggedTurn,
            parentSessionId: parentSessionId,
            calledAt: calledAt,
            tailCount: tailCount,
            tailBox: nil
        )
    }

    private nonisolated func stream(
        sessionId: String,
        expectedSuffix: String?,
        historyTurnIds: Set<String> = [],
        startIndex: Int,
        untilTail: Bool,
        markHistory: Bool = false,
        historyMarker: String? = nil,
        allowUntaggedTurn: Bool = true,
        parentSessionId: String? = nil,
        calledAt: Int? = nil,
        tailCount: Int? = nil,
        tailBox: TailBox?
    ) -> AsyncThrowingStream<EveEvent, Error> {
        // A marker stands in for the tail index; without one, the tail is
        // asked for as before.
        let marker = markHistory ? historyMarker : nil
        // The last `tailCount` events: eve reads a negative `startIndex` from the
        // tail, and the tail index is needed to say where the first one sits.
        let wantsTail = untilTail || (markHistory && marker == nil) || tailCount != nil
        let base = self.base
        let client = self
        return AsyncThrowingStream { continuation in
            let activity = ActivityBox()
            let armedBox = FlagBox()
            // Set once a 2xx response's headers are in. Until then eve is
            // still preparing the read: with `includeTailIndex` it opens every
            // chunk file of the session to count the tail before it answers,
            // which takes seconds on a long session and is not a hung link.
            let openedBox = FlagBox()
            let reader = Task {
                do {
                    for attempt in 0..<2 {
                        // The idle watchdog covers the whole handshake, not
                        // just the line loop: the header wait, an error-body
                        // drain and a re-auth round trip each reset it so a
                        // slow link cannot finish() the stream mid-handling.
                        activity.touch()
                        var components = URLComponents(
                            url: base.appendingPathComponent("eve/v1/session/\(Self.pathComponent(sessionId))/stream"),
                            resolvingAgainstBaseURL: false
                        )
                        components?.queryItems = [URLQueryItem(name: "startIndex", value: tailCount.map { String(-max(1, $0)) } ?? String(max(0, startIndex)))]
                        if wantsTail {
                            components?.queryItems?.append(URLQueryItem(name: "includeTailIndex", value: "1"))
                        }
                        // A sub-agent's child session is read through its parent,
                        // naming where the parent's `subagent.called` for it sits.
                        if let parentSessionId {
                            components?.queryItems?.append(URLQueryItem(name: "parent", value: parentSessionId))
                            if let calledAt {
                                components?.queryItems?.append(URLQueryItem(name: "at", value: String(calledAt)))
                            }
                        }
                        guard let url = components?.url else { throw BackendError.decoding }
                        var request = URLRequest(url: url)
                        request.timeoutInterval = 180
                        let (bytes, response, sentCookie, sentEpoch) = try await sendBytes(request)
                        activity.touch()
                        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
#if os(iOS)
                        // §6.2/§8.4: a 401 re-auths through the shared single
                        // flight once; `credential_invalid` and every 403 are
                        // terminal and never re-auth.
                        if status == 401, attempt == 0 {
                            let code = try await Self.errorCode(bytes)
                            activity.touch()
                            if code != "credential_invalid" {
                                try await client.reauth(unlessRotatedFrom: sentCookie, signedOutSince: sentEpoch)
                                activity.touch()
                                continue
                            }
                            throw BackendError.credentialInvalid
                        }
                        guard (200...299).contains(status) else {
                            switch status {
                            case 401:
                                throw BackendError.credentialInvalid
                            case 403:
                                throw BackendError.forbidden(
                                    (try await Self.errorCode(bytes)) ?? "forbidden")
                            default:
                                throw BackendError.http(status)
                            }
                        }
#else
                        // A child stream's 403 is the proxy refusing it (the parent
                        // does not vouch for it), which signing in again never fixes.
                        if (status == 401 || (status == 403 && parentSessionId == nil)), attempt == 0 {
                            // The session rotated (server restart); sign in and
                            // rebuild the stream once.
                            try await client.reauth(unlessRotatedFrom: sentCookie, signedOutSince: sentEpoch)
                            activity.touch()
                            continue
                        }
                        guard (200...299).contains(status) else {
                            // A 401/403 after the re-sign-in attempt is an
                            // auth failure, not a generic HTTP error.
                            throw status == 401 || status == 403
                                ? BackendError.unauthorized
                                : BackendError.http(status)
                        }
#endif
                        // Zero-based index of the last recorded event, or -1
                        // for an empty stream. Nil when the server did not say.
                        let tail = wantsTail
                            ? (response as? HTTPURLResponse)?
                                .value(forHTTPHeaderField: "x-eve-stream-tail-index")
                                .flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
                            : nil
                        openedBox.set()
                        tailBox?.set(tail)
                        var nextIndex = max(0, startIndex)
                        if let tailCount {
                            // Without the tail there is no telling where these
                            // events sit, and a cursor built on a guess is worse
                            // than no read.
                            guard let tail else { throw BackendError.decoding }
                            nextIndex = max(0, tail + 1 - max(1, tailCount))
                        }
                        if untilTail, let tail, tail < nextIndex {
                            // Nothing recorded past the cursor.
                            continuation.finish()
                            return
                        }
                        var armed = expectedSuffix == nil
                        if armed { armedBox.set() }
                        // In history mode a waiting marker ends every replayed
                        // turn; only the idle watchdog may finish the read.
                        let finishOnTerminal = expectedSuffix != nil
                        // In armed mode the stream must end with a terminal
                        // event; an EOF before one means the server dropped
                        // mid-turn, not that the reply is done.
                        var sawTerminal = false
                        for try await line in bytes.lines {
                            activity.touch()
                            // Counted before it is decoded: a line this build
                            // cannot read is still one event in eve's count.
                            guard EveStream.payload(of: line) != nil else { continue }
                            let index = nextIndex
                            nextIndex += 1
                            let reachedTail = untilTail && (tail.map { index >= $0 } ?? false)
                            guard var event = EveStream.parseLine(line) else {
                                if reachedTail {
                                    continuation.finish()
                                    return
                                }
                                // A marker this build cannot decode still ends
                                // the history where it sits.
                                if let marker, let payload = EveStream.payload(of: line),
                                   EveStream.eventId(ofPayload: payload) == marker {
                                    continuation.finish()
                                    return
                                }
                                continue
                            }
                            event.index = index
                            event.sessionId = sessionId
                            let reachedMarker = marker != nil && event.id == marker
                            if markHistory, let tail {
                                event.historyRemaining = tail - index
                            } else if marker != nil {
                                event.historyRemaining = reachedMarker ? 0 : 1
                            }
                            if !armed {
                                if event.type == "message.received",
                                   let message = event.message,
                                   let suffix = expectedSuffix {
                                    let stripped = EveStream.stripThreadPrefix(message)
                                    // Nothing truncates a stored turn today, so
                                    // the equality above is what arms the
                                    // stream. The prefix arm is tolerance only:
                                    // a composed message carrying an attached
                                    // file body runs far past the composer cap,
                                    // and a server that started clipping there
                                    // would otherwise leave the send unarmed.
                                    let expected = String(suffix.prefix(Attachments.messageMax))
                                    let matches = stripped == suffix || stripped.hasPrefix(expected)
                                    if matches,
                                       let turnId = event.turnId,
                                       !historyTurnIds.contains(turnId) {
                                        armed = true
                                        armedBox.set()
                                        continuation.yield(event)
                                    } else if matches,
                                              event.turnId == nil,
                                              allowUntaggedTurn,
                                              historyTurnIds.isEmpty {
                                        armed = true
                                        armedBox.set()
                                        continuation.yield(event)
                                    }
                                }
                                continue
                            }
                            continuation.yield(event)
                            if reachedMarker {
                                continuation.finish()
                                return
                            }
                            if ["turn.completed", "turn.cancelled", "turn.failed",
                                "session.completed", "session.failed", "session.cancelled"].contains(event.type) {
                                sawTerminal = true
                                if finishOnTerminal {
                                    continuation.finish()
                                    return
                                }
                            }
                            if reachedTail {
                                continuation.finish()
                                return
                            }
                        }
                        if expectedSuffix != nil, armed, !sawTerminal {
                            throw BackendError.streamInterrupted
                        }
                        // The server closed the read before the marker: the
                        // history is not known to be whole.
                        if marker != nil {
                            throw BackendError.streamInterrupted
                        }
                        continuation.finish()
                        return
                    }
                    continuation.finish(throwing: BackendError.unauthorized)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            let watchdog = TaskBox()
            if expectedSuffix == nil {
                // History replay finishes when the server closes the stream;
                // this is only a backstop for a hung connection, so it waits
                // long enough not to truncate a slow large replay.
                // The header wait gets a longer allowance than a gap in the
                // body: eve scans the whole session before its first byte, so
                // a 3s limit there failed every long chat before it replayed.
                watchdog.set(Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        if activity.idle > (openedBox.value ? 3 : 30) {
                            // §8.3: a watchdog stop is an early stop - the
                            // read is incomplete and reported as such, never
                            // presented as a complete replay.
                            continuation.finish(throwing: BackendError.streamInterrupted)
                            return
                        }
                    }
                })
            } else {
                // A send whose expected turn never appears in the replay must
                // not hang the composer: finish once the stream goes quiet
                // without ever arming.
                watchdog.set(Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        if !armedBox.value, activity.idle > 20 {
                            continuation.finish(throwing: BackendError.streamInterrupted)
                            return
                        }
                    }
                })
            }
            continuation.onTermination = { _ in
                reader.cancel()
                watchdog.cancel()
            }
        }
    }

    private static func expectOK(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw BackendError.decoding }
        // eve answers 202 Accepted for a session turn, so any 2xx is success.
        guard (200...299).contains(http.statusCode) else {
#if os(iOS)
            // §6.2/§8.4: a 401 this far down already burned its one re-auth —
            // `credential_invalid` or not, it is terminal (§4.8). A 403
            // surfaces with its code and was never a re-auth trigger.
            switch http.statusCode {
            case 401:
                throw BackendError.credentialInvalid
            case 403:
                throw BackendError.forbidden(Self.errorCode(data) ?? "forbidden")
            default:
                throw BackendError.http(http.statusCode)
            }
#else
            // A final 401 after the sign-in retry is an auth failure; a 403
            // keeps its code so callers can tell refusal from a bad token.
            if http.statusCode == 401 {
                throw BackendError.unauthorized
            }
            throw BackendError.http(http.statusCode)
#endif
        }
    }

    /// The shell route answers `{ok:false,error:"code"}`; surface that code
    /// instead of a bare status so the UI can explain what failed.
    private static func expectShellOK(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw BackendError.decoding }
        guard (200...299).contains(http.statusCode) else {
#if os(iOS)
            // §6.2: a post-retry 401 is terminal `credentialInvalid`, a 403 is
            // `forbidden(code)` — never `.shell("unauthorized")`.
            throw Self.failure(
                status: http.statusCode,
                code: Self.errorCode(data),
                fallback: "shell_failed",
                typed: BackendError.shell
            )
#else
            if let decoded = try? JSONDecoder().decode(ShellErrorResponse.self, from: data),
               let code = decoded.error, !code.isEmpty {
                throw BackendError.shell(code)
            }
            try expectOK(data, response)
            return
#endif
        }
    }

    /// Percent-encode one path segment with a strict alphabet so an id can
    /// never add a path, a query, a fragment or a percent-decoded separator.
    static func pathComponent(_ value: String) -> String {
        guard !value.isEmpty, value != ".", value != ".." else { return "_" }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "_"
    }
}

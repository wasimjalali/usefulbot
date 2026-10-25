import Foundation
import Testing
@testable import UsefulBotCore

private final class SwitchStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest, Data?) -> (HTTPURLResponse, Data) = { request, _ in
        (HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!, Data())
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // A request body arrives as a stream by the time a protocol sees it.
        var body: Data?
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        } else {
            body = request.httpBody
        }
        let (response, data) = Self.handler(request, body)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private struct SwitchTokens: DeviceTokenStore {
    func token() throws -> String { "device-token" }
}

private struct SwitchEndpoint: EndpointPolicy {
    func endpoint(for proposed: URL) throws -> ServerEndpoint { ServerEndpoint(baseURL: proposed) }
}

private final class Captured: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(url: URL, body: Data?)] = []
    func add(_ url: URL, _ body: Data?) { lock.lock(); items.append((url, body)); lock.unlock() }
    var all: [(url: URL, body: Data?)] { lock.lock(); defer { lock.unlock() }; return items }
}

private func composerJSON(model: String, label: String, available: Bool = true) -> String {
    """
    {"composer":{"connectionId":"c","modelId":"\(model)","modelLabel":"\(label)","effort":null,
     "effortLabel":null,"speed":"standard","efforts":[],"speeds":[],"models":[],"groups":[],
     "available":\(available)}}
    """
}

@Suite(.serialized) struct ModelSwitchingTests {
    private func makeClient() throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SwitchStub.self]
        return try BackendClient(
            base: URL(string: "http://127.0.0.1:9")!,
            tokenStore: SwitchTokens(),
            endpointPolicy: SwitchEndpoint(),
            session: URLSession(configuration: config)
        )
    }

    private func respond(_ status: Int, _ json: String, to url: URL) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                         headerFields: ["content-type": "application/json"])!, Data(json.utf8))
    }

    private func state(_ model: String, _ label: String, available: Bool = true) throws -> ComposerState {
        struct Wrap: Decodable { let composer: ComposerState }
        return try JSONDecoder().decode(Wrap.self, from: Data(composerJSON(model: model, label: label, available: available).utf8)).composer
    }

    // MARK: request shape

    @Test func theComposerReadAndSaveCarryTheBotId() async throws {
        let seen = Captured()
        SwitchStub.handler = { [self] request, body in
            if request.url?.path == "/api/auth/session" {
                return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            seen.add(request.url!, body)
            return respond(200, composerJSON(model: "m", label: "M"), to: request.url!)
        }
        let client = try makeClient()
        _ = try await client.composer(botId: "bot a")
        _ = try await client.updateComposer(botId: "bot-b", modelId: "c::m")
        let calls = seen.all
        #expect(calls.count == 2)
        let query = URLComponents(url: calls[0].url, resolvingAgainstBaseURL: false)?.queryItems
        #expect(query == [URLQueryItem(name: "botId", value: "bot a")])
        let put = try #require(calls[1].body)
        let json = try #require(try JSONSerialization.jsonObject(with: put) as? [String: String])
        #expect(json == ["botId": "bot-b", "modelId": "c::m"])
    }

    @Test func aSendRefusedForTheModelSurfacesTheSameCopyInEitherEnvelope() async throws {
        let bodies = [
            #"{"error":{"code":"model_selection_unavailable","message":"gone"}}"#,
            #"{"error":"model_selection_unavailable"}"#,
            #"{"ok":false,"error":"model_selection_unavailable"}"#,
            #"{"code":"model_selection_unavailable"}"#,
        ]
        for body in bodies {
            SwitchStub.handler = { [self] request, _ in
                if request.url?.path == "/api/auth/session" {
                    return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
                }
                return respond(409, body, to: request.url!)
            }
            let client = try makeClient()
            do {
                _ = try await client.sendTurn(chatId: "c1", clientId: "x", text: "hi")
                Issue.record("expected a refusal")
            } catch let error as BackendError {
                #expect(error == .modelSelectionUnavailable)
                #expect(error.errorDescription == "This bot's model isn't available any more. Pick another model below.")
            }
        }
    }

    @Test func aSendOnATurnedOffRouteSurfacesThatRoutesOwnSentence() async throws {
        let sentence = "Alibaba only allows the Qwen Coding Plan in interactive coding tools, so Useful Bot can't use it. Connect a Qwen (DashScope) API key instead, then disconnect this one."
        SwitchStub.handler = { [self] request, _ in
            if request.url?.path == "/api/auth/session" {
                return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return respond(400, #"{"ok":false,"error":"provider_route_retired","message":"\#(sentence)"}"#, to: request.url!)
        }
        let client = try makeClient()
        do {
            _ = try await client.sendTurn(chatId: "c1", clientId: "x", text: "hi")
            Issue.record("expected a refusal")
        } catch let error as BackendError {
            #expect(error == .providerNotice(code: "provider_route_retired", message: sentence))
            #expect(error.errorDescription == sentence)
        }
    }

    @Test func theEnginesOtherRefusalsReadInPlainWords() async throws {
        let cases: [(Int, String, BackendError)] = [
            (400, #"{"ok":false,"error":"model_no_vision"}"#, .modelNoVision),
            (400, #"{"ok":false,"error":"description_too_long"}"#, .shell("shell_description_too_long")),
            (409, #"{"ok":false,"error":"chat_busy"}"#, .chat(code: "chat_busy", retryAfterMs: nil)),
            (404, #"{"ok":false,"error":"chat_not_found"}"#, .chat(code: "chat_not_found", retryAfterMs: nil)),
            (429, #"{"ok":false,"error":"retry_too_soon","retryAfterMs":4500}"#, .chat(code: "retry_too_soon", retryAfterMs: 4500)),
            (400, #"{"ok":false,"error":"context_too_large"}"#, .chat(code: "context_too_large", retryAfterMs: nil)),
            (503, #"{"ok":false,"error":"engine_starting"}"#, .chat(code: "engine_starting", retryAfterMs: nil)),
            (500, "not json", .http(500)),
        ]
        for (status, body, expected) in cases {
            SwitchStub.handler = { [self] request, _ in
                if request.url?.path == "/api/auth/session" {
                    return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
                }
                return respond(status, body, to: request.url!)
            }
            let client = try makeClient()
            do {
                _ = try await client.sendTurn(chatId: "c1", clientId: "x", text: "hi")
                Issue.record("expected a refusal for \(body)")
            } catch let error as BackendError {
                #expect(error == expected, Comment(rawValue: body))
            }
        }
        #expect(BackendError.chat(code: "chat_busy", retryAfterMs: nil).errorDescription == "Stop the chat first.")
        #expect(BackendError.chat(code: "chat_not_found", retryAfterMs: nil).errorDescription == "That chat is gone.")
    }

    @Test func aTurnBodyCarriesTheTextAndTheFilesBesideIt() async throws {
        let seen = Captured()
        SwitchStub.handler = { [self] request, body in
            if request.url?.path == "/api/auth/session" {
                return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            seen.add(request.url!, body)
            return respond(202, #"{"turnId":"t1"}"#, to: request.url!)
        }
        let client = try makeClient()
        let note = UsefulBotCore.Attachment(id: "a", name: "notes.txt", bytes: 5, text: "hello")
        let shot = UsefulBotCore.Attachment(
            id: "b", name: "shot.png", bytes: 9, text: nil, mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA"
        )
        let ack = try await client.sendTurn(chatId: "c 1", clientId: "x1", text: "look", attachments: [note, shot], retry: true)
        #expect(ack == BackendClient.TurnAck(turnId: "t1", queued: false))
        let call = try #require(seen.all.first)
        #expect(call.url.path == "/api/chats/c%201/turns" || call.url.path == "/api/chats/c 1/turns")
        let raw = try #require(call.body)
        let body = try #require(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        #expect(body["clientId"] as? String == "x1")
        #expect(body["text"] as? String == "look")
        #expect(body["retry"] as? Bool == true)
        let files = try #require(body["attachments"] as? [[String: Any]])
        #expect(files.count == 2)
        #expect(files[0]["text"] as? String == "hello")
        #expect(files[0]["mediaType"] as? String == "text/plain")
        #expect(files[1]["dataUrl"] as? String == "data:image/png;base64,AAAA")
        #expect(files[1]["text"] == nil)
    }

    @Test func aQueuedAnswerSaysSo() async throws {
        SwitchStub.handler = { [self] request, _ in
            if request.url?.path == "/api/auth/session" {
                return respond(200, #"{"ok":true,"csrfToken":"t"}"#, to: request.url!)
            }
            return respond(202, #"{"queued":true}"#, to: request.url!)
        }
        let client = try makeClient()
        let ack = try await client.sendTurn(chatId: "c1", clientId: "x", text: "again")
        #expect(ack == BackendClient.TurnAck(turnId: nil, queued: true))
    }

    @Test func aTurnTheRouterRefusedOnATurnedOffRouteReadsItsSentence() {
        let sentence = "GitHub doesn't support this Copilot sign-in in Useful Bot, so it's been turned off. Pick another provider."
        #expect(TurnFailure(code: "provider_route_retired", detail: "provider_route_retired: \(sentence)").message == sentence)
        // Wrapped in other text and a JSON tail.
        let wrapped = #"Failed after 1 attempt. Last error: {"error":{"code":"provider_route_retired","message":"provider_route_retired: \#(sentence)"}}"#
        #expect(TurnFailure(code: "MODEL_CALL_FAILED", detail: wrapped).message == sentence)
        // An escaped apostrophe cuts the text at the backslash: a half sentence is never shown.
        let escaped = #"{"error":{"code":"provider_route_retired","message":"provider_route_retired: GitHub doesn\u0027t support this Copilot sign-in."}}"#
        #expect(TurnFailure(code: "MODEL_CALL_FAILED", detail: escaped).message == "Useful Bot can't use this provider connection any more. Pick another model.")
        // No sentence in the text: still an honest plain line, never a generic failure.
        #expect(TurnFailure(code: "provider_route_retired", detail: "").message == "Useful Bot can't use this provider connection any more. Pick another model.")
    }

    // MARK: the stale-answer guard

    @Test func aSaveForBotAThatLandsAfterTheMoveToBotBLeavesBsChipAlone() throws {
        var chip = ComposerSelection()
        chip.select("a")
        chip.apply(try state("glm", "GLM 5.3 Flash"), for: "a")
        chip.select("b")
        #expect(chip.shown == nil)
        chip.apply(try state("opus", "Opus"), for: "b")
        #expect(chip.shown?.modelLabel == "Opus")
        // A's save answers late.
        let changed = chip.apply(try state("kimi", "Kimi"), for: "a")
        #expect(!changed)
        #expect(chip.shown?.modelLabel == "Opus")
        // It still filled A's cache, so going back paints A's pick.
        chip.select("a")
        #expect(chip.shown?.modelLabel == "Kimi")
    }

    @Test func aReadThatStartedBeforeASaveCannotPutTheOldPickBack() throws {
        var chip = ComposerSelection()
        chip.select("a")
        chip.apply(try state("old", "Old"), for: "a")
        let token = chip.readToken
        chip.beginSave()
        chip.apply(try state("new", "New"), for: "a")
        #expect(!chip.apply(try state("old", "Old"), for: "a", readToken: token))
        #expect(chip.shown?.modelLabel == "New")
    }

    @Test func anUnavailableModelStaysNamed() throws {
        let gone = try state("glm", "GLM 5.3 Flash", available: false)
        #expect(!gone.available)
        #expect(gone.modelLabel == "GLM 5.3 Flash")
        // A server that predates the field cannot say a model is gone.
        let old = try JSONDecoder().decode(ComposerState.self, from: Data(#"{"modelId":"m","modelLabel":"M"}"#.utf8))
        #expect(old.available)
    }

    // MARK: plain error copy

    @Test func eachRouterCodeReadsInPlainWordsInBothForms() {
        let expected: [(String, String)] = [
            ("model_selection_unavailable", "This bot's model isn't available any more. Pick another model below."),
            ("model_unavailable", "The provider doesn't offer this model right now. Pick another model."),
            ("upstream_auth_failed", "Sign-in to the model provider expired. Reconnect it in Settings."),
            ("upstream_credential_missing", "Sign-in to the model provider expired. Reconnect it in Settings."),
            ("provider_disconnected", "The model provider is disconnected. Reconnect it in Settings."),
        ]
        for (code, copy) in expected {
            // The code as the failure's own field, and only inside other text.
            #expect(TurnFailure(code: code, detail: "").message == copy, "\(code) as code")
            #expect(TurnFailure(code: "MODEL_CALL_FAILED", detail: "Failed after 3 attempts. Last error: AI_APICallError: \(code) (401)").message == copy, "\(code) in detail")
        }
    }
}

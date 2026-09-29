import Foundation
import Testing
@testable import UsefulBotCore

/// Serves a canned NDJSON body for the session stream and records the URLs
/// asked for, so the read's query and its end can be checked without eve.
private final class MarkerStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var body = ""
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var requested: [URL] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.requested.append(url)
        let response = HTTPURLResponse(url: url, statusCode: Self.status, httpVersion: nil,
                                       headerFields: ["content-type": "application/x-ndjson"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private struct MarkerTokenStore: DeviceTokenStore {
    func token() throws -> String { "device-token" }
}

private struct MarkerEndpoint: EndpointPolicy {
    func endpoint(for proposed: URL) throws -> ServerEndpoint { ServerEndpoint(baseURL: proposed) }
}

/// A load no longer asks eve for the tail index, which costs a pass over
/// every chunk file of the session. It asks for the newest event's id and
/// reads up to that event instead.
@Suite(.serialized) struct HistoryMarkerTests {
    private func makeClient() throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MarkerStubProtocol.self]
        return try BackendClient(
            base: URL(string: "http://127.0.0.1:9")!,
            tokenStore: MarkerTokenStore(),
            endpointPolicy: MarkerEndpoint(),
            session: URLSession(configuration: config)
        )
    }

    private static func line(_ type: String, _ id: String) -> String {
        #"{"type":"\#(type)","data":{},"meta":{"id":"\#(id)","at":"2026-09-20T10:00:00.000Z"}}"#
    }

    private func reset(body: [String], status: Int = 200) {
        MarkerStubProtocol.body = body.joined(separator: "\n") + "\n"
        MarkerStubProtocol.status = status
        MarkerStubProtocol.requested = []
    }

    @Test func theNewestEventIdIsReadFromTheTailWithoutTheTailIndex() async throws {
        reset(body: [Self.line("session.waiting", "evt_9")])
        let client = try makeClient()
        let id = await client.newestEventId(sessionId: "wrun_1")
        #expect(id == "evt_9")
        let query = MarkerStubProtocol.requested.first?.query ?? ""
        #expect(query.contains("startIndex=-1"))
        #expect(!query.contains("includeTailIndex"))
    }

    @Test func aProbeThatFailsReadsAsNoMarker() async throws {
        reset(body: [], status: 500)
        let client = try makeClient()
        #expect(await client.newestEventId(sessionId: "wrun_1") == nil)
        reset(body: [])
        #expect(await client.newestEventId(sessionId: "wrun_1") == nil)
    }

    @Test func eventsUpToTheMarkerAreHistoryAndTheReadEndsThere() async throws {
        reset(body: [
            Self.line("turn.started", "evt_1"),
            Self.line("message.received", "evt_2"),
            Self.line("session.waiting", "evt_3"),
            // Arrived after the probe: not part of this read.
            Self.line("turn.started", "evt_4"),
        ])
        let client = try makeClient()
        var seen: [(String?, Int?, Int?)] = []
        for try await event in client.stream(sessionId: "wrun_1", startIndex: 7, markHistory: true, historyMarker: "evt_3") {
            seen.append((event.id, event.index, event.historyRemaining))
        }
        #expect(seen.map(\.0) == ["evt_1", "evt_2", "evt_3"])
        #expect(seen.map(\.1) == [7, 8, 9])
        #expect(seen.map(\.2) == [1, 1, 0])
        let query = MarkerStubProtocol.requested.first?.query ?? ""
        #expect(query.contains("startIndex=7"))
        #expect(!query.contains("includeTailIndex"))
    }

    @Test func aMarkerThisBuildCannotDecodeStillEndsTheHistory() async throws {
        reset(body: [
            Self.line("turn.started", "evt_1"),
            #"{"meta":{"id":"evt_2"},"no_type":true}"#,
            Self.line("turn.started", "evt_3"),
        ])
        let client = try makeClient()
        var ids: [String?] = []
        for try await event in client.stream(sessionId: "wrun_1", markHistory: true, historyMarker: "evt_2") {
            ids.append(event.id)
        }
        #expect(ids == ["evt_1"])
    }

    /// The server closing the read before the marker leaves the history
    /// unproved, and the caller must not take the loop's end for it.
    @Test func aReadThatEndsBeforeTheMarkerThrows() async throws {
        reset(body: [Self.line("turn.started", "evt_1")])
        let client = try makeClient()
        await #expect(throws: BackendError.self) {
            for try await _ in client.stream(sessionId: "wrun_1", markHistory: true, historyMarker: "evt_missing") {}
        }
    }

    @Test func withoutAMarkerTheTailIndexIsStillAskedFor() async throws {
        reset(body: [Self.line("session.waiting", "evt_1")])
        let client = try makeClient()
        for try await _ in client.stream(sessionId: "wrun_1", markHistory: true) {}
        #expect((MarkerStubProtocol.requested.first?.query ?? "").contains("includeTailIndex=1"))
    }
}

#if os(macOS)
import Foundation

public protocol HealthProbe: Sendable {
    func probe(_ url: URL) async -> Bool
}

public struct URLSessionHealthProbe: HealthProbe {
    public init() {}
    public func probe(_ url: URL) async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else {
            return false
        }
        return http.statusCode == 200
    }
}

public final class HealthPoller: @unchecked Sendable {
    private let probe: HealthProbe
    public var onChange: ((Bool) -> Void)?

    public init(probe: HealthProbe) {
        self.probe = probe
    }

    public func check(_ url: URL) async -> Bool {
        let ok = await probe.probe(url)
        onChange?(ok)
        return ok
    }
}
#endif

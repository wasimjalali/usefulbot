#if os(macOS)
import Foundation

public protocol HealthProbe: Sendable {
    func probe(_ url: URL) async -> Bool
    /// The answer of a healthy endpoint with the stack it reports; nil when
    /// it does not answer 200.
    func read(_ url: URL) async -> HealthReading?
}

extension HealthProbe {
    /// A probe that only knows up or down reports no stack.
    public func read(_ url: URL) async -> HealthReading? {
        await probe(url) ? HealthReading(stack: nil) : nil
    }
}

public struct URLSessionHealthProbe: HealthProbe {
    public init() {}
    public func probe(_ url: URL) async -> Bool {
        await read(url) != nil
    }

    public func read(_ url: URL) async -> HealthReading? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              http.statusCode == 200 else {
            return nil
        }
        return HealthReading(body: data)
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

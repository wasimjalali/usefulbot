#if os(macOS)
import Testing
import Foundation
@testable import UsefulBotCore

@Suite struct ServerConfigTests {
    @Test func defaultsPointAtLoopbackWebPort() {
        let config = ServerConfig()
        #expect(config.port == 4320)
        #expect(config.baseURL.absoluteString == "http://127.0.0.1:4320")
        #expect(config.healthURL.absoluteString == "http://127.0.0.1:4320/api/health")
    }

    @Test func outOfRangePortFallsBackInsteadOfTrapping() {
        // An out-of-range port used to make `URL(string:)` return nil behind a
        // force unwrap and trap at launch.
        for port in [0, -1, 65536, 99999] {
            let config = ServerConfig(port: port)
            #expect(config.port == ServerConfig.defaultPort)
            #expect(config.baseURL.absoluteString == "http://127.0.0.1:4320")
        }
    }

    @Test func unsupportedPortFallsBackToTheSupervisedPort() {
        // The supervisor only binds 4320, so any other in-range port is
        // rejected rather than probed forever.
        for port in [1, 4000, 65535] {
            #expect(ServerConfig(port: port).port == ServerConfig.defaultPort)
            #expect(ServerConfig(port: port).healthURL.absoluteString == "http://127.0.0.1:4320/api/health")
        }
    }

    @Test func resolvedRejectsPortsTheSupervisorCannotServe() {
        let name = "ServerConfigTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(9999, forKey: "port")
        #expect(ServerConfig.resolved(defaults: defaults).port == ServerConfig.defaultPort)
    }

    @Test func resolvedExpandsTheRepoPathAndKeepsTheSupervisedPort() {
        let name = "ServerConfigTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("~/Desktop/useful-bot", forKey: "repoPath")
        defaults.set(ServerConfig.defaultPort, forKey: "port")
        let config = ServerConfig.resolved(defaults: defaults)
        #expect(config.port == ServerConfig.defaultPort)
        #expect(!config.repoPath.hasPrefix("~"))
    }
}
#endif

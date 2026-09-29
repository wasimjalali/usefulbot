#if os(macOS)
import Testing
@testable import UsefulBotCore

@Suite struct ServiceSupervisorTests {
    private let repo = "/Users/wasim/Desktop/useful-bot"

    @Test func commandsPointAtRepoServiceScript() {
        let supervisor = ServiceSupervisor()
        let cmd = supervisor.command(mode: .web, repoPath: repo)
        #expect(cmd.executable == ServiceSupervisor.resolveNodePath())
        #expect(cmd.arguments == ["\(repo)/scripts/service.mjs", "web"])
        #expect(cmd.workingDirectory == repo)
    }

    @Test func resolvesNodeFromCandidatesInOrder() {
        #expect(ServiceSupervisor.resolveNodePath(exists: { _ in false }) == "/usr/local/bin/node")
        #expect(ServiceSupervisor.resolveNodePath(exists: { $0 == "/usr/local/bin/node" }) == "/usr/local/bin/node")
        #expect(ServiceSupervisor.resolveNodePath(exists: { $0 == "/opt/homebrew/bin/node" }) == "/opt/homebrew/bin/node")
    }

    @Test func ownsUsefulBotNodeProcessesOnly() {
        let supervisor = ServiceSupervisor()
        #expect(supervisor.isOwnNodeProcess("/usr/local/bin/node \(repo)/scripts/service.mjs web", repoPath: repo))
        #expect(supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)/node_modules/next/dist/bin/next dev \(repo)/web --port 4320",
            repoPath: repo
        ))
        #expect(supervisor.isOwnNodeProcess(
            "node --experimental-strip-types \(repo)/router/src/index.ts",
            repoPath: repo
        ))
        #expect(supervisor.isOwnNodeProcess(
            "node \(repo)/node_modules/eve/bin/eve.js dev",
            repoPath: repo
        ))
        // The built web server, as launched and before it renames itself.
        #expect(supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)/web/.next/standalone/web/server.js",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)-2/web/.next/standalone/web/server.js",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess("next-server (v16.2.1)", repoPath: repo))
        // The runner appends the parent command line, so a title-rewritten
        // Next child is still recognized through its service.mjs launcher.
        #expect(supervisor.isOwnNodeProcess(
            "next-server (v16.2.1) /usr/local/bin/node \(repo)/scripts/service.mjs web",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node /other/checkout/node_modules/next/dist/bin/next dev",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess("node some-other-app", repoPath: repo))
        #expect(!supervisor.isOwnNodeProcess("Chrome", repoPath: repo))
    }

    @Test func aSiblingCheckoutWithALongerPathIsNotOurs() {
        // A sibling checkout (`useful-bot-2`) extends this repo's path, so a
        // raw substring match would count its processes as our own and
        // signal them.
        let supervisor = ServiceSupervisor()
        let sibling = "\(repo)-2"
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(sibling)/node_modules/next/dist/bin/next dev \(sibling)/web --port 4320",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "node --experimental-strip-types \(sibling)/router/src/index.ts",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(sibling)/scripts/service.mjs web",
            repoPath: repo
        ))
    }
}
#endif
